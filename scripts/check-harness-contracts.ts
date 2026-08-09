import assert from "node:assert/strict";
import { historicalEchoes, matchHistoricalEcho } from "@/data/historical-echoes";
import { pioneers } from "@/data/pioneers";
import {
  classifyUserTurnIntent,
  ensureRequestedSecondary,
  findCorrectionTerm,
  sanitizeDiscussionPlan,
  sanitizeFollowUpPlan
} from "@/lib/harness/director";
import { retrieveSourceNoteMatches } from "@/lib/harness/source-retriever";
import {
  breakLongSentences,
  compactQuote,
  composePioneerTurn,
  findConversationOverlap,
  findClarityIssues,
  findSegmentIssues,
  findUnknownCauseIssues,
  guardPioneerContent,
  guardSafety,
  groundQuoteInContent,
  ensureFirstPerson,
  segmentTurnContent,
  softenUnsupportedInference
} from "@/lib/harness/output-guard";
import { classifySupportContext, resolveTurnSupportContext } from "@/lib/harness/support-mode";
import {
  actionAcknowledgesContext,
  actionCardGuardIssues,
  actionCardIsGrounded,
  actionCardQualityIssues,
  buildFallbackOpening,
  contributionIsVisibleInContent,
  dedupeClosingQuotes,
  dedupeFallbackTurn,
  fallbackFinal,
  resolveActionCard,
  resolveActionSourceIds,
  resolveGuardedQuoteCards,
  resolveHistoricalEcho,
  tensionLeakedIntoOpening
} from "@/lib/harness/stage-generator";
import {
  buildLanguageRepairPrompt,
  checkCoherence,
  checkFactBoundary,
  checkGrammar,
  checkHostOpening,
  checkLanguage,
  checkListenerFraming,
  checkMetaphorNaturalness,
  checkNaturalness,
  checkReferenceClarity,
  hasHardLanguageIssue
} from "@/lib/harness/language-editor";
import {
  canComposeComposite,
  createDefaultCardPreferences,
  quoteCardId,
  restoreCardPreferences,
  selectedQuoteCardsFor,
  toggleCardId
} from "@/lib/card-preferences";
import { selectPioneerFallbackMove } from "@/lib/harness/pioneer-mind";
import { classifyQuestionIntent, questionTaskFrame } from "@/lib/harness/question-intent";
import type { QuoteCard, RoundtableMessage, RoundtableSession } from "@/lib/types";

assert.equal(pioneers.length, 9, "Expected exactly nine pioneer profiles");
assert.equal(new Set(pioneers.map((pioneer) => pioneer.id)).size, 9, "Pioneer ids must be unique");
const pioneerByIdForContracts = new Set(pioneers.map((pioneer) => pioneer.id));
assert.equal(
  new Set(historicalEchoes.map((echo) => echo.id)).size,
  historicalEchoes.length,
  "Historical echo ids must be unique"
);

assert.ok(
  guardSafety("我保证你能做到。接下来先试一次。 ").startsWith("我不能替结果作保证，但你能做到。"),
  "Safety guard must preserve grammatical sentences instead of replacing isolated words"
);

const adaRetrieval = retrieveSourceNoteMatches(
  "ada-lovelace",
  {
    question: "我有很多灵感，却一直没有真正开始。",
    theme: "从灵感到行动",
    tension: "继续想象还是先做一个小版本",
    need: "定义输入、输出和最小可运行原型"
  },
  1
);
assert.equal(
  adaRetrieval[0]?.note.id,
  "ada-practice-prototype",
  "Prototype questions should retrieve Ada's prototype source rather than the first note"
);
assert.ok(
  (adaRetrieval[0]?.matchedTerms.length ?? 0) > 0,
  "Hybrid retrieval must preserve an explainable match signal"
);
assert.ok(
  historicalEchoes.every(
    (echo) => pioneerByIdForContracts.has(echo.pioneerId) && echo.work.trim() && echo.sourceUrl.startsWith("https://")
  ),
  "Every historical echo must name a known pioneer and a verifiable HTTPS source"
);
assert.equal(
  matchHistoricalEcho("jane-austen", "这场谈话讨论朋友关系里的温柔与自尊")?.id,
  "austen-emma-tenderness",
  "A historical echo should match the closing note theme"
);
assert.equal(matchHistoricalEcho("qin-liangyu", "边界与责任"), undefined, "Missing verified text must stay missing");
assert.equal(
  matchHistoricalEcho("li-qingzhao", "我正在观察自我否定"),
  undefined,
  "A single broad tag must not force an unrelated historical echo"
);
assert.equal(
  matchHistoricalEcho("wu-zetian", "这场谈话只是在讨论行动与选择"),
  undefined,
  "Broad action tags alone must not force a historical echo"
);

for (const pioneer of pioneers) {
  const voice = pioneer.voiceProfile;
  assert.ok(pioneer.addressName.trim(), `${pioneer.id} is missing its roundtable address name`);
  assert.ok(voice.rhythm.trim(), `${pioneer.id} is missing voice rhythm`);
  assert.ok(voice.tone.trim(), `${pioneer.id} is missing voice tone`);
  assert.ok(voice.firmness.trim(), `${pioneer.id} is missing voice firmness`);
  assert.ok(voice.directness.trim(), `${pioneer.id} is missing voice directness`);
  assert.ok(voice.responsePosture.trim(), `${pioneer.id} is missing response posture`);
  assert.ok(voice.questionStyle.trim(), `${pioneer.id} is missing question style`);
  assert.ok(voice.humor.trim(), `${pioneer.id} is missing humor guidance`);
  assert.ok(voice.reasoningMove.trim(), `${pioneer.id} is missing reasoning move`);
  assert.ok(voice.preferredWords.length >= 3, `${pioneer.id} needs at least three preferred words`);
  assert.ok(voice.avoidPatterns.length >= 2, `${pioneer.id} needs at least two avoid patterns`);
  assert.ok(voice.imageryBudget === 0 || voice.imageryBudget === 1, `${pioneer.id} imagery budget must be 0 or 1`);
  assert.ok(voice.crossfireClaim.trim(), `${pioneer.id} is missing a crossfire claim`);
  assert.ok(voice.counterRisk.trim(), `${pioneer.id} is missing a counter risk`);
  assert.ok(voice.preferredSpeechActs.length >= 3, `${pioneer.id} needs at least three preferred speech acts`);
}

const pioneerMindSample = pioneers.filter((pioneer) =>
  ["li-qingzhao", "jane-austen", "ada-lovelace"].includes(pioneer.id)
);
assert.equal(pioneerMindSample.length, 3, "The first PioneerMind sample must contain three pioneers");
for (const pioneer of pioneerMindSample) {
  assert.ok(pioneer.mind, `${pioneer.id} is missing its PioneerMind`);
  assert.ok(
    (pioneer.mind?.fallbackMoves.length ?? 0) >= 2,
    `${pioneer.id} needs intent-aware fallback moves`
  );
  assert.ok(
    pioneer.sourceNotes.some(
      (note) =>
        note.sourceKind &&
        note.confidence &&
        (note.sourceUrl?.startsWith("https://") || note.sourceKind === "contemporary_projection")
    ),
    `${pioneer.id} needs source metadata for historical grounding`
  );
}

