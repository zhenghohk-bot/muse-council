import { pioneerById } from "@/data/pioneers";
import { RoundtableDirector } from "@/lib/harness/director";
import { guardMessage } from "@/lib/harness/output-guard";
import { retrieveSourceNotes } from "@/lib/harness/source-retriever";
import { StageGenerator } from "@/lib/harness/stage-generator";
import type {
  ApiEnvelope,
  RoundtableMessage,
  RoundtableSession,
  RoundtableStage,
  SpeechAct,
  TurnRelation
} from "@/lib/types";

export const director = new RoundtableDirector();
export const generator = new StageGenerator();

export function json<T>(data: ApiEnvelope<T>, status = 200) {
  return Response.json(data, { status });
}

export async function parseBody<T>(request: Request) {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

export function makeMessage(input: {
  sessionId: string;
  role: "user" | "moderator" | "pioneer";
  speakerId: string;
  stage: RoundtableStage;
  content: string;
  quote?: string;
  speechAct?: SpeechAct;
  relation?: TurnRelation;
  respondsToMessageId?: string;
  newContribution?: string;
  sourceNoteIds?: string[];
}): RoundtableMessage {
  return guardMessage({
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    speakerId: input.speakerId,
    stage: input.stage,
    content: input.content,
    quote: input.quote,
    speechAct: input.speechAct,
    relation: input.relation,
    respondsToMessageId: input.respondsToMessageId,
    newContribution: input.newContribution,
    sourceNoteIds: input.sourceNoteIds ?? [],
    createdAt: new Date().toISOString()
  });
}

export function touchSession(session: RoundtableSession, stage: RoundtableStage, selectedPioneerIds?: string[]) {
  return {
    ...session,
    selectedPioneerIds: selectedPioneerIds ?? session.selectedPioneerIds,
    stage,
    updatedAt: new Date().toISOString()
  };
}

export function getPioneerOrError(pioneerId: string) {
  const pioneer = pioneerById.get(pioneerId);
  if (!pioneer) {
    throw new Error(`Unknown pioneer: ${pioneerId}`);
  }
  return pioneer;
}

export function getSourceIds(pioneerId: string, question: string) {
  return retrieveSourceNotes(pioneerId, question, 2).map((note) => note.id);
}
