import { director, generator, json, makeMessage, parseBody, touchSession } from "@/app/api/roundtable/_utils";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { RoundtableMessage, RoundtableSession } from "@/lib/types";

export async function POST(request: Request) {
  const body = await parseBody<{ session?: RoundtableSession; messages?: RoundtableMessage[] }>(request);
  if (!body?.session) {
    return json({ ok: false, error: "缺少圆桌 session。" }, 400);
  }

  const history = Array.isArray(body.messages)
    ? body.messages.filter(
        (message) =>
          message?.sessionId === body.session!.id &&
          typeof message.content === "string" &&
          message.status !== "retracted" &&
          message.status !== "superseded"
      )
    : [];
  const planResult = await director.planDiscussionWithMeta(body.session, history);
  const discussionSession = {
    ...touchSession(body.session, "discussion"),
    discussionMode: planResult.data.mode
  };
  const result = await generator.discussion(discussionSession, planResult.data, history);
  const messages: RoundtableMessage[] = result.data.turns.map((turn) =>
    makeMessage({
      sessionId: discussionSession.id,
      role: "pioneer",
      speakerId: turn.speakerId,
      stage: "discussion",
      content: turn.content,
      segments: turn.segments,
      relation: planResult.data.mode === "crossfire" ? "challenge" : "extend",
      respondsToMessageId: turn.referencedMessageIds[0],
      referencedMessageIds: turn.referencedMessageIds,
      newContribution: turn.newContribution,
      discussionMode: planResult.data.mode,
      sourceNoteIds: []
    })
  );
  if (result.data.synthesis) {
    messages.push(
      makeMessage({
        sessionId: discussionSession.id,
        role: "moderator",
        speakerId: "moderator",
        stage: "synthesis",
        content: result.data.synthesis,
        referencedMessageIds: messages.map((message) => message.id),
        discussionMode: planResult.data.mode
      })
    );
  }

  const finalStage = messages.some((message) => message.stage === "synthesis") ? "synthesis" : "follow_up";
  const session = { ...touchSession(discussionSession, finalStage), discussionMode: planResult.data.mode };
  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages(messages);

  return json({
    ok: true,
    data: { session, discussionPlan: planResult.data, messages },
    usedFallback: planResult.usedFallback || result.usedFallback
  });
}
