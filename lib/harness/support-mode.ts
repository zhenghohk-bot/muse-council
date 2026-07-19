import type { RoundtableSession, SupportMode } from "@/lib/types";

export type SupportContext = {
  mode: SupportMode;
  explicitEmotionTerms: string[];
};

const emotionTerms = [
  "羞耻",
  "羞愧",
  "失落",
  "哀悼",
  "悲伤",
  "难过",
  "焦虑",
  "不安",
  "紧张",
  "害怕",
  "恐惧",
  "愤怒",
  "生气",
  "委屈",
  "内疚",
  "亏欠",
  "孤独",
  "嫉妒",
  "羡慕",
  "痛苦",
  "压抑",
  "疲惫",
  "后悔",
  "失望",
  "自责",
  "无助",
  "迷茫"
];

const unknownCausePatterns = [
  /(?:说不清|讲不清|弄不明白).{0,16}(?:是什么|为什么|怎么回事|原因|缘由|从哪(?:里)?来)/,
  /(?:不知道|不明白).{0,12}(?:为什么|原因|怎么回事|从哪(?:里)?来)/,
  /(?:原因|缘由).{0,6}(?:不清楚|不知道|不明)/,
  /(?:莫名其妙|无缘无故|不明原因)/
];

const experienceContextPatterns = [
  /(?:因为|由于|自从|起因是|原因是)/,
  /(?:每次|每当|当我|在我).{0,20}(?:时|后|之后)/,
  /(?:被|遭到).{1,18}(?:后|时)/,
  /(?:朋友|伴侣|前任|父母|家人|同事|老板|公司|学校|工作|关系|分手|离职|失业|考编|催婚|生病|争吵|冲突)/,
  /(?:同龄|升职|结婚|买房|简历|面试|收入|副业|辞职|创作|写作|账号|发布)/
];

export function extractExplicitEmotionTerms(text: string) {
  return emotionTerms.filter((term) => text.includes(term));
}

export function classifySupportContext(text: string): SupportContext {
  const explicitEmotionTerms = extractExplicitEmotionTerms(text);
  if (unknownCausePatterns.some((pattern) => pattern.test(text))) {
    return { mode: "unknown_cause", explicitEmotionTerms };
  }
  if (experienceContextPatterns.some((pattern) => pattern.test(text))) {
    return { mode: "experience_context", explicitEmotionTerms };
  }
  if (explicitEmotionTerms.length) {
    return { mode: "named_emotion", explicitEmotionTerms };
  }
  return { mode: "experience_context", explicitEmotionTerms };
}

export function resolveTurnSupportContext(session: RoundtableSession, latestUserText?: string): SupportContext {
  if (!latestUserText?.trim()) {
    return { mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms };
  }

  const latest = classifySupportContext(latestUserText);
  const explicitEmotionTerms = [...new Set([...session.explicitEmotionTerms, ...latest.explicitEmotionTerms])];
  const latestHasEvidence =
    latest.explicitEmotionTerms.length > 0 ||
    unknownCausePatterns.some((pattern) => pattern.test(latestUserText)) ||
    experienceContextPatterns.some((pattern) => pattern.test(latestUserText));
  return {
    mode: latestHasEvidence ? latest.mode : session.supportMode,
    explicitEmotionTerms
  };
}

export function isUnknownCauseMode(session: Pick<RoundtableSession, "supportMode">) {
  return session.supportMode === "unknown_cause";
}

export function supportModeInstruction(context: SupportContext) {
  if (context.mode === "unknown_cause") {
    return "支持模式：原因未知。先承认感受真实且暂时说不清会让人难以着力；可以陪伴、复述可确认事实并观察变化，但不得补写隐藏情绪、象征意义或心理原因。";
  }
  if (context.mode === "named_emotion") {
    const terms = context.explicitEmotionTerms.length ? context.explicitEmotionTerms.join("、") : "用户亲自命名的情绪";
    return `支持模式：用户已命名情绪（${terms}）。可以原样承接这些词，帮助区分触发场景、强度、需要与选择；可以表达理解和安慰，但不得升级成用户没说过的创伤、依恋或深层原因。`;
  }
  const terms = context.explicitEmotionTerms.length ? `用户明确说出的情绪包括：${context.explicitEmotionTerms.join("、")}。` : "";
  return `支持模式：用户已提供具体经历或情境。${terms}可以分析原文中事件、感受与选择之间的联系，并提出有依据的可能性；新推测必须写成问题或可能性，不得写成诊断或唯一原因。`;
}
