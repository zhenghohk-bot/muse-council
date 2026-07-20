import {
  generator,
  getPioneerOrError,
  getSourceIds,
  json,
  makeMessage,
  parseBody,
  touchSession
} from "@/app/api/roundtable/_utils";
import { retrieveSourceNotes, sessionRetrievalContext } from "@/lib/harness/source-retriever";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { ConversationAssignment, RoundtableMessage, RoundtableSession } from "@/lib/types";

export async function POST(request: Request) {
  const body = await parseBody<{
    session?: RoundtableSession;
    pioneerId?: string;
    messages?: RoundtableMessage[];
    assignment?: ConversationAssignment;
  }>(request);
  if (!body?.session || !body.pioneerId) {
    return json({ ok: false, error: "缺少 session 或先行者。" }, 400);
  }

  const pioneer = getPioneerOrError(body.pioneerId);
  const session = touchSession(body.session, "first_round");
  const retrievalContext = sessionRetrievalContext(session);
  const sourceNotes = retrieveSourceNotes(pioneer.id, retrievalContext, 2);
  const result = await generator.pioneerSpeech(
    session,
    pioneer,
    sourceNotes,
    body.messages ?? [],
    body.assignment
  );
  const respondsToMessageId = body.assignment?.respondsToPioneerId
    ? body.messages
        ?.filter(
          (message) =>
            message.speakerId === body.assignment?.respondsToPioneerId && message.stage === "first_round"
        )
        .at(-1)?.id
    : undefined;
  const message = makeMessage({
    sessionId: session.id,
    role: "pioneer",
    speakerId: pioneer.id,
    stage: "first_round",
    content: result.data.content,
    segments: result.data.segments,
    quote: result.data.quote,
    speechAct: body.assignment?.speechAct,
    relation: body.assignment?.relation,
    respondsToMessageId,
    newContribution: result.data.deliveredContribution ?? body.assignment?.newContribution,
    sourceNoteIds: getSourceIds(pioneer.id, retrievalContext)
  });

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages([message]);

  return json({ ok: true, data: { session, message, sourceNotes }, usedFallback: result.usedFallback });
}
