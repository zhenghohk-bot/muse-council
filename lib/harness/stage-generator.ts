import { pioneerById } from "@/data/pioneers";
import { matchHistoricalEcho } from "@/data/historical-echoes";
import { buildHarvestTranscript, describePioneer } from "@/lib/harness/context-builder";
import { generateJson } from "@/lib/harness/openai-client";
import {
  classifySupportContext,
  isUnknownCauseMode,
  resolveTurnSupportContext,
  supportModeInstruction
} from "@/lib/harness/support-mode";
import {
  breakLongSentences,
  compactQuote,
  compactText,
  ensureFirstPerson,
  findClarityIssues,
  findConversationOverlap,
  findSegmentIssues,
  findUnknownCauseIssues,
  guardPioneerContent,
  groundQuoteInContent,
  segmentTurnContent,
  softenUnsupportedInference,
  textSimilarity
} from "@/lib/harness/output-guard";
import type {
  ActionCard,
  ConversationAssignment,
  ConversationPlan,
  DiscussionPlan,
  PioneerProfile,
  QuoteCard,
  RoundtableMessage,
  RoundtableSession,
  SourceNote,
  ThemeAnalysis,
  UserTurnIntent
} from "@/lib/types";

const textWithQuoteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "quote"],
  properties: {
    content: { type: "string" },
    quote: { type: "string" }
  }
};

function classifyGenerationError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/\b429\b/.test(message)) return "http_429";
  if (/\b401\b|\b403\b/.test(message)) return "auth";
  if (/abort|timeout/i.test(message)) return "timeout";
  if (/JSON|parse|Unexpected token/i.test(message)) return "invalid_json";
  if (/5\d\d/.test(message)) return "upstream_5xx";
  return "request_failed";
}

type AssignedPioneerTurnDraft = { content: string; quote: string; deliveredContribution: string };
type CrossfireSideDraft = { priority: string; otherPathCost: string; content: string };
type CrossfireDraft = {
  first: CrossfireSideDraft;
  second: CrossfireSideDraft;
  synthesis: { difference: string; condition: string; content: string };
};
type DiscussionDraft = {
  turns: Array<{
    speakerId: string;
    content: string;
    referencedMessageIds: string[];
    newContribution: string;
  }>;
  synthesis: string;
};
type ActionCardDraft = Omit<ActionCard, "sessionId" | "sourceMessageIds"> & { sourceMessageIds?: string[] };

const assignedPioneerTurnSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "quote", "deliveredContribution"],
  properties: {
    content: { type: "string" },
    quote: { type: "string" },
    deliveredContribution: { type: "string" }
  }
};

const speechActLabels: Record<ConversationAssignment["speechAct"], string> = {
  name_emotion: "说清用户已经表达、但尚未说透的感受",
  reframe: "提供一个新的理解框架",
  distinguish: "区分边界、责任、事实或可控范围",
  challenge: "质疑一个证据不足或过早的结论",
  share_experience: "用有来源的经历或作品经验提供参照",
  ask_question: "提出一个会改变判断的具体问题",
  propose_action: "给出一个当下可以完成的小动作"
};

const firstPersonPrefixes: Record<ConversationAssignment["speechAct"], string> = {
  name_emotion: "我想先停在这个感受上：",
  reframe: "我会换一个角度看：",
  distinguish: "我想先分清一件事：",
  challenge: "我不愿意这么快下结论：",
  share_experience: "我想到一条可以参照的经验：",
  ask_question: "我想追问一句：",
  propose_action: "我建议先做一件小事："
};

function hasExecutableAction(content: string) {
  const hasActionVerb = /(写下|记录|列出|画出|整理|发送|完成|发布|制作|填写|删掉|做出)/.test(content);
  const hasSpecificObject = /(备忘录|文档|纸|表格|日历|清单|问题|结果|作品|原型|一件|一项|一条|三条|三个)/.test(content);
  return hasActionVerb && hasSpecificObject;
}

export function actionAcknowledgesContext(content: string, previousContents: string[]) {
  if (!previousContents.length) return true;
  const opening = content.split(/[。！？]/)[0]?.trim() ?? content.trim();
  const hasBridgePhrase = /(?:既然|先把|先别急|你已经|你提到|这时|沿着|从.{0,12}(?:开始|看)|比起|与其|先不急)/.test(
    opening
  );
  const bridgeAnchors = ["真诚", "感受", "字眼", "节奏", "空间", "独处", "边界", "证据", "时间", "退路", "分寸", "反馈"];
  const hasSharedAnchor = bridgeAnchors.some(
    (anchor) =>
      opening.includes(anchor) &&
      previousContents.some((previous) => previous.includes(anchor))
  );
  return hasBridgePhrase || hasSharedAnchor;
}

export function contributionIsVisibleInContent(content: string, contribution: string) {
  const normalizedContribution = contribution.trim();
  if (!normalizedContribution) return true;
  return textSimilarity(content, normalizedContribution) >= 0.18;
}

