import { pioneers } from "@/data/pioneers";
import { director, json, parseBody } from "@/app/api/roundtable/_utils";
import { getBearerToken, PersistenceAdapter } from "@/lib/persistence-adapter";

export async function POST(request: Request) {
  const body = await parseBody<{ question?: string }>(request);
  const question = body?.question?.trim();

  if (!question) {
    return json({ ok: false, error: "请先写下你的问题。" }, 400);
  }

  const persistence = new PersistenceAdapter(getBearerToken(request));
  const userId = await persistence.getUserId();
  const analysis = await director.analyze(question);
  const session = director.createSession(question, analysis, userId);

  await persistence.upsertSession(session);

  return json({
    ok: true,
    data: {
      session,
      analysis,
      pioneers,
      recommendedPioneers: pioneers.filter((pioneer) => analysis.recommendedPioneerIds.includes(pioneer.id))
    }
  });
}