assert.equal(
  classifyQuestionIntent("如何提升自己的表达能力？").primary,
  "skill_building",
  "A direct skill question must not fall into emotional-support mode"
);
const expressionSession = {
  id: "expression-skill-contract",
  question: "如何提升自己的表达能力？",
  theme: "表达能力",
  tension: "想说清楚，但缺少稳定练习与反馈",
  supportMode: "experience_context",
  explicitEmotionTerms: [],
  selectedPioneerIds: ["li-qingzhao", "jane-austen", "ada-lovelace"],
  stage: "first_round",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
} satisfies RoundtableSession;
const expressionOpening = buildFallbackOpening(expressionSession, pioneerMindSample);
assert.equal(
  expressionOpening.content,
  "三位先行者已经入席。关于表达这件事，不妨先听听她们怎么想。",
  "Expression opening should confirm the seats and invite the conversation"
);
assert.equal(
  checkHostOpening(
    expressionOpening.content,
    pioneerMindSample.map((pioneer) => pioneer.figure)
  ).length,
  0,
  "Expression opening must pass the host-language contract"
);
assert.ok(
  pioneerMindSample.every((pioneer) => !expressionOpening.content.includes(pioneer.figure)),
  "The host must not narrate each pioneer's assignment"
);
assert.ok(
  questionTaskFrame(expressionSession.question).includes("不能把反馈设计成考听者"),
  "Expression feedback must remain the speaker's responsibility rather than testing the listener"
);
const expressionFallbackIds = pioneerMindSample.map(
  (pioneer) => selectPioneerFallbackMove(pioneer, expressionSession)?.id
);
assert.deepEqual(
  expressionFallbackIds,
  ["expression-skill", "expression-audience", "skill-loop"],
  "The expression question should trigger three distinct, person-specific reasoning moves"
);
assert.equal(
  new Set(
    pioneerMindSample.map(
      (pioneer) => selectPioneerFallbackMove(pioneer, expressionSession)?.judgment
    )
  ).size,
  3,
  "Person-specific fallbacks must not collapse into the same generic advice"
);
assert.equal(
  guardPioneerContent("你可以先说清最想让对方听见的那一句。", 220, "", 72, false),
  "你可以先说清最想让对方听见的那一句。",
  "A natural direct sentence must not receive a forced first-person preface"
);
assert.ok(
  guardPioneerContent("我同意先缩小范围，但还需要知道听者会怎样理解。", 220, "", 72, false).startsWith(
    "我同意"
  ),
  "A meaningful first-person agreement must remain available"
);

const guardedTurn = composePioneerTurn({
  acknowledgement: "我也曾经历过和你完全一样的处境",
  judgment: "你真正害怕的是失败",
  reason: "现在还没有足够证据",
  nextStep: "今天记录一个可以验证的小动作"
});

assert.ok(guardedTurn.includes("我"), "Rendered pioneer turn must use first person");
assert.ok(
  ensureFirstPerson("羞耻是一种过于清醒的自我辨认。", "我想先说：").startsWith("我想先说："),
  "The word '自我' must not satisfy the first-person voice requirement"
);
const expandableTurn =
  "我不愿意只用一次沉默判断自己的能力。先看哪些作品真正得到过回应，再区分是方向需要调整，还是投递对象并不合适。这样做不是安慰自己，而是给下一步留下可以核对的依据。";
const expandableSegments = segmentTurnContent(expandableTurn);
assert.equal(expandableSegments.length, 2, "A substantial turn should become two display bubbles");
assert.ok(
  expandableSegments.every((segment) => segment.length <= 68),
  "Each display bubble must stay within the visual length limit"
);
assert.equal(expandableSegments.join(""), expandableTurn, "Display bubbles must preserve the complete semantic turn");
assert.equal(
  findSegmentIssues(expandableSegments, expandableTurn).length,
  0,
  "A valid two-bubble turn should pass segment contracts"
);
const semanticPauseTurn =
  "我会换一个角度看：将亏欠当成首要感受时，你也把评判交往的标尺交给了别人。不妨看清自己在这段关系中的位置：你所在意的亏欠，真是对方要求的，还是你自己默许的？若维持友谊只为了消除这种感受，它已不再是相称的交换。";
const semanticPauseSegments = segmentTurnContent(semanticPauseTurn);
assert.equal(semanticPauseSegments.length, 2, "A long turn should use two display bubbles");
assert.notEqual(semanticPauseSegments[0].at(-1), "，", "A stronger semantic pause should win over a comma");
assert.equal(semanticPauseSegments.join(""), semanticPauseTurn, "Semantic splitting must preserve the full turn");
assert.ok(
  findSegmentIssues(["我会先观察这件事。", "我会先观察这件事。"], "我会先观察这件事。我会先观察这件事。").length > 0,
  "A continuation bubble must add information instead of repeating the first"
);
assert.ok(guardedTurn.length <= 100, "Rendered pioneer turn must stay within 100 Chinese characters");
assert.equal(findClarityIssues(guardedTurn, 100).length, 0, "Rendered pioneer turn violates clarity rules");
assert.ok(compactQuote("这是一句非常非常长而且不适合放在分享卡上的金句示例文字").length <= 22);
assert.equal(softenUnsupportedInference("你要长回自己，把答案还给自己"), "你要按自己的方式生活，由你自己做决定");
assert.ok(
  !guardPioneerContent("醒时的沉重，我也有过。我会先观察它什么时候变化。").includes("我也有过"),
  "Unsupported first-person biography should be removed"
);
assert.ok(
  softenUnsupportedInference("身体不会无故变沉").includes("原因还不能确定"),
  "Ambiguous physical feelings must not be assigned a certain cause"
);
assert.equal(
  softenUnsupportedInference("先做基线评分，再判断是否存在情绪劳动或内在空间被侵占"),
  "先做第一次记录，再判断是否存在承接对方情绪的疲惫或独处和思考的余地越来越少",
  "Psychology and evaluation jargon should be rewritten in everyday language"
);
assert.ok(
  softenUnsupportedInference("今天定个二十分钟的时，只整理一处。").includes("二十分钟的时间"),
  "An incomplete time phrase should be repaired before display"
);
assert.equal(
  softenUnsupportedInference("我认为你的内在空间被占据，所以要先停下来。"),
  "我认为你的独处和思考的余地越来越少，所以要先停下来。",
  "Crossfire copy should become direct, everyday Chinese before rendering"
);
assert.ok(
  findClarityIssues("只有独处和思考的余地复原了。", 100).length > 0,
  "Incomplete '只有' conditions should be rejected"
);
assert.ok(
  findUnknownCauseIssues(
    "也许它不是凭空来的，而是一些不曾辨认的哀悼。",
    "每天醒来身体沉沉的，但我说不清为什么。"
  ).length > 0,
  "Unknown physical feelings must not be reframed as invented grief"
);
assert.ok(
  findUnknownCauseIssues(
    "你避开它，以为能换来轻松，可这笔沉默的账一直在支付利息。",
    "每天醒来身体沉沉的，但我说不清为什么。"
  ).length > 0,
  "Unknown physical feelings must not be assigned an avoidance narrative"
);
assert.ok(
  findUnknownCauseIssues(
    "那沉沉的不是困乏，而是心里有东西还没成形。",
    "每天醒来身体沉沉的，但我说不清为什么。"
  ).length > 0,
  "A literary hidden cause must be rejected even when it avoids clinical language"
);
assert.ok(
  findUnknownCauseIssues(
    "心口的重量也许和把别人的责任误当成自己的底线。",
    "每天醒来身体沉沉的，但我说不清为什么。"
  ).length > 0,
  "An unsupported causal guess must not become a statement"
);
assert.ok(
  findClarityIssues("心口的重量也许和把别人的责任误当成自己的底线。", 100).length > 0,
  "A causal clause without a predicate must be rejected"
);
assert.equal(
  findUnknownCauseIssues(
    "我暂时不解释原因，只观察它何时出现、何时变化。",
    "每天醒来身体沉沉的，但我说不清为什么。"
  ).length,
  0,
  "Observation without causal attribution should remain allowed"
);

