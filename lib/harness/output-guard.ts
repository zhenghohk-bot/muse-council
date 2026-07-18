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

export function ensureFirstPerson(content: string) {
  return content.includes("我") ? content : `我会这样看：${content}`;
}

function cleanClause(content: string, maxChars: number) {
  const normalized = content
    .replace(/^(承接|判断|理由|行动|下一步)\s*[：:]/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。！？；]+$/, "");
  if (normalized.length <= maxChars) return normalized;

  const slice = normalized.slice(0, maxChars);
  const boundaries = [slice.lastIndexOf("，"), slice.lastIndexOf("；"), slice.lastIndexOf("、")];
  const boundary = Math.max(...boundaries);
  return (boundary >= Math.floor(maxChars * 0.6) ? slice.slice(0, boundary) : slice).trim();
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
  return `${cleanClause(normalized, maxChars - 1)}。`;
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
    .replace(/你其实是/g, "你也许正在")
    .replace(/这说明你/g, "这或许提示你")
    .replace(/这证明你/g, "这可能意味着")
    .replace(/未被认领的照护冲动/g, "一种还需要观察的感受");
}

export function composePioneerTurn(parts: PioneerTurnParts, maxChars = 100) {
  const content = [
    cleanClause(parts.acknowledgement, 20),
    cleanClause(parts.judgment, 26),
    cleanClause(parts.reason, 22),
    cleanClause(parts.nextStep, 28)
  ]
    .filter(Boolean)
    .map((part) => `${part}。`)
    .join("");

  const guarded = guardSafety(softenUnsupportedInference(stripUnsupportedBiography(content)));
  return compactText(ensureFirstPerson(guarded), maxChars);
}

export function compactQuote(content: string) {
  return cleanClause(guardSafety(content), 22);
}

export function findClarityIssues(content: string, maxChars: number) {
  const issues: string[] = [];
  if (content.length > maxChars) issues.push(`超过 ${maxChars} 字`);
  if (/(我也?曾|我曾经|当年我|在我的一生中|我亲历过)/.test(content)) issues.push("包含无来源人物经历");
  if (/(你真正害怕的是|你其实是|这说明你|这证明你|未被认领的)/.test(content)) {
    issues.push("包含替用户下结论的表达");
  }
  if ((content.match(/不是/g) ?? []).length > 1 && (content.match(/而是/g) ?? []).length > 1) {
    issues.push("重复使用“不是…而是…”结构");
  }
  return issues;
}

export function guardMessage(message: RoundtableMessage) {
  const content = guardSafety(message.content);
  return {
    ...message,
    content
  };
}
