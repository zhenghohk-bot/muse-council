import { classifyQuestionIntent } from "@/lib/harness/question-intent";
import type {
  ConversationAssignment,
  PioneerFallbackMove,
  PioneerProfile,
  RoundtableSession
} from "@/lib/types";

function list(label: string, values: string[]) {
  return values.length ? `${label}：${values.join("；")}` : "";
}

export function describePioneerMind(pioneer: PioneerProfile) {
  const mind = pioneer.mind;
  if (!mind) return "";

  return [
    "人物心智模型：",
    list("最适合的任务意图", mind.capabilities.strongestIntents),
    list("擅长处理", mind.capabilities.handles),
    list("能力边界", mind.capabilities.avoids),
    list("能带来的产出", mind.capabilities.usefulOutputs),
    list("观察顺序", mind.reasoning.attentionOrder),
    list("核心区分", mind.reasoning.coreDistinctions),
    `证据标准：${mind.reasoning.evidenceStandard}`,
    list("改变判断的条件", mind.reasoning.changesMindWhen),
    list("人物盲点", mind.reasoning.blindSpots),
    list("自然赞同的条件", mind.interaction.agreesWhen),
    list("适合提出异议的条件", mind.interaction.challengesWhen),
    list("适合补充的新层次", mind.interaction.extendsWith),
    `让步方式：${mind.interaction.concessionStyle}`,
    list("互动边界", mind.interaction.boundaries),
    list("可延伸到当代的原则", mind.contemporaryProjection.enduringPrinciples),
    list("当代映射", mind.contemporaryProjection.modernMappings),
    `当代推演边界：${mind.contemporaryProjection.confidenceBoundary}`
  ]
    .filter(Boolean)
    .join("\n");
}

function fallbackContext(session: RoundtableSession, assignment?: ConversationAssignment) {
  return [
    session.question,
    session.theme,
    session.tension,
    assignment?.objective,
    assignment?.newContribution
  ]
    .filter(Boolean)
    .join(" ");
}

export function selectPioneerFallbackMove(
  pioneer: PioneerProfile,
  session: RoundtableSession,
  assignment?: ConversationAssignment
): PioneerFallbackMove | undefined {
  const moves = pioneer.mind?.fallbackMoves ?? [];
  if (!moves.length) return undefined;

  const context = fallbackContext(session, assignment);
  const intent = classifyQuestionIntent(session.question);
  const ranked = moves
    .map((move, index) => {
      const termScore = move.matchTerms.reduce(
        (score, term) => score + (context.toLowerCase().includes(term.toLowerCase()) ? 2 : 0),
        0
      );
      const intentScore = move.matchTerms.includes(intent.primary) ? 3 : 0;
      return { move, index, score: termScore + intentScore };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return ranked[0]?.score > 0
    ? ranked[0].move
    : moves.find((move) => move.id === "general") ?? moves[0];
}

export function describeFallbackMoves(pioneer: PioneerProfile) {
  const moves = pioneer.mind?.fallbackMoves ?? [];
  if (!moves.length) return "";
  return [
    "人物专属兜底动作：",
    ...moves.map(
      (move) =>
        `- ${move.id}：适用于${move.matchTerms.join("、")}；思维动作是${move.operation}。这只是失效时的思考路径，不得照抄固定开头。`
    )
  ].join("\n");
}