assert.deepEqual(
  classifySupportContext("每天醒来身体沉沉的，可我说不清那到底是什么，也不知道为什么。"),
  { mode: "unknown_cause", explicitEmotionTerms: [] },
  "An unexplained feeling should enter unknown-cause support mode"
);
assert.equal(
  classifySupportContext("朋友关系让我很累又觉得亏欠，不知道该继续还是退出。").mode,
  "experience_context",
  "A difficult choice containing '不知道' must not be mistaken for an unknown cause"
);
assert.deepEqual(
  classifySupportContext("我最近总有一种羞耻感，觉得自己不够好，但不想再否定自己。"),
  { mode: "named_emotion", explicitEmotionTerms: ["羞耻"] },
  "A user-named emotion should be available for direct emotional support"
);
assert.deepEqual(
  classifySupportContext("被老板否定后，我感到羞耻。"),
  { mode: "experience_context", explicitEmotionTerms: ["羞耻"] },
  "An emotion tied to an explicit event should remain in experience-context mode"
);
assert.equal(
  findUnknownCauseIssues(
    "这段关系让你反复消耗，也让退出显得像一种亏欠。",
    "朋友关系让我很累又觉得亏欠，不知道该继续还是退出。"
  ).length,
  0,
  "Relationship dilemmas must not receive unknown-cause restrictions"
);

const unknownCauseSession = {
  id: "support-mode-contract",
  question: "每天醒来身体沉沉的，可我说不清为什么。",
  theme: "模糊情绪",
  tension: "寻找解释与容许未知",
  supportMode: "unknown_cause",
  explicitEmotionTerms: [],
  selectedPioneerIds: ["li-qingzhao", "ban-zhao", "marie-curie"],
  stage: "follow_up",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
} satisfies RoundtableSession;
assert.deepEqual(
  resolveTurnSupportContext(unknownCauseSession, "我现在意识到，那更像是一种羞耻。"),
  { mode: "named_emotion", explicitEmotionTerms: ["羞耻"] },
  "A follow-up should upgrade the support mode when the user names an emotion"
);
assert.equal(
  findUnknownCauseIssues("我听见了你说的羞耻，我们先看看它在哪些时刻变重。", unknownCauseSession.question, {
    mode: "named_emotion",
    explicitEmotionTerms: ["羞耻"]
  }).length,
  0,
  "A user-named emotion must remain available after an unknown-cause opening"
);
const splitLongTurn = guardPioneerContent(
  "我不愿意这么快下结论：把副业看作可验证假设，这容易让人追逐每个假设的成败，却忽略积累需要另一种证据。"
);
assert.ok(
  !findClarityIssues(splitLongTurn, 100).includes("包含超过 48 字的长句"),
  "Rendered turns should split long clauses without leaving a dangling conjunction"
);
assert.ok(
  !breakLongSentences("你想过辞职，却又怕一旦收入不稳，连现有积累也会落空。", 28).includes("收入不稳。连"),
  "Conditional clauses must not be split before their consequence"
);
assert.ok(
  !guardPioneerContent("我想到一件事。”它还没有名字。").includes("”"),
  "Unmatched Chinese quotation marks should be removed"
);
assert.ok(
  findClarityIssues("这个过程本身就是在建造一个可运行原型——每试一次。", 100).length > 0,
  "Dangling sentence fragments should be rejected"
);
assert.ok(
  findClarityIssues("我想换一个角度看——可是。关系里的事实还没有核对。", 100).includes(
    "包含悬空的连接词"
  ),
  "Dangling conjunctions should trigger a rewrite"
);
const firstPersonAfterCompaction = guardPioneerContent(
  "你说讲情义，可忠实的是哪一种标准？真正的义气是守住彼此成事的底线，不是单方面承接消耗。我会坚持这个判断。",
  60,
  "我不愿意这么快下结论："
);
assert.ok(firstPersonAfterCompaction.includes("我"), "Compaction must not remove the only first-person marker");

const firstRoundMessages: RoundtableMessage[] = [
  {
    id: "ada-turn",
    sessionId: "contract-session",
    role: "pioneer",
    speakerId: "ada-lovelace",
    stage: "first_round",
    content: "先做一个只回答核心问题的最小样稿，今天就能拿到真实输入。",
    sourceNoteIds: ["ada-note"],
    createdAt: new Date().toISOString()
  },
  {
    id: "wu-turn",
    sessionId: "contract-session",
    role: "pioneer",
    speakerId: "wu-zetian",
    stage: "first_round",
    content: "先算清最多能投入多少时间和现金，再决定做到哪一步。",
    sourceNoteIds: ["wu-note"],
    createdAt: new Date().toISOString()
  }
];
assert.deepEqual(
  sanitizeDiscussionPlan(
    {
      mode: "crossfire",
      label: "温和交锋",
      speakerIds: ["ada-lovelace", "wu-zetian"],
      primaryMessageIds: ["ada-turn", "wu-turn"],
      focus: "把做原型与控制投入伪装成冲突",
      rationale: "人物不同，所以应当争论",
      hasTrueConflict: false
    },
    firstRoundMessages
  ).mode,
  "sequence",
  "A discussion without a real priority conflict must not remain crossfire"
);
assert.equal(
  sanitizeDiscussionPlan(
    {
      mode: "complement",
      label: "共同完善",
      speakerIds: ["ada-lovelace", "wu-zetian"],
      primaryMessageIds: ["missing", "wu-turn"],
      focus: "补全验证边界",
      rationale: "推进同一个决策",
      hasTrueConflict: false
    },
    firstRoundMessages
  ).mode,
  "clarify",
  "Discussion plans may reference only messages that were actually spoken"
);
assert.equal(
  classifyUserTurnIntent("什么亏欠？我没有提到任何的亏欠"),
  "user_correction",
  "An explicit denial must route to correction rather than ordinary follow-up"
);
assert.equal(
  classifyUserTurnIntent("我明白了，那我可以如何锻炼呢？"),
  "question",
  "A request for practice after acknowledging must remain a question"
);
assert.equal(
  classifyUserTurnIntent("怎么判断是我没说清楚，还是对方不熟悉这个话题？"),
  "question",
  "A diagnostic question must not be mistaken for a correction or rebuttal"
);
assert.equal(
  classifyUserTurnIntent("好的，我明白了"),
  "closure",
  "A standalone acknowledgement should close briefly"
);
const selectedForFollowUp = pioneers.filter((pioneer) =>
  ["jane-austen", "qin-liangyu", "ban-zhao"].includes(pioneer.id)
);
assert.equal(
  sanitizeFollowUpPlan(
    {
      primaryPioneerId: "jane-austen",
      secondaryPioneerId: "qin-liangyu",
      secondaryMode: "challenge",
      focus: "重新检查关系风险",
      rationale: "继续制造分歧"
    },
    selectedForFollowUp,
    "jane-austen",
    "commitment"
  ).secondaryMode,
  "none",
  "A commitment or closure must not reopen the table with a second pioneer"
);
assert.equal(
  sanitizeFollowUpPlan(
    {
      primaryPioneerId: "jane-austen",
      secondaryPioneerId: "qin-liangyu",
      secondaryMode: "alternate",
      focus: "从责任边界补充另一种判断",
      rationale: "用户明确邀请另一种视角"
    },
    selectedForFollowUp,
    "jane-austen",
    "request_other_view"
  ).secondaryPioneerId,
  "qin-liangyu",
  "An explicit request for another view may invite a different seated pioneer"
);
assert.ok(
  ensureRequestedSecondary(
    {
      primaryPioneerId: "jane-austen",
      secondaryMode: "none",
      focus: "只回应本轮内容",
      rationale: "模型没有安排第二位"
    },
    selectedForFollowUp,
    "jane-austen",
    "request_other_view",
    []
  ).secondaryPioneerId,
  "An explicit request for another view must be completed even when the model returns none"
);
assert.equal(
  findCorrectionTerm("什么亏欠？我没有提到任何的亏欠", firstRoundMessages.concat({
    ...firstRoundMessages[0],
    id: "bad-assumption",
    content: "你可能一直在偿还关系里的亏欠。"
  })),
  "亏欠",
  "The correction path must identify the unsupported term in prior system speech"
);
assert.ok(
  !guardPioneerContent("我会先问：你手里有多少时间、现金和退路？").startsWith("我会先问"),
  "Empty first-person framing should be removed"
);
assert.ok(
  guardPioneerContent("我不同意把一次沉默当成结论。").startsWith("我不同意"),
  "Meaningful first-person disagreement should remain"
);