function analysisSummary(
  session: RoundtableSession,
  analysis?: Pick<ThemeAnalysis, "theme" | "tension" | "emotion" | "need">
) {
  const values = analysis ?? {
    theme: session.theme,
    tension: session.tension,
    emotion: session.explicitEmotionTerms.join("、"),
    need: ""
  };
  return [
    `主题：${values.theme}`,
    `核心张力：${values.tension}`,
    values.emotion ? `已明确的感受：${values.emotion}` : "",
    values.need ? `当前需要：${values.need}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function containsInstruction(content: string) {
  return /(?:你可以|请|不妨|试着|先|今天|今晚|现在|连续.{0,6}(?:天|周)|每天).{0,18}(?:打开|写|记录|列|画|做|完成|发布|整理)/.test(
    content
  );
}

function distinctGroundedQuote(
  content: string,
  preferred: string,
  contribution: string,
  bannedTexts: string[]
) {
  const grounded = groundQuoteInContent(content, preferred, contribution);
  const isRepeated = (quote: string) =>
    bannedTexts.some((text) => text.includes(quote) || textSimilarity(quote, text) >= 0.5);
  const isWeak = (quote: string) =>
    /^(我想|我会|我建议|我主张|我不愿意|先分清|先做一件|就是|是来自|还是一种|并|以及|然后|再)/.test(quote) || quote.length < 8;
  if (grounded && !isRepeated(grounded) && !isWeak(grounded)) return grounded;

  const candidates = (content.match(/[^。！？；]+[。！？；]?/g) ?? [])
    .filter((sentence) => !/[？?]$/.test(sentence.trim()))
    .map((sentence) => compactQuote(sentence))
    .filter((quote) => quote && content.includes(quote) && !isRepeated(quote) && !isWeak(quote));
  return candidates[0] ?? "";
}

function renderAssignedPioneerTurn(
  draft: AssignedPioneerTurnDraft,
  assignment: ConversationAssignment,
  pioneer: PioneerProfile,
  bannedQuoteTexts: string[] = [],
  maxChars = 124
) {
  let rawContent = draft.content;
  if (assignment.actionMode === "offer_one_step" && rawContent.length > maxChars) {
    const sentences = rawContent.match(/[^。！？]+[。！？]?/g) ?? [rawContent];
    if (sentences.length > 2) rawContent = `${sentences[0]}${sentences.at(-1)}`;
  }
  const content = guardPioneerContent(rawContent, maxChars, firstPersonPrefixes[assignment.speechAct], 60);
  return {
    content,
    segments: segmentTurnContent(content),
    quote: distinctGroundedQuote(content, draft.quote, draft.deliveredContribution, bannedQuoteTexts),
    deliveredContribution: compactText(draft.deliveredContribution || assignment.newContribution, 48)
  };
}

function assignedTurnIssues(
  turn: ReturnType<typeof renderAssignedPioneerTurn>,
  assignment: ConversationAssignment,
  pioneer: PioneerProfile,
  previousContents: string[],
  question: string,
  moderatorAnalysis = ""
) {
  const comparedContents = assignment.speechAct === "name_emotion" ? [] : previousContents;
  const issues = findConversationOverlap(turn.content, comparedContents);
  if (assignment.speechAct === "name_emotion" && moderatorAnalysis) {
    issues.push(
      ...findConversationOverlap(turn.content, [moderatorAnalysis]).map((issue) => `与主持人读题摘要${issue}`)
    );
  }
  const unsupportedAssumptions = sensitiveAssumptionTerms.filter(
    (term) => turn.content.includes(term) && !question.includes(term)
  );
  if (unsupportedAssumptions.length) {
    issues.push(`正文新增了用户没有表达的前提：${unsupportedAssumptions.join("、")}`);
  }
  if (assignment.relation !== "challenge" && assignment.relation !== "redirect") {
    const opening = turn.content.split(/[。！？]/)[0] ?? turn.content;
    const conceptAnchors = [
      "独处",
      "空间",
      "秩序",
      "证据",
      "交换",
      "边界",
      "责任",
      "期待",
      "自尊",
      "表达",
      "结构",
      "筹码",
      "精力",
      "作品",
      "选择权",
      "照护",
      "尺子",
      "标尺",
      "刻度",
      "声音",
      "漩涡"
    ];
    const repeatedOpeningConcepts = conceptAnchors.filter(
      (concept) =>
        !question.includes(concept) &&
        opening.includes(concept) &&
        previousContents.some((previous) => (previous.split(/[。！？]/)[0] ?? previous).includes(concept))
    );
    if (repeatedOpeningConcepts.length) {
      issues.push(`开场沿用了前一位新引入的概念：${repeatedOpeningConcepts.join("、")}`);
    }
  }
  issues.push(...findClarityIssues(turn.content, 124, 60));
  issues.push(...findSegmentIssues(turn.segments, turn.content));
  if (assignment.actionMode === "none" && containsInstruction(turn.content)) {
    issues.push("本轮任务不应给行动，但正文出现了行动指令");
  }
  if (assignment.actionMode === "offer_one_step" && !hasExecutableAction(turn.content)) {
    issues.push("行动没有同时说清具体动作与交付结果");
  }
  if (assignment.actionMode === "offer_one_step" && !actionAcknowledgesContext(turn.content, previousContents)) {
    issues.push("行动型发言没有自然承接前文，只是直接跳到建议");
  }
  if (
    assignment.relation !== "open" &&
    !contributionIsVisibleInContent(turn.content, turn.deliveredContribution)
  ) {
    issues.push("正文没有落实 deliveredContribution 所承诺的新增判断");
  }
  if (
    assignment.actionMode === "offer_one_step" &&
    /(做一件小事|极小的完整|主动完成|稳当的出发点)/.test(turn.content)
  ) {
    issues.push("行动只说了做一件小事，没有说明具体做什么");
  }
  if (turn.quote && (question.includes(turn.quote) || textSimilarity(turn.quote, question) >= 0.5)) {
    issues.push("摘句重复了用户原话，没有体现人物的新判断");
  }
  if (/(我也?有过|我也?曾|你真正|你深层|你的根源|身体不会无故|你(?:渴望|需要|想要)的也许并非)/.test(turn.content)) {
    issues.push("正文包含无来源的人物经历或过度确定的心理归因");
  }
  issues.push(...findUnknownCauseIssues(turn.content, question));
  const figurativeMarkers =
    turn.content.match(/(?:像|仿佛|如同|犹如|回声|房间|潮水|漩涡|火焰|风暴|河流|枝叶|城池|战场|刀剑|堡垒|镜子|容器|土壤|种子|翅膀|灯塔|迷雾|枷锁|量尺|尺子|钟表|时辰|里程表|里程碑)/g) ?? [];
  if (figurativeMarkers.length > pioneer.voiceProfile.imageryBudget) {
    issues.push(
      `本轮使用了 ${figurativeMarkers.length} 处意象，超过人物额度 ${pioneer.voiceProfile.imageryBudget}`
    );
  }
  if (
    pioneer.voiceProfile.imageryBudget === 0 &&
    /(像|仿佛|如同|犹如|流弹|阵地|穿胸|风声|战场|城池|刀剑|堡垒|镜子|武器|枝叶)/.test(turn.content)
  ) {
    issues.push("这位先行者本轮的意象额度为 0，正文却使用了比喻或角色化意象");
  }
  if (assignment.speechAct === "name_emotion") {
    const inferredEmotionThemes = ["价值", "创伤", "羞耻", "悲伤", "被爱", "认可", "压抑"];
    const inventedThemes = inferredEmotionThemes.filter(
      (theme) => turn.content.includes(theme) && !question.includes(theme)
    );
    if (inventedThemes.length) {
      issues.push(`情绪命名新增了用户没有表达的心理主题：${inventedThemes.join("、")}`);
    }
  }
  if (pioneer.id === "li-qingzhao") {
    const imageryCount = (
      turn.content.match(/(根|词稿|散页|沉吟|雨夜|残酒|搁浅|填词|音节|上阕|下阕|残章|韵脚|连缀|好字)/g) ?? []
    ).length;
    if (/两丛根/.test(turn.content) || imageryCount > pioneer.voiceProfile.imageryBudget) {
      issues.push("李清照本轮的文学意象超过额度，影响直接理解");
    }
    if (turn.content.length > 108) {
      issues.push("李清照本轮过长，文学表达挤占了判断本身");
    }
  }
  return [...new Set(issues)];
}

function hasHardTurnIssue(issues: string[]) {
  return issues.some(
    (issue) =>
      issue.startsWith("与前文重复了") ||
      !/^(开场与前文相似|整体内容与前文相似|摘句重复了|行动型发言没有自然承接前文|正文没有落实 deliveredContribution)/.test(
        issue
      )
  );
}

function compactStageText(content: string, maxChars: number) {
  const broken = breakLongSentences(content, Math.min(36, maxChars));
  const compacted = compactText(broken, maxChars);
  if (compacted.length <= maxChars) return compacted;
  const slice = compacted.slice(0, Math.max(1, maxChars - 1));
  const boundary = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf("；"), slice.lastIndexOf("："));
  return `${(boundary >= Math.floor(maxChars * 0.55) ? slice.slice(0, boundary) : slice).trim()}。`;
}

function renderCrossfireTurn(content: string, pioneer: PioneerProfile, maxChars = 64) {
  return compactText(
    breakLongSentences(
      softenUnsupportedInference(ensureFirstPerson(content, `我从${pioneer.values[0]}来看：`))
    ),
    maxChars
  );
}

function renderCrossfireSide(draft: CrossfireSideDraft | string, pioneer: PioneerProfile) {
  if (typeof draft === "string") {
    const content = renderCrossfireTurn(draft, pioneer);
    return !/(先|优先|主张)/.test(content) ||
      !/(代价|风险|会|容易|可能|只会|失去|拖延|浪费)/.test(content) ||
      content.length < 34
      ? renderCrossfireTurn(`${pioneer.voiceProfile.crossfireClaim}。${pioneer.voiceProfile.counterRisk}。`, pioneer)
      : content;
  }
  let content = renderCrossfireTurn(draft?.content ?? "", pioneer);
  if (
    content.length < 34 ||
    !/(先|优先|主张)/.test(content) ||
    !/(代价|风险|会|容易|可能|只会|失去|拖延|浪费)/.test(content)
  ) {
    content = renderCrossfireTurn(
      `${draft?.priority || pioneer.voiceProfile.crossfireClaim}。${draft?.otherPathCost || pioneer.voiceProfile.counterRisk}。`,
      pioneer
    );
  }
  return content;
}

function renderCrossfireSynthesis(draft: CrossfireDraft["synthesis"] | string) {
  if (typeof draft === "string") {
    const content = compactStageText(softenUnsupportedInference(draft), 64);
    return /(如果|若|当|取决于|先看|判断条件)/.test(content)
      ? content
      : compactStageText(`${content}如果一周内没有可观察结果，就交换先后顺序。`, 64);
  }
  let content = compactStageText(softenUnsupportedInference(draft?.content ?? ""), 64);
  if (!/(如果|若|当|取决于|先看|判断条件)/.test(content)) {
    content = compactStageText(draft?.condition ?? "如果一周内没有可观察结果，就交换先后顺序。", 64);
  }
  return content;
}

function crossfireQualityIssues(
  first: string,
  second: string,
  synthesis: string,
  firstPrior?: string,
  secondPrior?: string,
  question = ""
) {
  const issues: string[] = [];
  for (const [label, content] of [["first", first], ["second", second]] as const) {
    if (!/(先|优先|主张)/.test(content)) issues.push(`${label} 没有明确优先级`);
    if (!/(代价|风险|会|容易|可能|只会|失去|拖延|浪费)/.test(content)) {
      issues.push(`${label} 没有说明另一条路径的直接代价`);
    }
    if (content.length < 34) issues.push(`${label} 过短，分歧没有展开`);
  }
  if (!/(如果|若|当|取决于|先看|判断条件)/.test(synthesis)) {
    issues.push("主持人收束没有给出可验证的选择条件");
  }
  if (firstPrior && textSimilarity(first, firstPrior) >= 0.5) {
    issues.push("first 与自己的第一轮发言重复，没有推进");
  }
  if (secondPrior && textSimilarity(second, secondPrior) >= 0.5) {
    issues.push("second 与自己的第一轮发言重复，没有推进");
  }
  if (textSimilarity(first, second) >= 0.46) {
    issues.push("两位交锋者实际采用了相近路径，没有形成价值张力");
  }
  if (!/(不同意|不能|不该|不宜|先别|更该|与其|问题在于)/.test(second)) {
    issues.push("second 没有直接回应第一位的优先级");
  }
  if (classifySupportContext(question).mode === "unknown_cause") {
    const combined = `${first}${second}${synthesis}`;
    const imageryCount = (combined.match(/(像|仿佛|如同|犹如|残墨|淤塞|烟|废稿|落款|漫漶|拴着)/g) ?? []).length;
    if (imageryCount > 1) issues.push("原因未知时交锋使用了连续意象，容易把比喻误当解释");
    if (/(沉重|身体).{0,10}(?:是|来自|源于|因为|说明|意味着)/.test(combined)) {
      issues.push("原因未知时交锋替身体感受给出了确定解释");
    }
    issues.push(...findUnknownCauseIssues(combined, question));
  }
  return issues;
}

function activeRoundtableMessages(messages: RoundtableMessage[]) {
  return messages.filter((message) => message.status !== "retracted" && message.status !== "superseded");
}

const sensitiveAssumptionTerms = [
  "亏欠", "失约", "创伤", "哀悼", "羞耻", "债务", "欠债", "情感债", "内疚", "依恋", "原生家庭"
];

const actionAnchors = [
  "记录", "记下", "观察", "比较", "分数", "位置", "安静", "消息", "描述", "辨认",
  "结构", "样稿", "原型", "输入", "输出", "反馈", "预算", "投入", "退路", "边界",
  "责任", "支援", "作品", "时间", "技能", "发布", "询价", "选择"
];

function repeatedActionWithoutNewDimension(content: string, prior: string) {
  const current = new Set(actionAnchors.filter((anchor) => content.includes(anchor)));
  const previous = new Set(actionAnchors.filter((anchor) => prior.includes(anchor)));
  const shared = [...current].filter((anchor) => previous.has(anchor));
  const novel = [...current].filter((anchor) => !previous.has(anchor));
  const onlyExtendsTime = /(连续|三天|七天|一周|每天|每周|再做|延长)/.test(content);
  return shared.length >= 2 && novel.length <= 1 && onlyExtendsTime;
}

function discussionQualityIssues(
  session: RoundtableSession,
  plan: DiscussionPlan,
  turns: DiscussionDraft["turns"],
  synthesis: string,
  messages: RoundtableMessage[]
) {
  const issues: string[] = [];
  const active = activeRoundtableMessages(messages);
  const validMessageIds = new Set(active.map((message) => message.id));
  const groundedText = `${session.question}\n${active.map((message) => message.content).join("\n")}`;
  const denied = new Set(session.deniedAssumptions ?? []);
  for (const turn of turns) {
    const sourceMessages = turn.referencedMessageIds
      .map((id) => active.find((message) => message.id === id))
      .filter((message): message is RoundtableMessage => Boolean(message));
    if (!plan.speakerIds.includes(turn.speakerId)) issues.push(`${turn.speakerId} 不在本轮讨论计划中`);
    if (!turn.referencedMessageIds.length || turn.referencedMessageIds.some((id) => !validMessageIds.has(id))) {
      issues.push(`${turn.speakerId} 没有引用真实前文`);
    }
    const ownPrior = active.filter(
      (message) => message.role === "pioneer" && message.speakerId === turn.speakerId
    );
    if (ownPrior.some((message) => textSimilarity(turn.content, message.content) >= 0.58)) {
      issues.push(`${turn.speakerId} 重复了自己此前的发言`);
    }
    if (ownPrior.some((message) => repeatedActionWithoutNewDimension(turn.content, message.content))) {
      issues.push(`${turn.speakerId} 只是延长了此前动作的时间，没有增加新的判断维度`);
    }
    const priorPioneerContents = active
      .filter((message) => message.role === "pioneer")
      .map((message) => message.content);
    const overlapIssues = findConversationOverlap(turn.content, priorPioneerContents).filter(
      (issue) =>
        issue.startsWith("开场与前文相似") ||
        issue.startsWith("整体内容与前文相似") ||
        issue.startsWith("与前文重复了")
    );
    if (overlapIssues.length) {
      issues.push(`${turn.speakerId} 的讨论发言复述前文：${overlapIssues.join("、")}`);
    }
    const sourceText = sourceMessages.map((message) => message.content).join("\n");
    if (textSimilarity(turn.content, session.question) < 0.08 && textSimilarity(turn.content, sourceText) < 0.08) {
      issues.push(`${turn.speakerId} 与用户问题和所引用前文缺少关联`);
    }
    const unsupported = sensitiveAssumptionTerms.filter(
      (term) => turn.content.includes(term) && !groundedText.includes(term)
    );
    if (unsupported.length) issues.push(`${turn.speakerId} 新增了没有依据的前提：${unsupported.join("、")}`);
    if ([...denied].some((term) => turn.content.includes(term))) issues.push(`${turn.speakerId} 延续了用户已否认的前提`);
    issues.push(...findClarityIssues(turn.content, 124, 60));
  }
  if (plan.mode === "crossfire") {
    if (turns.length !== 2) issues.push("交锋必须有两位发言者");
    if (!turns.slice(1).some((turn) => /(不同意|不能|不该|不宜|问题在于|我更在意|更该)/.test(turn.content))) {
      issues.push("交锋没有回应真实的优先级分歧");
    }
  }
  if (plan.mode !== "crossfire" && turns.some((turn) => /^我不同意/.test(turn.content))) {
    issues.push("本轮不是交锋，却被写成了强制反对");
  }
  if (synthesis) {
    if (textSimilarity(synthesis, session.question) < 0.06 && textSimilarity(synthesis, turns.map((turn) => turn.content).join("\n")) < 0.08) {
      issues.push("主持人收束偏离本轮问题");
    }
    if ([...denied].some((term) => synthesis.includes(term))) issues.push("主持人延续了用户已否认的前提");
  }
  return [...new Set(issues)];
}

function sourceList(sourceNotes: SourceNote[]) {
  return sourceNotes.map((note) => `- ${note.id}｜${note.title}：${note.note} 用法：${note.usageHint}`).join("\n");
}

const fallbackPerspectiveByPioneer: Record<string, string> = {
  "li-qingzhao": "我会先找一个比‘难受’更准确的字眼。它不必漂亮，只要能让这份感受成句；成句以后，才知道该保留什么。",
  "ban-zhao": "我会先分清哪些责任属于你，哪些只是外界期待。秩序不是把事情做满，而是守住一个今天也能完成的节奏。",
  "qin-liangyu": "我会把局面分成三处：必须守住的底线、可以放下的责任、需要支援的部分。边界清楚，力气才不会用错地方。",
  "wu-zetian": "我会先问：你手里有多少时间、现金和退路？这些筹码没算清，一次好反馈也可能让你过早加注。",
  "marie-curie": "我会把‘没有积累’拆成两类证据：有没有留下作品，有没有得到真实反馈。担心不是结论，先看已有记录。",
  "florence-nightingale": "我会先看问题在哪个环节反复出现，而不急着怪自己。一次感受说明不了规律，连续记录才看得见该改哪里。",
  "jane-austen": "我会先看清关系里的交换：哪些事出于你的意愿，哪些只是怕让人失望。位置看清了，选择才不会只剩迎合。",
  "ada-lovelace": "我会把副业看成一个还没跑过的小实验：你提供什么、谁会使用、什么反馈算值得继续。积累也包括被验证的能力。",
  "virginia-woolf": "我会先问：你的日程里有没有一段能独立思考的时间？先确认空间是否存在，再判断它和眼前问题有没有关系。"
};

const unknownCausePerspectiveByPioneer: Record<string, string> = {
  "li-qingzhao": "说不清的时候，我不会催你找原因。我会先辨一辨：这份沉重更像闷、钝，还是紧；词只负责描述，不负责解释。",
  "ban-zhao": "不知缘由，也不必责备自己不够清醒。我会把作息、醒来后的安排和身体轻重分开看，让反复出现的变化慢慢显出来。",
  "qin-liangyu": "我先不追问心里藏了什么，只看今天哪些事必须应对、哪些可以暂缓、哪里可以请人帮忙。局面分开，力气才不会全压在一处。",
  "wu-zetian": "原因暂时未知，我就先看仍在你手里的部分：它几点出现、持续多久、今天哪项安排可以调整。先找得到主动权的地方。",
  "marie-curie": "一次沉重还不能说明规律。我会在相近时间留下同样三项事实，再比较它们怎样变化；证据不替你解释，只帮你少猜一点。",
  "florence-nightingale": "我会沿一天的顺序看：睡了多久，沉重落在哪里，起身后何时变轻。先照顾这份不舒服，再让时间线告诉我们哪里值得留意。",
  "jane-austen": "我不会急着替这份沉重安排一个动机。我更在意它常与哪类日程或互动一同出现；重复的场景，比漂亮的解释可靠。",
  "ada-lovelace": "我会把清晨看成一个小实验，但一次只动一个条件。睡醒时间、消息和身体轻重分开留下，才知道变化跟着哪一项走。",
  "virginia-woolf": "这份沉重不必马上被解释。我想先替清晨留十分钟不被消息打断的安静，再看安静前后，身体有没有一点不同。"
};

const unknownCauseQuoteByPioneer: Record<string, string> = {
  "li-qingzhao": "词只负责描述，不负责解释",
  "ban-zhao": "不知缘由，也不必责备自己",
  "qin-liangyu": "力气才不会全压在一处",
  "wu-zetian": "先找得到主动权的地方",
  "marie-curie": "证据不替你解释",
  "florence-nightingale": "先照顾这份不舒服",
  "jane-austen": "重复的场景比漂亮的解释可靠",
  "ada-lovelace": "一次只动一个条件",
  "virginia-woolf": "这份沉重不必马上被解释"
};

const unknownCauseContributionByPioneer: Record<string, string> = {
  "li-qingzhao": "用准确的词描述感受，不替感受解释原因",
  "ban-zhao": "把作息、安排和身体变化分开观察",
  "qin-liangyu": "区分必须应对、可以暂缓与可以求援的事",
  "wu-zetian": "先找仍能调整的时间和安排",
  "marie-curie": "用相同条件下的事实减少猜测",
  "florence-nightingale": "沿时间顺序观察身体位置与变化",
  "jane-austen": "比较沉重是否与某类互动反复同时出现",
  "ada-lovelace": "一次只改变一个条件来观察差异",
  "virginia-woolf": "比较清晨是否被消息打断时的身体变化"
};

const unknownCauseActionByPioneer: Record<string, string> = {
  "li-qingzhao": "在纸上写一个最接近此刻身体感受的字，不解释原因；五分钟后再看，这个字是否仍然准确。",
  "ban-zhao": "只选一个今天守得住的起床节奏，连续三天不增加要求，观察身体是否更容易开始一天。",
  "qin-liangyu": "今天先不增加任务。只留一件必须现在处理的事，其余暂缓到身体稍轻后再看，不把休息当成失守。",
  "wu-zetian": "记下沉重出现的时间和持续多久，再取消今天一项非必要安排，看主动减少投入后有没有变化。",
  "marie-curie": "在相近时间记录身体位置、轻重和一个外界条件；下一次只比较同样三项，不补原因。",
  "florence-nightingale": "沿清晨的顺序记下睡醒、起身和稍微变轻的时间点，先找哪一段最值得照顾。",
  "jane-austen": "只标记沉重是否常在某类互动或日程之后出现；没有重复场景，就暂时不解释它。",
  "ada-lovelace": "明早只改变一个条件，例如醒来十分钟不看消息；其余照旧，再比较身体轻重。",
  "virginia-woolf": "明早留十分钟不被消息打断的安静，结束后只记身体有没有一点变化，不追问原因。"
};

function fallbackActionForSession(session: RoundtableSession, pioneer: PioneerProfile) {
  const question = `${session.question}\n${session.theme}`;
  if (/(朋友|关系|边界|消耗|亏欠)/.test(question)) {
    return "在备忘录写下一个下次见面要测试的边界：缩短三十分钟或避开最消耗的话题；见面后记录疲惫和亏欠各几分。";
  }
  if (/(副业|创业|辞职|变现|赚钱|产品)/.test(question)) {
    return "打开空白文档，写清副业的对象、交付物和一周时间上限，再做出一份可以给别人看的最小样稿。";
  }
  if (/(父母|家里|家庭|考编|期待)/.test(question)) {
    return "打开备忘录，分别写下考编与创造性工作各自的一项收益、一项代价，以及本周能验证的一条事实。";
  }
  if (/(同龄|落后|比较|羡慕|自我价值)/.test(question)) {
    return "在备忘录写下一件这个月由你亲手完成的事，并补上日期和结果，作为只与过去的自己比较的第一条记录。";
  }
  if (/(写作|表达|发布|内容|账号|作品)/.test(question)) {
    return "打开空白文档，写一段只回答一个具体问题的短文，删到三百字以内，并留下可发布的第一稿。";
  }
  if (/(说不清|压在心口|身体沉|沉重)/.test(question)) {
    return "醒来后在纸上记下身体最沉的位置和轻重分数。五分钟后再记一次，只比较变化。";
  }
  return pioneer.practice;
}

function fallbackOpening(
  session: RoundtableSession,
  selected: PioneerProfile[] = [],
  plan?: ConversationPlan
) {
  if (isUnknownCauseMode(session)) {
    return {
      content: "这份感受每天都在，原因却暂时说不清，确实让人难以着力。说不清不等于不真实，我们先陪你看它怎样变化。",
      quote: "说不清不等于不真实"
    };
  }
  const assignmentByPioneer = new Map(plan?.assignments.map((assignment) => [assignment.pioneerId, assignment]));
  const introductions = selected
    .slice(0, 3)
    .map((pioneer) => {
      const contribution = assignmentByPioneer.get(pioneer.id)?.newContribution;
      return contribution ? `${pioneer.figure}会看${compactText(contribution, 18)}` : `${pioneer.figure}会从${pioneer.values[0]}来看`;
    })
    .join("；");
  return {
    content: compactText(
      `你正在权衡${session.tension}。今天请她们从不同位置陪你看：${introductions || "先把事实、感受和选择分开"}。`,
      76
    ),
    quote: "先把问题看清，再决定下一步。"
  };
}

function fallbackPioneerSpeech(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  sourceNotes: SourceNote[],
  assignment: ConversationAssignment
) {
  const primary = sourceNotes[0];
  const profileFallback = isUnknownCauseMode(session)
    ? unknownCausePerspectiveByPioneer[pioneer.id] ?? pioneer.decisionStyle
    : fallbackPerspectiveByPioneer[pioneer.id] ?? pioneer.decisionStyle;
  const contentByAct: Record<ConversationAssignment["speechAct"], string> = {
    name_emotion: `我会先承认这份拉扯：${compactText(session.tension, 34)}。不急着解释它，只看哪一项担心已经有事实依据。`,
    reframe: profileFallback,
    distinguish: profileFallback,
    challenge: profileFallback,
    share_experience: primary
      ? `我想到「${primary.title}」这条经验。${primary.note}`
      : `我会从${pioneer.values[0]}重新看这件事。${pioneer.pushback}`,
    ask_question: `我想追问一句：如果暂时不按最坏的解释判断，你会怎样重看「${session.theme}」？`,
    propose_action: isUnknownCauseMode(session)
      ? unknownCauseActionByPioneer[pioneer.id] ?? profileFallback
      : fallbackActionForSession(session, pioneer)
  };
  if (isUnknownCauseMode(session)) {
    for (const speechAct of Object.keys(contentByAct) as ConversationAssignment["speechAct"][]) {
      if (speechAct !== "propose_action") contentByAct[speechAct] = profileFallback;
    }
  }
  const rendered = renderAssignedPioneerTurn(
    {
      content: contentByAct[assignment.speechAct],
      quote: isUnknownCauseMode(session)
        ? unknownCauseQuoteByPioneer[pioneer.id] ?? "先留下变化，再讨论原因"
        : pioneer.pushback,
      deliveredContribution: isUnknownCauseMode(session)
        ? unknownCauseContributionByPioneer[pioneer.id] ?? assignment.newContribution
        : assignment.newContribution
    },
    assignment,
    pioneer,
    [session.question]
  );
  return assignment.speechAct === "name_emotion" && !isUnknownCauseMode(session)
    ? { ...rendered, quote: "" }
    : rendered;
}

function fallbackCrossfire(session: RoundtableSession, first: PioneerProfile, second: PioneerProfile, tension: string) {
  if (isUnknownCauseMode(session)) {
    const pairKey = [first.id, second.id].sort().join("|");
    if (pairKey === "li-qingzhao|virginia-woolf") {
      return {
        first: "我会先替这份沉重找一个准确的字。若只留下安静，感受仍没有名字，明天也难看出它是否改变。",
        second: "我不同意先催它成句。若清晨已被消息挤满，写下的词也会混进外界的声音；我会先留十分钟清静。",
        synthesis: "如果安静后感受变清楚，就先守住这十分钟；如果仍旧模糊，就只写一个描述身体的词。"
      };
    }
    return {
      first: compactText(`我会先沿${first.values[0]}的方向留下一条线索。若先走另一条路，眼前的变化可能更难分清。`, 64),
      second: compactText(`我不同意这个先后。我会先从${second.values[0]}着手；若只沿前一种办法，今天可能又多一项负担。`, 64),
      synthesis: "如果一种做法让感受更清楚，就先保留；如果它只是增加负担，就换另一种更轻的观察。"
    };
  }
  const firstPath = first.voiceProfile.crossfireClaim.replace(/^我主张先/, "");
  const secondPath = second.voiceProfile.crossfireClaim.replace(/^我主张先/, "");
  const pairKey = [first.id, second.id].sort().join("|");
  const isNamedShame = /羞耻|自我否定|不够好/.test(`${session.question}\n${session.theme}`);
  const conditionByPair: Record<string, string> = {
    "ada-lovelace|marie-curie": "如果当前缺的是市场反馈，先做原型；如果已有多次尝试却无法比较，先统一记录。",
    "ada-lovelace|wu-zetian": "如果还没有真实反馈，先做原型；如果连投入上限都说不清，先算筹码。",
    "ban-zhao|virginia-woolf": "如果日程已经失控，先恢复节奏；如果只是没有独处时间，先守住空间。",
    "ban-zhao|jane-austen": isNamedShame
      ? "如果羞耻在某些人面前明显变强，先减少比较；如果独处时也反复出现，先降低今天的自我要求。"
      : "如果能说出一次具体失约，就先处理那件事；如果没有具体亏欠却反复疲惫，就先缩短一次相处。",
    "jane-austen|virginia-woolf": "如果你还说不清自己总在扮演什么角色，先观察交换；如果角色已经清楚却没有恢复时间，先减少一次消耗。",
    "li-qingzhao|virginia-woolf": isNamedShame
      ? "如果离开比较场景后羞耻明显减轻，先减少外界评价；如果仍反复出现，写下它依据的具体标准。"
      : "如果独处后更清楚自己要表达什么，先保留空间；如果仍停在模糊里，先写下一句不求发布的真话。"
  };
  const turnsByPair: Record<string, { first: string; second: string }> = {
    "ban-zhao|jane-austen": isNamedShame
      ? {
          first: "我会先问：这句“不够好”在谁面前最响？若先加一条新规矩，标准来自哪里还没看清，规矩也可能变成新的自责。",
          second: "我不同意先追问别人。羞耻正强时，继续审视关系会多一层负担；我会先把今天对自己的要求减到一件。"
        }
      : {
          first: "我会先核对这份亏欠有没有具体事实：你是否失约、隐瞒，或让对方承担了代价？若没有，继续调整自己可能只是在替对方的失望负责。",
          second: "我不同意先审问亏欠是否成立。若每次见面已经耗尽心力，继续核对关系只会增加自责；我会先缩短一次相处，再回来判断。"
        },
    "jane-austen|virginia-woolf": {
      first: "我会先看清你在这段关系里总被安排成什么角色。若只缩短相处，却没看懂交换方式，下一段关系仍可能重复。",
      second: "我不同意把观察放在最前。若每次见面都耗尽恢复时间，先少见一次，才有余地分辨哪些期待真正属于你。"
    },
    "li-qingzhao|virginia-woolf": {
      first: isNamedShame
        ? "我会先把“我不够好”写成一句可核对的话。若只退回安静，那把衡量自己的尺子仍藏在暗处。"
        : "我会先写下一句不求漂亮的真话。若只等待安静，想表达的东西仍可能没有落点。",
      second: isNamedShame
        ? "我不同意立刻审问这句话。若羞耻正被比较和评价放大，先离开那些目光，才有余地判断哪些标准属于你。"
        : "我不同意立刻把感受变成作品。若自己的时间仍被打断，写下的也可能只是外界催促的回声。"
    }
  };
  const condition = conditionByPair[pairKey] ?? "各试一次最小动作，哪条让问题更清楚，就沿哪条继续。";
  const pairTurns = turnsByPair[pairKey];
  return {
    first: compactText(
      pairTurns?.first ?? `${first.voiceProfile.crossfireClaim}。若先${secondPath}，${first.voiceProfile.counterRisk}。`,
      64
    ),
    second: compactText(
      pairTurns?.second ?? `我不同意这个先后。${second.voiceProfile.crossfireClaim}。若先${firstPath}，${second.voiceProfile.counterRisk}。`,
      64
    ),
    synthesis: compactText(
      `判断条件：${condition}`,
      64
    )
  };
}

function followUpAssignment(pioneer: PioneerProfile, question: string): ConversationAssignment {
  const asksForAction = /怎么办|怎么做|如何|下一步|要不要|该不该|能做什么/.test(question);
  const speechAct = asksForAction
    ? "propose_action"
    : pioneer.voiceProfile.preferredSpeechActs.find((act) => act !== "propose_action") ?? "reframe";
  return {
    pioneerId: pioneer.id,
    speechAct,
    relation: "clarify",
    objective: asksForAction ? "直接回答追问，只给一个足够具体的小动作" : "直接回答用户刚刚的追问，并推进一个新的判断",
    newContribution: `针对追问补充${pioneer.voiceProfile.reasoningMove}`,
    actionMode: asksForAction ? "offer_one_step" : "none"
  };
}

const commitmentFallbacks: Record<string, string> = {
  "li-qingzhao": "这个方向已经比刚才清楚。别急着把它说得漂亮，先保留你真正愿意开始的那一部分。",
  "ban-zhao": "方向既已确定，就把第一步缩到今天也能守住。小，不在于轻率，而在于可以持续。",
  "qin-liangyu": "既然主次已经清楚，就先守住这一件事。其余想法暂时放下，不必同时开战线。",
  "wu-zetian": "可以。再把投入上限写清：最多用多少时间和钱，看到什么结果才继续。选择权要留在你手里。",
  "marie-curie": "这个决定可以开始验证。只保留一个观察标准，做完后再用结果判断，不让一时情绪替实验下结论。",
  "florence-nightingale": "这个方向可行。接下来只看它是否能在你的日程里稳定运行，而不是再增加一套负担。",
  "jane-austen": "这个决定听起来更像你的选择，而不是为了向谁证明。接下来只需留意，你是否又悄悄把标准交给了旁人的掌声。",
  "ada-lovelace": "对，把“小”再写得具体：两天内完成、只解决一个问题、能给一个真实用户看。这样才真正可运行。",
  "virginia-woolf": "方向已经出现了。现在替它留出一小段不被占用的时间，让这个选择有地方真正发生。"
};

function fallbackFollowUp(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  question: string,
  intent: UserTurnIntent,
  sourceNotes: SourceNote[],
  assignment: ConversationAssignment
) {
  if (intent === "commitment" || intent === "closure") {
    const content = guardPioneerContent(commitmentFallbacks[pioneer.id] ?? "这个方向已经清楚。把第一步缩到可以完成、可以观察，再用结果决定是否继续。", 110, "我的判断是：", 58);
    return {
      content,
      segments: segmentTurnContent(content),
      quote: distinctGroundedQuote(content, "", assignment.newContribution, [session.question, question]),
      deliveredContribution: "确认用户选择，并把下一步限定得更清楚"
    };
  }
  return fallbackPioneerSpeech(session, pioneer, sourceNotes, assignment);
}

// The follow-up fallback reuses the same canned per-pioneer perspective as the first
// round. If this speaker already fell to that line earlier in the session, the two turns
// come out verbatim-identical — the worst repetition the judge can see. When that happens,
// pivot to a reply that actually picks up the follow-up, built from this pioneer's own
// pushback so it stays distinct from the first-round perspective string.
function dedupeFollowUpFallback<T extends { content: string; segments: string[]; quote: string }>(
  data: T,
  sameSpeakerContents: string[],
  pioneer: PioneerProfile,
  question: string,
  assignment: ConversationAssignment
): T {
  const collides = sameSpeakerContents.some(
    (prior) => prior === data.content || textSimilarity(prior, data.content) >= 0.7
  );
  if (!collides) return data;
  const pivot = guardPioneerContent(
    `接着你追问的这一点，我想再往前看一步：${pioneer.pushback}`,
    116,
    "我接着你的追问说：",
    60
  );
  return {
    ...data,
    content: pivot,
    segments: segmentTurnContent(pivot),
    quote: distinctGroundedQuote(pivot, "", assignment.newContribution, [question, ...sameSpeakerContents])
  };
}

const fallbackClosingNotes: Record<string, string> = {
  "li-qingzhao": "把此刻说清，也是在为自己保留位置。",
  "ban-zhao": "先守住一件做得到的事，再决定下一步。",
  "qin-liangyu": "边界不是退缩，是把力量留给真正要守的事。",
  "wu-zetian": "先算清最多能投入多少，再决定要不要继续加注。",
  "marie-curie": "别让一次沉默，替长期积累下结论。",
  "florence-nightingale": "善意需要边界，才能成为长久的力量。",
  "jane-austen": "温柔不必以失去自尊为代价。",
  "ada-lovelace": "让想象进入一个可以运行的小结构。",
  "virginia-woolf": "先为自己留出空间，答案才有地方出现。"
};

function renderQuoteContext(raw: string, speakerId: string, theme: string) {
  const prefixed = raw.startsWith("本场赠言") ? raw : `本场赠言｜${raw}`;
  if (/(根源|本质|深层恐惧|真正害怕|这说明你|来自你|源于你|是因为你)/.test(prefixed)) {
    return compactText(
      `本场赠言｜${pioneerById.get(speakerId)?.figure ?? "先行者"}为「${theme}」留下一个可继续思考的角度。`,
      70
    );
  }
  return compactText(softenUnsupportedInference(prefixed), 70);
}

// Re-distill a gift from what THIS speaker actually contributed. deliveredContribution
// is Harness-only metadata (never shown to the user, never the raw transcript), so a
// clause drawn from it stays tied to this pioneer's own turn and is naturally distinct
// from other speakers'. Preferred over the shared theme table below.
function distillOwnContribution(source: RoundtableMessage | undefined) {
  const contribution = source?.newContribution?.trim();
  if (!contribution) return "";
  const clauses = contribution.split(/[，。；：]/).map((clause) => clause.trim()).filter(Boolean);
  const preferred =
    [...clauses].reverse().find((clause) => clause.length >= 8 && clause.length <= 26) ??
    compactText(contribution, 28);
  const normalized = preferred
    .replace(/^将/, "把")
    .replace(/^(?:提供了?|提出了?|补充了?|质疑了?|帮助|让用户|引导用户)/, "")
    .trim();
  if (normalized.length < 8 || normalized.length > 30) return "";
  // The closing-note grounding check rejects quotes that appear verbatim in the source.
  if (source && source.content.includes(normalized)) return "";
  return normalized;
}

function sourceDerivedClosingQuote(source: RoundtableMessage | undefined) {
  if (!source?.newContribution?.trim()) return "";
  // 1) Prefer a re-distillation of this speaker's own contribution (distinct per pioneer).
  const ownGift = distillOwnContribution(source);
  if (ownGift) return ownGift;
  // 2) Fall back to a shared theme table only when own-speech distillation fails.
  const sourceText = `${source.newContribution}\n${source.content}`;
  const semanticGifts: Array<[RegExp, string]> = [
    [/(?:描述|字眼|命名|词只负责)/, "先给感受一个字，不急着替它下结论。"],
    [/(?:必须应对|暂缓|求援|轻重)/, "先分清轻重缓急，再把力气放回手里。"],
    [/(?:节奏|起床)/, "今天只守住一个节奏，就已经够了。"],
    [/(?:说不清|真实|被相信)/, "说不清的感受，也值得被认真对待。"],
    [/(?:独处|空间|不被打扰)/, "先留出一小段不被打扰的时间。"],
    [/(?:证据|比较|记录)/, "先留下能比较的记录，再让结果说话。"],
    [/(?:原型|样稿|交付|可运行)/, "先做出一个能被看见的小样。"],
    [/(?:时间|现金|退路|投入)/, "先算清能投入多少，再决定是否继续。"]
  ];
  const semanticGift = semanticGifts.find(([pattern]) => pattern.test(sourceText))?.[1];
  if (semanticGift && !source.content.includes(semanticGift)) return semanticGift;
  return "";
}

function isOpaqueClosingQuote(quote: string) {
  return /(恐惧.{0,6}面具|寂静.{0,12}(?:褪尽|颜色)|灵魂|命运|深渊|彼岸|枷锁|选择权来自.{0,12}筹码|(?:量尺|尺子).*(?:时辰|钟表)|里程表.*里程碑)/.test(
    quote
  );
}

function closingQuoteNeedsRepair(draft: { quote?: string } | undefined, source: RoundtableMessage | undefined) {
  if (!source) return false;
  const quote = compactText(draft?.quote?.trim() || "", 30);
  return !quote || source.content.includes(quote) || isOpaqueClosingQuote(quote);
}

function renderClosingCard(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  source: RoundtableMessage | undefined,
  draft?: { quote?: string; context?: string }
): QuoteCard {
  const draftQuote = compactText(draft?.quote?.trim() || "", 30);
  const draftIsVerbatim = source ? source.content.includes(draftQuote) : false;
  const draftIsGrounded = source
    ? !draftIsVerbatim && Boolean(draftQuote)
    : Boolean(draftQuote);
  const candidate = draftIsGrounded && draftQuote ? draftQuote : "";
  const quoteIsOpaque = isOpaqueClosingQuote(candidate);
  const quote = candidate && !quoteIsOpaque
    ? candidate
    : sourceDerivedClosingQuote(source) || fallbackClosingNotes[pioneer.id] || compactText(pioneer.pushback, 30);
  const sourceContext = source
    ? `${pioneer.figure}把「${compactText(source.newContribution || source.content, 38)}」收成一句提醒。`
    : `${pioneer.figure}根据本场谈话，为「${session.theme}」留下的提醒。`;
  const context = renderQuoteContext(
    draftIsGrounded && draft?.context?.trim() ? draft.context.trim() : sourceContext,
    pioneer.id,
    session.theme
  );
  const historicalEcho = session.supportMode === "unknown_cause"
    ? undefined
    : matchHistoricalEcho(pioneer.id, `${quote}\n${context}`);
  return {
    sessionId: session.id,
    speakerId: pioneer.id,
    quote,
    context,
    sourceMessageId: source?.id,
    sourceMessageIds: source ? [source.id] : [],
    kind: "closing_note",
    historicalEcho
  };
}

// Cards are rendered per-pioneer in isolation, so two speakers can independently land
// on the same deterministic fallback quote (e.g. one shared theme gift). This final pass
// runs in both the model and fallback paths: on a collision it swaps the later card for
// that pioneer's own unique closing note, which is keyed by id and guaranteed distinct.
export function dedupeClosingQuotes(
  cards: QuoteCard[],
  selected: PioneerProfile[],
  session: RoundtableSession
): QuoteCard[] {
  const seen: string[] = [];
  return cards.map((card) => {
    const collides = seen.some(
      (prior) => prior === card.quote || textSimilarity(prior, card.quote) >= 0.7
    );
    if (!collides) {
      seen.push(card.quote);
      return card;
    }
    const pioneer = selected.find((item) => item.id === card.speakerId);
    const uniqueQuote = compactText(
      fallbackClosingNotes[card.speakerId] || pioneer?.pushback || card.quote,
      30
    );
    seen.push(uniqueQuote);
    return {
      ...card,
      quote: uniqueQuote,
      historicalEcho:
        session.supportMode === "unknown_cause"
          ? undefined
          : matchHistoricalEcho(card.speakerId, `${uniqueQuote}\n${card.context}`)
    };
  });
}

function chooseActionLead(
  session: RoundtableSession,
  selected: PioneerProfile[],
  messages: RoundtableMessage[]
) {
  const latestUserTurn = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.stage === "follow_up");
  if (latestUserTurn) {
    const userTurnIndex = messages.findIndex((message) => message.id === latestUserTurn.id);
    const latestFollowUpReply = messages
      .slice(userTurnIndex + 1)
      .filter((message) => message.role === "pioneer" && message.stage === "follow_up")
      .at(-1);
    const latestFollowUpPioneer = latestFollowUpReply
      ? selected.find((pioneer) => pioneer.id === latestFollowUpReply.speakerId)
      : undefined;
    if (latestFollowUpReply && latestFollowUpPioneer) {
      return { message: latestFollowUpReply, pioneer: latestFollowUpPioneer };
    }
  }

  if (session.supportMode === "named_emotion") {
    const crossfireMessages = messages.filter(
      (message) => message.stage === "crossfire" && message.role === "pioneer"
    );
    const emotionPreferences = /羞耻|自我否定|不够好/.test(`${session.question}\n${session.theme}`)
      ? ["jane-austen", "li-qingzhao", "virginia-woolf", "ban-zhao"]
      : selected.map((pioneer) => pioneer.id);
    const emotionalLead = emotionPreferences
      .map((id) => crossfireMessages.find((message) => message.speakerId === id))
      .find(Boolean);
    const emotionalPioneer = emotionalLead
      ? selected.find((pioneer) => pioneer.id === emotionalLead.speakerId)
      : undefined;
    if (emotionalLead && emotionalPioneer) {
      return { message: emotionalLead, pioneer: emotionalPioneer };
    }
  }

  const proposedAction = messages.find(
    (message) => message.stage === "first_round" && message.speechAct === "propose_action"
  );
  const proposedActionPioneer = proposedAction
    ? selected.find((pioneer) => pioneer.id === proposedAction.speakerId)
    : undefined;
  if (proposedAction && proposedActionPioneer) {
    return { message: proposedAction, pioneer: proposedActionPioneer };
  }

  const preferences = [
    { match: /父母|家里|家庭|考编|催婚/, ids: ["qin-liangyu", "jane-austen", "ban-zhao"] },
    { match: /朋友|恋爱|关系|亏欠|伴侣|前任/, ids: ["jane-austen", "qin-liangyu", "ban-zhao"] },
    { match: /副业|创业|辞职|变现|赚钱|产品/, ids: ["wu-zetian", "ada-lovelace", "marie-curie"] },
    { match: /写作|表达|发布|内容|账号|作品/, ids: ["li-qingzhao", "virginia-woolf", "ada-lovelace"] },
    { match: /同龄|落后|比较|羡慕|自我价值/, ids: ["jane-austen", "marie-curie", "ban-zhao"] },
    { match: /说不清|压在心口|身体沉|沉重/, ids: ["virginia-woolf", "li-qingzhao", "ban-zhao"] }
  ];
  const rule = preferences.find(({ match }) => match.test(`${session.question}\n${session.theme}`));
  const selectedIds = new Set(selected.map((pioneer) => pioneer.id));
  const leadId = rule?.ids.find((id) => selectedIds.has(id)) ?? selected[0]?.id;
  const message = messages.find(
    (item) => item.stage === "first_round" && item.speakerId === leadId
  );
  const pioneer = selected.find((item) => item.id === leadId);
  return message && pioneer ? { message, pioneer } : undefined;
}

function renderActionCard(sessionId: string, card: ActionCardDraft): ActionCard {
  const balanceQuotes = (content: string) => {
    const left = (content.match(/“/g) ?? []).length;
    const right = (content.match(/”/g) ?? []).length;
    return left > right ? `${content}”` : content;
  };
  return {
    sessionId,
    chosenPath: balanceQuotes(compactText(softenUnsupportedInference(card.chosenPath), 60)),
    within24h: balanceQuotes(compactText(softenUnsupportedInference(card.within24h), 58)),
    sevenDayExperiment: balanceQuotes(compactText(softenUnsupportedInference(card.sevenDayExperiment), 78)),
    thirtyDayPractice: balanceQuotes(compactText(softenUnsupportedInference(card.thirtyDayPractice), 82)),
    guardrail: balanceQuotes(compactText(softenUnsupportedInference(card.guardrail), 70)),
    evidenceToReview: balanceQuotes(compactText(softenUnsupportedInference(card.evidenceToReview), 64)),
    sourceMessageIds: card.sourceMessageIds?.slice(0, 4)
  };
}

function fallbackFinal(
  session: RoundtableSession,
  selected: PioneerProfile[],
  messages: RoundtableMessage[] = []
): { actionCard: ActionCard; quoteCards: QuoteCard[] } {
  const lead = selected[0];
  const synthesis = messages.filter((message) => message.stage === "synthesis").at(-1)?.content;
  const sourceMessageIds = messages
    .filter((message) => message.role === "pioneer" || message.stage === "synthesis")
    .slice(-3)
    .map((message) => message.id);
  const unknownCause = isUnknownCauseMode(session);
  return {
    actionCard: renderActionCard(session.id, {
      chosenPath: unknownCause
        ? "本轮先不解释原因，只比较沉重出现的时间、身体位置和外界干扰，让变化成为下一步判断的依据。"
        : `本轮先沿${lead?.figure ?? "第一位先行者"}的练习推进，因为它最接近你此刻能验证的一步。`,
      within24h: unknownCause
        ? "明早醒来后记录身体最沉的位置、轻重分数和当时是否已看消息，只记录一次，不分析原因。"
        : lead?.practice ?? `用 20 分钟完成一个与「${session.theme}」有关的小动作，留下结果。`,
      sevenDayExperiment: unknownCause
        ? "连续七天在同一时间记录这三项，并比较看消息前后是否有稳定差异；没有规律也如实保留。"
        : "接下来 7 天围绕同一个动作完成 3 次，每次只记录投入、结果和一个需要调整的地方。",
      thirtyDayPractice: unknownCause
        ? "只保留七天中最容易完成的记录方式，每周回看一次出现时间和轻重变化，不把单次波动当成结论。"
        : "未来 30 天每周固定一次执行与复盘，只保留有可观察结果的部分，并逐步缩小无效投入。",
      guardrail: unknownCause
        ? "如果记录让你更难受或明显影响日常生活，就暂停自我分析，并考虑向可信赖的人或专业人士求助。"
        : "如果连续 7 天没有留下任何结果，就把动作缩小一半或暂停，不用靠增加任务来证明自己。",
      evidenceToReview: unknownCause
        ? "出现时间、身体位置、轻重分数，以及它们是否在相似条件下重复变化。"
        : synthesis
          ? `对照圆桌收束复盘：投入时间、实际反馈、完成后的感受。`
          : "复盘三类证据：投入时间、实际反馈、完成后的感受。",
      sourceMessageIds
    }),
    quoteCards: dedupeClosingQuotes(
      selected.map((pioneer) =>
        renderClosingCard(
          session,
          pioneer,
          [...messages].reverse().find((message) => message.role === "pioneer" && message.speakerId === pioneer.id)
        )
      ),
      selected,
      session
    )
  };
}

export class StageGenerator {
  async opening(session: RoundtableSession, selected: PioneerProfile[] = [], plan?: ConversationPlan) {
    if (isUnknownCauseMode(session)) {
      return {
        data: fallbackOpening(session, selected, plan),
        usedGuardRepair: true as const,
        guardIssues: ["原因未知模式：主持人只复述可确认事实"]
      };
    }
    const prompt = [
      "请生成主持人的反映式开场。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      "本场入席与任务：",
      selected
        .map((pioneer) => {
          const assignment = plan?.assignments.find((item) => item.pioneerId === pioneer.id);
          return `- ${pioneer.figure}：${assignment?.newContribution ?? pioneer.voiceProfile.reasoningMove}`;
        })
        .join("\n"),
      supportModeInstruction({ mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms }),
      "要求：直接用“你”称呼用户，不使用“她”“我听到的是”“我看见”；第一句自然承接她正在权衡什么，第二句用姓名简短介绍为何邀请这些先行者入席；不是人物履历介绍，不逐条念任务；只承接她明确说出的感受，无法确认的地方保留不确定；不分析隐藏原因，不给建议；45-76 个中文字，不用比喻和抽象心理术语；给一句 8-20 字的 quote。"
    ].join("\n");

    try {
      const result = await generateJson<{ content: string; quote: string }>("roundtable_opening", textWithQuoteSchema, prompt);
      const content = compactText(breakLongSentences(softenUnsupportedInference(result.data.content)), 76);
      const guardIssues = findUnknownCauseIssues(content, session.question);
      if (guardIssues.length) {
        return {
          ...result,
          data: fallbackOpening(session, selected, plan),
          usedGuardRepair: true as const,
          guardIssues
        };
      }
      return {
        ...result,
        data: {
          content,
          quote: groundQuoteInContent(content, result.data.quote, content)
        }
      };
    } catch (error) {
      return {
        data: fallbackOpening(session, selected, plan),
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async pioneerSpeech(
    session: RoundtableSession,
    pioneer: PioneerProfile,
    sourceNotes: SourceNote[],
    messages: RoundtableMessage[] = [],
    assignment?: ConversationAssignment,
    analysis?: Pick<ThemeAnalysis, "theme" | "tension" | "emotion" | "need">
  ) {
    const resolvedAssignment: ConversationAssignment = assignment ?? {
      pioneerId: pioneer.id,
      speechAct: pioneer.voiceProfile.preferredSpeechActs[0] ?? "reframe",
      relation: messages.some((message) => message.stage === "first_round") ? "extend" : "open",
      respondsToPioneerId: messages.filter((message) => message.stage === "first_round").at(-1)?.speakerId,
      objective: `使用${pioneer.figure}擅长的方式推进一个新观点`,
      newContribution: pioneer.voiceProfile.reasoningMove,
      actionMode: "none"
    };
    const pioneerNames = new Map(
      messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId])
    );
    const priorPioneerMessages = messages.filter(
      (message) => message.role === "pioneer" && message.stage === "first_round"
    );
    const priorConversationContents = messages
      .filter((message) => message.stage === "opening" || message.stage === "first_round")
      .map((message) => message.content);
    const priorPioneerContents = priorPioneerMessages.map((message) => message.content);
    const moderatorAnalysis = analysisSummary(session, analysis);
    const respondsTo = priorPioneerMessages.find(
      (message) => message.speakerId === resolvedAssignment.respondsToPioneerId
    );
    const prompt = [
      "请生成一位先行者的第一轮发言。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      "主持人已完成的读题摘要：",
      moderatorAnalysis,
      supportModeInstruction({ mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms }),
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "此前已经说过的话：",
      buildHarvestTranscript(messages, pioneerNames) || "你是第一位发言者，暂无前序发言。",
      "Director 为你分配的本场任务：",
      `- speechAct：${resolvedAssignment.speechAct}（${speechActLabels[resolvedAssignment.speechAct]}）`,
      `- relation：${resolvedAssignment.relation}`,
      `- objective：${resolvedAssignment.objective}`,
      `- 必须带来的新增内容：${resolvedAssignment.newContribution}`,
      `- 是否给行动：${resolvedAssignment.actionMode === "offer_one_step" ? "可以给且只给一个具体动作" : "不要给行动建议，只推进理解或判断"}`,
      respondsTo
        ? `你要自然回应${pioneerById.get(respondsTo.speakerId)?.figure ?? "前一位"}的观点：${respondsTo.content}`
        : "你是第一位，不需要承接其他人物。",
      "输出要求：",
      "- content 写成 2-4 句、45-120 个中文字的自然口语。能在 68 字内讲清就及时停下；只有确实需要补充理由、区分或追问时才展开第二层意思。只完成 Director 分配的一个主要任务，不套“承接—判断—理由—行动”结构。",
      "- 如果 content 超过 68 字，请在接近中间的位置结束一个完整句意，让前后自然成为两个对话框：第一段先给判断或观察，第二段必须增加理由、代价或追问，不能换词重复。",
      "- 第一人称发言，但不要固定用“我的判断是”“我主张”“我看到的是”开场，也不要重新复述用户的简历、关系或处境。第一句应直接进入这位人物独有的观察、区分、质疑或问题。",
      resolvedAssignment.speechAct === "name_emotion"
        ? "- 你可以承认用户已经说出的感受，但不能把主持人的读题摘要换词复述。请从人物自己的观察、措辞或轻微追问切入，并把 Director 分配的新判断真正写进正文。"
        : "",
      "- 若 relation 不是 open，要让人读得出你在回应前文，但不要使用“我同意，但是”这种机械连接。",
      "- 承接不等于重复前一位的解释。若前一位刚引入“独处、空间、秩序、证据、交换、边界”等概念，不要再用同一概念开场；先完成你被分配的新判断，再在必要时用短语回应。",
      "- 承接是回应前文的判断，不是复述原句：不得复制前文任何连续 10 个字，也不要用“她说/刚才说/正如”后接原句。",
      resolvedAssignment.relation === "challenge" || resolvedAssignment.relation === "redirect"
        ? "- 你的任务是改变判断标准：不要沿用前文的核心名词继续搭系统，要指出前一视角忽略了什么，或把讨论带向另一项价值。"
        : "- 可以承接前文，但必须增加一个前面没有出现的判断依据。",
      "- deliveredContribution 用 12-36 字说明正文实际新增了什么，仅供 Harness 校验，不会展示给用户。",
      "- quote 为 content 中原样出现的 8-22 字完整短句或分句，不冒充历史名言。",
      resolvedAssignment.actionMode === "offer_one_step"
        ? priorPioneerMessages.length
          ? "- 给行动前，先用一句自然的话承接或推进前文的具体判断，再说明打开或使用什么、做什么、留下什么结果；禁止“建立档案”“调整状态”“找回自己”等需要用户再次解释的说法。"
          : "- 行动必须说明打开或使用什么、做什么、留下什么结果；禁止“建立档案”“调整状态”“找回自己”等需要用户再次解释的说法。"
        : "- 本轮不要出现“今天写下、列出、建立、完成”等行动指令，完整行动会在圆桌结束后生成。",
      "- 请做换名检查：如果把姓名换成另一位先行者仍成立，就按角色的推理动作重写。",
      pioneer.voiceProfile.imageryBudget === 0
        ? "- 本轮不用比喻或文学意象，人物特色通过语气、提问方式和判断逻辑体现。"
        : `- 本轮最多使用 ${pioneer.voiceProfile.imageryBudget} 个易懂意象；出现后立即回到具体事实、边界或判断标准，不得追加第二层意象。`,
      pioneer.id === "li-qingzhao"
        ? "- 本轮最多使用一个文学意象。用了一个之后，立刻回到普通现代中文；不能围绕同一意象继续堆音节、残章、韵脚等词。"
        : "",
      "禁止：无来源地声称“我曾经/我也曾”；替用户定义隐藏心理原因；连续堆叠比喻；堆角色关键词；使用角色卡中的禁止模式；使用“情绪劳动、基线评分、内在空间被侵占”等咨询或评测术语，改成普通人一遍就能读懂的话。",
      session.supportMode === "named_emotion"
        ? "用户已经亲自说出这些情绪，可以直接承接并表示理解；不要把羞耻、悲伤等不舒服重新包装成清醒、礼物、力量或成长信号。"
        : "",
      isUnknownCauseMode(session)
        ? "用户明确说自己不知道原因：你不能替她补出原因，只能承认未知、提出可观察线索，或把某种可能写成真正的问句。不得写“不是 A，而是心里/内在的 B”“这是某种信号”，也不得用“可能、也许、往往”把未经确认的因果猜测包装成陈述。不要把感受写成等待安放、等待表达的字句，也不要暗示它在保护、提醒或拴住用户。"
        : ""
    ].join("\n");

    try {
      const result = await generateJson<AssignedPioneerTurnDraft>(
        `pioneer_${pioneer.id.replaceAll("-", "_")}`,
        assignedPioneerTurnSchema,
        prompt
      );
      const bannedQuoteTexts = [session.question, ...priorConversationContents];
      let rendered = renderAssignedPioneerTurn(
        result.data,
        resolvedAssignment,
        pioneer,
        bannedQuoteTexts
      );
      let qualityIssues = assignedTurnIssues(
        rendered,
        resolvedAssignment,
        pioneer,
        priorPioneerContents,
        session.question,
        moderatorAnalysis
      );
      let bestRendered = rendered;
      let bestIssues = qualityIssues;

      if (qualityIssues.length) {
        const needsActionBridge = qualityIssues.includes("行动型发言没有自然承接前文，只是直接跳到建议");
        const needsVisibleContribution = qualityIssues.includes("正文没有落实 deliveredContribution 所承诺的新增判断");
        const repairPrompt = [
          prompt,
          "",
          `上一版未通过 Harness 检查：${qualityIssues.join("；")}`,
          `上一版正文：${rendered.content}`,
          "请重新写 content 和 deliveredContribution。保留同一个人物立场和 Director 任务，但换一个起点与句法；删除重复复述，并确保新增内容在第一句就出现。deliveredContribution 只能概括正文实际已经说出的新判断，不能比正文多走一步。若任务要求行动，必须写清做什么和留下什么；若任务不要求行动，就不要夹带计划。",
          needsActionBridge
            ? "这一版是行动型承接失败：第一句先用这位人物自己的判断推进前文，不要以“打开、写下、列出、发布”等动作开头；第二句再给一个动作。不要套用“我同意/正如刚才说”的连接词，也不要复述前文原句。"
            : "",
          needsVisibleContribution
            ? "这一版的正文与 deliveredContribution 脱节：请把 deliveredContribution 中最关键的新判断真正写入 content；若正文只保留一个问题或动作，就把 deliveredContribution 缩小到那个问题或动作。"
            : ""
        ].join("\n");
        try {
          const repaired = await generateJson<AssignedPioneerTurnDraft>(
            `pioneer_${pioneer.id.replaceAll("-", "_")}_repair`,
            assignedPioneerTurnSchema,
            repairPrompt
          );
          const repairedRendered = renderAssignedPioneerTurn(
            repaired.data,
            resolvedAssignment,
            pioneer,
            bannedQuoteTexts
          );
          const repairedIssues = assignedTurnIssues(
            repairedRendered,
            resolvedAssignment,
            pioneer,
            priorPioneerContents,
            session.question,
            moderatorAnalysis
          );
          if (repairedIssues.length <= bestIssues.length) {
            bestRendered = repairedRendered;
            bestIssues = repairedIssues;
          }
        } catch {
          // The first valid turn is still safer than dropping the entire stage.
        }
      }
      if (bestIssues.length && hasHardTurnIssue(bestIssues)) {
        return {
          ...result,
          data: fallbackPioneerSpeech(session, pioneer, sourceNotes, resolvedAssignment),
          usedGuardRepair: true as const,
          guardIssues: bestIssues
        };
      }
      return {
        ...result,
        data: bestIssues.some((issue) => issue.startsWith("摘句重复了"))
          ? { ...bestRendered, quote: "" }
          : bestRendered,
        guardIssues: bestIssues
      };
    } catch (error) {
      return {
        data: fallbackPioneerSpeech(session, pioneer, sourceNotes, resolvedAssignment),
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async discussion(
    session: RoundtableSession,
    plan: DiscussionPlan,
    messages: RoundtableMessage[] = []
  ) {
    if (plan.mode === "skip" || !plan.speakerIds.length) {
      return { data: { turns: [], synthesis: "" }, usedFallback: true as const, fallbackReason: "discussion_skipped" };
    }
    const active = activeRoundtableMessages(messages);
    const sourceById = new Map(active.map((message) => [message.id, message]));
    const selected = plan.speakerIds
      .map((speakerId) => pioneerById.get(speakerId))
      .filter((pioneer): pioneer is PioneerProfile => Boolean(pioneer));
    if (!selected.length) {
      return { data: { turns: [], synthesis: "" }, usedFallback: true as const, fallbackReason: "missing_speakers" };
    }
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["turns", "synthesis"],
      properties: {
        turns: {
          type: "array",
          minItems: selected.length,
          maxItems: selected.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["speakerId", "content", "referencedMessageIds", "newContribution"],
            properties: {
              speakerId: { type: "string", enum: selected.map((pioneer) => pioneer.id) },
              content: { type: "string" },
              referencedMessageIds: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: { type: "string", enum: active.map((message) => message.id) }
              },
              newContribution: { type: "string" }
            }
          }
        },
        synthesis: { type: "string" }
      }
    };
    const modeInstruction: Record<Exclude<DiscussionPlan["mode"], "skip">, string> = {
      crossfire: "两位只讨论同一个真实优先级分歧。第二位可以明确反对，但只能反对第一位实际说过的观点。",
      sequence: "两位按先后递进。后一位说明前一步完成后怎样推进，不制造反对。",
      complement: "两位从不同方面补全同一个判断。各自增加一项独立信息，不重复。",
      clarify: "围绕一个模糊概念或判断标准澄清。可以用问题推进，不制造结论。"
    };
    const prompt = [
      "请生成圆桌第一轮之后的一小段讨论。",
      `用户原问题：${session.question}`,
      `本轮模式：${plan.mode}（${plan.label}）`,
      `本轮焦点：${plan.focus}`,
      modeInstruction[plan.mode as Exclude<DiscussionPlan["mode"], "skip">],
      "本场有效消息：",
      buildHarvestTranscript(active, new Map(active.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))),
      "本轮发言者：",
      selected.map(describePioneer).join("\n\n"),
      "规则：",
      "- 每位只说 35-90 个中文字，可以承接多个前文，但 primaryMessageIds 中对应的消息必须是主要依据。",
      "- referencedMessageIds 只能填写确实在正文中被承接的真实消息。不能把甲的观点归给乙，也不能发明对方立场。",
      "- 第一人称口吻不等于每句以“我”开头。可以直接提问或判断；保留“我不同意、我的判断是、我更在意”等有意义的立场表达，删除“我会先问、我来提供一个角度”等空壳开场。",
      "- 每位必须带来 newContribution，不能重复自己此前任何一轮的原句或核心结论。",
      "- 不能把前文的一次观察改成连续三天、七天就当作新贡献；新增时间长度不等于新增判断。",
      "- 不复述另一位的关键词、分类或意象来表示承接。先说自己的新判断，必要时只用一个短语指出它回应了哪条前文。",
      "- 不得引入用户和有效消息中没有出现的亏欠、失约、创伤、哀悼、羞耻、债务或隐藏动机。",
      session.deniedAssumptions?.length ? `- 用户已经否认这些前提，任何形式都不能继续使用：${session.deniedAssumptions.join("、")}` : "",
      "- synthesis 只在需要留下一个清晰判断条件或未决问题时写 25-60 字；若两位的推进已经自然完整，返回空字符串，不必让主持人重复总结。"
    ].join("\n");

    const render = (draft: DiscussionDraft) => ({
      turns: plan.speakerIds
        .map((speakerId) => draft.turns.find((turn) => turn.speakerId === speakerId))
        .filter((turn): turn is DiscussionDraft["turns"][number] => Boolean(turn))
        .map((turn) => {
          const content = guardPioneerContent(turn.content, 124, "我的判断是：", 60);
          return {
            ...turn,
            content,
            segments: segmentTurnContent(content),
            referencedMessageIds: turn.referencedMessageIds.filter((id) => sourceById.has(id)).slice(0, 3),
            newContribution: compactText(turn.newContribution, 48)
          };
        }),
      synthesis: compactText(softenUnsupportedInference(draft.synthesis || ""), 64)
    });

    try {
      const result = await generateJson<DiscussionDraft>("roundtable_discussion", schema, prompt);
      let rendered = render(result.data);
      let issues = discussionQualityIssues(session, plan, rendered.turns, rendered.synthesis, active);
      if (issues.length) {
        try {
          const repaired = await generateJson<DiscussionDraft>(
            "roundtable_discussion_repair",
            schema,
            [
              prompt,
              `上一版未通过检查：${issues.join("；")}`,
              `上一版：${JSON.stringify(rendered)}`,
              "请重新生成。删除无依据前提和重复内容，只承接真实消息；若没有真实冲突，不得写成反对。"
            ].join("\n")
          );
          rendered = render(repaired.data);
          issues = discussionQualityIssues(session, plan, rendered.turns, rendered.synthesis, active);
        } catch {
          // Fall through to the safe skip below.
        }
      }
      if (issues.length || rendered.turns.length !== selected.length) {
        return {
          data: { turns: [], synthesis: "" },
          usedFallback: true as const,
          usedGuardRepair: true as const,
          fallbackReason: "discussion_quality_rejected",
          guardIssues: issues
        };
      }
      return { ...result, data: rendered, guardIssues: issues };
    } catch (error) {
      return {
        data: { turns: [], synthesis: "" },
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async crossfire(
    session: RoundtableSession,
    first: PioneerProfile,
    second: PioneerProfile,
    tension: string,
    messages: RoundtableMessage[] = []
  ) {
    if (isUnknownCauseMode(session)) {
      return {
        data: fallbackCrossfire(session, first, second, tension),
        usedGuardRepair: true as const,
        guardIssues: ["原因未知模式：交锋只比较记录线索与减少干扰"]
      };
    }
    const firstPrior = messages.find(
      (message) => message.speakerId === first.id && message.stage === "first_round"
    )?.content;
    const secondPrior = messages.find(
      (message) => message.speakerId === second.id && message.stage === "first_round"
    )?.content;
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["first", "second", "synthesis"],
      properties: {
        first: {
          type: "object",
          additionalProperties: false,
          required: ["priority", "otherPathCost", "content"],
          properties: {
            priority: { type: "string" },
            otherPathCost: { type: "string" },
            content: { type: "string" }
          }
        },
        second: {
          type: "object",
          additionalProperties: false,
          required: ["priority", "otherPathCost", "content"],
          properties: {
            priority: { type: "string" },
            otherPathCost: { type: "string" },
            content: { type: "string" }
          }
        },
        synthesis: {
          type: "object",
          additionalProperties: false,
          required: ["difference", "condition", "content"],
          properties: {
            difference: { type: "string" },
            condition: { type: "string" },
            content: { type: "string" }
          }
        }
      }
    };
    const prompt = [
      "请生成温和交锋，不是吵架。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `价值张力：${tension}`,
      supportModeInstruction({ mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms }),
      `第一位：${describePioneer(first)}`,
      `第二位：${describePioneer(second)}`,
      `第一位此前判断：${firstPrior ?? "无"}`,
      `第二位此前判断：${secondPrior ?? "无"}`,
      "此前圆桌发言：",
      buildHarvestTranscript(
        messages,
        new Map(messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ),
      "要求：只争论“用户现在应该先做什么”。first.priority 写第一位的优先方案，first.otherPathCost 写第二位方案先做的直接代价；second 同理。两位都必须带入本题中的一个具体对象，不能只写人物设定。",
      "first.content 和 second.content 分别把 priority 与 otherPathCost 写成 38-64 个中文字的第一人称自然发言。第二位要明确不同意前一位的优先级；不复述第一轮，不使用“我同意，但”式假交锋；不用“情绪劳动、基线评分、内在空间被侵占”等术语；每一句都必须说完整。",
      "synthesis.difference 用一句话说清真正分歧；synthesis.condition 必须使用“如果/若……就……”写出可观察的选择条件，不以焦虑大小或直觉作为唯一标准；synthesis.content 将两者写成 38-64 字的主持人收束，不判谁赢，不逐人复述。",
      isUnknownCauseMode(session)
        ? "本题原因未知：两位只能争论先记录身体线索还是先减少外界干扰；不得把沉重解释为未表达的情绪、空间不足或任何象征，不连续使用文学意象。"
        : ""
    ].join("\n");

    try {
      const result = await generateJson<CrossfireDraft>("roundtable_crossfire", schema, prompt);
      let rendered = {
        first: renderCrossfireSide(result.data.first, first),
        second: renderCrossfireSide(result.data.second, second),
        synthesis: renderCrossfireSynthesis(result.data.synthesis)
      };
      let qualityIssues = crossfireQualityIssues(
        rendered.first,
        rendered.second,
        rendered.synthesis,
        firstPrior,
        secondPrior,
        session.question
      );
      if (qualityIssues.length) {
        try {
          const repaired = await generateJson<CrossfireDraft>(
            "roundtable_crossfire_repair",
            schema,
            [
              prompt,
              "",
              `上一版未通过 Harness 检查：${qualityIssues.join("；")}`,
              `上一版：${JSON.stringify(rendered)}`,
              "请重写三段。两位必须争同一个“先做什么”，各自说清另一条路径先做的现实代价；主持人必须用“如果/若……就……”给出选择条件。"
            ].join("\n")
          );
          rendered = {
            first: renderCrossfireSide(repaired.data.first, first),
            second: renderCrossfireSide(repaired.data.second, second),
            synthesis: renderCrossfireSynthesis(repaired.data.synthesis)
          };
          qualityIssues = crossfireQualityIssues(
            rendered.first,
            rendered.second,
            rendered.synthesis,
            firstPrior,
            secondPrior,
            session.question
          );
        } catch {
          // Keep the first valid JSON and let the deterministic fallback handle quality below.
        }
      }
      if (qualityIssues.length) {
        return {
          data: fallbackCrossfire(session, first, second, tension),
          usedFallback: false as const,
          usedGuardRepair: true as const
        };
      }
      return {
        ...result,
        data: rendered
      };
    } catch (error) {
      return {
        data: fallbackCrossfire(session, first, second, tension),
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async correctMisreading(
    session: RoundtableSession,
    pioneer: PioneerProfile,
    followUpQuestion: string,
    challengedTerm: string | undefined,
    messages: RoundtableMessage[] = []
  ) {
    const active = activeRoundtableMessages(messages);
    const offending = challengedTerm
      ? [...active]
          .reverse()
          .find((message) => message.role !== "user" && message.content.includes(challengedTerm))
      : undefined;
    const term = challengedTerm || "刚才的判断";
    const fallbackContent = challengedTerm
      ? `你说得对，是我把你的话误读成了“${challengedTerm}”。这个判断没有来自你的原话，我先撤回。回到你实际说的处境，你此刻最想先分清的是哪一处？`
      : "你说得对，刚才是我理解偏了。我先撤回那个判断，不替你的话补充含义。我们回到你实际说出的内容：你最想先谈清哪一处？";
    const prompt = [
      "用户正在纠正先行者对她的误读。请用该先行者的第一人称口吻完成一次简短修正。",
      `用户原问题：${session.question}`,
      `用户纠正：${followUpQuestion}`,
      `被质疑的词或前提：${term}`,
      `需要撤回的原发言：${offending?.content ?? "没有定位到具体句子，仍需承认理解偏差"}`,
      `先行者：${describePioneer(pioneer)}`,
      "要求：第一句明确承认误读；第二句撤回没有依据的前提；第三句用普通中文回到用户实际说过的内容；最后用一个不带新前提的简短问题，邀请用户决定下一步先谈哪一处。不要把用户原话整段复述。55-110 个中文字。",
      "不得解释为什么原误读其实仍然成立；不得使用“但当你……其实已经……”等辩护句式；被用户否认的词只可在承认撤回时出现一次，之后不再延伸。"
    ].join("\n");
    try {
      const result = await generateJson<{ content: string; quote: string }>(
        `correction_${pioneer.id.replaceAll("-", "_")}`,
        textWithQuoteSchema,
        prompt
      );
      const content = guardPioneerContent(result.data.content, 116, "是我理解偏了：", 60);
      const invalid =
        !/(你说得对|是我|我把|我理解偏|我误读)/.test(content) ||
        !/(撤回|没有来自你的原话|不该替你)/.test(content) ||
        /(但当你|其实已经|仍然说明|仍旧说明)/.test(content) ||
        (challengedTerm ? (content.match(new RegExp(challengedTerm, "g")) ?? []).length > 1 : false);
      const safeContent = invalid ? fallbackContent : content;
      return {
        ...result,
        data: {
          content: safeContent,
          segments: segmentTurnContent(safeContent),
          quote: "",
          deliveredContribution: "承认并撤回无依据的误读"
        },
        retractedMessageIds: offending ? [offending.id] : [],
        usedGuardRepair: invalid || undefined
      };
    } catch (error) {
      return {
        data: {
          content: fallbackContent,
          segments: segmentTurnContent(fallbackContent),
          quote: "",
          deliveredContribution: "承认并撤回无依据的误读"
        },
        retractedMessageIds: offending ? [offending.id] : [],
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async followUp(
    session: RoundtableSession,
    pioneer: PioneerProfile,
    followUpQuestion: string,
    sourceNotes: SourceNote[],
    messages: RoundtableMessage[] = [],
    intent: UserTurnIntent = "question",
    assignmentOverride?: ConversationAssignment
  ) {
    const assignment = assignmentOverride ?? followUpAssignment(pioneer, followUpQuestion);
    const turnSupportContext = resolveTurnSupportContext(session, followUpQuestion);
    const turnSession: RoundtableSession = {
      ...session,
      supportMode: turnSupportContext.mode,
      explicitEmotionTerms: turnSupportContext.explicitEmotionTerms
    };
    const activeMessages = activeRoundtableMessages(messages);
    const priorPioneerMessages = activeMessages.filter((message) => message.role === "pioneer");
    const sameSpeakerHistory = priorPioneerMessages.filter((message) => message.speakerId === pioneer.id);
    const latestUserIndex = activeMessages.findLastIndex((message) => message.role === "user");
    const currentFollowUpPeers = activeMessages
      .slice(latestUserIndex + 1)
      .filter((message) => message.role === "pioneer" && message.speakerId !== pioneer.id);
    const comparisonContents = [
      ...sameSpeakerHistory.map((message) => message.content),
      ...currentFollowUpPeers.map((message) => message.content)
    ];
    const prompt = [
      "请生成用户追问后的单人回应。",
      `原始问题：${session.question}`,
      `用户追问：${followUpQuestion}`,
      `用户本轮意图：${intent}`,
      `主题：${session.theme}`,
      supportModeInstruction(turnSupportContext),
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "本场此前谈话：",
      buildHarvestTranscript(
        activeMessages,
        new Map(activeMessages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ) || "无",
      "Director 为这次追问分配的任务：",
      `- speechAct：${assignment.speechAct}（${speechActLabels[assignment.speechAct]}）`,
      `- objective：${assignment.objective}`,
      `- 是否给行动：${assignment.actionMode === "offer_one_step" ? "给一个具体动作" : "不夹带行动计划"}`,
      "先回答追问本身，不复述第一轮，也不要再次概括原始问题。content 写成 2-4 句、45-120 个中文字；能简短说清就只说一段，确需展开时在完整句意处自然分成两层，第二层必须带来新的理由、区分或追问；句式服从人物声音，不使用统一的“承接—判断—理由—行动”模板。",
      intent === "commitment" || intent === "closure"
        ? "用户正在确认或收束方向：先支持她已经形成的选择，再向前推进半步，把模糊处限定得更具体；不要重新打开已经讨论过的风险，也不要重复自己的上一轮问题。"
        : "",
      intent === "reflection"
        ? "用户在整理自己的理解：回应她刚形成的认识，只补一个新的区分，不把它误当成求建议。"
        : "",
      intent === "disagreement"
        ? "用户不同意前文：先准确承认分歧，再检查自己的判断依据；不得防御角色立场。"
        : "",
      assignment.actionMode === "offer_one_step"
        ? "行动必须写清使用什么、做什么、留下什么结果。"
        : "只推进理解或判断，不使用“今天写下、列出、记录、完成”等行动指令。",
      pioneer.voiceProfile.imageryBudget === 0
        ? "本轮不用比喻或文学意象，人物特色放在语气和判断方式里。"
        : `本轮最多使用 ${pioneer.voiceProfile.imageryBudget} 个易懂意象；用了以后立即用普通现代中文说清观察标准，不再追加第二层意象。`,
      "deliveredContribution 用 12-36 字说明新增内容；quote 必须是 content 中原样出现的完整短句或分句。禁止无来源地声称“我曾经/我也曾”。"
    ].join("\n");

    try {
      const result = await generateJson<AssignedPioneerTurnDraft>(
        `follow_up_${pioneer.id.replaceAll("-", "_")}`,
        assignedPioneerTurnSchema,
        prompt
      );
      const bannedQuoteTexts = [session.question, followUpQuestion, ...priorPioneerMessages.map((message) => message.content)];
      let rendered = renderAssignedPioneerTurn(result.data, assignment, pioneer, bannedQuoteTexts);
      let qualityIssues = assignedTurnIssues(
        rendered,
        assignment,
        pioneer,
        comparisonContents,
        followUpQuestion
      );
      let bestRendered = rendered;
      let bestIssues = qualityIssues;
      if (qualityIssues.length) {
        try {
          const repaired = await generateJson<AssignedPioneerTurnDraft>(
            `follow_up_${pioneer.id.replaceAll("-", "_")}_repair`,
            assignedPioneerTurnSchema,
            [
              prompt,
              "",
              `上一版未通过 Harness 检查：${qualityIssues.join("；")}`,
              `上一版正文：${rendered.content}`,
              "请直接重写，回答追问并保留人物判断方式；不要复述旧话。"
            ].join("\n")
          );
          const repairedRendered = renderAssignedPioneerTurn(repaired.data, assignment, pioneer, bannedQuoteTexts);
          const repairedIssues = assignedTurnIssues(
            repairedRendered,
            assignment,
            pioneer,
            comparisonContents,
            followUpQuestion
          );
          if (repairedIssues.length <= bestIssues.length) {
            bestRendered = repairedRendered;
            bestIssues = repairedIssues;
          }
        } catch {
          // Use the local fallback below if the repair request also fails.
        }
      }
      if (bestIssues.length && hasHardTurnIssue(bestIssues)) {
        return {
          ...result,
          data: dedupeFollowUpFallback(
            fallbackFollowUp(turnSession, pioneer, followUpQuestion, intent, sourceNotes, assignment),
            sameSpeakerHistory.map((message) => message.content),
            pioneer,
            followUpQuestion,
            assignment
          ),
          assignment,
          usedGuardRepair: true as const,
          guardIssues: bestIssues
        };
      }
      return {
        ...result,
        data: bestIssues.some((issue) => issue.startsWith("摘句重复了"))
          ? { ...bestRendered, quote: "" }
          : bestRendered,
        assignment,
        guardIssues: bestIssues
      };
    } catch (error) {
      return {
        data: dedupeFollowUpFallback(
          fallbackFollowUp(turnSession, pioneer, followUpQuestion, intent, sourceNotes, assignment),
          sameSpeakerHistory.map((message) => message.content),
          pioneer,
          followUpQuestion,
          assignment
        ),
        assignment,
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async finalize(session: RoundtableSession, selected: PioneerProfile[], messages: RoundtableMessage[] = []) {
    messages = activeRoundtableMessages(messages).filter(
      (message) => message.messageKind !== "correction" && message.userTurnIntent !== "user_correction"
    );
    if (isUnknownCauseMode(session)) {
      return {
        data: fallbackFinal(session, selected, messages),
        usedGuardRepair: true as const,
        guardIssues: ["原因未知模式：卡片只保留可观察变化与求助护栏"]
      };
    }
    const closingSourceAliases = selected
      .map((pioneer, index) => {
        const message = [...messages]
          .reverse()
          .find((item) => item.role === "pioneer" && item.speakerId === pioneer.id);
        return message ? { alias: `g${index + 1}`, pioneer, message } : undefined;
      })
      .filter((item): item is { alias: string; pioneer: PioneerProfile; message: RoundtableMessage } => Boolean(item));
    const closingSourceByAlias = new Map(closingSourceAliases.map(({ alias, message }) => [alias, message]));
    const closingSourceByPioneer = new Map(closingSourceAliases.map(({ pioneer, message }) => [pioneer.id, message]));
    const actionSourceMessages = messages.filter(
      (message) => message.role === "pioneer" || message.stage === "synthesis"
    );
    const actionSourceIds = actionSourceMessages.map((message) => message.id);
    const actionSourceAliases = actionSourceMessages.map((message, index) => ({
      alias: `m${index + 1}`,
      message
    }));
    const actionSourceIdByAlias = new Map(
      actionSourceAliases.map(({ alias, message }) => [alias, message.id])
    );
    const actionLead = chooseActionLead(session, selected, messages);
    const actionLeadAlias = actionSourceAliases.find(
      ({ message }) => message.id === actionLead?.message.id
    )?.alias;
    const latestUserTurn = [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.stage === "follow_up");
    const actionCardRequired = [
      "chosenPath",
      "within24h",
      "sevenDayExperiment",
      "thirtyDayPractice",
      "guardrail",
      "evidenceToReview"
    ];
    if (actionSourceIds.length) actionCardRequired.push("sourceMessageIds");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["actionCard", "quoteCards"],
      properties: {
        actionCard: {
          type: "object",
          additionalProperties: false,
          required: actionCardRequired,
          properties: {
            chosenPath: { type: "string" },
            within24h: { type: "string" },
            sevenDayExperiment: { type: "string" },
            thirtyDayPractice: { type: "string" },
            guardrail: { type: "string" },
            evidenceToReview: { type: "string" },
            sourceMessageIds: actionSourceIds.length
              ? {
                  type: "array",
                  minItems: Math.min(2, actionSourceIds.length),
                  maxItems: Math.min(4, actionSourceIds.length),
                  items: { type: "string", enum: actionSourceAliases.map(({ alias }) => alias) }
                }
              : { type: "array", items: { type: "string" } }
          }
        },
        quoteCards: {
          type: "array",
          minItems: selected.length,
          maxItems: selected.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: closingSourceAliases.length
              ? ["quote", "speakerId", "context", "sourceMessageId"]
              : ["quote", "speakerId", "context"],
            properties: {
              quote: { type: "string" },
              speakerId: { type: "string", enum: selected.map((pioneer) => pioneer.id) },
              context: { type: "string" },
              sourceMessageId: closingSourceAliases.length
                ? { type: "string", enum: closingSourceAliases.map(({ alias }) => alias) }
                : { type: "string" }
            }
          }
        }
      }
    };
    const prompt = [
      "请为这场圆桌生成行动卡和金句卡。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      session.userCommitment
        ? `用户在后续谈话中已经形成的方向：${session.userCommitment}。行动卡必须沿这个方向具体化，不得重新打开她已经收束的旧分歧。`
        : "",
      latestUserTurn
        ? `用户最后一次追问或补充：${latestUserTurn.content}。行动卡必须优先回应这一轮已经变化的关注点，不能退回只采用第一轮建议。`
        : "",
      session.deniedAssumptions?.length
        ? `用户已经明确否认的前提：${session.deniedAssumptions.join("、")}。行动卡、赠言和说明中都不得继续使用。`
        : "",
      supportModeInstruction({ mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms }),
      `入席先行者：${selected.map((pioneer) => `${pioneer.figure}（${pioneer.practice}）`).join("；")}`,
      "本轮真实谈话：",
      buildHarvestTranscript(messages, new Map(selected.map((pioneer) => [pioneer.id, pioneer.figure]))),
      "行动卡来源消息（sourceMessageIds 只填写左侧 m 编号，不要复制 UUID）：",
      actionSourceAliases.map(({ alias, message }) => `- ${alias}｜${message.content}`).join("\n") || "无",
      actionLead && actionLeadAlias
        ? `Harness 已决定行动主线：${actionLeadAlias}｜${actionLead.pioneer.figure}。chosenPath 和三段行动必须沿这条主线，sourceMessageIds 第一项必须是 ${actionLeadAlias}，不可自行换人。`
        : "Harness 未指定行动主线，请选择最贴近用户现实问题的一条。",
      "每位先行者本场需要提炼的真实发言（sourceMessageId 只填写左侧 g 编号）：",
      closingSourceAliases.length
        ? closingSourceAliases
            .map(({ alias, pioneer, message }) => `- ${alias}｜${pioneer.id}｜${pioneer.figure}｜${message.content}`)
            .join("\n")
        : "本轮没有可用发言，只能使用角色卡中的价值观生成克制赠言。",
      "要求：先从来源消息里选择一条最适合用户当前处境的主线，sourceMessageIds 的第一个编号就是主线，其余编号只用于补充或收束。chosenPath 用 25-60 字说明本轮先采用谁的哪条判断，以及为什么适合用户现在开始。行动都沿着这条主线递进，不要把不同先行者的练习拼成任务大礼包。",
      "再从有效谈话中找出对这条主线最有力的一项现实风险。它可以来自真实分歧，也可以来自先行者已经说出的投入边界或失败条件；没有分歧时不得虚构反方。guardrail 用 25-70 字写成明确的“如果出现该风险，就缩小、暂停或调整”的条件。sourceMessageIds 至少包含主线发言和风险依据，不增加第二套行动。",
      "24 小时动作 25-58 字，只完成第一次观察或一个普通用户约 10-30 分钟能留下的最小交付，最多两个检查项；必须写清使用什么、记录或完成什么、留下什么可见结果，不能只写“回忆一下、想一想、观察看看”。若主线来源本身已经给出动作，行动卡要沿同一方向换一个更具体的执行粒度来写，不得复制来源中任何连续 8 个字。除非谈话已说明已有明确素材，不要求从零完成整页样稿或完整作品。7 天实验 35-78 字，必须在 24 小时结果上增加比较、反馈或变量测试，不能只是每天重复同一句自问；30 天练习 40-82 字，要把验证结果变成固定节奏、环境边界或决策规则，不能只是把 7 天延长，也不在其中嵌套“若无效就改做另一件事”的备用路径。三阶段必须产生不同层次的结果。副业刚起步时，不擅自要求 30 天内达到某个工资百分比；优先观察作品、询价、付费意愿和时间是否可持续。复盘证据 25-64 字，只列 3 个可观察指标。每项只写一句，使用直接、自然的现代中文，不用“基线评分、情绪劳动、内在空间被侵占”等术语，并返回 2-4 个实际承接的 sourceMessageIds。",
      `为每位入席先行者各生成一张金句卡，共 ${selected.length} 张，不得遗漏或重复人物。quote 是她对自己本场发言核心判断的再次提炼：12-30 个中文字，像临别赠言，第一人称可以省略；不能逐字摘抄原发言，也不能加入原发言没有的新结论。每句最多一个清楚意象，不能把量尺和钟表、里程表和里程碑等不同物象堆在同一句里；不要用“恐惧递来的面具、在寂静里褪尽颜色、灵魂、命运、深渊、彼岸、枷锁”等需要二次解读的修辞。sourceMessageId 必须指向同一位先行者的 g 编号。context 用 20-55 字直白说明这句赠言如何承接她在本场的判断，只能复述她实际提出的观察、判断或行动，不替用户解释原因；不使用“根源、本质、深层恐惧、真正害怕、这说明你、来自你、源于你、是因为你”。不得生成或引用历史名言，历史回声由系统根据这张赠言本身从核验资料库另行匹配。`,
      isUnknownCauseMode(session)
        ? "用户明确不知道原因：chosenPath、行动和金句 context 只能帮助观察出现时间、身体位置、外界干扰与变化，不得写“内在淤塞、等待表达、未被安放”，也不得断言空间或情绪就是原因。"
        : ""
    ].join("\n");

    try {
      const result = await generateJson<{
        actionCard: ActionCardDraft;
        quoteCards: Array<Omit<QuoteCard, "sessionId"> & { sourceMessageId?: string }>;
      }>("roundtable_finalize", schema, prompt);
      let quoteDrafts = result.data.quoteCards;
      const quoteRepairTargets = closingSourceAliases.filter(({ pioneer, message }) =>
        closingQuoteNeedsRepair(quoteDrafts.find((quoteCard) => quoteCard.speakerId === pioneer.id), message)
      );
      if (quoteRepairTargets.length) {
        const quoteRepairSchema = {
          type: "object",
          additionalProperties: false,
          required: ["quoteCards"],
          properties: {
            quoteCards: {
              type: "array",
              minItems: quoteRepairTargets.length,
              maxItems: quoteRepairTargets.length,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["speakerId", "sourceMessageId", "quote", "context"],
                properties: {
                  speakerId: { type: "string", enum: quoteRepairTargets.map(({ pioneer }) => pioneer.id) },
                  sourceMessageId: { type: "string", enum: quoteRepairTargets.map(({ alias }) => alias) },
                  quote: { type: "string" },
                  context: { type: "string" }
                }
              }
            }
          }
        };
        const quoteRepairPrompt = [
          "只重写以下先行者的本场赠言卡。不要改行动卡，也不要补充其他人物。",
          "每句 12-30 个中文字，必须是对同一位先行者来源发言的重新提炼，不得复制来源中任何连续 8 个字；不能加入来源里没有的新结论。句子要直接、可理解，最多一个具象意象。",
          "每张卡的 sourceMessageId 必须保留对应 g 编号；context 用一句普通中文说明它承接了来源中的哪项判断。",
          "待修复来源：",
          ...quoteRepairTargets.map(({ alias, pioneer, message }) =>
            `- ${alias}｜${pioneer.id}｜${pioneer.figure}｜来源：${message.content}｜原赠言：${quoteDrafts.find((card) => card.speakerId === pioneer.id)?.quote ?? "无"}`
          )
        ].join("\n");
        try {
          const repaired = await generateJson<{
            quoteCards: Array<Omit<QuoteCard, "sessionId"> & { sourceMessageId: string }>;
          }>("roundtable_quote_repair", quoteRepairSchema, quoteRepairPrompt);
          const repairedByPioneer = new Map(repaired.data.quoteCards.map((quoteCard) => [quoteCard.speakerId, quoteCard]));
          quoteDrafts = quoteDrafts.map((quoteCard) => {
            const replacement = repairedByPioneer.get(quoteCard.speakerId);
            const target = quoteRepairTargets.find(({ pioneer }) => pioneer.id === quoteCard.speakerId);
            return replacement && target?.alias === replacement.sourceMessageId ? replacement : quoteCard;
          });
        } catch {
          // Keep the deterministic source-derived fallback if the focused repair request fails.
        }
      }
      const draftedByPioneer = new Map(
        quoteDrafts.map((quoteCard) => [quoteCard.speakerId, quoteCard])
      );
      let quoteCards = selected.map((pioneer) => {
        const draft = draftedByPioneer.get(pioneer.id);
        const requestedSource = draft?.sourceMessageId
          ? closingSourceByAlias.get(draft.sourceMessageId)
          : undefined;
        const source = requestedSource?.speakerId === pioneer.id
          ? requestedSource
          : closingSourceByPioneer.get(pioneer.id);
        return renderClosingCard(session, pioneer, source, draft);
      });
      const quoteMotifs = ["尺子", "标尺", "刻度", "镜子", "房间", "空间", "边界", "证据", "记录", "结构", "筹码", "秩序", "雨", "声音", "漩涡"];
      quoteCards = quoteCards.map((card, index, cards) => {
        const repeatedMotif = quoteMotifs.some(
          (motif) =>
            !session.question.includes(motif) &&
            card.quote.includes(motif) &&
            cards.slice(0, index).some((previous) => previous.quote.includes(motif))
        );
        if (!repeatedMotif) return card;
        const pioneer = selected.find((item) => item.id === card.speakerId);
        return pioneer
          ? renderClosingCard(session, pioneer, closingSourceByPioneer.get(pioneer.id))
          : card;
      });
      quoteCards = dedupeClosingQuotes(quoteCards, selected, session);
      const groundedActionSourceIds = (result.data.actionCard.sourceMessageIds ?? [])
        .map((alias) => actionSourceIdByAlias.get(alias))
        .filter((id): id is string => Boolean(id));
      if (actionLead && !groundedActionSourceIds.includes(actionLead.message.id)) {
        groundedActionSourceIds.unshift(actionLead.message.id);
      }
      const proposedActionMessages = actionSourceMessages.filter(
        (message) => message.speechAct === "propose_action"
      );
      if (actionLead?.message.stage !== "follow_up") {
        for (const message of proposedActionMessages) {
          if (!groundedActionSourceIds.includes(message.id)) groundedActionSourceIds.push(message.id);
        }
      }
      if (actionSourceIds.length >= 2 && groundedActionSourceIds.length < 2) {
        throw new Error("Action card is not grounded in enough roundtable messages");
      }
      const actionCard = renderActionCard(session.id, {
        ...result.data.actionCard,
        chosenPath:
          actionLead && !result.data.actionCard.chosenPath.includes(actionLead.pioneer.figure)
            ? `本轮先沿${actionLead.pioneer.figure}的判断推进：${result.data.actionCard.chosenPath}`
            : result.data.actionCard.chosenPath,
        sourceMessageIds: groundedActionSourceIds.slice(0, 4)
      });
      const finalGuardIssues = [
        actionCard.chosenPath,
        actionCard.within24h,
        actionCard.sevenDayExperiment,
        actionCard.thirtyDayPractice,
        actionCard.guardrail,
        actionCard.evidenceToReview,
        ...quoteCards.flatMap((card) => [card.quote, card.context])
      ].flatMap((content) =>
        findUnknownCauseIssues(content, session.question, {
          mode: session.supportMode,
          explicitEmotionTerms: session.explicitEmotionTerms
        })
      );
      for (const denied of session.deniedAssumptions ?? []) {
        if (
          [
            actionCard.chosenPath,
            actionCard.within24h,
            actionCard.sevenDayExperiment,
            actionCard.thirtyDayPractice,
            actionCard.guardrail,
            actionCard.evidenceToReview,
            ...quoteCards.flatMap((card) => [card.quote, card.context])
          ].some((content) => content.includes(denied))
        ) {
          finalGuardIssues.push(`最终卡片延续了用户已否认的前提：${denied}`);
        }
      }
      if (finalGuardIssues.length) {
        return {
          ...result,
          data: fallbackFinal(session, selected, messages),
          usedGuardRepair: true as const,
          guardIssues: [...new Set(finalGuardIssues)]
        };
      }
      return {
        data: {
          actionCard,
          quoteCards
        },
        usedFallback: false as const
      };
    } catch (error) {
      return {
        data: fallbackFinal(session, selected, messages),
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }
}
