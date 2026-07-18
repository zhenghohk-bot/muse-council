import assert from "node:assert/strict";
import { pioneers } from "@/data/pioneers";
import {
  compactQuote,
  composePioneerTurn,
  findClarityIssues,
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

const groundedQuote = groundQuoteInContent(guardedTurn, "正文里不存在的漂亮话", "现在还没有足够证据");
assert.ok(guardedTurn.includes(groundedQuote), "Quote must be grounded in the rendered pioneer turn");

console.log("Harness contracts passed: 9 voice profiles and local clarity guards are valid.");
