import { director, generator, json, makeMessage, parseBody, touchSession } from "@/app/api/roundtable/_utils";
import { getPioneers } from "@/data/pioneers";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";
import type { RoundtableSession } from "@/lib/types";

export async function POST(request: Request) {
  const body = await parseBody<{ session?: RoundtableSession; selectedPioneerIds?: string[] }>(request);
  if (!body?.session) {
    return json({ ok: false, error: "缺少圆桌 session。" }, 400);
  }

  const session = touchSession(body.session, "opening", body.selectedPioneerIds?.slice(0, 5));
  const selected = getPioneers(session.selectedPioneerIds);
  const [result, planResult] = await Promise.all([
    generator.opening(session),
    director.planConversationWithMeta(session, selected)
  ]);
  const message = makeMessage({
    sessionId: session.id,
    role: "moderator",
    speakerId: "moderator",
    stage: "opening",
    content: result.data.content,
    quote: result.data.quote
  });

  const persistence = new PersistenceAdapter(getBearerToken(request));
  await persistence.upsertSession(session);
  await persistence.insertMessages([message]);

  return json({
    ok: true,
    data: { session, message, conversationPlan: planResult.data, planUsedFallback: planResult.usedFallback },
    usedFallback: result.usedFallback || planResult.usedFallback
  });
}
