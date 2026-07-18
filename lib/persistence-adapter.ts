import type { ActionCard, QuoteCard, RoundtableMessage, RoundtableSession } from "@/lib/types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function supabaseFetch(path: string, token: string, init: RequestInit) {
  if (!supabaseUrl || !supabaseAnonKey || !token) return undefined;

  return fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
      ...(init.headers ?? {})
    }
  });
}

export class PersistenceAdapter {
  constructor(private readonly token?: string) {}

  async getUserId() {
    if (!this.token || !supabaseUrl || !supabaseAnonKey) return undefined;

    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) return undefined;
    const user = (await response.json()) as { id?: string };
    return user.id;
  }

  async upsertSession(session: RoundtableSession) {
    if (!this.token || !session.userId) return;

    await supabaseFetch("/rest/v1/roundtable_sessions?on_conflict=id", this.token, {
      method: "POST",
      body: JSON.stringify({
        id: session.id,
        user_id: session.userId,
        question: session.question,
        theme: session.theme,
        tension: session.tension,
        selected_pioneer_ids: session.selectedPioneerIds,
        stage: session.stage,
        created_at: session.createdAt,
        updated_at: session.updatedAt
      })
    });
  }

  async insertMessages(messages: RoundtableMessage[]) {
    if (!this.token || messages.length === 0) return;

    await supabaseFetch("/rest/v1/roundtable_messages?on_conflict=id", this.token, {
      method: "POST",
      body: JSON.stringify(
        messages.map((message) => ({
          id: message.id,
          session_id: message.sessionId,
          role: message.role,
          speaker_id: message.speakerId,
          stage: message.stage,
          content: message.content,
          quote: message.quote ?? null,
          source_note_ids: message.sourceNoteIds,
          created_at: message.createdAt
        }))
      )
    });
  }

  async upsertFinalCards(actionCard: ActionCard, quoteCards: QuoteCard[]) {
    if (!this.token) return;

    await supabaseFetch("/rest/v1/action_cards?on_conflict=session_id", this.token, {
      method: "POST",
      body: JSON.stringify({
        session_id: actionCard.sessionId,
        within_24h: actionCard.within24h,
        seven_day_experiment: actionCard.sevenDayExperiment,
        thirty_day_practice: actionCard.thirtyDayPractice,
        evidence_to_review: actionCard.evidenceToReview
      })
    });

    await supabaseFetch("/rest/v1/quote_cards", this.token, {
      method: "POST",
      body: JSON.stringify(
        quoteCards.map((quoteCard) => ({
          session_id: quoteCard.sessionId,
          quote: quoteCard.quote,
          speaker_id: quoteCard.speakerId,
          context: quoteCard.context
        }))
      )
    });
  }
}

export function getBearerToken(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}
