import { director, generator, getPioneerOrError, json, makeMessage, parseBody, touchSession } from "@/app/api/roundtable/_utils";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { RoundtableMessage, RoundtableSession } from "@/lib/types";

export async function POST(request: Request) {
  const body = await parseBody<{ session?: RoundtableSession; messages?: RoundtableMessage[] }>(request);
  if (!body?.session) {
    return json({ ok: false, error: "缺少圆桌 session。" }, 400);
  }

  const session = touchSession(body.session, "crossfire");
  const pair = director.chooseCrossfirePair(session.selectedPioneerIds, session.theme);
  const first = getPioneerOrError(pair.firstId);
  const second = getPioneerOrError(pair.secondId);
  const history = Array.isArray(body.messages)
    ? body.messages
        .filter((message) => message?.sessionId === session.id && typeof message.content === "string")
        .slice(-16)
    : [];
  const result = await generator.crossfire(session, first, second, pair.tension, history);

  const messages = [
    makeMessage({
      sessionId: session.id,
      role: "pioneer",
      speakerId: first.id,
      stage: "crossfire",
      content: result.data.first,
      sourceNoteIds: [first.sourceNotes[0]?.id].filter(Boolean)
    }),
    makeMessage({
      sessionId: session.id,
      role: "pioneer",
      speakerId: second.id,
      stage: "crossfire",
      content: result.data.second,
      sourceNoteIds: [second.sourceNotes[0]?.id].filter(Boolean)
    }),
    makeMessage({
      sessionId: session.id,
      role: "moderator",
      speakerId: "moderator",
      stage: "synthesis",
      content: result.data.synthesis
    })
  ];

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(touchSession(session, "synthesis"));
  await persistence.insertMessages(messages);

  return json({
    ok: true,
    data: { session: touchSession(session, "synthesis"), pair, messages },
    usedFallback: result.usedFallback
  });
}