const groundedQuote = groundQuoteInContent(guardedTurn, "正文里不存在的漂亮话", "现在还没有足够证据");
assert.ok(guardedTurn.includes(groundedQuote), "Quote must be grounded in the rendered pioneer turn");

assert.ok(
  findConversationOverlap(
    "我不愿意因为简历没有回音，就把它当成能力不足的证据。",
    ["简历没有回音，这很容易让你怀疑自己的能力。"]
  ).length > 0,
  "Near-duplicate openings should be detected"
);
assert.equal(
  findConversationOverlap(
    "我想先分开两件事：公司的回应不由你控制，投递节奏仍由你决定。",
    ["我不愿意把几次沉默叫作能力不足，目前的证据还不够。"]
  ).length,
  0,
  "Distinct contributions should not be flagged as duplicates"
);

// --- Deterministic assertions for the three P2 fixes (judge-independent, zero-variance) ---

// Fix 1: closing quotes must be distinct per pioneer; a verbatim collision is rewritten
// to that pioneer's own unique closing note rather than left duplicated.
const collidingQuoteCards: QuoteCard[] = [
  {
    sessionId: "dedupe-contract",
    speakerId: "wu-zetian",
    quote: "先算清能投入多少，再决定是否继续。",
    context: "本场赠言｜示例",
    kind: "closing_note"
  },
  {
    sessionId: "dedupe-contract",
    speakerId: "li-qingzhao",
    quote: "先算清能投入多少，再决定是否继续。",
    context: "本场赠言｜示例",
    kind: "closing_note"
  }
];
const dedupeSelected = pioneers.filter((pioneer) => ["wu-zetian", "li-qingzhao"].includes(pioneer.id));
const dedupeSession = {
  ...unknownCauseSession,
  id: "dedupe-contract",
  selectedPioneerIds: ["wu-zetian", "li-qingzhao"]
} satisfies RoundtableSession;
const dedupedQuoteCards = dedupeClosingQuotes(collidingQuoteCards, dedupeSelected, dedupeSession);
assert.notEqual(
  dedupedQuoteCards[0].quote,
  dedupedQuoteCards[1].quote,
  "Two pioneers must not leave a verbatim-identical closing quote"
);
assert.ok(
  dedupedQuoteCards[1].quote.trim().length > 0,
  "A de-duplicated closing quote must fall back to a real, non-empty note"
);

// Fix 2: an offer_one_step turn that jumps straight to a directive without acknowledging
// prior context must be rejected; a turn that bridges from prior content passes.
assert.equal(
  actionAcknowledgesContext("今天写下三条清单。", ["先看看你手里有多少时间和退路。"]),
  false,
  "A bare directive that ignores prior context must not satisfy the acknowledgement check"
);
assert.equal(
  actionAcknowledgesContext("你提到的那份证据，今天先记录一条。", ["先留下能比较的记录，再让结果说话。"]),
  true,
  "A turn that bridges from prior content should pass the acknowledgement check"
);

// Fix 3: the contribution-visibility check is a boolean signal (downgraded from a hard
// failure to a soft one), so it never forces a fallback on its own.
assert.equal(
  contributionIsVisibleInContent("我先分清轻重缓急，再把力气放回手里。", "分清轻重缓急"),
  true,
  "A contribution echoed in the body must read as visible"
);
assert.equal(
  contributionIsVisibleInContent("今天的天气格外晴朗，很适合出门散步。", "先算清时间与退路"),
  false,
  "A contribution absent from the body must read as not visible"
);
assert.equal(
  contributionIsVisibleInContent("任意正文都可以。", ""),
  true,
  "An empty contribution must never block a turn"
);

// ---------------------------------------------------------------------------
// Language Editor：四类语言问题的确定性判定。
// 事实边界是硬红线，其余三类作为 repair 信号。
// ---------------------------------------------------------------------------

// 事实边界必须条件化：用户说过就允许承接，没说过才算越界。
// 这样规则对任何情绪词、任何题型都成立，而不是禁用某几个词。
assert.equal(
  checkFactBoundary("紧张的时候先说结论。", "我一到汇报就特别紧张，怎么提升表达能力？", []).length,
  0,
  "An emotion the user stated themselves must remain available to acknowledge"
);
assert.ok(
  checkFactBoundary("你紧张的时候先说结论。", "说出来总让人抓不住重点，应该怎样练习？", []).length > 0,
  "An emotion the user never stated must be flagged as an unauthorized inner state"
);
assert.equal(
  checkFactBoundary("这份羞耻不必急着解释。", "我不知道该怎么办", ["羞耻"]).length,
  0,
  "explicitEmotionTerms must authorize acknowledging that emotion"
);
assert.ok(
  checkFactBoundary("这份焦虑先记下来。", "我该选哪个 offer？", []).length > 0,
  "The fact-boundary rule must hold outside expression-skill questions too"
);
assert.ok(
  hasHardLanguageIssue(checkFactBoundary("你害怕被评价。", "怎么练习汇报？", [])),
  "A fact-boundary violation must count as a hard language issue"
);
assert.equal(
  hasHardLanguageIssue(checkNaturalness("先建立一个反馈循环。")),
  false,
  "Naturalness issues must stay soft repair signals rather than hard failures"
);

// 听者框定：按句式判断，不绑定人物 id。
// 这两种句式此前分别只对 jane-austen 和 ada-lovelace 生效。
for (const listenerFramingCase of [
  "先想清楚对方要从你话里拿走什么。",
  "对方必须从这段话里找到结论。",
  "不要把判断责任推给听者。",
  "把理解的责任交给对方并不公平。"
]) {
  assert.ok(
    checkListenerFraming(listenerFramingCase).length > 0,
    `Listener framing must be caught by shape, not by pioneer id: ${listenerFramingCase}`
  );
}
for (const naturalListenerCase of [
  "先说明你希望对方先听懂哪一点。",
  "问问对方最先听懂了什么、哪里还需要补充。",
  "她需要先知道结论，再听依据。"
]) {
  assert.equal(
    checkListenerFraming(naturalListenerCase).length,
    0,
    `Natural listener phrasing must not be flagged: ${naturalListenerCase}`
  );
}

// 中文语法：杂糅句式。
assert.ok(
  checkGrammar("你要把认真准备的内容，让听者更容易听懂重点。").length > 0,
  "A conflated 把/让 sentence must be reported as a grammar issue"
);
assert.equal(
  checkGrammar("先写一句核心观点，再保留两条必要补充。").length,
  0,
  "A well-formed sentence must not be reported"
);

// 对话衔接：只有套话、没有实质承接才算问题。
assert.ok(
  checkCoherence("我想先分清一件事。", ["先确定这次最想让对方听懂的重点。"]).length > 0,
  "A hollow bridge with no anchor in prior content must be flagged"
);
assert.equal(
  checkCoherence("我想先分清对方听懂的重点和你想说的重点。", ["先确定这次最想让对方听懂的重点。"]).length,
  0,
  "A bridge that genuinely picks up prior content must pass"
);
assert.equal(
  checkCoherence("我想先分清一件事。", [], true).length,
  0,
  "The first speaker has no prior turn to pick up, so coherence must not apply"
);

