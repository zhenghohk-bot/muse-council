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
    messages?: RoundtableMessage[];
  }>(request);
  if (!body?.session || !body.pioneerId) {
    return json({ ok: false, error: "缺少 session 或先行者。" }, 400);
  }

  const pioneer = getPioneerOrError(body.pioneerId);
  const session = touchSession(body.session, "first_round");
  const sourceNotes = retrieveSourceNotes(pioneer.id, session.question, 2);
  const result = await generator.pioneerSpeech(session, pioneer, sourceNotes, body.messages ?? []);
  const message = makeMessage({
    sessionId: session.id,
    role: "pioneer",
    speakerId: pioneer.id,
    stage: "first_round",
    content: result.data.content,
    quote: result.data.quote,
    sourceNoteIds: getSourceIds(pioneer.id, session.question)
  });

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages([message]);

  return json({ ok: true, data: { session, message, sourceNotes }, usedFallback: result.usedFallback });
}
