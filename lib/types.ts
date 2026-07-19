export type RoundtableStage =
  | "intake"
  | "analyze"
  | "recommend"
  | "opening"
  | "first_round"
  | "crossfire"
  | "follow_up"
  | "synthesis"
  | "action_card"
  | "quote_card";

export type SpeakerRole = "user" | "moderator" | "pioneer";

export type SupportMode = "unknown_cause" | "named_emotion" | "experience_context";

export type SpeechAct =
  | "name_emotion"
  | "reframe"
  | "distinguish"
  | "challenge"
  | "share_experience"
  | "ask_question"
  | "propose_action";

export type TurnRelation = "open" | "extend" | "challenge" | "clarify" | "redirect";

export type ConversationAssignment = {
  pioneerId: string;
  speechAct: SpeechAct;
  relation: TurnRelation;
  respondsToPioneerId?: string;
  objective: string;
  newContribution: string;
  actionMode: "none" | "offer_one_step";
};

export type ConversationPlan = {
  assignments: ConversationAssignment[];
  rationale: string;
};

export type SourceNote = {
  id: string;
  pioneerId: string;
  type: "life" | "work" | "idea";
  title: string;
  note: string;
  usageHint: string;
};

export type VoiceProfile = {
  rhythm: string;
  reasoningMove: string;
  preferredWords: string[];
  imageryBudget: number;
  emotionalDistance: string;
  avoidPatterns: string[];
  crossfireClaim: string;
  counterRisk: string;
  preferredSpeechActs: SpeechAct[];
};

export type PioneerProfile = {
  id: string;
  name: string;
  figure: string;
  title: string;
  era: string;
  archetype: string;
  avatar: string;
  color: string;
  values: string[];
  suitableFor: string[];
  speakingStyle: string;
  voiceProfile: VoiceProfile;
  decisionStyle: string;
  pushback: string;
  practice: string;
  sourceNotes: SourceNote[];
};

export type ThemeAnalysis = {
  theme: string;
  tension: string;
  emotion: string;
  need: string;
  supportMode: SupportMode;
  explicitEmotionTerms: string[];
  recommendedPioneerIds: string[];
  reason: string;
};

export type RoundtableSession = {
  id: string;
  userId?: string;
  question: string;
  theme: string;
  tension: string;
  supportMode: SupportMode;
  explicitEmotionTerms: string[];
  selectedPioneerIds: string[];
  stage: RoundtableStage;
  createdAt: string;
  updatedAt: string;
};

export type RoundtableMessage = {
  id: string;
  sessionId: string;
  role: SpeakerRole;
  speakerId: string;
  stage: RoundtableStage;
  content: string;
  segments?: string[];
  quote?: string;
  speechAct?: SpeechAct;
  relation?: TurnRelation;
  respondsToMessageId?: string;
  newContribution?: string;
  sourceNoteIds: string[];
  createdAt: string;
};

export type ActionCard = {
  sessionId: string;
  chosenPath: string;
  within24h: string;
  sevenDayExperiment: string;
  thirtyDayPractice: string;
  guardrail: string;
  evidenceToReview: string;
  sourceMessageIds?: string[];
};

export type QuoteCard = {
  sessionId: string;
  quote: string;
  speakerId: string;
  context: string;
  sourceMessageId?: string;
};

export type ApiEnvelope<T> =
  | {
      ok: true;
      data: T;
      usedFallback?: boolean;
    }
  | {
      ok: false;
      error: string;
    };
