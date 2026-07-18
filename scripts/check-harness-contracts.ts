import assert from "node:assert/strict";
import { pioneers } from "@/data/pioneers";
import { RoundtableDirector } from "@/lib/harness/director";
import {
  breakLongSentences,
  compactQuote,
  composePioneerTurn,
  findConversationOverlap,
  findClarityIssues,
  findUnknownCauseIssues,
  guardPioneerContent,
  groundQuoteInContent,
  softenUnsupportedInference
} from "@/lib/harness/output-guard";

assert.equal(pioneers.length, 9, "Expected exactly nine pioneer profiles");
assert.equal(new Set(pioneers.map((pioneer) => pioneer.id)).size, 9, "Pioneer ids must be unique");

for (const pioneer of pioneers) {
  const voice = pioneer.voiceProfile;
  assert.ok(voice.rhythm.trim(), `${pioneer.id} is missing voice rhythm`);
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
assert.equal(
  findUnknownCauseIssues(
    "我暂时不解释原因，只观察它何时出现、何时变化。",
    "每天醒来身体沉沉的，但我说不清为什么。"
  ).length,
  0,
  "Observation without causal attribution should remain allowed"
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
const firstPersonAfterCompaction = guardPioneerContent(
  "你说讲情义，可忠实的是哪一种标准？真正的义气是守住彼此成事的底线，不是单方面承接消耗。我会坚持这个判断。",
  60,
  "我不愿意这么快下结论："
);
assert.ok(firstPersonAfterCompaction.includes("我"), "Compaction must not remove the only first-person marker");

const director = new RoundtableDirector();
assert.deepEqual(
  director.chooseCrossfirePair(["virginia-woolf", "li-qingzhao", "ban-zhao"], "模糊情绪"),
  { firstId: "li-qingzhao", secondId: "virginia-woolf", tension: "先表达还是先留空间" }
);
assert.deepEqual(
  director.chooseCrossfirePair(["jane-austen", "qin-liangyu", "ban-zhao"], "关系边界"),
  { firstId: "jane-austen", secondId: "ban-zhao", tension: "关系观察与相处节奏" }
);
assert.deepEqual(
  director.chooseCrossfirePair(["jane-austen", "qin-liangyu", "virginia-woolf"], "关系边界"),
  {
    firstId: "jane-austen",
    secondId: "virginia-woolf",
    tension: "先看清关系交换还是先保住精神空间"
  }
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

console.log("Harness contracts passed: 9 voice profiles and local clarity guards are valid.");
