import { getPioneerOrError, generator, json, parseBody, touchSession } from "@/app/api/roundtable/_utils";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { RoundtableMessage, RoundtableSession } from "@/lib/types";

export async function POST(request: Request) {
  const body = await parseBody<{ session?: RoundtableSession; messages?: RoundtableMessage[] }>(request);
  if (!body?.session) {
    return json({ ok: false, error: "缺少圆桌 session。" }, 400);
  }

  const session = touchSession(body.session, "action_card");
  const selected = session.selectedPioneerIds.map(getPioneerOrError);
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((message) => message?.sessionId === session.id && typeof message.content === "string")
        .slice(-20)
    : [];
  const result = await generator.finalize(session, selected, messages);

  const finalSession = touchSession(session, "quote_card");
  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(finalSession);
  await persistence.upsertFinalCards(result.data.actionCard, result.data.quoteCards);

  return json({
    ok: true,
    data: {
      session: finalSession,
      actionCard: result.data.actionCard,
      quoteCards: result.data.quoteCards
    },
    usedFallback: result.usedFallback
  });
}
