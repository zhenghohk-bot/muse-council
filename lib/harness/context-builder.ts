import { getPioneers, pioneerById } from "@/data/pioneers";
import { retrieveSourceNotes } from "@/lib/harness/source-retriever";
import type { PioneerProfile, RoundtableMessage, RoundtableSession, ThemeAnalysis } from "@/lib/types";

export function compactHistory(messages: RoundtableMessage[] = []) {
  return messages
    .slice(-8)
    .map((message) => `${message.speakerId}: ${message.content}`)
    .join("\n");
}

export function buildHarvestTranscript(
  messages: RoundtableMessage[] = [],
  pioneerNames: ReadonlyMap<string, string> = new Map()
) {
  return messages
    .filter((message) => message.role === "user" || message.role === "moderator" || message.role === "pioneer")
    .slice(-16)
    .map((message) => {
      const speaker =
        message.role === "user"
          ? "用户"
          : message.role === "moderator"
            ? "主持人"
            : (pioneerNames.get(message.speakerId) ?? message.speakerId);
      return `[${message.id}] ${speaker}（${message.stage}）：${message.content}`;
    })
    .join("\n");
}

export function buildSessionContext(session: RoundtableSession, messages: RoundtableMessage[] = []) {
  const selectedPioneers = getPioneers(session.selectedPioneerIds);
  return {
    question: session.question,
    theme: session.theme,
    tension: session.tension,
    selectedPioneers,
    history: compactHistory(messages)
  };
}

export function buildPioneerContext(
  session: RoundtableSession,
  pioneerId: string,
  messages: RoundtableMessage[] = []
) {
  const pioneer = pioneerById.get(pioneerId);
  if (!pioneer) {
    throw new Error(`Unknown pioneer: ${pioneerId}`);
  }

  const sourceNotes = retrieveSourceNotes(pioneerId, session.question, 2);

  return {
    session: buildSessionContext(session, messages),
    pioneer,
    sourceNotes
  };
}

export function describePioneer(pioneer: PioneerProfile) {
  return [
    `姓名：${pioneer.figure}`,
    `能力模型：${pioneer.name}`,
    `核心价值：${pioneer.values.join("、")}`,
    `说话风格：${pioneer.speakingStyle}`,
    `语言节奏：${pioneer.voiceProfile.rhythm}`,
    `推理动作：${pioneer.voiceProfile.reasoningMove}`,
    `偏好概念：${pioneer.voiceProfile.preferredWords.join("、")}`,
    `意象额度：每段最多 ${pioneer.voiceProfile.imageryBudget} 个意象`,
    `情感距离：${pioneer.voiceProfile.emotionalDistance}`,
    `禁止模式：${pioneer.voiceProfile.avoidPatterns.join("；")}`,
    `交锋主张：${pioneer.voiceProfile.crossfireClaim}`,
    `反方风险：${pioneer.voiceProfile.counterRisk}`,
    `决策方式：${pioneer.decisionStyle}`,
    `温和推回：${pioneer.pushback}`,
    `练习方向：${pioneer.practice}`
  ].join("\n");
}

export function describeAnalysis(analysis: ThemeAnalysis) {
  return [
    `主题：${analysis.theme}`,
    `核心张力：${analysis.tension}`,
    `情绪：${analysis.emotion}`,
    `真正需要：${analysis.need}`,
    `推荐理由：${analysis.reason}`
  ].join("\n");
}
