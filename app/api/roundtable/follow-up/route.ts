import {
  generator,
  getPioneerOrError,
  getSourceIds,
  json,
  makeMessage,
  parseBody,
  touchSession
} from "@/app/api/roundtable/_utils";
import { retrieveSourceNotes } from "@/lib/harness/source-retriever";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { RoundtableMessage, RoundtableSession } from "@/lib/types";

export async function POST(request: Request) {
  const body = await parseBody<{
    session?: RoundtableSession;
    pioneerId?: string;
    followUp?: string;
    messages?: RoundtableMessage[];
  }>(request);
  const followUp = body?.followUp?.trim();
  if (!body?.session || !body.pioneerId || !followUp) {
    return json({ ok: false, error: "缺少追问内容或先行者。" }, 400);
  }

  const pioneer = getPioneerOrError(body.pioneerId);
  const session = touchSession(body.session, "follow_up");
  const sourceNotes = retrieveSourceNotes(pioneer.id, session.question, 2);
  const userMessage = makeMessage({
    sessionId: session.id,
    role: "user",
    speakerId: "user",
    stage: "follow_up",
    content: followUp
  });
  const result = await generator.followUp(session, pioneer, followUp, sourceNotes, body.messages ?? []);
  const reply = makeMessage({
    sessionId: session.id,
    role: "pioneer",
    speakerId: pioneer.id,
    stage: "follow_up",
    content: result.data.content,
    quote: result.data.quote,
    sourceNoteIds: getSourceIds(pioneer.id, session.question)
  });

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages([userMessage, reply]);

  return json({ ok: true, data: { session, messages: [userMessage, reply], sourceNotes }, usedFallback: result.usedFallback });
}
