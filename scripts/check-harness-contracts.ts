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
import type { RoundtableMessage, RoundtableSession } from "@/lib/types";

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

for (const pioneer of pioneers) {
  const voice = pioneer.voiceProfile;
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

console.log("Harness contracts passed: voice, retrieval, discussion and follow-up rules are valid.");
