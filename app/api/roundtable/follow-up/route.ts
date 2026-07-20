import {
  director,
  generator,
  getPioneerOrError,
  getSourceIds,
  json,
  makeMessage,
  parseBody,
  touchSession
} from "@/app/api/roundtable/_utils";
import { getPioneers } from "@/data/pioneers";
import { retrieveSourceNotes, sessionRetrievalContext } from "@/lib/harness/source-retriever";
import { resolveTurnSupportContext } from "@/lib/harness/support-mode";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { ConversationAssignment, RoundtableMessage, RoundtableSession, SourceNote } from "@/lib/types";

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

  const history = Array.isArray(body.messages) ? body.messages : [];
  const touchedSession = touchSession(body.session, "follow_up");
  const pioneer = getPioneerOrError(body.pioneerId);
  const supportContext = resolveTurnSupportContext(touchedSession, followUp);
  const intent = director.classifyUserTurn(followUp);
  const retrievalContext = sessionRetrievalContext(touchedSession, followUp);
  const sourceNotes = retrieveSourceNotes(pioneer.id, retrievalContext, 2);
  const challengedTerm = intent === "user_correction" ? director.findCorrectionTerm(followUp, history) : undefined;
  const priorUserText = `${touchedSession.question}\n${history
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n")}`;
  const deniedAssumptions = [...(touchedSession.deniedAssumptions ?? [])];
  if (challengedTerm && !priorUserText.includes(challengedTerm) && !deniedAssumptions.includes(challengedTerm)) {
    deniedAssumptions.push(challengedTerm);
  }
  const shouldOfferClose =
    (intent === "commitment" || intent === "closure") && !touchedSession.readyToClose;
  const session: RoundtableSession = {
    ...touchedSession,
    supportMode: supportContext.mode,
    explicitEmotionTerms: supportContext.explicitEmotionTerms,
    deniedAssumptions,
    userCommitment:
      intent === "commitment" || intent === "closure" ? followUp : touchedSession.userCommitment,
    readyToClose: shouldOfferClose || touchedSession.readyToClose
  };
  const userMessage = makeMessage({
    sessionId: session.id,
    role: "user",
    speakerId: "user",
    stage: "follow_up",
    content: followUp,
    userTurnIntent: intent
  });

  const result =
    intent === "user_correction"
      ? await generator.correctMisreading(session, pioneer, followUp, challengedTerm, history)
      : await generator.followUp(session, pioneer, followUp, sourceNotes, history, intent);
  const retractedMessageIds = "retractedMessageIds" in result ? result.retractedMessageIds : [];
  const assignment =
    "assignment" in result
      ? result.assignment
      : {
          speechAct: "distinguish" as const,
          relation: "clarify" as const,
          newContribution: "撤回误读"
        };
  const reply = makeMessage({
    sessionId: session.id,
    role: "pioneer",
    speakerId: pioneer.id,
    stage: "follow_up",
    content: result.data.content,
    segments: result.data.segments,
    quote: result.data.quote,
    speechAct: assignment.speechAct,
    relation: assignment.relation,
    respondsToMessageId: userMessage.id,
    referencedMessageIds: [userMessage.id, ...retractedMessageIds],
    newContribution:
      result.data.deliveredContribution ??
      assignment.newContribution,
    userTurnIntent: intent,
    messageKind: intent === "user_correction" ? "correction" : "standard",
    sourceNoteIds: getSourceIds(pioneer.id, retrievalContext)
  });
  const messages: RoundtableMessage[] = [userMessage, reply];
  const allSourceNotes: SourceNote[] = [...sourceNotes];
  const selectedPioneers = getPioneers(session.selectedPioneerIds);
  const followUpPlanResult = await director.planFollowUpWithMeta(
    session,
    selectedPioneers,
    pioneer.id,
    followUp,
    intent,
    [...history, userMessage, reply]
  );
  let secondaryUsedFallback = false;

  if (followUpPlanResult.data.secondaryPioneerId) {
    const secondary = getPioneerOrError(followUpPlanResult.data.secondaryPioneerId);
    const secondaryContext = sessionRetrievalContext(session, followUp);
    const secondaryNotes = retrieveSourceNotes(secondary.id, secondaryContext, 2);
    const secondaryAssignment: ConversationAssignment = {
      pioneerId: secondary.id,
      speechAct:
        followUpPlanResult.data.secondaryMode === "challenge"
          ? "challenge"
          : followUpPlanResult.data.secondaryMode === "alternate"
            ? "reframe"
            : "distinguish",
      relation:
        followUpPlanResult.data.secondaryMode === "challenge"
          ? "challenge"
          : followUpPlanResult.data.secondaryMode === "alternate"
            ? "redirect"
            : "extend",
      respondsToPioneerId: pioneer.id,
      objective: followUpPlanResult.data.focus,
      newContribution: followUpPlanResult.data.focus,
      actionMode: "none"
    };
    const secondaryResult = await generator.followUp(
      session,
      secondary,
      followUp,
      secondaryNotes,
      [...history, userMessage, reply],
      intent,
      secondaryAssignment
    );
    secondaryUsedFallback = secondaryResult.usedFallback === true;
    messages.push(
      makeMessage({
        sessionId: session.id,
        role: "pioneer",
        speakerId: secondary.id,
        stage: "follow_up",
        content: secondaryResult.data.content,
        segments: secondaryResult.data.segments,
        quote: secondaryResult.data.quote,
        speechAct: secondaryAssignment.speechAct,
        relation: secondaryAssignment.relation,
        respondsToMessageId: reply.id,
        referencedMessageIds: [userMessage.id, reply.id],
        newContribution: secondaryResult.data.deliveredContribution ?? secondaryAssignment.newContribution,
        userTurnIntent: intent,
        sourceNoteIds: getSourceIds(secondary.id, secondaryContext)
      })
    );
    allSourceNotes.push(...secondaryNotes);
  }

  if (shouldOfferClose) {
    messages.push(
      makeMessage({
        sessionId: session.id,
        role: "moderator",
        speakerId: "moderator",
        stage: "follow_up",
        content: "这个方向如果已经足够清楚，可以收束圆桌，把它整理成行动卡；还有顾虑，也可以继续聊。",
        referencedMessageIds: [userMessage.id, ...messages.filter((message) => message.role === "pioneer").map((message) => message.id)],
        userTurnIntent: intent,
        messageKind: "ready_to_close"
      })
    );
  }

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages(messages);

  return json({
    ok: true,
    data: {
      session,
      messages,
      sourceNotes: [...new Map(allSourceNotes.map((note) => [note.id, note])).values()],
      retractedMessageIds,
      intent,
      followUpPlan: followUpPlanResult.data
    },
    usedFallback: result.usedFallback || followUpPlanResult.usedFallback || secondaryUsedFallback
  });
}
