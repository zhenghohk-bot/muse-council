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
  recommendedPioneerIds: string[];
  reason: string;
};

export type RoundtableSession = {
  id: string;
  userId?: string;
  question: string;
  theme: string;
  tension: string;
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
  quote?: string;
  sourceNoteIds: string[];
  createdAt: string;
};

export type ActionCard = {
  sessionId: string;
  within24h: string;
  sevenDayExperiment: string;
  thirtyDayPractice: string;
  evidenceToReview: string;
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