// repair 指令只在存在问题时生成，且不得夹带新判断。
assert.equal(buildLanguageRepairPrompt([]).length, 0, "No issues must produce no repair instruction");
assert.ok(
  buildLanguageRepairPrompt(checkGrammar("你要把准备好的内容，让对方更容易懂。")).includes("语言编辑要求"),
  "A grammar issue must produce a scoped language-repair instruction"
);

// ---------------------------------------------------------------------------
// 主持人 grounded opening：InternalTension 不得冒充用户意图。
// ---------------------------------------------------------------------------

const tensionLeakSession = {
  ...expressionSession,
  id: "tension-leak-contract",
  question: "我认真准备了很多内容，但说出来总让人抓不住重点，应该怎样练习？",
  tension: "信息完整、重点清楚和听者理解之间的取舍"
} satisfies RoundtableSession;

assert.ok(
  tensionLeakedIntoOpening(
    "你想知道，怎样在信息完整、重点清楚和听者理解之间取舍。",
    tensionLeakSession
  ),
  "Reciting the internal tension model as the user's own intent must be caught"
);
assert.equal(
  tensionLeakedIntoOpening(
    "你想知道，怎样练习才能让认真准备的内容更容易被听懂。",
    tensionLeakSession
  ),
  false,
  "An opening grounded in the user's own words must pass"
);
// 用户自己说出取舍框架时，复述不算泄漏。
assert.equal(
  tensionLeakedIntoOpening("你在重点清楚和信息完整之间取舍。", {
    ...tensionLeakSession,
    question: "我该在重点清楚和信息完整之间怎么取舍？"
  }),
  false,
  "If the user framed the tradeoff themselves, restating it is not a leak"
);

// 开场只确认入席并邀请圆桌开始，不播报人物分工。
const openingContract = buildFallbackOpening(tensionLeakSession, pioneerMindSample);
assert.equal(
  openingContract.content,
  "三位先行者已经入席。关于表达这件事，不妨先听听她们怎么想。",
  "Grounded opening should remain brief and conversational"
);
assert.equal(
  checkHostOpening(
    openingContract.content,
    pioneerMindSample.map((pioneer) => pioneer.figure)
  ).length,
  0,
  "The fallback opening must pass the host-language contract"
);
assert.ok(
  checkHostOpening(
    "本场将由李清照看重点与字句，简·奥斯汀看听者需要，阿达·洛夫莱斯看练习方法。",
    pioneerMindSample.map((pioneer) => pioneer.figure)
  ).some((issue) => issue.category === "naturalness"),
  "The host guard must reject person-by-person assignment narration"
);
assert.ok(
  checkHostOpening(
    "李清照、简·奥斯汀与阿达·洛夫莱斯都曾经历过与你相似的困境。",
    pioneerMindSample.map((pioneer) => pioneer.figure)
  ).some((issue) => issue.category === "fact_boundary"),
  "The host guard must reject invented shared biographies"
);
assert.equal(
  checkFactBoundary(openingContract.content, tensionLeakSession.question, []).length,
  0,
  "The fallback opening must not invent feelings the user never stated"
);

// ---------------------------------------------------------------------------
// fallback 二次去重：四个比较范围 + 替换后必须再次校验。
// ---------------------------------------------------------------------------

// 独立实现的撞车判定，用于验证「替换后确实不再重复」。
// 刻意不复用 stage-generator 内部函数，避免检查只是复述实现。
function collidesForContract(content: string, priorContents: string[]) {
  const normalized = content.trim();
  return priorContents.some((prior) => {
    const priorText = prior.trim();
    if (priorText === normalized) return true;
    for (let start = 0; start + 14 <= normalized.length; start += 1) {
      const fragment = normalized.slice(start, start + 14);
      if (/[，。；：！？\s]/.test(fragment)) continue;
      if (priorText.includes(fragment)) return true;
    }
    return false;
  });
}

const dedupePioneer = pioneers.find((pioneer) => pioneer.id === "ada-lovelace")!;
const dedupeAssignment = {
  pioneerId: dedupePioneer.id,
  speechAct: "propose_action",
  relation: "extend",
  objective: "把练习拆成可观察的步骤",
  newContribution: "一次只改一个环节",
  actionMode: "offer_one_step"
} as const;
const dedupeTurn = (content: string) => ({ content, segments: [content], quote: "" });

// 未撞车时原样返回。
const uncollided = dedupeFallbackTurn(
  dedupeTurn("选一个高频场景，先写一句核心观点和两条必要补充。"),
  ["完全无关的另一段内容。"],
  dedupePioneer,
  expressionSession,
  expressionSession.question,
  dedupeAssignment
);
assert.equal(
  uncollided.content,
  "选一个高频场景，先写一句核心观点和两条必要补充。",
  "A turn that collides with nothing must pass through untouched"
);

// 与其他人物本场发言撞车时必须换角度，而不是沿用原句。
const collidedContent = "选一个高频场景，先写一句核心观点和两条必要补充。";
const decollided = dedupeFallbackTurn(
  dedupeTurn(collidedContent),
  [collidedContent],
  dedupePioneer,
  expressionSession,
  expressionSession.question,
  dedupeAssignment
);
assert.notEqual(
  decollided.content,
  collidedContent,
  "A fallback that repeats existing content must pivot to a different reasoning move"
);
// 关键回归：替换结果本身也必须通过去重，不能用另一句已出现过的固定 fallback 顶替。
assert.ok(
  !collidesForContract(decollided.content, [collidedContent]),
  "The substituted fallback must be re-checked, not merely swapped for another stock line"
);

// 主持人分析也在比较范围内。
const moderatorEcho = "先确定这次最想让对方听懂的重点，再按听者需要保留必要信息。";
const vsModerator = dedupeFallbackTurn(
  dedupeTurn(moderatorEcho),
  [moderatorEcho],
  dedupePioneer,
  expressionSession,
  expressionSession.question,
  dedupeAssignment
);
assert.notEqual(
  vsModerator.content,
  moderatorEcho,
  "Repeating the moderator's own analysis must also trigger a pivot"
);

// ---------------------------------------------------------------------------
// 历史回声匹配：相关性 + 来源完整性，不按题型短路。
// ---------------------------------------------------------------------------

// 回归：表达技能题此前被全局禁止显示历史回声。
const expressionEchoSession = {
  ...expressionSession,
  id: "expression-echo-contract",
  question: "我认真准备了很多内容，但说出来总让人抓不住重点，应该怎样练习？",
  theme: "表达训练"
} satisfies RoundtableSession;
const expressionEcho = resolveHistoricalEcho(
  expressionEchoSession,
  "li-qingzhao",
  "先让最重要的那句话站在前面。",
  "本场赠言｜承接她对核心句、必要信息与删减的判断。"
);
assert.ok(
  expressionEcho,
  "An expression-skill question must no longer be blocked from showing a verified historical echo"
);
assert.ok(
  expressionEcho!.work.trim() && expressionEcho!.sourceUrl.startsWith("https://"),
  "Any surfaced echo must carry a work title and a verifiable HTTPS source"
);

// 原因未知模式仍然不展示：引文会被读成替用户解释原因。
assert.equal(
  resolveHistoricalEcho(
    { ...expressionEchoSession, supportMode: "unknown_cause" },
    "li-qingzhao",
    "先让最重要的那句话站在前面。",
    "本场赠言｜承接她对核心句的判断。"
  ),
  undefined,
  "unknown_cause sessions must still withhold historical echoes"
);

// 语义不相关时宁可留空。
assert.equal(
  resolveHistoricalEcho(
    { ...expressionEchoSession, question: "我该怎么和房东谈租金？", theme: "租金谈判" },
    "li-qingzhao",
    "先算清你能接受的上限。",
    "本场赠言｜承接她对边界的判断。"
  ),
  undefined,
  "An unrelated closing note must not pull in a loosely matching echo"
);

