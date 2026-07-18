import type { RoundtableMessage } from "@/lib/types";

export type PioneerTurnParts = {
  acknowledgement: string;
  judgment: string;
  reason: string;
  nextStep: string;
};

const forbiddenClaims = [
  /诊断/,
  /治愈/,
  /保证/,
  /一定会/,
  /医学建议/,
  /法律建议/,
  /投资建议/,
  /心理治疗/
];

export function guardSafety(content: string) {
  return forbiddenClaims.reduce(
    (safeContent, pattern) => safeContent.replace(pattern, "支持你自我反思的参考"),
    content
  );
}

export function ensureFirstPerson(content: string, prefix = "我的判断是：") {
  return content.includes("我") ? content : `${prefix}${content}`;
}

function cleanClause(content: string, maxChars: number) {
  const normalized = content
    .replace(/^(承接|判断|理由|行动|下一步)\s*[：:]/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。！？；]+$/, "");
  if (normalized.length <= maxChars) return normalized;

  const slice = normalized.slice(0, maxChars);
  const boundaries = [
    slice.lastIndexOf("，"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("："),
    slice.lastIndexOf("、")
  ];
  const boundary = Math.max(...boundaries);
  if (boundary >= Math.floor(maxChars * 0.45)) return slice.slice(0, boundary).trim();

  // A slightly long complete clause is preferable to a broken Chinese phrase.
  return normalized;
}

export function compactText(content: string, maxChars: number) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;

  const sentences = normalized.match(/[^。！？]+[。！？]?/g) ?? [normalized];
  let result = "";
  for (const sentence of sentences) {
    if ((result + sentence).length > maxChars) break;
    result += sentence;
  }
  if (result) return result.trim();
  return normalized;
}

export function breakLongSentences(content: string, maxSentenceChars = 42) {
  const sentences = content.match(/[^。！？]+[。！？]?/g) ?? [content];
  const output: string[] = [];

  for (const sentence of sentences) {
    let remainder = sentence.trim();
    while (remainder.replace(/[。！？]$/, "").length > maxSentenceChars) {
      const window = remainder.slice(0, maxSentenceChars + 1);
      const candidates = [...window.matchAll(/[，；：]/g)]
        .map((match) => match.index ?? -1)
        .filter((index) => index >= 14)
        .reverse();
      const boundary = candidates.find((index) => {
        const left = window.slice(0, index).trim();
        const right = remainder.slice(index + 1).trim();
        if (/^(如果|若|只要|当)/.test(left)) return false;
        if (left.includes("不是") && /^而是/.test(right)) return false;
        if (/^(却|但是|但|所以|因为|而且|又|连|也|就|才|便)/.test(right)) return false;
        if (/(一旦|如果|若|只要|除非)[^。！？；]{0,24}$/.test(left)) return false;
        return !/(的是|因为|所以|但是|但|而且|如果|虽然|却|意味着)$/.test(left);
      }) ?? -1;
      if (boundary < 14) break;
      output.push(`${remainder.slice(0, boundary).trim()}。`);
      remainder = remainder.slice(boundary + 1).trim();
    }
    if (remainder) output.push(remainder);
  }

  return output.join("");
}

function stripUnsupportedBiography(content: string) {
  const biographyPattern = /(我也?曾|我曾经|我也?有过|我经历(?:过)?|当年我|在我的一生中|我亲历过)/;
  const sentences = content.match(/[^。！？]+[。！？]?/g) ?? [content];
  const kept = sentences.filter((sentence) => !biographyPattern.test(sentence));
  return (kept.length ? kept : sentences).join("");
}

function removeUnmatchedChineseQuotes(content: string) {
  const left = (content.match(/“/g) ?? []).length;
  const right = (content.match(/”/g) ?? []).length;
  if (left === 0 && right > 0) return content.replace(/”/g, "");
  if (right === 0 && left > 0) return content.replace(/“/g, "");
  return content;
}

