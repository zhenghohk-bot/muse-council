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
import { resolveTurnSupportContext } from "@/lib/harness/support-mode";
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
  const touchedSession = touchSession(body.session, "follow_up");
  const supportContext = resolveTurnSupportContext(touchedSession, followUp);
  const session: RoundtableSession = {
    ...touchedSession,
    supportMode: supportContext.mode,
    explicitEmotionTerms: supportContext.explicitEmotionTerms
  };
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
    segments: result.data.segments,
    quote: result.data.quote,
    speechAct: result.assignment.speechAct,
    relation: result.assignment.relation,
    respondsToMessageId: userMessage.id,
    newContribution: result.data.deliveredContribution ?? result.assignment.newContribution,
    sourceNoteIds: getSourceIds(pioneer.id, session.question)
  });

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages([userMessage, reply]);

  return json({ ok: true, data: { session, messages: [userMessage, reply], sourceNotes }, usedFallback: result.usedFallback });
}