// 每条回声都必须有可核验来源，包括本轮新增的条目。
for (const echo of historicalEchoes) {
  assert.ok(
    echo.work.trim() && echo.sourceUrl.startsWith("https://") && echo.originalText.trim(),
    `Historical echo ${echo.id} must carry original text, a work title and an HTTPS source`
  );
}

// ---------------------------------------------------------------------------
// 行动卡溯源。
// ---------------------------------------------------------------------------

const aliasToId = new Map([
  ["m1", "message-one"],
  ["m2", "message-two"],
  ["m3", "message-three"]
]);
assert.deepEqual(
  resolveActionSourceIds(["m1", "m3"], aliasToId),
  ["message-one", "message-three"],
  "Valid aliases must resolve to real message ids"
);
assert.deepEqual(
  resolveActionSourceIds(["m1", "m1", "m9", "550e8400-e29b-41d4-a716-446655440000"], aliasToId),
  ["message-one"],
  "Unknown aliases, duplicates and raw UUIDs must be discarded"
);
assert.deepEqual(resolveActionSourceIds(undefined, aliasToId), [], "Missing aliases must resolve to nothing");
assert.equal(
  actionCardIsGrounded(3, 2),
  true,
  "An action card citing two real messages is grounded"
);
assert.equal(
  actionCardIsGrounded(3, 1),
  false,
  "An action card citing only one message when more were available is not grounded"
);
assert.equal(
  actionCardIsGrounded(1, 0),
  true,
  "A session with fewer than two citable messages must not be forced to fail"
);

// ---------------------------------------------------------------------------
// P0-1 主持人开场：议程报幕与逐位分工按句式拦截，与提到几个人名无关。
// ---------------------------------------------------------------------------

const hostNames = pioneerMindSample.map((pioneer) => pioneer.figure);
for (const agendaOpening of [
  "本场要讨论的是如何提升表达能力。",
  "本轮围绕表达练习展开。",
  "李清照看重点与字句，其余两位稍后补充。",
  "李清照从听者的角度先谈。",
  "三位先行者分别从字句、听者和练习的角度切入。"
]) {
  assert.ok(
    checkHostOpening(agendaOpening, hostNames).length > 0,
    `Agenda-style opening must be rejected: ${agendaOpening}`
  );
}
assert.equal(
  checkHostOpening("三位先行者已经入席。这个问题，可以先交给她们聊一轮。", hostNames).length,
  0,
  "A natural invitation without a roster must pass the host contract"
);

// 非表达题的 fallback 开场同样不播报分工、不虚构主题。
const genericSession = {
  ...expressionSession,
  id: "generic-opening-contract",
  question: "我想开始做副业，但不知道从哪一步入手。",
  theme: "副业起步",
  tension: "想行动与缺少验证之间"
} satisfies RoundtableSession;
const genericSelected = pioneers.filter((pioneer) =>
  ["ada-lovelace", "wu-zetian", "marie-curie"].includes(pioneer.id)
);
const genericOpening = buildFallbackOpening(genericSession, genericSelected);
assert.equal(
  genericOpening.content,
  "三位先行者已经入席。不妨先听听她们怎么想。",
  "A non-expression opening should omit the topic clause rather than invent one"
);
assert.equal(
  checkHostOpening(genericOpening.content, genericSelected.map((pioneer) => pioneer.figure)).length,
  0,
  "The generic fallback opening must pass the host-language contract"
);

// ---------------------------------------------------------------------------
// P0-2 通用语言自然度：指代回指、强造比喻、翻译腔空指代。
// ---------------------------------------------------------------------------

const languageSession = { question: tensionLeakSession.question, explicitEmotionTerms: [] as string[] };
assert.ok(
  checkMetaphorNaturalness("耳朵最先通向哪里，先听清重点落在哪儿。").length > 0,
  "A strained metaphor with a sense-organ subject must be flagged"
);
assert.ok(
  checkReferenceClarity("具体经历只是证据，不能说明表达有效。", [languageSession.question]).length > 0,
  "A definite noun phrase without an antecedent must be flagged"
);
assert.equal(
  checkReferenceClarity("具体经历只是证据，不能说明表达有效。", ["我有一段汇报失败的经历，怎么练习？"]).length,
  0,
  "A definite noun phrase with a real antecedent must pass"
);
assert.equal(
  checkReferenceClarity("具体来说，先写一句核心观点。", [languageSession.question]).length,
  0,
  "Non-referential uses of 具体 must not be flagged"
);
assert.ok(
  checkReferenceClarity("想想对方要用的那一样。", [languageSession.question]).length > 0,
  "A bare demonstrative without a noun must be flagged"
);
assert.equal(
  checkLanguage("先写一句最希望听者记住的结论，再补充两条理解它所必需的信息。", languageSession, [], true).length,
  0,
  "A plain, natural instruction must pass all language checks"
);
assert.ok(
  checkLanguage("耳朵最先通向哪里。", languageSession, [], true).some((issue) => issue.category === "naturalness"),
  "checkLanguage must aggregate metaphor-naturalness issues"
);
assert.ok(
  buildLanguageRepairPrompt(checkLanguage("具体经历只是证据。", languageSession, [], true)).includes("比喻"),
  "The repair instruction must carry the general language requirements"
);

// ---------------------------------------------------------------------------
// P0-3 金句卡选择：默认不选、点赞与组合独立、恢复只认用户明确选择。
// ---------------------------------------------------------------------------

const selectableCards: QuoteCard[] = pioneerMindSample.map((pioneer, index) => ({
  sessionId: "card-pref-contract",
  speakerId: pioneer.id,
  quote: `赠言${index + 1}号`,
  context: "本场赠言｜示例",
  kind: "closing_note"
}));
const defaultPrefs = createDefaultCardPreferences();
assert.deepEqual(defaultPrefs.selectedQuoteCardIds, [], "No quote card may be pre-selected by default");
assert.equal(
  selectedQuoteCardsFor(defaultPrefs, selectableCards).length,
  0,
  "An empty selection must compose zero quote cards, never the first two"
);
const likedOnly = toggleCardId(defaultPrefs.likedQuoteCardIds, quoteCardId(selectableCards[0]));
assert.deepEqual(
  defaultPrefs.selectedQuoteCardIds,
  [],
  "Liking a quote must not add it to the composite"
);
const selectedOnly = toggleCardId(defaultPrefs.selectedQuoteCardIds, quoteCardId(selectableCards[1]));
assert.deepEqual(likedOnly, [quoteCardId(selectableCards[0])], "Selecting a quote must not add a like");
assert.deepEqual(selectedOnly, [quoteCardId(selectableCards[1])], "Selection toggles only the chosen card");
assert.equal(
  canComposeComposite({ includeActionCard: false, myLine: "", includeMyLine: true }, 0),
  false,
  "An empty composite must not be savable"
);
assert.equal(
  canComposeComposite({ includeActionCard: false, myLine: "", includeMyLine: true }, 1),
  true,
  "A composite with one user-selected quote is savable"
);
const restored = restoreCardPreferences(
  { selectedQuoteCardIds: [quoteCardId(selectableCards[2]), "stale:已不存在的卡片"], likedQuoteCardIds: [] },
  selectableCards
);
assert.deepEqual(
  restored.selectedQuoteCardIds,
  [quoteCardId(selectableCards[2])],
  "Restore must keep only user choices that still exist in the current cards"
);
const regeneratedCards = selectableCards.map((card) => ({ ...card, quote: `${card.quote}（新）` }));
assert.deepEqual(
  restoreCardPreferences({ selectedQuoteCardIds: selectableCards.map(quoteCardId) }, regeneratedCards)
    .selectedQuoteCardIds,
  [],
  "Regenerated cards must never silently restore the old positional selection"
);
const reversedSelection = restoreCardPreferences(
  { selectedQuoteCardIds: [quoteCardId(selectableCards[0])] },
  [...selectableCards].reverse()
);
assert.deepEqual(
  selectedQuoteCardsFor(reversedSelection, [...selectableCards].reverse()).map((card) => card.speakerId),
  [selectableCards[0].speakerId],
  "List order must not change which cards are selected"
);

