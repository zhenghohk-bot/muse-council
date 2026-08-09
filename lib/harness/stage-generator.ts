import { pioneerById } from "@/data/pioneers";
import { matchHistoricalEcho } from "@/data/historical-echoes";
import { buildHarvestTranscript, describePioneer } from "@/lib/harness/context-builder";
import { generateJson } from "@/lib/harness/openai-client";
import { selectPioneerFallbackMove } from "@/lib/harness/pioneer-mind";
import {
  classifyQuestionIntent,
  isExpressionSkillQuestion,
  questionIntentInstruction,
  questionTaskFrame
} from "@/lib/harness/question-intent";
import {
  classifySupportContext,
  isUnknownCauseMode,
  resolveTurnSupportContext,
  supportModeInstruction
} from "@/lib/harness/support-mode";
import {
  buildLanguageRepairPrompt,
  checkFactBoundary,
  checkHostOpening,
  checkLanguage,
  checkListenerFraming,
  describeLanguageIssues
} from "@/lib/harness/language-editor";
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

function sharedTaskFrame(session: RoundtableSession) {
  return questionTaskFrame(session.question);
}

// InternalTension：仅供 Director 分配任务使用。
// 它是 Harness 的内部建模字段，不是用户说过的话，因此不得由主持人当成用户意图复述。
function internalTension(session: RoundtableSession) {
  return isExpressionSkillQuestion(session.question)
    ? "信息完整、重点清楚和听者理解之间的取舍"
    : session.tension;
}

