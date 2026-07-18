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
      const candidates = [...window.matchAll(/[，；]/g)]
        .map((match) => match.index ?? -1)
        .filter((index) => index >= 14)
        .reverse();
      const boundary = candidates.find((index) => {
        const left = window.slice(0, index).trim();
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
  const biographyPattern = /(我也?曾|我曾经|当年我|在我的一生中|我亲历过)/;
  const sentences = content.match(/[^。！？]+[。！？]?/g) ?? [content];
  const kept = sentences.filter((sentence) => !biographyPattern.test(sentence));
  return (kept.length ? kept : sentences).join("");
}

export function softenUnsupportedInference(content: string) {
  return content
    .replace(/你真正害怕的是/g, "你可能也在担心")
    .replace(/你害怕的其实是/g, "你可能也在担心")
    .replace(/你其实是/g, "你也许正在")
    .replace(/你需要的其实是/g, "你可以先考虑")
    .replace(/常常不是因为你不够清晰，而是/g, "也许不只关乎清晰，还可能和")
    .replace(/常常来自/g, "也许和")
    .replace(/这说明你/g, "这或许提示你")
    .replace(/这证明你/g, "这可能意味着")
    .replace(/未被认领的[^，。！？；]*/g, "还没说清的感受")
    .replace(/生命在要求你/g, "你可以开始")
    .replace(/长回自己/g, "按自己的方式生活")
    .replace(/把答案还给自己/g, "由你自己做决定")
    .replace(/灵魂深处/g, "心里");
}

function isStandaloneQuote(fragment: string) {
  if (fragment.length < 6 || fragment.length > 22) return false;
  if (/^(而是|但是|但|却|因为|所以|如果|若|虽然|并且|以及|或)/.test(fragment)) return false;
  if (/(的|地|得|和|与|或|但|却|因为|所以)$/.test(fragment)) return false;
  if (fragment.includes("不是") && !fragment.includes("而是")) return false;
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

export function guardPioneerContent(content: string, maxChars = 100) {
  const normalized = breakLongSentences(
    guardSafety(softenUnsupportedInference(stripUnsupportedBiography(content)))
  );
  return compactText(ensureFirstPerson(normalized), maxChars);
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
  if (/(我也?曾|我曾经|当年我|在我的一生中|我亲历过)/.test(content)) issues.push("包含无来源人物经历");
  if (/(你真正害怕的是|你害怕的其实是|你其实是|你需要的其实是|这说明你|这证明你|未被认领的)/.test(content)) {
    issues.push("包含替用户下结论的表达");
  }
  if (/(生命在要求你|长回自己|把答案还给自己|灵魂深处)/.test(content)) {
    issues.push("包含抽象套话");
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