// ---------------------------------------------------------------------------
// P0-4 行动卡质检：空泛动作、缺动词、同栏多任务、跨栏重复、概念转换。
// fallback 自身必须通过自己的质检，避免兜底内容触发同类问题。
// ---------------------------------------------------------------------------

const baseActionCard = {
  chosenPath: "先确定这次最想让对方听懂的重点，再按听者需要保留必要信息，并用一次反馈修改下一版。",
  within24h: "选一个真实场景，写一句核心观点和两条必要补充。先说明自己在练习，再请对方说最先听懂什么、哪里还需补充。",
  sevenDayExperiment:
    "连续 7 天在同一种高频场景练习 3 次，每次只改重点、顺序或必要背景中的一项，并记录对方理解到的重点与仍需补充之处。",
  thirtyDayPractice:
    "未来 30 天每周选一个真实表达场景，固定完成准备、表达和反馈三步；月底回看哪类调整最常让重点更容易被理解。",
  guardrail: "如果对方需要补充，是先判断重点表达有偏差，还是必要背景不足；一次只改一处，不把所有问题都归到自己能力上。",
  evidenceToReview: "对方最先理解到的重点、仍需补充的地方，以及修改后两者是否更接近你的原意。"
};
assert.deepEqual(
  actionCardQualityIssues(baseActionCard),
  [],
  "A clear, progressive action card must pass the quality gate"
);
assert.ok(
  actionCardQualityIssues({ ...baseActionCard, within24h: "回忆一下自己最近的表达。" }).some((issue) =>
    issue.includes("空泛")
  ),
  "A vague action without an executable verb must be rejected"
);
assert.ok(
  actionCardQualityIssues({ ...baseActionCard, within24h: "重点清晰是表达的基础。" }).some((issue) =>
    issue.includes("缺少可执行动作")
  ),
  "A field without any executable action must be rejected"
);
assert.ok(
  actionCardQualityIssues({ ...baseActionCard, within24h: "写下核心观点。整理三条依据。发布到账号上。" }).some(
    (issue) => issue.includes("多个任务")
  ),
  "A field carrying several tasks at once must be rejected"
);
assert.ok(
  actionCardQualityIssues({
    ...baseActionCard,
    within24h: "在备忘录写下三条反馈记录，留下结果。",
    sevenDayExperiment: "连续七天在备忘录写下三条反馈记录，留下结果。"
  }).length > 0,
  "A stage that only extends the previous action in time must be rejected"
);
assert.ok(
  actionCardQualityIssues({ ...baseActionCard, within24h: "选一个词，再把它配成一句因为所以的判断。" }).some((issue) =>
    issue.includes("概念转换")
  ),
  "Forced concept-conversion actions must be rejected"
);
assert.ok(
  checkFactBoundary("把你汇报时的紧张写下来，观察它的变化。", languageSession.question, []).length > 0,
  "Card copy must not invent feelings the user never stated"
);
const unknownCauseSelected = pioneers.filter((pioneer) =>
  ["li-qingzhao", "ban-zhao", "marie-curie"].includes(pioneer.id)
);
for (const [session, selected] of [
  [expressionSession, pioneerMindSample],
  [unknownCauseSession, unknownCauseSelected],
  [genericSession, genericSelected]
] as const) {
  assert.deepEqual(
    actionCardQualityIssues(fallbackFinal(session, selected, []).actionCard),
    [],
    `The fallback action card must pass its own quality gate (${session.id})`
  );
}

// ---------------------------------------------------------------------------
// finalize 行动卡定向降级：行动卡失败不得带走合格的赠言卡与历史回声。
// ---------------------------------------------------------------------------

const fallbackActionForResolution = fallbackFinal(expressionSession, pioneerMindSample, []).actionCard;
const validDraftAction = { ...baseActionCard, sessionId: expressionSession.id };
const invalidDraftAction = { ...validDraftAction, within24h: "回忆一下自己最近的表达。" };
const invalidDraftIssues = actionCardQualityIssues(invalidDraftAction);
assert.ok(invalidDraftIssues.length > 0, "The invalid draft fixture must actually fail the quality gate");

// 合格的赠言卡（含历史回声）：在行动卡修复或降级的整个流程中必须保持引用不变。
const quoteCardsWithEcho: QuoteCard[] = [
  {
    sessionId: expressionSession.id,
    speakerId: "li-qingzhao",
    quote: "先让最重要的那句话站在前面。",
    context: "本场赠言｜承接她对核心句的判断。",
    kind: "closing_note",
    historicalEcho: resolveHistoricalEcho(
      expressionEchoSession,
      "li-qingzhao",
      "先让最重要的那句话站在前面。",
      "本场赠言｜承接她对核心句的判断。"
    )
  }
];
assert.ok(quoteCardsWithEcho[0].historicalEcho, "The fixture quote card must carry a historical echo");

let fallbackCalls = 0;
const trackFallback = () => {
  fallbackCalls += 1;
  return fallbackActionForResolution;
};

// 1. draft 合格：原样使用，不触发 repair，也不触碰 fallback。
const cleanResolution = resolveActionCard(validDraftAction, [], undefined, trackFallback);
assert.equal(cleanResolution.actionCard, validDraftAction, "A clean draft must be used as-is");
assert.equal(fallbackCalls, 0, "A clean draft must never invoke the fallback");

// 2. draft 不合格 + repair 通过：只替换行动卡，赠言卡与历史回声保持引用不变。
const repairedValid = { ...validDraftAction, within24h: "写下一句核心观点，再请对方说说最先听懂什么。" };
const repairedResolution = resolveActionCard(invalidDraftAction, invalidDraftIssues, repairedValid, trackFallback);
assert.equal(repairedResolution.actionCard, repairedValid, "A successful repair replaces only the action card");
assert.equal(repairedResolution.usedRepair, true, "The resolution must record that a repair was used");
assert.equal(repairedResolution.degradedToFallback, false, "A successful repair is not a degrade");
assert.equal(fallbackCalls, 0, "A successful repair must not invoke the fallback");
const repairedResult = { actionCard: repairedResolution.actionCard, quoteCards: quoteCardsWithEcho };
assert.equal(repairedResult.quoteCards, quoteCardsWithEcho, "Quote cards must be preserved by reference");
assert.equal(
  repairedResult.quoteCards[0].historicalEcho,
  quoteCardsWithEcho[0].historicalEcho,
  "Historical echoes must survive an action-card repair"
);

// 3. repair 失败或不可用：只降级行动卡；fallback 恰好调用一次，不存在无限重试。
const degradedResolution = resolveActionCard(invalidDraftAction, invalidDraftIssues, undefined, trackFallback);
assert.equal(
  degradedResolution.actionCard,
  fallbackActionForResolution,
  "Only the action card degrades to the fallback"
);
assert.equal(degradedResolution.degradedToFallback, true, "The resolution must record the degrade");
assert.equal(fallbackCalls, 1, "Degradation is a single terminal step with no retry loop");
const degradedResult = { actionCard: degradedResolution.actionCard, quoteCards: quoteCardsWithEcho };
assert.equal(degradedResult.quoteCards, quoteCardsWithEcho, "Quote cards must survive an action-card-only degrade");
assert.equal(
  degradedResult.quoteCards[0].historicalEcho,
  quoteCardsWithEcho[0].historicalEcho,
  "Historical echoes must survive an action-card-only degrade"
);
assert.equal(
  actionCardQualityIssues(degradedResolution.actionCard).length,
  0,
  "The degraded fallback action card must itself pass the quality gate"
);

