import { pioneerById } from "@/data/pioneers";
import { buildHarvestTranscript, describePioneer } from "@/lib/harness/context-builder";
import { generateJson } from "@/lib/harness/openai-client";
import {
  breakLongSentences,
  compactQuote,
  compactText,
  ensureFirstPerson,
  findClarityIssues,
  findConversationOverlap,
  findUnknownCauseIssues,
  guardPioneerContent,
  groundQuoteInContent,
  softenUnsupportedInference,
  textSimilarity
} from "@/lib/harness/output-guard";
import type {
  ActionCard,
  ConversationAssignment,
  PioneerProfile,
  QuoteCard,
  RoundtableMessage,
  RoundtableSession,
  SourceNote
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
  maxChars = 92
) {
  let rawContent = draft.content;
  if (assignment.actionMode === "offer_one_step" && rawContent.length > maxChars) {
    const sentences = rawContent.match(/[^。！？]+[。！？]?/g) ?? [rawContent];
    if (sentences.length > 2) rawContent = `${sentences[0]}${sentences.at(-1)}`;
  }
  const content = guardPioneerContent(rawContent, maxChars, firstPersonPrefixes[assignment.speechAct]);
  return {
    content,
    quote: distinctGroundedQuote(content, draft.quote, draft.deliveredContribution, bannedQuoteTexts),
    deliveredContribution: compactText(draft.deliveredContribution || assignment.newContribution, 48)
  };
}