export function softenUnsupportedInference(content: string) {
  return content
    .replace(/你担心的不止是([^，。！？；]+)，而是/g, "除了$1，你可能也在担心")
    .replace(/你真正害怕的是/g, "你可能也在担心")
    .replace(/你害怕的其实是/g, "你可能也在担心")
    .replace(/你其实是/g, "你也许正在")
    .replace(/你需要的其实是/g, "你可以先考虑")
    .replace(/真正怕的是/g, "可能担心的是")
    .replace(/常常不是因为你不够清晰，而是/g, "也许不只关乎清晰，还可能和")
    .replace(/常常来自/g, "也许和")
    .replace(/这说明你/g, "这或许提示你")
    .replace(/这证明你/g, "这可能意味着")
    .replace(/身体不会无故变沉/g, "身体的沉重值得留意，但原因还不能确定")
    .replace(/压着的不是具体的事，是/g, "压着的不一定是具体的事，也可能是")
    .replace(/往往不是/g, "可能不只是")
    .replace(/未被认领的[^，。！？；]*/g, "还没说清的感受")
    .replace(/生命在要求你/g, "你可以开始")
    .replace(/长回自己/g, "按自己的方式生活")
    .replace(/把答案还给自己/g, "由你自己做决定")
    .replace(/灵魂深处/g, "心里");
}

export function findUnknownCauseIssues(content: string, question: string) {
  if (!/(说不清|不知道|不明)/.test(question)) return [];

  const issues: string[] = [];
  const inventedThemes = [
    "哀悼",
    "失落",
    "创伤",
    "羞耻",
    "压抑",
    "悲伤",
    "依恋",
    "潜意识",
    "愁绪",
    "真话",
    "默契",
    "逃避",
    "避开",
    "心思",
    "愿望",
    "渴望",
    "恐惧",
    "害怕",
    "担心",
    "亏欠",
    "期待",
    "在意"
  ].filter((theme) => content.includes(theme) && !question.includes(theme));
  if (inventedThemes.length) {
    issues.push(`原因未知时新增了用户没有表达的心理主题：${inventedThemes.join("、")}`);
  }
  if (
    /(是一种|之所以|是因为|源自|源于|来自|由于|缺少一个|不是凭空|正因|或许.{0,8}(?:正因|因为)|而是.{0,18}少了|就会变成|是情感本身|只是.{0,12}(?:没|未)|那或许正是|不敢.{0,12}(?:面对|承认|轻看)|在等.{0,12}(?:位置|表达|说出)|提醒你|保护你|拴着你|支付利息|欠债|等待安放|未成形)/.test(
      content
    )
  ) {
    issues.push("用户明确说原因不明，正文却给出了确定的心理原因");
  }
  return issues;
}

function isStandaloneQuote(fragment: string) {
  if (fragment.length < 6 || fragment.length > 22) return false;
  if (/^(而是|但是|但|却|因为|所以|如果|若|虽然|并且|以及|或)/.test(fragment)) return false;
  if (/(的|地|得|和|与|或|但|却|因为|所以)$/.test(fragment)) return false;
  if (fragment.includes("不是") && !fragment.includes("而是")) return false;
  if ((fragment.match(/“/g) ?? []).length !== (fragment.match(/”/g) ?? []).length) return false;
  return true;
}

export function composePioneerTurn(parts: PioneerTurnParts, maxChars = 100) {
  const acknowledgement = cleanClause(parts.acknowledgement, 20);
  const judgment = cleanClause(parts.judgment, 28);
  const reason = cleanClause(parts.reason, 24);
  const nextStep = cleanClause(parts.nextStep, 28);
  const judgmentWithReason = [judgment, reason].filter(Boolean).join("，");
  const content = [acknowledgement, judgmentWithReason, nextStep]
    .filter(Boolean)
    .map((part) => `${part}。`)
    .join("");

  const guarded = breakLongSentences(guardSafety(softenUnsupportedInference(stripUnsupportedBiography(content))));
  return compactText(ensureFirstPerson(guarded), maxChars);
}

export function guardPioneerContent(content: string, maxChars = 100, firstPersonPrefix = "我的判断是：") {
  const normalized = breakLongSentences(
    guardSafety(softenUnsupportedInference(stripUnsupportedBiography(removeUnmatchedChineseQuotes(content))))
  );
  const compacted = compactText(normalized, maxChars);
  return compactText(ensureFirstPerson(compacted, firstPersonPrefix), maxChars);
}