// ---------------------------------------------------------------------------
// finalize 末端 guard 按来源拆分：行动卡与赠言卡互不带倒。
// ---------------------------------------------------------------------------

const finalGuardContext = {
  question: tensionLeakSession.question,
  transcriptText: "先确定这次最想让对方听懂的重点，再按听者需要保留必要信息。",
  supportMode: "experience_context" as const,
  explicitEmotionTerms: [] as string[],
  deniedAssumptions: ["亏欠"],
  expressionSkill: true
};

const finalGuardQuoteCards: QuoteCard[] = [
  {
    sessionId: "final-guard-contract",
    speakerId: "li-qingzhao",
    quote: "先让最重要的那句话站在前面。",
    context: "本场赠言｜承接她对核心句的判断。",
    kind: "closing_note",
    historicalEcho: resolveHistoricalEcho(
      expressionEchoSession,
      "li-qingzhao",
      "先让最重要的那句话站在前面。",
      "本场赠言｜承接她对核心句的判断。"
    )
  },
  {
    sessionId: "final-guard-contract",
    speakerId: "ada-lovelace",
    quote: "每次只改一个环节，让反馈指出下一步。",
    context: "本场赠言｜承接她把表达拆成可反馈练习的做法。",
    kind: "closing_note"
  }
];
assert.ok(finalGuardQuoteCards[0].historicalEcho, "The fixture must carry a historical echo");

// 合格卡组：赠言与回声都不触发 guard。
const cleanGuardPass = resolveGuardedQuoteCards(finalGuardQuoteCards, finalGuardContext, () => undefined);
assert.deepEqual(cleanGuardPass.quoteCards, finalGuardQuoteCards, "Clean quote cards must pass the quote guard untouched");
assert.equal(cleanGuardPass.notes.length, 0, "Clean quote cards must produce no guard notes");
assert.equal(
  actionCardGuardIssues(baseActionCard, finalGuardContext).length,
  0,
  "The clean action card fixture must pass the action guard"
);

// 场景 1：合格 quote + echo，action 触发事实边界（用户没说过紧张）。
const boundaryBrokenAction = { ...baseActionCard, within24h: "把你汇报时的紧张写下来，观察它的变化。" };
assert.ok(
  actionCardGuardIssues(boundaryBrokenAction, finalGuardContext).some((issue) => issue.includes("感受或前提")),
  "An action card inventing an unstated feeling must fail the action guard"
);
const actionSideOnly = resolveGuardedQuoteCards(finalGuardQuoteCards, finalGuardContext, () => undefined);
assert.deepEqual(
  actionSideOnly.quoteCards,
  finalGuardQuoteCards,
  "Action-side guard issues must not touch quote cards or historical echoes"
);

// 场景 2：合格 action，单张 quote 越界——重提炼保留，重提炼失败才移除；其余卡不动。
const dirtyQuoteCards: QuoteCard[] = [
  finalGuardQuoteCards[0],
  { ...finalGuardQuoteCards[1], quote: "你要坦白内心，才能被看见。", context: "本场赠言｜承接她的判断。" }
];
const rerenderedClean: QuoteCard = { ...finalGuardQuoteCards[1], quote: "每次只改一个环节。" };
const redistilled = resolveGuardedQuoteCards(dirtyQuoteCards, finalGuardContext, (card) =>
  card.speakerId === "ada-lovelace" ? rerenderedClean : undefined
);
assert.equal(redistilled.quoteCards.length, 2, "A re-distillable dirty card must be kept, not removed");
assert.deepEqual(redistilled.quoteCards[0], finalGuardQuoteCards[0], "Unaffected quote cards stay untouched");
assert.equal(redistilled.quoteCards[1].quote, "每次只改一个环节。", "The dirty card is replaced by its re-distillation");
const removedOnly = resolveGuardedQuoteCards(dirtyQuoteCards, finalGuardContext, () => undefined);
assert.equal(removedOnly.quoteCards.length, 1, "A dirty card that cannot be re-distilled is removed alone");
assert.deepEqual(removedOnly.quoteCards[0], finalGuardQuoteCards[0], "Other quote cards survive a single-card removal");
assert.deepEqual(
  baseActionCard,
  {
    chosenPath: "先确定这次最想让对方听懂的重点，再按听者需要保留必要信息，并用一次反馈修改下一版。",
    within24h: "选一个真实场景，写一句核心观点和两条必要补充。先说明自己在练习，再请对方说最先听懂什么、哪里还需补充。",
    sevenDayExperiment:
      "连续 7 天在同一种高频场景练习 3 次，每次只改重点、顺序或必要背景中的一项，并记录对方理解到的重点与仍需补充之处。",
    thirtyDayPractice:
      "未来 30 天每周选一个真实表达场景，固定完成准备、表达和反馈三步；月底回看哪类调整最常让重点更容易被理解。",
    guardrail: "如果对方需要补充，是先判断重点表达有偏差，还是必要背景不足；一次只改一处，不把所有问题都归到自己能力上。",
    evidenceToReview: "对方最先理解到的重点、仍需补充的地方，以及修改后两者是否更接近你的原意。"
  },
  "Quote-side guard issues must not touch the action card"
);

// 场景 3：已否认前提只出现在行动卡——不触发整份 fallback，赠言卡原样保留。
const deniedInAction = { ...baseActionCard, guardrail: "如果连续练习让你感到亏欠，就先暂停。" };
assert.ok(
  actionCardGuardIssues(deniedInAction, finalGuardContext).some((issue) => issue.includes("亏欠")),
  "A denied assumption in the action card must fail the action guard"
);
const deniedActionQuotes = resolveGuardedQuoteCards(finalGuardQuoteCards, finalGuardContext, () => undefined);
assert.deepEqual(
  deniedActionQuotes.quoteCards,
  finalGuardQuoteCards,
  "A denied assumption confined to the action card must not cause a whole-result fallback"
);

// 仅历史回声越界：只摘除回声，本场赠言保留。
const echoDirtyCard: QuoteCard = {
  ...finalGuardQuoteCards[1],
  historicalEcho: {
    id: "fake-echo",
    pioneerId: "ada-lovelace",
    originalText: "这是一段包含亏欠的引文。",
    work: "示例作品",
    sourceUrl: "https://example.com/echo",
    tags: []
  }
};
const echoStripped = resolveGuardedQuoteCards([echoDirtyCard], finalGuardContext, () => undefined);
assert.equal(echoStripped.quoteCards.length, 1, "A card with a clean quote but dirty echo must be kept");
assert.equal(echoStripped.quoteCards[0].historicalEcho, undefined, "Only the offending echo is removed");
assert.equal(
  echoStripped.quoteCards[0].quote,
  echoDirtyCard.quote,
  "The closing note itself survives an echo-only violation"
);

// 「考」必须成词：请对方考虑/参考是自然的反馈请求，不得误判为考试；
// 让听者复述、打分仍是硬问题。
assert.equal(
  actionCardGuardIssues(
    { ...baseActionCard, within24h: "写下核心句后，请对方考虑哪里还需要补充。" },
    finalGuardContext
  ).length,
  0,
  "Asking the listener to consider what is missing must not be misread as an exam"
);
assert.ok(
  actionCardGuardIssues(
    { ...baseActionCard, within24h: "写下核心句后，让对方复述一遍你说的重点。" },
    finalGuardContext
  ).some((issue) => issue.includes("考试")),
  "Making the listener recite the key points must still be rejected"
);

console.log("Harness contracts passed: voice, retrieval, discussion and follow-up rules are valid.");