// 检测主持人是否把内部 tension 当成用户意图说出来。
// 判据是「取舍框架句式 + 用户原句里并不存在这些名词」，不针对任何具体题目。
export function tensionLeakedIntoOpening(content: string, session: RoundtableSession) {
  const tradeoffFrame = /(?:在|于)[^。；]{4,40}(?:之间|中间)[^。；]{0,8}(?:取舍|平衡|拉扯|权衡|抉择)/.test(content);
  if (!tradeoffFrame) return false;
  const tensionNouns = internalTension(session)
    .split(/[、，,和与]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  // 只有当这些张力名词确实不在用户原句里时，才算替用户发明了取舍框架。
  return tensionNouns.some((noun) => content.includes(noun) && !session.question.includes(noun));
}

function expressionRoleInstruction(pioneer: PioneerProfile, session: RoundtableSession) {
  if (!isExpressionSkillQuestion(session.question)) return "";
  if (pioneer.id === "li-qingzhao") {
    return "表达训练中的角色边界：你负责辨认核心句、必要信息和可删内容。不要替用户补写紧张、压抑或害怕被误解，也不要把认真准备说成表达沉重的原因。";
  }
  if (pioneer.id === "jane-austen") {
    return "表达训练中的角色边界：你负责判断听者此刻最需要先听懂什么，以及哪些背景需要现在说明。用“听懂、理解、需要补充”这类自然说法；不要写成“从话里拿走什么”“对方要用哪一样”等产品术语。不要接管阿达的练习循环，也不要把表达训练改写成关系交换、迎合、自尊或获取认可。";
  }
  if (pioneer.id === "ada-lovelace") {
    return "表达训练中的角色边界：你负责把练习拆成可执行、可比较、可修改的步骤。反馈是帮助用户发现下一处修改，不是把判断责任分给谁；不要写“把判断责任推给听者”等责备式句子。不要接管简对听者需要的判断，也不要反复套用“同一场景、一次输出、一项反馈”的固定口号；动作必须随用户本轮追问变化。";
  }
  return "";
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
  if (isExpressionSkillQuestion(session.question)) {
    return [
      "主题：表达训练",
      "核心张力：信息完整、重点清楚和听者理解之间的取舍",
      "当前需要：明确具体场景、核心信息和听者需要，再用反馈修改下一版",
      "边界：不补写害怕评价、坦白内心、关系交换或公开发布等用户没有提出的主题"
    ].join("\n");
  }
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
  maxChars = 220
) {
  let rawContent = draft.content;
  if (assignment.actionMode === "offer_one_step" && rawContent.length > maxChars) {
    const sentences = rawContent.match(/[^。！？]+[。！？]?/g) ?? [rawContent];
    if (sentences.length > 2) rawContent = `${sentences[0]}${sentences.at(-1)}`;
  }
  const content = guardPioneerContent(rawContent, maxChars, "", 72, false);
  return {
    content,
    segments: segmentTurnContent(content, 108),
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
  moderatorAnalysis = "",
  session?: Pick<RoundtableSession, "question" | "explicitEmotionTerms">
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
  issues.push(...findClarityIssues(turn.content, 220, 72));
  issues.push(...findSegmentIssues(turn.segments, turn.content, 108));
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
    if (turn.content.length > 190) {
      issues.push("李清照本轮过长，文学表达开始挤占判断本身");
    }
  }
  // 听者框定失败改由 Language Editor 按句式判断，不再绑定人物 id 与单一措辞。
  // 保留为硬问题：这类表达跨人物、跨题型都不可接受。
  issues.push(...describeLanguageIssues(checkListenerFraming(turn.content)));
  // Language Editor：语法、自然度、事实边界与承接质量。
  // 这一层跨人物、跨题型统一生效，替代逐条追加人物专属禁用词。
  if (session) {
    issues.push(
      ...describeLanguageIssues(
        checkLanguage(turn.content, session, previousContents, assignment.relation === "open")
      )
    );
  }
  return [...new Set(issues)];
}

function hasHardTurnIssue(issues: string[]) {
  return issues.some((issue) =>
    /^(?:与前文重复了|整体内容与前文相似|与主持人读题摘要.*(?:相似|重复)|正文新增了用户没有表达的前提|正文新增了用户没有表达的感受或前提|情绪命名新增了用户没有表达的心理主题|本轮任务不应给行动|行动没有同时说清|行动只说了|正文包含无来源人物经历|正文包含无来源的人物经历|原因未知时|用户明确说原因不明|包含替用户下结论|用猜测替换了用户|用对比句替用户|把用户明确说出的羞耻|把听者理解写成了从话里取走某件东西|把理解或反馈写成了对听者的责任归属)/.test(
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
  return sourceNotes
    .map((note) => {
      const grounding = [
        note.sourceKind ? `性质：${note.sourceKind}` : "",
        note.work ? `作品：${note.work}` : "",
        note.locator ? `位置：${note.locator}` : "",
        note.confidence ? `置信：${note.confidence}` : ""
      ]
        .filter(Boolean)
        .join("；");
      const prohibited = note.prohibitedUses?.length ? ` 禁止：${note.prohibitedUses.join("；")}` : "";
      return `- ${note.id}｜${note.title}：${note.note} 用法：${note.usageHint}${grounding ? ` ${grounding}` : ""}${prohibited}`;
    })
    .join("\n");
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

function expressionFallbackMove(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  assignment: ConversationAssignment
) {
  if (!isExpressionSkillQuestion(session.question)) return undefined;
  const context = session.question;
  const asksHowToJudge = /(?:怎么|如何|怎样)判断|如何知道|怎么知道|是否.*还是|哪一版/.test(context);
  const asksHowToPractice = /(?:怎么|如何|怎样)(?:练|锻炼|练习|准备|改进|提升|开始|做)|具体.*(?:练|做)|下一次/.test(
    context
  );

  if (pioneer.id === "li-qingzhao") {
    return {
      judgment:
        "先找出这次最想让对方听懂的那句话。若背景和解释太多，重点容易被盖住；若信息不够，再补理解它所必需的部分。",
      question: asksHowToJudge ? "删减后，核心意思是否仍然准确？" : "这次最不能被误解的是哪一句？",
      action:
        "先写一句核心观点，再只保留两条必要补充；朗读一遍，删掉没有帮助核心观点的内容。"
    };
  }

  if (pioneer.id === "jane-austen") {
    return {
      judgment:
        "先确认听者最需要听懂什么：结论、原因，还是下一步。目标不同，重点和顺序也会不同。",
      question: asksHowToJudge ? "对方最先听懂的重点，与你原本想表达的一致吗？" : "对方最需要先听明白哪一点？",
      action:
        "表达前先写下“我希望对方先听懂什么”，说完后再看哪些背景仍需补充。"
    };
  }

  if (pioneer.id === "ada-lovelace") {
    const isPresentation = /(汇报|演讲|会议|答辩|发言)/.test(context);
    const isConversation = /(聊天|沟通|对话|交流|当面说)/.test(context);
    const isPreparation = /(准备|组织|材料|内容太多|重点)/.test(context);
    if (asksHowToJudge) {
      return {
        judgment:
          "判断重点是否清楚，可以同时看两件事：对方最先理解到什么，以及哪些地方仍需要补充。",
        question: "如果对方理解的重点与你不同，是信息顺序需要调整，还是必要背景还不够？",
        action:
          "先说明“我在练习把话说清楚”，再礼貌问对方最先听懂了什么、哪里还需要补充；根据回答只改一处。"
      };
    }
    if (asksHowToPractice || assignment.actionMode === "offer_one_step") {
      if (isPresentation) {
        return {
          judgment:
            "汇报练习先固定一次真实任务：听者需要知道什么、据此做什么。每次只检查重点、依据和下一步是否连得起来。",
          question: "这次汇报结束后，你希望听者记住什么，又准备做什么？",
          action:
            "选一段近期汇报，先写结论、两条必要依据和下一步；讲完后请一位听者指出最清楚和最需补充的各一处。"
        };
      }
      if (isConversation) {
        return {
          judgment:
            "日常沟通不必一次说完所有背景。先让对方听见这一刻最重要的意思，再根据反应补充。",
          question: "你最常在哪类对话里越说越乱？",
          action:
            "选一次真实对话，开口前只写一句重点；说完后问对方是否需要背景、例子或下一步，只补她真正需要的一项。"
        };
      }
      if (isPreparation) {
        return {
          judgment:
            "准备不是把内容装满，而是提前决定哪些信息帮助重点、哪些可以等对方追问后再补。",
          question: "现有材料里，哪两条信息最直接支持你的核心观点？",
          action:
            "把准备内容分成核心观点、必要依据和备用背景三栏；第一次表达只用前两栏，再根据真实追问调整。"
        };
      }
      return {
        judgment:
          "练习需要固定一个常见场景，每次只改一个环节，才能看出哪种变化真正有用。",
        question: "你最常在哪种场景卡住，又最想先改善哪个环节？",
        action:
          "选一个高频场景，先写一句核心观点和两条必要补充；完成一次表达后，根据对方仍需补充的地方改下一版。"
      };
    }
    return {
      judgment:
        "把表达拆成三步：先确定重点，再组织必要信息，最后用一次真实反馈检查理解是否一致。",
      question: "你最想先改善的是重点、顺序，还是反馈后的修改？",
      action:
        "选一个高频场景完成一次短表达，只改一个环节，并记录修改前后的理解差异。"
    };
  }

  return undefined;
}

export function buildFallbackOpening(
  session: RoundtableSession,
  selected: PioneerProfile[] = [],
  _plan?: ConversationPlan
) {
  const count = selected.length || session.selectedPioneerIds.length || 3;
  const countLabel = ({ 1: "一", 2: "两", 3: "三", 4: "四", 5: "五" } as Record<number, string>)[count] ?? String(count);
  const topic = isExpressionSkillQuestion(session.question) ? "关于表达这件事，" : "";
  return {
    content: `${countLabel}位先行者已经入席。${topic}不妨先听听她们怎么想。`,
    quote: "不妨先听听她们怎么想"
  };
}

function fallbackPioneerSpeech(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  sourceNotes: SourceNote[],
  assignment: ConversationAssignment
) {
  const primary = sourceNotes[0];
  const mindMove = isUnknownCauseMode(session)
    ? undefined
    : expressionFallbackMove(session, pioneer, assignment) ??
      selectPioneerFallbackMove(pioneer, session, assignment);
  const profileFallback = isUnknownCauseMode(session)
    ? unknownCausePerspectiveByPioneer[pioneer.id] ?? pioneer.decisionStyle
    : mindMove?.judgment ?? fallbackPerspectiveByPioneer[pioneer.id] ?? pioneer.decisionStyle;
  const mindQuestion = mindMove?.question
    ? [profileFallback.replace(/[。！？]$/, ""), mindMove.question].filter(Boolean).join("。")
    : profileFallback;
  const mindAction =
    mindMove?.action && mindMove?.judgment
      ? `${mindMove.judgment}${mindMove.action}`
      : mindMove?.action ?? fallbackActionForSession(session, pioneer);
  const contentByAct: Record<ConversationAssignment["speechAct"], string> = {
    name_emotion: `我会先承认这份拉扯：${compactText(session.tension, 34)}。不急着解释它，只看哪一项担心已经有事实依据。`,
    reframe: profileFallback,
    distinguish: profileFallback,
    challenge: profileFallback,
    share_experience: primary
      ? `我想到「${primary.title}」这条经验。${primary.note}`
      : `我会从${pioneer.values[0]}重新看这件事。${pioneer.pushback}`,
    ask_question: mindMove
      ? mindQuestion
      : `如果暂时不按最坏的解释判断，你会怎样重看「${session.theme}」？`,
    propose_action: isUnknownCauseMode(session)
      ? unknownCauseActionByPioneer[pioneer.id] ?? profileFallback
      : mindAction
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
  const asksForAction =
    /怎么办|下一步|先做什么|能做什么|(?:怎么|如何|怎样)(?:练|锻炼|练习|准备|改进|提升|开始|做)/.test(
      question
    );
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

const closureFallbacks: Record<string, string> = {
  "li-qingzhao": "好，先把这句清楚的认识留住。",
  "ban-zhao": "好，先按这一点稳稳做一次。",
  "qin-liangyu": "好，方向清楚了，先守住第一步。",
  "wu-zetian": "好，选择在你手里，先按边界行动。",
  "marie-curie": "好，先用一次结果检验它。",
  "florence-nightingale": "好，先让这一步进入你的日常。",
  "jane-austen": "好，先保留这个由你自己定下的方向。",
  "ada-lovelace": "好，先跑一次最小版本，再看结果。",
  "virginia-woolf": "好，先给这个方向留一点真实的时间。"
};

function fallbackFollowUp(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  question: string,
  intent: UserTurnIntent,
  sourceNotes: SourceNote[],
  assignment: ConversationAssignment
) {
  if (intent === "closure") {
    const content = closureFallbacks[pioneer.id] ?? "好，先把刚才已经清楚的部分留住。";
    return {
      content,
      segments: [content],
      quote: "",
      deliveredContribution: "简短回应用户收束"
    };
  }
  if (intent === "commitment") {
    const content = guardPioneerContent(commitmentFallbacks[pioneer.id] ?? "这个方向已经清楚。把第一步缩到可以完成、可以观察，再用结果决定是否继续。", 110, "我的判断是：", 58);
    return {
      content,
      segments: segmentTurnContent(content),
      quote: distinctGroundedQuote(content, "", assignment.newContribution, [session.question, question]),
      deliveredContribution: "确认用户选择，并把下一步限定得更清楚"
    };
  }
  return fallbackPioneerSpeech(
    { ...session, question: `${session.question}\n用户追问：${question}` },
    pioneer,
    sourceNotes,
    assignment
  );
}

const REPEAT_SIMILARITY = 0.7;

function collidesWithAny(content: string, bannedContents: string[]) {
  const normalized = content.trim();
  if (!normalized) return false;
  return bannedContents.some(
    (prior) =>
      prior.trim() === normalized ||
      textSimilarity(prior, normalized) >= REPEAT_SIMILARITY ||
      // 逐字复读：任何 14 字以上的连续片段完全重合。
      hasVerbatimOverlap(prior, normalized, 14)
  );
}

function hasVerbatimOverlap(first: string, second: string, size: number) {
  if (first.length < size || second.length < size) return false;
  for (let start = 0; start + size <= second.length; start += 1) {
    const fragment = second.slice(start, start + size);
    if (/[，。；：！？\s]/.test(fragment)) continue;
    if (first.includes(fragment)) return true;
  }
  return false;
}

/**
 * fallback 二次去重。
 *
 * 覆盖四个范围（交接文档 3.4）：当前人物历史发言、其他人物本场发言、
 * 主持人分析与开场、以及 repair/fallback 替换后的内容本身。
 *
 * 关键点：替换后必须再次检测。此前的实现只做一次比较，
 * 因此可能用另一句同样出现过的固定 fallback 顶替，重复依旧存在。
 */
export function dedupeFallbackTurn<T extends { content: string; segments: string[]; quote: string }>(
  data: T,
  bannedContents: string[],
  pioneer: PioneerProfile,
  session: RoundtableSession,
  question: string,
  assignment: ConversationAssignment
): T {
  const banned = bannedContents.map((content) => content.trim()).filter(Boolean);
  if (!collidesWithAny(data.content, banned)) return data;

  const contextualSession =
    question && question !== session.question
      ? { ...session, question: `${session.question}\n用户追问：${question}` }
      : session;

  // 候选池按人物专属思维动作展开，而不是一句固定台词。
  const moves = [
    expressionFallbackMove(contextualSession, pioneer, assignment),
    selectPioneerFallbackMove(pioneer, contextualSession, assignment),
    ...(pioneer.mind?.fallbackMoves ?? [])
  ].filter((move): move is NonNullable<typeof move> => Boolean(move));

  const candidates: string[] = [];
  for (const move of moves) {
    const tail = assignment.actionMode === "offer_one_step" ? move.action : move.question;
    candidates.push([move.judgment, tail].filter(Boolean).join(" "));
    // 同一动作的另一种组合，用于在第一种仍撞车时继续换角度。
    candidates.push([move.judgment, move.question, move.action].filter(Boolean).join(" "));
    if (move.judgment) candidates.push(move.judgment);
  }
  candidates.push(pioneer.pushback, pioneer.decisionStyle, pioneer.practice);

  for (const candidate of candidates) {
    const pivot = guardPioneerContent(candidate, 220, "", 72, false);
    // 二次校验：替换结果不能再次撞上任何已出现内容。
    if (!pivot || collidesWithAny(pivot, banned)) continue;
    return {
      ...data,
      content: pivot,
      segments: segmentTurnContent(pivot, 108),
      quote: distinctGroundedQuote(pivot, "", assignment.newContribution, [question, ...banned])
    };
  }

  // 所有候选都撞车时，保留原内容并清空摘句，避免再产出一条重复金句。
  return { ...data, quote: "" };
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

const expressionClosingNotes: Record<string, string> = {
  "li-qingzhao": "先让最重要的那句话站在前面。",
  "jane-austen": "先弄清听者需要带走哪一点。",
  "ada-lovelace": "每次只改一个环节，让反馈指出下一步。"
};

const expressionClosingContexts: Record<string, string> = {
  "li-qingzhao": "承接她对核心句、必要信息与删减的判断。",
  "jane-austen": "承接她对听者需要与必要背景的区分。",
  "ada-lovelace": "承接她把表达拆成可反馈练习的做法。"
};

// 历史回声的唯一准入条件：语义高度相关，且来源字段完整。
//
// 这里刻意不按题型短路。此前「表达技能题一律不显示历史回声」属于按类别封杀，
// 会把经核验的《词论》《分析机概论》等原文一起隐藏；相关性判断交给 matchHistoricalEcho
// 的标签评分，来源完整性在此做一次确定性校验，缺来源时宁可留空。
export function resolveHistoricalEcho(
  session: RoundtableSession,
  speakerId: string,
  quote: string,
  context: string,
  unsupportedProjection = false
) {
  // 原因未知模式下，用户明确说不清成因，任何历史原文都可能被读成替她解释原因。
  if (isUnknownCauseMode(session)) return undefined;
  // 赠言本身已经越界（补写了用户未表达的心理主题）时，不再叠加引文放大问题。
  if (unsupportedProjection) return undefined;

  const echo = matchHistoricalEcho(speakerId, `${quote}\n${context}\n${session.question}\n${session.theme}`);
  if (!echo) return undefined;
  // 来源必须可核验：作品名与 HTTPS 来源链接缺一不可。
  if (!echo.work?.trim() || !echo.sourceUrl?.startsWith("https://")) return undefined;
  return echo;
}

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
  const expressionUnsupported =
    isExpressionSkillQuestion(session.question) &&
    /(坦白|内心|害怕评价|不敢示人|关系交换|获取认可|证明自己|自尊|被看见)/.test(
      `${candidate}\n${draft?.context ?? ""}`
    );
  const quoteIsOpaque = isOpaqueClosingQuote(candidate) || expressionUnsupported;
  const quote = candidate && !quoteIsOpaque
    ? candidate
    : (isExpressionSkillQuestion(session.question) ? expressionClosingNotes[pioneer.id] : undefined) ||
      sourceDerivedClosingQuote(source) ||
      fallbackClosingNotes[pioneer.id] ||
      compactText(pioneer.pushback, 30);
  const sourceContext = isExpressionSkillQuestion(session.question)
    ? expressionClosingContexts[pioneer.id] ??
      `${pioneer.figure}根据本场谈话，为「${session.theme}」留下的提醒。`
    : source
      ? `${pioneer.figure}把「${compactText(source.newContribution || source.content, 38)}」收成一句提醒。`
      : `${pioneer.figure}根据本场谈话，为「${session.theme}」留下的提醒。`;
  const context = renderQuoteContext(
    draftIsGrounded && draft?.context?.trim() ? draft.context.trim() : sourceContext,
    pioneer.id,
    session.theme
  );
  // 历史回声只受「语义是否高度相关 + 来源是否完整」约束。
  // 不再按题型（例如表达技能题）整体短路，否则经核验的作品原文会被无故隐藏。
  const historicalEcho = resolveHistoricalEcho(session, pioneer.id, quote, context, expressionUnsupported);
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
      historicalEcho: resolveHistoricalEcho(session, card.speakerId, uniqueQuote, card.context)
    };
  });
}

/**
 * 行动卡溯源：把模型返回的 m 别名解析回真实消息 id，丢弃无法解析的编号。
 * 模型可能返回不存在的别名或直接复制 UUID，这两种都不算真实溯源。
 */
export function resolveActionSourceIds(
  aliases: string[] | undefined,
  aliasToId: ReadonlyMap<string, string>
): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const alias of aliases ?? []) {
    const id = aliasToId.get(alias);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    resolved.push(id);
  }
  return resolved;
}

/**
 * 只要本场存在至少两条可引用消息，行动卡就必须真实承接其中至少两条。
 * 可引用消息不足两条时（例如极短会话）不强制，避免把结构要求变成硬失败。
 */
export function actionCardIsGrounded(availableSourceCount: number, groundedSourceCount: number) {
  return availableSourceCount >= 2 ? groundedSourceCount >= 2 : true;
}

/**
 * 行动卡确定性质检（P0-4）。
 *
 * 每个行动项必须独立回答「做什么、怎么做、如何知道完成或有效」；
 * 五栏前后递进，不是同一个动作换时间重复。只硬判高置信度形态：
 * 空泛动作、缺少可执行动词、同栏多任务、跨栏近义重复、概念转换不成立。
 * 更细的自然度问题交给 repair 指令与质量评测，不在这里堆禁词。
 */
const actionVerbPattern =
  /(写下|写出|记录|记下|列出|画出|标出|整理|发送|完成|发布|制作|填写|删掉|删除|做出|打开|朗读|标记|保留|比较|观察|询问|请|取消|暂停|回看|复盘|练习|讲|说明|读|修改|调整|选择|选定|固定|安排|确定|判断|验证|推进|对照|核对|测试|缩短|减少|留下|算出)/;

const vagueActionPattern = /(回忆一下|想一想|思考一下|感受一下|反思一下|沉淀一下|调整状态|找回自己|建立档案|提升自己)/;

// 概念转换不成立：把一类产物强行配成另一类（选一个词配成判断、把感受换算成分数）。
const forcedConversionPattern = /(配成|换算成|转换成|翻译成)[^。；]{0,10}(判断|结论|分数|答案)/;

export function actionCardQualityIssues(card: Omit<ActionCard, "sessionId" | "sourceMessageIds">) {
  const issues: string[] = [];
  const actionFields: Array<[string, string]> = [
    ["本轮练习路径", card.chosenPath],
    ["24 小时", card.within24h],
    ["7 天实验", card.sevenDayExperiment],
    ["30 天练习", card.thirtyDayPractice]
  ];
  for (const [label, field] of actionFields) {
    if (!field.trim()) {
      issues.push(`${label}为空`);
      continue;
    }
    if (!actionVerbPattern.test(field)) {
      issues.push(
        vagueActionPattern.test(field)
          ? `${label}只有空泛动作，缺少可执行动作和可见结果`
          : `${label}缺少可执行动作`
      );
    }
    const actionSentences = field
      .split(/[。！？]/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence && actionVerbPattern.test(sentence));
    if (actionSentences.length >= 3) issues.push(`${label}一栏塞进了多个任务，超过一个主要动作`);
  }
  for (const field of [
    card.chosenPath,
    card.within24h,
    card.sevenDayExperiment,
    card.thirtyDayPractice,
    card.guardrail,
    card.evidenceToReview
  ]) {
    if (forcedConversionPattern.test(field)) {
      issues.push("行动卡使用了概念转换不成立的动作");
      break;
    }
  }
  const stages: Array<[string, string]> = [
    ["24 小时", card.within24h],
    ["7 天实验", card.sevenDayExperiment],
    ["30 天练习", card.thirtyDayPractice]
  ];
  for (let index = 1; index < stages.length; index += 1) {
    const [priorLabel, prior] = stages[index - 1];
    const [label, current] = stages[index];
    if (textSimilarity(prior, current) >= 0.45) {
      issues.push(`${label}与${priorLabel}近义重复，阶段之间没有递进`);
    } else if (repeatedActionWithoutNewDimension(current, prior)) {
      issues.push(`${label}只是把${priorLabel}的动作延长了时间，没有新增判断维度`);
    }
  }
  return [...new Set(issues)];
}

/**
 * 行动卡降级的单步决策（纯函数，供 finalize 与确定性契约测试共用）。
 *
 * 语义边界：
 * - draft 无问题：原样使用，不触发 repair，也不调用 fallback。
 * - draft 有问题且 repair 已通过重新校验：只替换行动卡。
 * - 否则：只降级为 fallback 行动卡。
 * 无论走哪条分支，赠言卡与历史回声都不在这个函数的作用域内，绝不被重新生成。
 * repair 次数由调用方保证最多一次；本函数自身不含任何重试循环。
 */
export function resolveActionCard(
  draft: ActionCard,
  draftIssues: string[],
  repaired: ActionCard | undefined,
  fallback: () => ActionCard
): {
  actionCard: ActionCard;
  usedRepair: boolean;
  degradedToFallback: boolean;
  issues: string[];
} {
  if (!draftIssues.length) {
    return { actionCard: draft, usedRepair: false, degradedToFallback: false, issues: [] };
  }
  if (repaired) {
    return { actionCard: repaired, usedRepair: true, degradedToFallback: false, issues: draftIssues };
  }
  return { actionCard: fallback(), usedRepair: false, degradedToFallback: true, issues: draftIssues };
}

/** finalize 末端 guard 的上下文：判断事实边界、已否认前提与主题漂移所需的会话信息。 */
export type FinalCardGuardContext = {
  question: string;
  transcriptText: string;
  supportMode: RoundtableSession["supportMode"];
  explicitEmotionTerms: string[];
  deniedAssumptions?: string[];
  expressionSkill: boolean;
};

// 表达训练不得漂移到的主题（未经用户提出的心理或关系框架）。
const expressionDriftPattern = /(坦白|内心|害怕评价|不敢示人|关系交换|获取认可|证明自己|被看见)/;
// 反馈任务不得把听者当考生。「考」必须成词（考试/考问/考考），单字会误伤「思考、参考、考虑」。
const listenerExamPattern = /(?:让|请|要求)[^。；]{0,10}(?:复述|重述|回答|答对|打分|评分|测试|考试|考问|考考)/;

/** 末端 guard 的文本级检查：未知原因、事实边界、已否认前提、表达主题漂移。 */
export function finalCardTextIssues(content: string, context: FinalCardGuardContext) {
  return [
    ...findUnknownCauseIssues(content, context.question, {
      mode: context.supportMode,
      explicitEmotionTerms: context.explicitEmotionTerms
    }),
    ...describeLanguageIssues(
      checkFactBoundary(content, `${context.question}\n${context.transcriptText}`, context.explicitEmotionTerms)
    ),
    ...(context.deniedAssumptions ?? [])
      .filter((denied) => content.includes(denied))
      .map((denied) => `延续了用户已否认的前提：${denied}`),
    ...(context.expressionSkill && expressionDriftPattern.test(content)
      ? ["偏离到未经用户提出的心理或关系主题"]
      : [])
  ];
}

/** 行动卡的末端 guard：六个字段的文本问题 + 不把听者当考生。 */
export function actionCardGuardIssues(
  card: Omit<ActionCard, "sessionId" | "sourceMessageIds">,
  context: FinalCardGuardContext
) {
  const issues = [
    card.chosenPath,
    card.within24h,
    card.sevenDayExperiment,
    card.thirtyDayPractice,
    card.guardrail,
    card.evidenceToReview
  ].flatMap((field) => finalCardTextIssues(field, context));
  if (listenerExamPattern.test(card.evidenceToReview + card.within24h + card.sevenDayExperiment)) {
    issues.push("把听者反馈写成了考试或复述测试");
  }
  return [...new Set(issues)];
}

function quoteCardGuardIssues(card: QuoteCard, context: FinalCardGuardContext) {
  return [...new Set([...finalCardTextIssues(card.quote, context), ...finalCardTextIssues(card.context, context)])];
}

/**
 * 赠言卡的末端 guard：只处理受影响的卡，行动卡与其他合格赠言卡不受影响。
 * 1. 赠言或说明越界：先由 rerender 按来源确定性重提炼；仍越界才移除该卡。
 * 2. 仅历史回声越界：只摘除回声，保留本场赠言。
 */
export function resolveGuardedQuoteCards(
  cards: QuoteCard[],
  context: FinalCardGuardContext,
  rerender: (card: QuoteCard) => QuoteCard | undefined
) {
  const quoteCards: QuoteCard[] = [];
  const notes: string[] = [];
  for (const card of cards) {
    let nextCard = card;
    if (quoteCardGuardIssues(nextCard, context).length) {
      const rerendered = rerender(card);
      if (rerendered && !quoteCardGuardIssues(rerendered, context).length) {
        nextCard = rerendered;
        notes.push(`赠言卡 ${card.speakerId} 越界，已按来源重新提炼`);
      } else {
        notes.push(`赠言卡 ${card.speakerId} 越界且无法按来源重提炼，已移除该卡`);
        continue;
      }
    }
    if (nextCard.historicalEcho) {
      const echoText = `${nextCard.historicalEcho.translatedText ?? ""}\n${nextCard.historicalEcho.originalText}`;
      if (finalCardTextIssues(echoText, context).length) {
        nextCard = { ...nextCard, historicalEcho: undefined };
        notes.push(`赠言卡 ${card.speakerId} 的历史回声越界，已只摘除回声`);
      }
    }
    quoteCards.push(nextCard);
  }
  return { quoteCards, notes };
}

function renderActionCard(sessionId: string, card: ActionCardDraft): ActionCard {
  const balanceQuotes = (content: string) => {
    const left = (content.match(/“/g) ?? []).length;
    const right = (content.match(/”/g) ?? []).length;
    return left > right ? `${content}”` : content;
  };
  // 每一栏只保留一个清楚动作或判断，显著压缩扫描成本（交接文档 3.6）。
  return {
    sessionId,
    chosenPath: balanceQuotes(compactText(softenUnsupportedInference(card.chosenPath), 52)),
    within24h: balanceQuotes(compactText(softenUnsupportedInference(card.within24h), 50)),
    sevenDayExperiment: balanceQuotes(compactText(softenUnsupportedInference(card.sevenDayExperiment), 62)),
    thirtyDayPractice: balanceQuotes(compactText(softenUnsupportedInference(card.thirtyDayPractice), 66)),
    guardrail: balanceQuotes(compactText(softenUnsupportedInference(card.guardrail), 58)),
    evidenceToReview: balanceQuotes(compactText(softenUnsupportedInference(card.evidenceToReview), 54)),
    sourceMessageIds: card.sourceMessageIds?.slice(0, 4)
  };
}

export function fallbackFinal(
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
  const expressionSkill = isExpressionSkillQuestion(session.question);
  return {
    actionCard: renderActionCard(session.id, {
      chosenPath: unknownCause
        ? "本轮先不解释原因，只比较沉重出现的时间、身体位置和外界干扰，让变化成为下一步判断的依据。"
        : expressionSkill
          ? "先确定这次最想让对方听懂的重点，再按听者需要保留必要信息，并用一次反馈修改下一版。"
          : `本轮先沿${lead?.figure ?? "第一位先行者"}的练习推进，因为它最接近你此刻能验证的一步。`,
      within24h: unknownCause
        ? "明早醒来后记录身体最沉的位置、轻重分数和当时是否已看消息，只记录一次，不分析原因。"
        : expressionSkill
          ? "写下一句核心观点和两条必要补充，说完后请对方说说最先听懂什么、哪里还需要补充。"
          : lead?.practice ?? `用 20 分钟完成一个与「${session.theme}」有关的小动作，留下结果。`,
      sevenDayExperiment: unknownCause
        ? "连续七天在同一时间记录这三项，并比较看消息前后是否有稳定差异；没有规律也如实保留。"
        : expressionSkill
          ? "连续 7 天在同一种高频场景练习 3 次，每次只改重点、顺序或必要背景中的一项，并记录对方理解到的重点与仍需补充之处。"
          : "接下来 7 天围绕同一个动作完成 3 次，每次只记录投入、结果和一个需要调整的地方。",
      thirtyDayPractice: unknownCause
        ? "只留下最容易坚持的那一种做法，固定在周末回看一次出现时间和轻重变化，不把单次波动当成结论。"
        : expressionSkill
          ? "未来 30 天每周选一个真实表达场景，固定完成准备、表达和反馈三步；月底回看哪类调整最常让重点更容易被理解。"
          : "未来 30 天每周固定一次执行与复盘，只保留有可观察结果的部分，并逐步缩小无效投入。",
      guardrail: unknownCause
        ? "如果记录让你更难受或明显影响日常生活，就暂停自我分析，并考虑向可信赖的人或专业人士求助。"
        : expressionSkill
          ? "如果对方需要补充，是先判断重点表达有偏差，还是必要背景不足；一次只改一处，不把所有问题都归到自己能力上。"
          : "如果连续 7 天没有留下任何结果，就把动作缩小一半或暂停，不用靠增加任务来证明自己。",
      evidenceToReview: unknownCause
        ? "出现时间、身体位置、轻重分数，以及它们是否在相似条件下重复变化。"
        : expressionSkill
          ? "对方最先理解到的重点、仍需补充的地方，以及修改后两者是否更接近你的原意。"
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
    const fallback = buildFallbackOpening(session, selected, plan);
    const seatedCount = selected.length || session.selectedPioneerIds.length || 3;
    const prompt = [
      "请生成圆桌主持人的自然开场。",
      `用户原话：${session.question}`,
      `入席人数：${seatedCount}`,
      "要求：",
      "- 1-2 句自然中文。先简短确认先行者已经入席，再邀请用户听听她们怎么想。",
      "- 不逐位报姓名，不介绍分工或观察角度，不写“某某看”“负责”“会帮你”“将从”。",
      "- 只有主题能从用户原话直接读出时，才可写“关于 X 这件事”；不补写用户没说的意图、感受或问题框架。",
      "- 不声称人物经历过相似处境，不给建议，不解释产品机制。",
      `可参考但不要机械照抄：${fallback.content}`,
      "输出 content 和 8-20 字 quote。"
    ].join("\n");

    try {
      const result = await generateJson<{ content: string; quote: string }>("roundtable_opening", textWithQuoteSchema, prompt);
      const content = compactText(breakLongSentences(softenUnsupportedInference(result.data.content)), 90);
      const inventedEmotion =
        !session.explicitEmotionTerms.length &&
        /(紧张|害怕|羞耻|失落|悲伤|焦虑|不安|迷雾|拉扯)/.test(content);
      // InternalTension 泄漏：主持人把 Harness 的内部张力模型当成用户意图复述。
      const leakedInternalTension = tensionLeakedIntoOpening(content, session);
      const guardIssues = [
        ...findUnknownCauseIssues(content, session.question),
        ...(inventedEmotion ? ["主持人为未表达情绪的任务题补写了感受"] : []),
        ...(leakedInternalTension ? ["主持人把内部张力模型当成用户意图复述"] : []),
        ...describeLanguageIssues(checkHostOpening(content, selected.map((pioneer) => pioneer.figure))).map(
          (issue) => `主持人开场${issue}`
        ),
        ...describeLanguageIssues(
          checkLanguage(content, session, [], true).filter((issue) => issue.category !== "coherence")
        ).map((issue) => `主持人开场${issue}`)
      ];
      if (guardIssues.length) {
        return {
          ...result,
          data: fallback,
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
        data: fallback,
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
    const questionIntent = classifyQuestionIntent(session.question);
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
      `内部张力（仅用于理解任务分工，不得向用户复述，也不得当成用户的原话或意图）：${internalTension(session)}`,
      questionIntentInstruction(questionIntent),
      sharedTaskFrame(session),
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
        ? `你要自然回应${pioneerById.get(respondsTo.speakerId)?.addressName ?? "前一位"}的观点：${respondsTo.content}`
        : resolvedAssignment.relation === "independent"
          ? "这一位提供独立的新视角，不需要先评价、同意或反对前一位。"
          : "你是第一位，不需要承接其他人物。",
      "输出要求：",
      "- content 使用自然、清楚的现代中文。长度由把意思讲完整所需决定：一个判断一两句即可；需要说明理由、条件或方法时可以展开，但总长不得超过 220 字，也不要为了显得深刻而凑成长段。",
      "- content 超过 108 字时，请在完整句意处形成两个自然段落：后一段必须增加理由、条件、例子或追问，不能换词重复。",
      "- 保持人物自己的立场和口吻，但不要求第一个字必须是“我”。可以直接提问、指出区别或给出判断；“我同意”“你说得对”“换个角度看”都可以自然出现，只能用于真实回应，不能作为固定开头。",
      "- 不要重新复述用户的简历、关系或处境。第一句应直接进入这位人物独有的观察、区分、质疑或问题。",
      resolvedAssignment.speechAct === "name_emotion"
        ? "- 你可以承认用户已经说出的感受，但不能把主持人的读题摘要换词复述。请从人物自己的观察、措辞或轻微追问切入，并把 Director 分配的新判断真正写进正文。"
        : "",
      resolvedAssignment.relation === "independent"
        ? "- 本轮是独立视角：不要评价前一位，也不要为了制造圆桌感而写“我同意”“她说得对”。直接提供 Director 指定的新信息。"
        : "- 若 relation 不是 open，要让人读得出你在回应前文。“我同意”“你说得对”等表达可以使用，但后面必须增加新判断，不能只做态度表演。",
      "- 承接不等于重复前一位的解释。若前一位刚引入“独处、空间、秩序、证据、交换、边界”等概念，不要再用同一概念开场；先完成你被分配的新判断，再在必要时用短语回应。",
      "- 承接是回应前文的判断，不是复述原句：不得复制前文任何连续 10 个字，也不要用“她说/刚才说/正如”后接原句。",
      "- 只有确实回应另一位时，才可以自然称呼她的圆桌短名（如“清照”“简”“阿达”）；不喊全名，不为制造热闹而每段点名。",
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
      "- 角色卡中的当代映射属于解释性延伸，只能用来迁移思维方式；不得冒充人物原话，也不得断言她亲历过用户的处境。",
      pioneer.voiceProfile.imageryBudget === 0
        ? "- 本轮不用比喻或文学意象，人物特色通过语气、提问方式和判断逻辑体现。"
        : `- 本轮最多使用 ${pioneer.voiceProfile.imageryBudget} 个易懂意象；出现后立即回到具体事实、边界或判断标准，不得追加第二层意象。`,
      pioneer.id === "li-qingzhao"
        ? "- 本轮最多使用一个文学意象。用了一个之后，立刻回到普通现代中文；不能围绕同一意象继续堆音节、残章、韵脚等词。用户认真准备不等于准备导致话语沉重；只能条件化检查内容是否太多、重点是否后置。"
        : "",
      pioneer.id === "jane-austen" && isExpressionSkillQuestion(session.question)
        ? "- 你要判断听者最需要先听懂什么、哪些背景需要补充。使用自然说法，不写“从话里拿走什么”“对方要用哪一样”“对方必须从你话里”等产品任务式表达；不把普通表达训练改写成关系交换、迎合、自尊或获取认可。"
        : "",
      expressionRoleInstruction(pioneer, session),
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
        moderatorAnalysis,
        session
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
            : "",
          buildLanguageRepairPrompt(
            checkLanguage(
              rendered.content,
              session,
              priorPioneerContents,
              resolvedAssignment.relation === "open"
            )
          )
        ]
          .filter(Boolean)
          .join("\n");
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
            moderatorAnalysis,
            session
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
          data: dedupeFallbackTurn(
            fallbackPioneerSpeech(session, pioneer, sourceNotes, resolvedAssignment),
            [...priorConversationContents, moderatorAnalysis],
            pioneer,
            session,
            session.question,
            resolvedAssignment
          ),
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
        data: dedupeFallbackTurn(
          fallbackPioneerSpeech(session, pioneer, sourceNotes, resolvedAssignment),
          [...priorConversationContents, moderatorAnalysis],
          pioneer,
          session,
          session.question,
          resolvedAssignment
        ),
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
    const questionIntent = classifyQuestionIntent(session.question);
    const turnSupportContext = resolveTurnSupportContext(session, followUpQuestion);
    const turnSession: RoundtableSession = {
      ...session,
      supportMode: turnSupportContext.mode,
      explicitEmotionTerms: turnSupportContext.explicitEmotionTerms
    };
    if (intent === "closure") {
      return {
        data: fallbackFollowUp(turnSession, pioneer, followUpQuestion, intent, sourceNotes, assignment),
        assignment,
        usedGuardRepair: true as const,
        guardIssues: ["用户已收束：使用人物化短回应，避免重新展开分析"]
      };
    }
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
    // 二次去重的比较范围：当前人物全部历史发言、其他人物本场发言，
    // 以及主持人的开场与读题内容。
    const followUpBannedContents = [
      ...activeMessages
        .filter((message) => message.speakerId === pioneer.id && message.role === "pioneer")
        .map((message) => message.content),
      ...activeMessages
        .filter((message) => message.role === "pioneer" && message.speakerId !== pioneer.id)
        .map((message) => message.content),
      ...activeMessages.filter((message) => message.role === "moderator").map((message) => message.content)
    ];
    const prompt = [
      "请生成用户追问后的单人回应。",
      `原始问题：${session.question}`,
      `用户追问：${followUpQuestion}`,
      `用户本轮意图：${intent}`,
      questionIntentInstruction(questionIntent),
      `主题：${session.theme}`,
      `内部张力（仅用于理解任务分工，不得向用户复述，也不得当成用户的原话或意图）：${internalTension(session)}`,
      sharedTaskFrame(session),
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
      "先回答追问本身，不复述第一轮，也不要再次概括原始问题。以清楚、精练、完整为准，不为凑短而省略理由，也不为显得深刻而拉长；content 最多 220 个中文字。能简短说清就只说一段，确需展开时可在完整句意处自然分成两层，每层最多约 108 字，第二层必须带来新的理由、区分或追问。",
      "句式服从人物声音，不使用统一的“承接—判断—理由—行动”模板，也不强制以“我”开头。“我同意”“你说得对”“换个角度看”可以自然出现，但只有在确实回应用户或前文时才使用，不能成为空洞起手式。",
      "普通的“怎么判断、如何知道”是在询问判断标准，不等于反驳或纠正；只有用户明确指出你读错、没说过某事时，才承认并撤回误读。",
      expressionRoleInstruction(pioneer, turnSession),
      intent === "commitment"
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
        followUpQuestion,
        "",
        { question: `${session.question}\n${followUpQuestion}`, explicitEmotionTerms: session.explicitEmotionTerms }
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
              "请直接重写，回答追问并保留人物判断方式；不要复述旧话。",
              buildLanguageRepairPrompt(
                checkLanguage(
                  rendered.content,
                  { question: `${session.question}\n${followUpQuestion}`, explicitEmotionTerms: session.explicitEmotionTerms },
                  comparisonContents,
                  false
                )
              )
            ]
              .filter(Boolean)
              .join("\n")
          );
          const repairedRendered = renderAssignedPioneerTurn(repaired.data, assignment, pioneer, bannedQuoteTexts);
          const repairedIssues = assignedTurnIssues(
            repairedRendered,
            assignment,
            pioneer,
            comparisonContents,
            followUpQuestion,
            "",
            { question: `${session.question}\n${followUpQuestion}`, explicitEmotionTerms: session.explicitEmotionTerms }
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
          data: dedupeFallbackTurn(
            fallbackFollowUp(turnSession, pioneer, followUpQuestion, intent, sourceNotes, assignment),
            followUpBannedContents,
            pioneer,
            turnSession,
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
        data: dedupeFallbackTurn(
          fallbackFollowUp(turnSession, pioneer, followUpQuestion, intent, sourceNotes, assignment),
          followUpBannedContents,
          pioneer,
          turnSession,
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
    // 行动卡子 schema 单独抽出：行动卡定向 repair 时复用同一份契约。
    const actionCardSchema = {
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
    };
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["actionCard", "quoteCards"],
      properties: {
        actionCard: actionCardSchema,
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
      `内部张力（仅用于理解任务分工，不得向用户复述，也不得当成用户的原话或意图）：${internalTension(session)}`,
      sharedTaskFrame(session),
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
      "行动卡不是评选一位赢家。请从 2-3 位先行者的有效发言中提取彼此兼容的环节，组成一条前后连贯的练习路径；若某条发言偏离用户最后的追问，就不要采用。",
      "每位先行者本场需要提炼的真实发言（sourceMessageId 只填写左侧 g 编号）：",
      closingSourceAliases.length
        ? closingSourceAliases
            .map(({ alias, pioneer, message }) => `- ${alias}｜${pioneer.id}｜${pioneer.figure}｜${message.content}`)
            .join("\n")
        : "本轮没有可用发言，只能使用角色卡中的价值观生成克制赠言。",
      "要求：chosenPath 表示“本轮练习路径”，用 22-50 字说明先做什么、再根据什么反馈调整；不写“采用某某的判断”，也不强行选出一位先行者。多位观点只能分别承担不同环节，例如确定重点、识别听者需要、设计反馈；不能把三套练习并排塞成任务大礼包。",
      "卡片是用来扫一眼就能执行的：每一栏只允许一个动作或一个判断。出现第二个并列动作、第二个条件或补充解释时，删掉次要的那个，不要用分号继续接。",
      "每个动作必须是普通用户立刻能执行的自然动作，例如写下、删改、询问、对比、固定节奏；不使用概念转换不成立的动作（例如把一个词配成一句判断、把感受换算成分数）；不补写用户没有说过的经历、关系、反馈或困难。",
      "再从有效谈话中找出这条练习路径最需要防止的一项现实风险。它可以来自真实分歧，也可以来自先行者已经说出的投入边界或失败条件；没有分歧时不得虚构反方。guardrail 用 22-58 字写成明确的“如果出现该风险，就缩小、暂停或调整”的条件。sourceMessageIds 要覆盖实际采用的 2-4 条来源。",
      "24 小时动作 22-50 字，只完成第一次观察或一个普通用户约 10-30 分钟能留下的最小交付，最多两个检查项；必须写清使用什么、记录或完成什么、留下什么可见结果，不能只写“回忆一下、想一想、观察看看”。若主线来源本身已经给出动作，行动卡要沿同一方向换一个更具体的执行粒度来写，不得复制来源中任何连续 8 个字。除非谈话已说明已有明确素材，不要求从零完成整页样稿或完整作品。7 天实验 30-62 字，必须在 24 小时结果上增加比较、反馈或变量测试，不能只是每天重复同一句自问；30 天练习 32-66 字，要把验证结果变成固定节奏、环境边界或决策规则，不能只是把 7 天延长，也不在其中嵌套“若无效就改做另一件事”的备用路径。三阶段必须产生不同层次的结果。副业刚起步时，不擅自要求 30 天内达到某个工资百分比；优先观察作品、询价、付费意愿和时间是否可持续。复盘证据 22-54 字，只列 2-3 个可观察指标，并优先使用用户自己就能记录的证据（例如她写下的核心句、修改前后的版本、自己记下的次数或时间）。需要他人反馈时，只能写成一次自然的询问，例如请对方说说理解到的重点和哪里还需要补充；不得设计成让听者复述、打分或完成测试。每项只写一句，使用直接、自然的现代中文，不用“基线评分、情绪劳动、内在空间被侵占”等术语，并返回 2-4 个实际承接的 sourceMessageIds。",
      `为每位入席先行者各生成一张金句卡，共 ${selected.length} 张，不得遗漏或重复人物。quote 是她对自己本场发言核心判断的再次提炼：12-30 个中文字，像临别赠言，第一人称可以省略；不能逐字摘抄原发言，也不能加入原发言没有的新结论。每句最多一个清楚意象，不能把量尺和钟表、里程表和里程碑等不同物象堆在同一句里；不要用“恐惧递来的面具、在寂静里褪尽颜色、灵魂、命运、深渊、彼岸、枷锁”等需要二次解读的修辞。sourceMessageId 必须指向同一位先行者的 g 编号。context 用 20-55 字直白说明这句赠言如何承接她在本场的判断，只能复述她实际提出的观察、判断或行动，不替用户解释原因；不使用“根源、本质、深层恐惧、真正害怕、这说明你、来自你、源于你、是因为你”。不得生成或引用历史名言，历史回声由系统根据这张赠言本身从核验资料库另行匹配。`,
      isUnknownCauseMode(session)
        ? "用户明确不知道原因：chosenPath、行动和金句 context 只能帮助观察出现时间、身体位置、外界干扰与变化，不得写“内在淤塞、等待表达、未被安放”，也不得断言空间或情绪就是原因。"
        : "",
      isExpressionSkillQuestion(session.question)
        ? "这是表达能力训练：路径必须围绕“确定重点—按听者需要组织必要信息—用反馈只改一处”。不能写成坦白内心、克服害怕评价、关系交换、公开发布或汇报表演；行动里请对方反馈时，要先说明用户在练习表达，不能把它写成对听者的考试。"
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
      // 只保留真正的意象词；「记录、证据、边界、结构、空间、秩序」是普通建议用语，
      // 两张卡同时出现不算意象撞车，误列入会静默丢弃合格的模型赠言。
      const quoteMotifs = ["尺子", "标尺", "刻度", "镜子", "房间", "筹码", "雨", "声音", "漩涡"];
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
      const transcriptText = messages.map((message) => message.content).join("\n");
      const guardContext: FinalCardGuardContext = {
        question: session.question,
        transcriptText,
        supportMode: session.supportMode,
        explicitEmotionTerms: session.explicitEmotionTerms,
        deniedAssumptions: session.deniedAssumptions,
        expressionSkill: isExpressionSkillQuestion(session.question)
      };

      // 行动卡定向 repair：整份 finalize 最多一次。repair 结果必须同时通过
      // 质检、溯源与末端 guard 才被接受，否则视为 repair 失败，只降级行动卡。
      let actionRepairAttempted = false;
      const attemptActionRepair = async (issues: string[], previousCard: ActionCard) => {
        actionRepairAttempted = true;
        try {
          const repaired = await generateJson<ActionCardDraft>(
            "roundtable_action_repair",
            actionCardSchema,
            [
              "只重写行动卡本身，不涉及任何赠言卡。",
              `用户问题：${session.question}`,
              `主题：${session.theme}`,
              "行动卡来源消息（sourceMessageIds 只填写左侧 m 编号，不要复制 UUID）：",
              actionSourceAliases.map(({ alias, message }) => `- ${alias}｜${message.content}`).join("\n") || "无",
              `上一版行动卡未通过检查：${issues.join("；")}`,
              `上一版行动卡：${JSON.stringify(previousCard)}`,
              "重写要求：每一栏只保留一个动作或判断；24 小时、7 天、30 天必须前后递进，不是同一动作换时间重复；每个动作是普通用户立刻能执行的自然动作，不使用概念转换不成立的动作；不补写用户没有说过的经历、关系、反馈或困难，不使用用户已否认的前提；sourceMessageIds 填写 2-4 个实际承接的 m 编号。"
            ].join("\n")
          );
          const repairedSourceIds = resolveActionSourceIds(repaired.data.sourceMessageIds, actionSourceIdByAlias);
          const repairedCard = renderActionCard(session.id, {
            ...repaired.data,
            sourceMessageIds: repairedSourceIds.slice(0, 4)
          });
          if (
            !actionCardQualityIssues(repairedCard).length &&
            actionCardIsGrounded(actionSourceIds.length, repairedSourceIds.length) &&
            !actionCardGuardIssues(repairedCard, guardContext).length
          ) {
            return repairedCard;
          }
        } catch {
          // repair 请求失败按未修复处理，下面只降级行动卡。
        }
        return undefined;
      };

      const groundedActionSourceIds = resolveActionSourceIds(
        result.data.actionCard.sourceMessageIds,
        actionSourceIdByAlias
      );
      const draftActionCard = renderActionCard(session.id, {
        ...result.data.actionCard,
        sourceMessageIds: groundedActionSourceIds.slice(0, 4)
      });
      // 行动卡问题只影响行动卡：质检或溯源失败时，针对行动卡做一次定向 repair；
      // 合格的赠言卡与历史回声保持原样，绝不一起降级。
      const draftActionIssues = [
        ...actionCardQualityIssues(draftActionCard),
        ...(actionCardIsGrounded(actionSourceIds.length, groundedActionSourceIds.length)
          ? []
          : ["没有真实承接至少两条圆桌消息"])
      ];
      const repairedActionCard = draftActionIssues.length
        ? await attemptActionRepair(draftActionIssues, draftActionCard)
        : undefined;
      const actionResolution = resolveActionCard(
        draftActionCard,
        draftActionIssues,
        repairedActionCard,
        () => fallbackFinal(session, selected, messages).actionCard
      );
      let actionCard = actionResolution.actionCard;
      const guardNotes = actionResolution.issues.map((issue) =>
        actionResolution.degradedToFallback ? `行动卡${issue}（已只降级行动卡）` : `行动卡${issue}（已定向修复）`
      );

      // 末端 guard 按来源拆分：行动卡侧的边界问题只修复或降级行动卡。
      const actionGuardIssues = actionCardGuardIssues(actionCard, guardContext);
      if (actionGuardIssues.length) {
        const repaired = actionRepairAttempted ? undefined : await attemptActionRepair(actionGuardIssues, actionCard);
        if (repaired) {
          actionCard = repaired;
          guardNotes.push(...actionGuardIssues.map((issue) => `行动卡${issue}（已定向修复）`));
        } else {
          actionCard = fallbackFinal(session, selected, messages).actionCard;
          guardNotes.push(...actionGuardIssues.map((issue) => `行动卡${issue}（已只降级行动卡）`));
        }
      }

      // 赠言卡侧的边界问题只处理受影响的卡：重提炼、摘除回声或移除该卡。
      const guardedQuotes = resolveGuardedQuoteCards(quoteCards, guardContext, (card) => {
        const pioneer = selected.find((item) => item.id === card.speakerId);
        return pioneer ? renderClosingCard(session, pioneer, closingSourceByPioneer.get(pioneer.id)) : undefined;
      });
      guardNotes.push(...guardedQuotes.notes);

      return {
        data: {
          actionCard,
          quoteCards: guardedQuotes.quoteCards
        },
        usedFallback: false as const,
        usedGuardRepair: guardNotes.length ? (true as const) : undefined,
        guardIssues: guardNotes.length ? guardNotes : undefined
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