function normalizeForSimilarity(content: string) {
  return content
    .replace(/[\s，。！？；：“”‘’、,.!?;:'"()（）]/g, "")
    .replace(/^(我想|我会|我认为|我的判断是|你现在|这件事)/, "")
    .trim();
}

function characterNgrams(content: string, size = 2) {
  const normalized = normalizeForSimilarity(content);
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

export function textSimilarity(first: string, second: string) {
  const a = characterNgrams(first);
  const b = characterNgrams(second);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  return intersection / Math.min(a.size, b.size);
}

function longestCommonSubstringLength(first: string, second: string) {
  const a = normalizeForSimilarity(first);
  const b = normalizeForSimilarity(second);
  const row = new Array(b.length + 1).fill(0);
  let longest = 0;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      diagonal = previous;
      longest = Math.max(longest, row[j]);
    }
  }
  return longest;
}

function firstSentence(content: string) {
  return content.split(/[。！？]/)[0]?.trim() ?? content.trim();
}

export function findConversationOverlap(content: string, previousContents: string[]) {
  const issues: string[] = [];
  for (const previous of previousContents) {
    const wholeScore = textSimilarity(content, previous);
    const openingScore = textSimilarity(firstSentence(content), firstSentence(previous));
    const repeatedRun = longestCommonSubstringLength(content, previous);
    if (openingScore >= 0.3) issues.push(`开场与前文相似（${openingScore.toFixed(2)}）`);
    if (wholeScore >= 0.58) issues.push(`整体内容与前文相似（${wholeScore.toFixed(2)}）`);
    if (repeatedRun >= 10) issues.push(`与前文重复了 ${repeatedRun} 个连续字`);
  }
  return [...new Set(issues)];
}

export function compactQuote(content: string) {
  const guarded = guardSafety(content).replace(/^[“”"'‘’]+|[“”"'‘’]+$/g, "").trim();
  const fragments = guarded
    .split(/[，。！？；：]/)
    .map((fragment) => fragment.trim())
    .filter(isStandaloneQuote);
  if (fragments.length) return fragments.sort((a, b) => b.length - a.length)[0];
  return guarded.length <= 22 ? guarded : "";
}

export function groundQuoteInContent(content: string, preferred: string, judgment: string) {
  const sources = [preferred, judgment, content];
  for (const source of sources) {
    const candidates = source
      .split(/[，。！？；：]/)
      .map((fragment) => fragment.trim())
      .filter(isStandaloneQuote)
      .sort((a, b) => b.length - a.length);
    const grounded = candidates.find((candidate) => content.includes(candidate));
    if (grounded) return grounded;
  }

  const fallback = content.match(/[^。！？；，：]{6,22}/)?.[0] ?? "";
  return fallback.trim();
}

export function findClarityIssues(content: string, maxChars: number) {
  const issues: string[] = [];
  if (content.length > maxChars) issues.push(`超过 ${maxChars} 字`);
  if (/(我也?曾|我曾经|我也?有过|当年我|在我的一生中|我亲历过)/.test(content)) issues.push("包含无来源人物经历");
  if (/(你真正害怕的是|你害怕的其实是|你其实是|你需要的其实是|这说明你|这证明你|未被认领的)/.test(content)) {
    issues.push("包含替用户下结论的表达");
  }
  if (/(生命在要求你|长回自己|把答案还给自己|灵魂深处)/.test(content)) {
    issues.push("包含抽象套话");
  }
  if (/(放进一份|放进去一个作品|建立一个证据档案)/.test(content)) {
    issues.push("包含不清楚的行动表达");
  }
  if (/(内在秩序.{0,6}低语|每(?:试|做|写|看)一次[。！？]?$)/.test(content)) {
    issues.push("包含抽象或没有说完整的表达");
  }
  if ((content.match(/不是/g) ?? []).length > 1 && (content.match(/而是/g) ?? []).length > 1) {
    issues.push("重复使用“不是…而是…”结构");
  }
  const longSentence = (content.match(/[^。！？；]+/g) ?? []).some((sentence) => sentence.length > 48);
  if (longSentence) issues.push("包含超过 48 字的长句");
  return issues;
}

export function guardMessage(message: RoundtableMessage) {
  const content = guardSafety(message.content);
  return {
    ...message,
    content
  };
}
