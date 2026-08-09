export type RoundtableStage =
  | "intake"
  | "analyze"
  | "recommend"
  | "opening"
  | "first_round"
  | "discussion"
  | "crossfire"
  | "follow_up"
  | "synthesis"
  | "action_card"
  | "quote_card";

export type SpeakerRole = "user" | "moderator" | "pioneer";

export type SupportMode = "unknown_cause" | "named_emotion" | "experience_context";

export type QuestionIntent =
  | "decision"
  | "problem_solving"
  | "skill_building"
  | "emotional_support"
  | "self_reflection"
  | "creative_exploration";

export type SpeechAct =
  | "name_emotion"
  | "reframe"
  | "distinguish"
  | "challenge"
  | "share_experience"
  | "ask_question"
  | "propose_action";

export type TurnRelation = "open" | "independent" | "extend" | "challenge" | "clarify" | "redirect";

export type DiscussionMode = "crossfire" | "sequence" | "complement" | "clarify" | "skip";

export type UserTurnIntent =
  | "question"
  | "concern"
  | "reflection"
  | "commitment"
  | "disagreement"
  | "emotion"
  | "request_other_view"
  | "closure"
  | "user_correction";

export type FollowUpPlan = {
  primaryPioneerId: string;
  secondaryPioneerId?: string;
  secondaryMode: "none" | "extend" | "challenge" | "alternate";
  focus: string;
  rationale: string;
};

export type DiscussionPlan = {
  mode: DiscussionMode;
  label: string;
  speakerIds: string[];
  primaryMessageIds: string[];
  focus: string;
  rationale: string;
  hasTrueConflict: boolean;
};

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
  sourceKind?: "primary_source" | "verified_biography" | "scholarly_interpretation" | "contemporary_projection";
  work?: string;
  locator?: string;
  sourceUrl?: string;
  confidence?: "high" | "medium" | "interpretive";
  prohibitedUses?: string[];
};

export type PioneerFallbackMove = {
  id: string;
  matchTerms: string[];
  operation: string;
  judgment: string;
  question?: string;
  action?: string;
};

export type PioneerMind = {
  capabilities: {
    strongestIntents: QuestionIntent[];
    handles: string[];
    avoids: string[];
    usefulOutputs: string[];
  };
  reasoning: {
    attentionOrder: string[];
    coreDistinctions: string[];
    evidenceStandard: string;
    changesMindWhen: string[];
    blindSpots: string[];
  };
  interaction: {
    agreesWhen: string[];
    challengesWhen: string[];
    extendsWith: string[];
    concessionStyle: string;
    boundaries: string[];
  };
  contemporaryProjection: {
    enduringPrinciples: string[];
    modernMappings: string[];
    confidenceBoundary: string;
  };
  fallbackMoves: PioneerFallbackMove[];
};

export type VoiceProfile = {
  tone: string;
  firmness: string;
  directness: string;
  responsePosture: string;
  questionStyle: string;
  humor: string;
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
  addressName: string;
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
  mind?: PioneerMind;
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
  discussionMode?: DiscussionMode;
  deniedAssumptions?: string[];
  userCommitment?: string;
  readyToClose?: boolean;
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
  referencedMessageIds?: string[];
  discussionMode?: DiscussionMode;
  userTurnIntent?: UserTurnIntent;
  messageKind?: "standard" | "correction" | "ready_to_close";
  status?: "active" | "retracted" | "superseded";
  retractedReason?: string;
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

export type HistoricalEcho = {
  id: string;
  pioneerId: string;
  originalText: string;
  translatedText?: string;
  work: string;
  locator?: string;
  sourceUrl: string;
  tags: string[];
  editorialNote?: string;
};

export type QuoteCard = {
  sessionId: string;
  quote: string;
  speakerId: string;
  context: string;
  sourceMessageId?: string;
  sourceMessageIds?: string[];
  kind?: "roundtable_excerpt" | "closing_note";
  historicalEcho?: HistoricalEcho;
};

export type CardLayout = "long" | "collage";

export type CardPreferences = {
  likedQuoteCardIds: string[];
  selectedQuoteCardIds: string[];
  includeActionCard: boolean;
  myLine: string;
  includeMyLine: boolean;
  layout: CardLayout;
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