function assignedTurnIssues(
  turn: ReturnType<typeof renderAssignedPioneerTurn>,
  assignment: ConversationAssignment,
  pioneer: PioneerProfile,
  previousContents: string[],
  question: string
) {
  const issues = findConversationOverlap(
    turn.content,
    assignment.speechAct === "name_emotion" ? [] : previousContents
  );
  issues.push(...findClarityIssues(turn.content, 92));
  if (assignment.actionMode === "none" && containsInstruction(turn.content)) {
    issues.push("本轮任务不应给行动，但正文出现了行动指令");
  }
  if (assignment.actionMode === "offer_one_step" && !hasExecutableAction(turn.content)) {
    issues.push("行动没有同时说清具体动作与交付结果");
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
  if (
    pioneer.voiceProfile.imageryBudget === 0 &&
    /(像|仿佛|如同|犹如|流弹|阵地|穿胸|风声|战场|城池|刀剑|堡垒)/.test(turn.content)
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
    const imageryCount = (turn.content.match(/(根|词稿|散页|沉吟|雨夜|残酒|搁浅)/g) ?? []).length;
    if (/两丛根/.test(turn.content) || imageryCount > pioneer.voiceProfile.imageryBudget) {
      issues.push("李清照本轮的文学意象超过额度，影响直接理解");
    }
  }
  return [...new Set(issues)];
}

function hasHardTurnIssue(issues: string[]) {
  return issues.some(
    (issue) =>
      issue.startsWith("与前文重复了") ||
      !/^(开场与前文相似|整体内容与前文相似|摘句重复了)/.test(issue)
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
    breakLongSentences(ensureFirstPerson(content, `我从${pioneer.values[0]}来看：`)),
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
  if (/(说不清|不知道|不明)/.test(question)) {
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
  "li-qingzhao": "我会找一个更准确的词来描述身体感受。词不负责解释，只负责留下比较。",
  "ban-zhao": "我会把早晨分成三栏：作息、当天要应对的事、身体轻重。先看变化是否总在同一时刻发生。",
  "qin-liangyu": "我会先把身体信号与外界要求分开，再补上可用支援。三列分别看，才知道哪一项先变化。",
  "wu-zetian": "我只看它几点出现、持续多久、当天哪些安排仍能调整。先找仍在掌握之中的安排。",
  "marie-curie": "单次感受还不能形成规律。相同时间、相同记录方式下的变化，才是下一步判断可用的证据。",
  "florence-nightingale": "我会沿时间线观察：醒来前睡了多久，沉重落在哪里，起身后多久发生变化。顺序本身就是线索。",
  "jane-austen": "我关心它与哪类日程或互动同时出现。重复的场景比猜测更值得比较，动机暂时留在空白处。",
  "ada-lovelace": "我会做一张最小变量表：睡醒时间、消息干扰、身体轻重。一次只比较一个变化。",
  "virginia-woolf": "我想比较醒来后的前十分钟。先比较有消息和安静时的身体变化，再看两种情况下轻重是否相同。"
};

const unknownCauseQuoteByPioneer: Record<string, string> = {
  "li-qingzhao": "词不负责解释，只负责留下比较",
  "ban-zhao": "先看变化是否总在同一时刻发生",
  "qin-liangyu": "先把身体信号与外界要求分开",
  "wu-zetian": "先找仍在掌握之中的安排",
  "marie-curie": "单次感受还不能形成规律",
  "florence-nightingale": "顺序本身就是线索",
  "jane-austen": "重复的场景比猜测更值得比较",
  "ada-lovelace": "一次只比较一个变化",
  "virginia-woolf": "先比较有消息和安静时的身体变化"
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

function fallbackOpening(session: RoundtableSession) {
  if (/(说不清|不知道|不明)/.test(session.question)) {
    return {
      content: "你说每天醒来身体沉沉，心口像压着什么，却还说不清原因。我们先不急着解释，只看它何时出现、何时变化。",
      quote: "先不解释，只看它怎样变化。"
    };
  }
  return {
    content: compactText(`你现在难以决定，是因为${session.tension}。我们先听听不同看法，再找一个你愿意尝试的小步骤。`, 64),
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
  const profileFallback = /(说不清|不知道|不明)/.test(session.question)
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
    propose_action: fallbackActionForSession(session, pioneer)
  };
  if (/(说不清|不知道|不明)/.test(session.question)) {
    for (const speechAct of Object.keys(contentByAct) as ConversationAssignment["speechAct"][]) {
      if (speechAct !== "propose_action") contentByAct[speechAct] = profileFallback;
    }
  }
  const rendered = renderAssignedPioneerTurn(
    {
      content: contentByAct[assignment.speechAct],
      quote: /(说不清|不知道|不明)/.test(session.question)
        ? unknownCauseQuoteByPioneer[pioneer.id] ?? "先留下变化，再讨论原因"
        : pioneer.pushback,
      deliveredContribution: assignment.newContribution
    },
    assignment,
    pioneer,
    [session.question]
  );
  return assignment.speechAct === "name_emotion" && !/(说不清|不知道|不明)/.test(session.question)
    ? { ...rendered, quote: "" }
    : rendered;
}

function fallbackCrossfire(session: RoundtableSession, first: PioneerProfile, second: PioneerProfile, tension: string) {
  if (/(说不清|不知道|不明)/.test(session.question)) {
    return {
      first: "我主张先比较醒来时和五分钟后的轻重。若先关掉消息，明天就少了一次原样基线。",
      second: "我不同意先保留原样。若消息和事务已经涌入，变化会混入干扰；先留十分钟安静，再比较轻重。",
      synthesis: "如果醒来时还没有看消息，就比较五分钟内的变化；如果消息已经进入，就先留十分钟安静，再比较。"
    };
  }
  const firstPath = first.voiceProfile.crossfireClaim.replace(/^我主张先/, "");
  const secondPath = second.voiceProfile.crossfireClaim.replace(/^我主张先/, "");
  const pairKey = [first.id, second.id].sort().join("|");
  const conditionByPair: Record<string, string> = {
    "ada-lovelace|marie-curie": "如果当前缺的是市场反馈，先做原型；如果已有多次尝试却无法比较，先统一记录。",
    "ada-lovelace|wu-zetian": "如果还没有真实反馈，先做原型；如果连投入上限都说不清，先算筹码。",
    "ban-zhao|virginia-woolf": "如果日程已经失控，先恢复节奏；如果只是没有独处时间，先守住空间。",
    "ban-zhao|jane-austen": "如果还看不清哪段互动最消耗，先观察交换；如果模式已经明确，先缩短相处时长。",
    "jane-austen|virginia-woolf": "如果你还说不清自己总在扮演什么角色，先观察交换；如果角色已经清楚却没有恢复时间，先减少一次消耗。",
    "li-qingzhao|virginia-woolf": "如果安静后感受更清楚，先保留空间；如果反而更沉重，先写下一句真话。"
  };
  const turnsByPair: Record<string, { first: string; second: string }> = {
    "jane-austen|virginia-woolf": {
      first: "我会先看清你在这段关系里总被安排成什么角色。若只缩短相处，却没看懂交换方式，下一段关系仍可能重复。",
      second: "我不同意把观察放在最前。若每次见面都耗尽恢复时间，先少见一次，才有余地分辨哪些期待真正属于你。"
    },
    "li-qingzhao|virginia-woolf": {
      first: "我会先写下一个最接近身体感受的词。只保留安静还看不见变化，一个词可以成为明天比较的起点。",
      second: "我不同意立刻把感受写成句子。若醒来时消息已经涌入，先留十分钟不看手机，才能观察沉重是否变化。"
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

function getQuoteCandidates(messages: RoundtableMessage[]) {
  return messages.filter(
    (message): message is RoundtableMessage & { quote: string } =>
      message.role === "pioneer" &&
      Boolean(message.quote?.trim()) &&
      message.content.includes(message.quote?.trim() ?? "")
  );
}

function renderQuoteContext(raw: string, speakerId: string, theme: string) {
  const prefixed = raw.startsWith("本轮圆桌提炼") ? raw : `本轮圆桌提炼｜${raw}`;
  if (/(根源|本质|深层恐惧|真正害怕|这说明你)/.test(prefixed)) {
    return compactText(
      `本轮圆桌提炼｜${pioneerById.get(speakerId)?.figure ?? "先行者"}为「${theme}」提供了一个可继续思考的角度。`,
      70
    );
  }
  return compactText(softenUnsupportedInference(prefixed), 70);
}

function chooseActionLead(
  session: RoundtableSession,
  selected: PioneerProfile[],
  messages: RoundtableMessage[]
) {
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
    chosenPath: balanceQuotes(compactText(card.chosenPath, 60)),
    within24h: balanceQuotes(compactText(card.within24h, 58)),
    sevenDayExperiment: balanceQuotes(compactText(card.sevenDayExperiment, 78)),
    thirtyDayPractice: balanceQuotes(compactText(card.thirtyDayPractice, 82)),
    guardrail: balanceQuotes(compactText(card.guardrail, 70)),
    evidenceToReview: balanceQuotes(compactText(card.evidenceToReview, 64)),
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
  const candidates = getQuoteCandidates(messages);
  const sourceMessageIds = messages
    .filter((message) => message.role === "pioneer" || message.stage === "synthesis")
    .slice(-3)
    .map((message) => message.id);
  const unknownCause = /(说不清|不知道|不明)/.test(session.question);
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
    quoteCards: candidates.length
      ? candidates.slice(0, 3).map((message) => ({
          sessionId: session.id,
          speakerId: message.speakerId,
          quote: message.quote,
          sourceMessageId: message.id,
          context: compactText(`本轮圆桌提炼｜${pioneerById.get(message.speakerId)?.figure ?? "先行者"}对「${session.theme}」的提醒`, 70)
        }))
      : selected.slice(0, 3).map((pioneer) => ({
          sessionId: session.id,
          speakerId: pioneer.id,
          quote: `不要急着成为谁，先把${pioneer.values[0]}练成你自己的能力。`,
          context: compactText(`本轮圆桌提炼｜${pioneer.figure}对「${session.theme}」的提醒`, 70)
        }))
  };
}

export class StageGenerator {
  async opening(session: RoundtableSession) {
    if (/(说不清|不知道|不明)/.test(session.question)) {
      return {
        data: fallbackOpening(session),
        usedGuardRepair: true as const,
        guardIssues: ["原因未知模式：主持人只复述可确认事实"]
      };
    }
    const prompt = [
      "请生成主持人的反映式开场。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      "要求：直接用“你”称呼用户，不使用“她”“我听到的是”“我看见”；抓住用户原话中的一个具体细节，用 2-3 句自然的现代中文说清她正在权衡什么；只承接她明确说出的感受，无法确认的地方保留不确定；不分析隐藏原因，不给建议；42-64 个中文字，不用比喻和抽象心理术语；给一句 8-20 字的 quote。"
    ].join("\n");

    try {
      const result = await generateJson<{ content: string; quote: string }>("roundtable_opening", textWithQuoteSchema, prompt);
      const content = compactText(breakLongSentences(softenUnsupportedInference(result.data.content)), 64);
      const guardIssues = findUnknownCauseIssues(content, session.question);
      if (guardIssues.length) {
        return {
          ...result,
          data: fallbackOpening(session),
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
        data: fallbackOpening(session),
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
    assignment?: ConversationAssignment
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
    if (/(说不清|不知道|不明)/.test(session.question)) {
      return {
        data: fallbackPioneerSpeech(session, pioneer, sourceNotes, resolvedAssignment),
        usedGuardRepair: true as const,
        guardIssues: ["原因未知模式：先行者使用人物专属观察协议"]
      };
    }
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
    const respondsTo = priorPioneerMessages.find(
      (message) => message.speakerId === resolvedAssignment.respondsToPioneerId
    );
    const prompt = [
      "请生成一位先行者的第一轮发言。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
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
      "- content 写成 2-4 句、45-92 个中文字的自然口语。只完成 Director 分配的一个主要任务，不套“承接—判断—理由—行动”结构。",
      "- 第一人称发言，但不要固定用“我的判断是”“我主张”“我看到的是”开场，也不要重新复述用户的简历、关系或处境。第一句应直接进入这位人物独有的观察、区分、质疑或问题。",
      "- 若 relation 不是 open，要让人读得出你在回应前文，但不要使用“我同意，但是”这种机械连接。",
      "- 承接是回应前文的判断，不是复述原句：不得复制前文任何连续 10 个字，也不要用“她说/刚才说/正如”后接原句。",
      resolvedAssignment.relation === "challenge" || resolvedAssignment.relation === "redirect"
        ? "- 你的任务是改变判断标准：不要沿用前文的核心名词继续搭系统，要指出前一视角忽略了什么，或把讨论带向另一项价值。"
        : "- 可以承接前文，但必须增加一个前面没有出现的判断依据。",
      "- deliveredContribution 用 12-36 字说明正文实际新增了什么，仅供 Harness 校验，不会展示给用户。",
      "- quote 为 content 中原样出现的 8-22 字完整短句或分句，不冒充历史名言。",
      resolvedAssignment.actionMode === "offer_one_step"
        ? "- 行动必须说明打开或使用什么、做什么、留下什么结果；禁止“建立档案”“调整状态”“找回自己”等需要用户再次解释的说法。"
        : "- 本轮不要出现“今天写下、列出、建立、完成”等行动指令，完整行动会在圆桌结束后生成。",
      "- 请做换名检查：如果把姓名换成另一位先行者仍成立，就按角色的推理动作重写。",
      "禁止：无来源地声称“我曾经/我也曾”；替用户定义隐藏心理原因；连续堆叠比喻；堆角色关键词；使用角色卡中的禁止模式。",
      /(说不清|不知道|不明)/.test(session.question)
        ? "用户明确说自己不知道原因：你不能替她补出原因，只能承认未知、提出可观察线索，或把某种可能写成问题。不要把感受写成等待安放、等待表达的字句，也不要暗示它在保护、提醒或拴住用户。"
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
        session.question
      );
      let bestRendered = rendered;
      let bestIssues = qualityIssues;

      if (qualityIssues.length) {
        const repairPrompt = [
          prompt,
          "",
          `上一版未通过 Harness 检查：${qualityIssues.join("；")}`,
          `上一版正文：${rendered.content}`,
          "请重新写 content。保留同一个人物立场和 Director 任务，但换一个起点与句法；删除重复复述，并确保新增内容在第一句就出现。若任务要求行动，必须写清做什么和留下什么；若任务不要求行动，就不要夹带计划。"
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
            session.question
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

  async crossfire(
    session: RoundtableSession,
    first: PioneerProfile,
    second: PioneerProfile,
    tension: string,
    messages: RoundtableMessage[] = []
  ) {
    if (/(说不清|不知道|不明)/.test(session.question)) {
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
      "first.content 和 second.content 分别把 priority 与 otherPathCost 写成 38-64 个中文字的第一人称自然发言。第二位要明确不同意前一位的优先级；不复述第一轮，不使用“我同意，但”式假交锋。",
      "synthesis.difference 用一句话说清真正分歧；synthesis.condition 必须使用“如果/若……就……”写出可观察的选择条件，不以焦虑大小或直觉作为唯一标准；synthesis.content 将两者写成 38-64 字的主持人收束，不判谁赢，不逐人复述。",
      /(说不清|不知道|不明)/.test(session.question)
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

  async followUp(
    session: RoundtableSession,
    pioneer: PioneerProfile,
    followUpQuestion: string,
    sourceNotes: SourceNote[],
    messages: RoundtableMessage[] = []
  ) {
    const assignment = followUpAssignment(pioneer, followUpQuestion);
    const priorPioneerMessages = messages.filter((message) => message.role === "pioneer").slice(-6);
    const prompt = [
      "请生成用户追问后的单人回应。",
      `原始问题：${session.question}`,
      `用户追问：${followUpQuestion}`,
      `主题：${session.theme}`,
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "本场此前谈话：",
      buildHarvestTranscript(
        messages,
        new Map(messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ) || "无",
      "Director 为这次追问分配的任务：",
      `- speechAct：${assignment.speechAct}（${speechActLabels[assignment.speechAct]}）`,
      `- objective：${assignment.objective}`,
      `- 是否给行动：${assignment.actionMode === "offer_one_step" ? "给一个具体动作" : "不夹带行动计划"}`,
      "先回答追问本身，不复述第一轮，也不要再次概括原始问题。content 写成 2-4 句、45-92 个中文字；句式服从人物声音，不使用统一的“承接—判断—理由—行动”模板。",
      assignment.actionMode === "offer_one_step"
        ? "行动必须写清使用什么、做什么、留下什么结果。"
        : "只推进理解或判断，不使用“今天写下、列出、记录、完成”等行动指令。",
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
        priorPioneerMessages.map((message) => message.content),
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
            priorPioneerMessages.map((message) => message.content),
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
          data: fallbackPioneerSpeech(session, pioneer, sourceNotes, assignment),
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
        data: fallbackPioneerSpeech(session, pioneer, sourceNotes, assignment),
        assignment,
        usedFallback: true as const,
        fallbackReason: classifyGenerationError(error)
      };
    }
  }

  async finalize(session: RoundtableSession, selected: PioneerProfile[], messages: RoundtableMessage[] = []) {
    if (/(说不清|不知道|不明)/.test(session.question)) {
      return {
        data: fallbackFinal(session, selected, messages),
        usedGuardRepair: true as const,
        guardIssues: ["原因未知模式：卡片只保留可观察变化与求助护栏"]
      };
    }
    const quoteCandidates = getQuoteCandidates(messages);
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
          minItems: quoteCandidates.length >= 2 ? 2 : 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: quoteCandidates.length
              ? ["quote", "speakerId", "context", "sourceMessageId"]
              : ["quote", "speakerId", "context"],
            properties: {
              quote: { type: "string" },
              speakerId: { type: "string", enum: selected.map((pioneer) => pioneer.id) },
              context: { type: "string" },
              sourceMessageId: quoteCandidates.length
                ? { type: "string", enum: quoteCandidates.map((message) => message.id) }
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
      `入席先行者：${selected.map((pioneer) => `${pioneer.figure}（${pioneer.practice}）`).join("；")}`,
      "本轮真实谈话：",
      buildHarvestTranscript(messages, new Map(selected.map((pioneer) => [pioneer.id, pioneer.figure]))),
      "行动卡来源消息（sourceMessageIds 只填写左侧 m 编号，不要复制 UUID）：",
      actionSourceAliases.map(({ alias, message }) => `- ${alias}｜${message.content}`).join("\n") || "无",
      actionLead && actionLeadAlias
        ? `Harness 已决定行动主线：${actionLeadAlias}｜${actionLead.pioneer.figure}。chosenPath 和三段行动必须沿这条主线，sourceMessageIds 第一项必须是 ${actionLeadAlias}，不可自行换人。`
        : "Harness 未指定行动主线，请选择最贴近用户现实问题的一条。",
      "可选金句（只能从这些实际发言中选择，不得另编历史名言）：",
      quoteCandidates.length
        ? quoteCandidates.map((message) => `- ${message.id}｜${message.speakerId}｜${message.quote}`).join("\n")
        : "本轮没有可选金句，可基于角色视角生成，但 context 必须注明“本轮圆桌提炼”。",
      "要求：先从来源消息里选择一条最适合用户当前处境的主线，sourceMessageIds 的第一个编号就是主线，其余编号只用于补充或收束。chosenPath 用 25-60 字说明本轮先采用谁的哪条判断，以及为什么适合用户现在开始。行动都沿着这条主线递进，不要把不同先行者的练习拼成任务大礼包。",
      "再从交锋中找出对这条主线最有力的一条反对意见。guardrail 用 25-70 字写成明确的“如果主线行动导致了反方担心的风险，就缩小、暂停或调整”的条件；护栏必须降低风险，不能反过来强化主线。sourceMessageIds 至少包含主线发言和这条反对意见。不要增加第二套行动。",
      "24 小时动作 25-58 字，只完成一次基线观察或交付一件东西，最多两个检查项；7 天实验 35-78 字，必须在 24 小时结果上增加比较、反馈或变量测试，不能只是每天重复同一句自问；30 天练习 40-82 字，要把验证结果变成固定节奏、环境边界或决策规则，不能只是把 7 天延长，也不在其中嵌套“若无效就改做另一件事”的备用路径。三阶段必须产生不同层次的结果。副业刚起步时，不擅自要求 30 天内达到某个工资百分比；优先观察作品、询价、付费意愿和时间是否可持续。复盘证据 25-64 字，只列 3 个可观察指标。每项只写一句，使用直接、自然的现代中文，并返回 2-4 个实际承接的 sourceMessageIds。",
      "每张金句卡的 quote 必须是一句脱离上下文也完整通顺的话，不能以“而是、但是、因为、如果”等连接词开头。context 只说明它与本轮问题的关系，20-55 字；不使用“根源、本质、深层恐惧、真正害怕、这说明你”替用户解释隐藏原因。有 2 条以上候选时返回 2-3 张金句卡；有候选金句时必须返回对应 sourceMessageId。",
      /(说不清|不知道|不明)/.test(session.question)
        ? "用户明确不知道原因：chosenPath、行动和金句 context 只能帮助观察出现时间、身体位置、外界干扰与变化，不得写“内在淤塞、等待表达、未被安放”，也不得断言空间或情绪就是原因。"
        : ""
    ].join("\n");

    try {
      const result = await generateJson<{
        actionCard: ActionCardDraft;
        quoteCards: Array<Omit<QuoteCard, "sessionId"> & { sourceMessageId?: string }>;
      }>("roundtable_finalize", schema, prompt);
      const candidateById = new Map(quoteCandidates.map((message) => [message.id, message]));
      const groundedQuoteCards = result.data.quoteCards
        .map((quoteCard) => {
          const source = quoteCard.sourceMessageId ? candidateById.get(quoteCard.sourceMessageId) : undefined;
          if (quoteCandidates.length && !source) return undefined;
          return {
            ...quoteCard,
            sessionId: session.id,
            speakerId: source?.speakerId ?? quoteCard.speakerId,
            quote: source?.quote ?? quoteCard.quote,
            context: renderQuoteContext(quoteCard.context, source?.speakerId ?? quoteCard.speakerId, session.theme)
          } satisfies QuoteCard;
        })
        .filter((quoteCard): quoteCard is QuoteCard => Boolean(quoteCard));

      const selectedQuoteMessageIds = new Set(groundedQuoteCards.map((card) => card.sourceMessageId));
      const minimumQuoteCards = Math.min(2, quoteCandidates.length);
      const supplementalQuoteCards = quoteCandidates
        .filter((message) => !selectedQuoteMessageIds.has(message.id))
        .slice(0, Math.max(0, minimumQuoteCards - groundedQuoteCards.length))
        .map((message) => ({
          sessionId: session.id,
          speakerId: message.speakerId,
          quote: message.quote,
          sourceMessageId: message.id,
          context: compactText(
            `本轮圆桌提炼｜${pioneerById.get(message.speakerId)?.figure ?? "先行者"}对「${session.theme}」的提醒`,
            55
          )
        }));
      const quoteCards = groundedQuoteCards.length || supplementalQuoteCards.length
        ? [...groundedQuoteCards, ...supplementalQuoteCards].slice(0, 3)
        : fallbackFinal(session, selected, messages).quoteCards;
      const groundedActionSourceIds = (result.data.actionCard.sourceMessageIds ?? [])
        .map((alias) => actionSourceIdByAlias.get(alias))
        .filter((id): id is string => Boolean(id));
      if (actionLead && !groundedActionSourceIds.includes(actionLead.message.id)) {
        groundedActionSourceIds.unshift(actionLead.message.id);
      }
      const proposedActionMessages = actionSourceMessages.filter(
        (message) => message.speechAct === "propose_action"
      );
      for (const message of proposedActionMessages) {
        if (!groundedActionSourceIds.includes(message.id)) groundedActionSourceIds.push(message.id);
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
      ].flatMap((content) => findUnknownCauseIssues(content, session.question));
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
