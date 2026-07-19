import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { getPioneers } from "@/data/pioneers";
import { RoundtableDirector } from "@/lib/harness/director";
import { findClarityIssues, findConversationOverlap, findSegmentIssues } from "@/lib/harness/output-guard";
import { retrieveSourceNotes } from "@/lib/harness/source-retriever";
import { StageGenerator } from "@/lib/harness/stage-generator";
import type {
  ActionCard,
  ConversationAssignment,
  QuoteCard,
  RoundtableMessage,
  RoundtableSession,
  RoundtableStage,
  ThemeAnalysis
} from "@/lib/types";
import { evalQuestions, type EvalQuestion } from "@/scripts/eval-questions";
import { judgeCase, type JudgeInput, type JudgeResult } from "@/scripts/eval-judge";

config({ path: path.join(process.cwd(), ".env.local") });

const WEIGHTS = {
  readingAccuracy: 0.15,
  roleDistinctiveness: 0.15,
  conversationProgression: 0.15,
  repetitionControl: 0.1,
  responseRelevance: 0.1,
  languageClarity: 0.1,
  safety: 0.05,
  actionCardQuality: 0.15,
  quoteCardQuality: 0.05
} as const;

const QUALITY_GATES = {
  overallScore: 88,
  readingAccuracy: 85,
  roleDistinctiveness: 85,
  conversationProgression: 90,
  repetitionControl: 90,
  responseRelevance: 88,
  languageClarity: 88,
  safety: 90,
  actionCardQuality: 90,
  quoteCardQuality: 85
} as const;

const RELEASE_GATES = {
  overallScore: 82,
  readingAccuracy: 85,
  roleDistinctiveness: 75,
  conversationProgression: 80,
  repetitionControl: 80,
  responseRelevance: 80,
  languageClarity: 80,
  safety: 90,
  actionCardQuality: 75,
  quoteCardQuality: 85
} as const;

const SMOKE_IDS = ["career-side-hustle", "probe-heavy-mornings"];

type SuccessfulCase = {
  id: string;
  bucket: string;
  question: string;
  analysis: ThemeAnalysis;
  messages: RoundtableMessage[];
  actionCard: ActionCard;
  quoteCards: QuoteCard[];
  fallbackStages: string[];
  deterministicFindings: string[];
  criticalFailures: string[];
  judgment: JudgeResult;
  overallScore: number;
  passed: boolean;
  meetsTarget: boolean;
  judgeAttempts: number;
};

type FailedCase = {
  id: string;
  bucket: string;
  question: string;
  error: string;
  passed: false;
};

type EvalCaseResult = SuccessfulCase | FailedCase;

type PreparedCase = {
  id: string;
  bucket: string;
  question: string;
  analysis: ThemeAnalysis;
  pioneers: JudgeInput["pioneers"];
  messages: RoundtableMessage[];
  actionCard: ActionCard;
  quoteCards: QuoteCard[];
  fallbackStages: string[];
  deterministicFindings: string[];
  criticalFailures: string[];
};

function makeMessage(input: {
  sessionId: string;
  role: "user" | "moderator" | "pioneer";
  speakerId: string;
  stage: RoundtableStage;
  content: string;
  segments?: string[];
  quote?: string;
  assignment?: ConversationAssignment;
  respondsToMessageId?: string;
  newContribution?: string;
  sourceNoteIds?: string[];
}): RoundtableMessage {
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    speakerId: input.speakerId,
    stage: input.stage,
    content: input.content,
    segments: input.segments,
    quote: input.quote,
    speechAct: input.assignment?.speechAct,
    relation: input.assignment?.relation,
    respondsToMessageId: input.respondsToMessageId,
    newContribution: input.newContribution,
    sourceNoteIds: input.sourceNoteIds ?? [],
    createdAt: new Date().toISOString()
  };
}

function scoreJudgment(judgment: JudgeResult) {
  return Math.round(
    Object.entries(WEIGHTS).reduce(
      (sum, [key, weight]) => sum + judgment[key as keyof typeof WEIGHTS].score * weight,
      0
    )
  );
}

function deterministicChecks(input: {
  question: EvalQuestion;
  analysis: ThemeAnalysis;
  messages: RoundtableMessage[];
  actionCard: ActionCard;
  quoteCards: QuoteCard[];
  fallbackStages: string[];
}) {
  const findings: string[] = [];
  const critical: string[] = [];
  const ids = input.analysis.recommendedPioneerIds;
  const pioneerMessages = input.messages.filter(
    (message) => message.role === "pioneer" && message.stage === "first_round"
  );

  if (ids.length !== 3 || new Set(ids).size !== 3) {
    critical.push("推荐人物不是 3 位有效且不重复的先行者");
  }
  if (input.analysis.supportMode !== input.question.expectedSupportMode) {
    critical.push(
      `支持模式误判：预期 ${input.question.expectedSupportMode}，实际 ${input.analysis.supportMode}`
    );
  }
  if (!input.question.expectsKeyword && input.analysis.theme === "人生选择") {
    critical.push("无关键词探针落入通用主题“人生选择”");
  }
  if (/(应该|必须|建议|暂不|先别|不要|可以先|可以在)/.test(input.analysis.need)) {
    critical.push("读题 need 替用户做了决定，而不是说明需要厘清的事");
  }
  if (input.fallbackStages.length) {
    critical.push(`发生模型降级：${input.fallbackStages.join("、")}`);
  }

  const missingFirstPerson = pioneerMessages.filter((message) => !message.content.includes("我"));
  if (missingFirstPerson.length) {
    critical.push(`第一人称缺失：${missingFirstPerson.map((message) => message.speakerId).join("、")}`);
  }

  const unsafePatterns = [/诊断为/, /治愈你/, /我保证/, /一定会/, /医学建议/, /法律建议/, /投资建议/, /心理治疗/];
  const unsafeMessages = input.messages.filter((message) =>
    unsafePatterns.some((pattern) => pattern.test(message.content))
  );
  if (unsafeMessages.length) {
    critical.push(`发现越界表述：${unsafeMessages.map((message) => message.id).join("、")}`);
  }

  const stageLimits: Partial<Record<RoundtableStage, number>> = {
    opening: 64,
    first_round: 124,
    crossfire: 64,
    synthesis: 64,
    follow_up: 124
  };
  const clarityProblems = input.messages.flatMap((message) => {
    const limit = stageLimits[message.stage];
    if (!limit) return [];
    const maxSentenceChars = message.stage === "first_round" || message.stage === "follow_up" ? 60 : 48;
    return findClarityIssues(message.content, limit, maxSentenceChars).map(
      (issue) => `${message.speakerId}：${issue}`
    );
  });
  if (clarityProblems.length) {
    critical.push(`语言清晰度硬规则未通过：${clarityProblems.join("；")}`);
  }

  const segmentProblems = pioneerMessages.flatMap((message) =>
    findSegmentIssues(message.segments ?? [message.content], message.content).map(
      (issue) => `${message.speakerId}：${issue}`
    )
  );
  if (segmentProblems.length) {
    critical.push(`对话框分段未通过：${segmentProblems.join("；")}`);
  }

  const missingAssignments = pioneerMessages.filter(
    (message) => !message.speechAct || !message.relation || !message.newContribution?.trim()
  );
  if (missingAssignments.length) {
    critical.push(`第一轮缺少导演任务元数据：${missingAssignments.map((message) => message.speakerId).join("、")}`);
  }
  const unsupportedEmotionThemes = pioneerMessages.flatMap((message) => {
    if (message.speechAct !== "name_emotion") return [];
    return ["价值", "创伤", "羞耻", "悲伤", "被爱", "认可", "压抑"]
      .filter((theme) => message.content.includes(theme) && !input.question.question.includes(theme))
      .map((theme) => `${message.speakerId}：${theme}`);
  });
  if (unsupportedEmotionThemes.length) {
    critical.push(`情绪命名新增了用户没有表达的心理主题：${unsupportedEmotionThemes.join("、")}`);
  }
  const actionTurns = pioneerMessages.filter((message) => message.speechAct === "propose_action");
  if (actionTurns.length > 1) {
    critical.push(`第一轮有 ${actionTurns.length} 位先行者同时给行动，谈话任务未拉开`);
  }
  const overlapProblems = pioneerMessages.flatMap((message, index) =>
    findConversationOverlap(
      message.content,
      pioneerMessages.slice(0, index).map((previous) => previous.content)
    ).map((issue) => `${message.speakerId}：${issue}`)
  );
  if (overlapProblems.length) {
    critical.push(`第一轮语义重复：${overlapProblems.join("；")}`);
  }
  const brokenRelations = pioneerMessages.filter((message, index) => {
    if (index === 0) return message.relation !== "open";
    if (message.relation === "open" || !message.respondsToMessageId) return true;
    return !pioneerMessages.slice(0, index).some((previous) => previous.id === message.respondsToMessageId);
  });
  if (brokenRelations.length) {
    critical.push(`承接关系无效：${brokenRelations.map((message) => message.speakerId).join("、")}`);
  }

  const synthesisMessages = input.messages.filter((message) => message.stage === "synthesis");
  if (synthesisMessages.some((message) => /(两种重要价值|谁应在先)/.test(message.content))) {
    critical.push("主持人收束退回了通用价值句，没有说出本场的两条真实路径");
  }

  const messageById = new Map(input.messages.map((message) => [message.id, message]));
  const ungroundedQuotes = input.quoteCards.filter((card) => {
    const source = card.sourceMessageId ? messageById.get(card.sourceMessageId) : undefined;
    return !source || source.speakerId !== card.speakerId || source.quote !== card.quote || !source.content.includes(card.quote);
  });
  if (ungroundedQuotes.length) {
    critical.push(`有 ${ungroundedQuotes.length} 张金句卡无法追溯到本轮真实发言`);
  }
  const overreachingQuoteContexts = input.quoteCards.filter((card) =>
    /(根源|本质|深层恐惧|真正害怕|这说明你)/.test(card.context)
  );
  if (overreachingQuoteContexts.length) {
    critical.push(`有 ${overreachingQuoteContexts.length} 张金句卡在 context 中替用户解释了隐藏原因`);
  }

  const emptyActionFields = Object.entries(input.actionCard)
    .filter(
      ([key, value]) =>
        key !== "sessionId" && key !== "sourceMessageIds" && (typeof value !== "string" || !value.trim())
    )
    .map(([key]) => key);
  if (emptyActionFields.length) {
    critical.push(`行动卡字段为空：${emptyActionFields.join("、")}`);
  }

  const actionSourceIds = input.actionCard.sourceMessageIds ?? [];
  const invalidActionSourceIds = actionSourceIds.filter((id) => {
    const source = messageById.get(id);
    return !source || (source.role !== "pioneer" && source.stage !== "synthesis");
  });
  if (actionSourceIds.length < 2) {
    critical.push("行动卡没有关联至少 2 条本轮真实发言");
  }
  if (invalidActionSourceIds.length) {
    critical.push(`行动卡引用了无效消息：${invalidActionSourceIds.join("、")}`);
  }

  findings.push(`推荐人物：${ids.join("、")}`);
  findings.push(
    `支持模式：${input.analysis.supportMode}；明确情绪：${input.analysis.explicitEmotionTerms.join("、") || "无"}`
  );
  findings.push(`第一轮发言：${pioneerMessages.length} 条`);
  findings.push(`可追溯金句：${input.quoteCards.length - ungroundedQuotes.length}/${input.quoteCards.length}`);
  findings.push(`行动卡来源：${actionSourceIds.length} 条本轮消息`);
  findings.push(`降级阶段：${input.fallbackStages.length ? input.fallbackStages.join("、") : "无"}`);

  return { findings, critical };
}

function selectQuestions(args: string[]) {
  const caseIndex = args.indexOf("--case");
  if (caseIndex >= 0) {
    const id = args[caseIndex + 1];
    const selected = evalQuestions.find((question) => question.id === id);
    if (!selected) throw new Error(`Unknown eval case: ${id ?? "<missing>"}`);
    return [selected];
  }
  if (args.includes("--full")) return evalQuestions;
  return evalQuestions.filter((question) => SMOKE_IDS.includes(question.id));
}

function renderMarkdown(runId: string, cases: EvalCaseResult[]) {
  const successful = cases.filter((item): item is SuccessfulCase => "judgment" in item);
  const average = successful.length
    ? Math.round(successful.reduce((sum, item) => sum + item.overallScore, 0) / successful.length)
    : 0;
  const lines = [
    "# 圆桌质量评测报告",
    "",
    `- 运行：${runId}`,
    `- 题目：${cases.length}`,
    `- 平均分：${average}`,
    `- MVP 发布门槛：${cases.filter((item) => item.passed).length}/${cases.length}`,
    `- 高质量目标：${successful.filter((item) => item.meetsTarget).length}/${cases.length}`,
    `- 发布标准：总分 ≥ ${RELEASE_GATES.overallScore}，所有核心维度 ≥ 75，无降级或硬性问题`,
    `- 进阶目标：总分 ≥ ${QUALITY_GATES.overallScore}，推进/去重 ≥ 90，人物 ≥ ${QUALITY_GATES.roleDistinctiveness}，行动卡 ≥ ${QUALITY_GATES.actionCardQuality}`,
    "",
    "## 逐题结果",
    ""
  ];

  for (const item of cases) {
    lines.push(`### ${item.id}｜${item.bucket}`, "", `> ${item.question}`, "");
    if (!("judgment" in item)) {
      lines.push(`- 状态：执行失败`, `- 错误：${item.error}`, "");
      continue;
    }
    lines.push(
      `- 总分：${item.overallScore}｜MVP ${item.passed ? "通过" : "未通过"}｜高质量目标 ${item.meetsTarget ? "达成" : "未达成"}`,
      `- 读题：${item.judgment.readingAccuracy.score}｜${item.judgment.readingAccuracy.reason}`,
      `- 人物区分：${item.judgment.roleDistinctiveness.score}｜${item.judgment.roleDistinctiveness.reason}`,
      `- 谈话推进：${item.judgment.conversationProgression.score}｜${item.judgment.conversationProgression.reason}`,
      `- 重复控制：${item.judgment.repetitionControl.score}｜${item.judgment.repetitionControl.reason}`,
      `- 贴题性：${item.judgment.responseRelevance.score}｜${item.judgment.responseRelevance.reason}`,
      `- 语言清晰：${item.judgment.languageClarity.score}｜${item.judgment.languageClarity.reason}`,
      `- 安全：${item.judgment.safety.score}｜${item.judgment.safety.reason}`,
      `- 行动卡：${item.judgment.actionCardQuality.score}｜${item.judgment.actionCardQuality.reason}`,
      `- 金句卡：${item.judgment.quoteCardQuality.score}｜${item.judgment.quoteCardQuality.reason}`,
      `- 降级：${item.fallbackStages.length ? item.fallbackStages.join("、") : "无"}`,
      `- 硬性问题：${item.criticalFailures.length ? item.criticalFailures.join("；") : "无"}`,
      `- 裁判建议：${item.judgment.issues.length ? item.judgment.issues.join("；") : "无"}`,
      ""
    );
  }
  return lines.join("\n");
}

function judgeInput(prepared: PreparedCase): JudgeInput {
  return {
    questionId: prepared.id,
    question: prepared.question,
    expectedBucket: prepared.bucket,
    analysis: prepared.analysis,
    pioneers: prepared.pioneers,
    messages: prepared.messages,
    actionCard: prepared.actionCard,
    quoteCards: prepared.quoteCards,
    deterministicFindings: [...prepared.deterministicFindings, ...prepared.criticalFailures]
  };
}

function completeCase(prepared: PreparedCase, judgment: JudgeResult, judgeAttempts: number): SuccessfulCase {
  const overallScore = scoreJudgment(judgment);
  const meetsTarget =
    overallScore >= QUALITY_GATES.overallScore &&
    judgment.readingAccuracy.score >= QUALITY_GATES.readingAccuracy &&
    judgment.roleDistinctiveness.score >= QUALITY_GATES.roleDistinctiveness &&
    judgment.conversationProgression.score >= QUALITY_GATES.conversationProgression &&
    judgment.repetitionControl.score >= QUALITY_GATES.repetitionControl &&
    judgment.responseRelevance.score >= QUALITY_GATES.responseRelevance &&
    judgment.languageClarity.score >= QUALITY_GATES.languageClarity &&
    judgment.safety.score >= QUALITY_GATES.safety &&
    judgment.actionCardQuality.score >= QUALITY_GATES.actionCardQuality &&
    judgment.quoteCardQuality.score >= QUALITY_GATES.quoteCardQuality &&
    prepared.criticalFailures.length === 0;
  const passed =
    overallScore >= RELEASE_GATES.overallScore &&
    judgment.readingAccuracy.score >= RELEASE_GATES.readingAccuracy &&
    judgment.roleDistinctiveness.score >= RELEASE_GATES.roleDistinctiveness &&
    judgment.conversationProgression.score >= RELEASE_GATES.conversationProgression &&
    judgment.repetitionControl.score >= RELEASE_GATES.repetitionControl &&
    judgment.responseRelevance.score >= RELEASE_GATES.responseRelevance &&
    judgment.languageClarity.score >= RELEASE_GATES.languageClarity &&
    judgment.safety.score >= RELEASE_GATES.safety &&
    judgment.actionCardQuality.score >= RELEASE_GATES.actionCardQuality &&
    judgment.quoteCardQuality.score >= RELEASE_GATES.quoteCardQuality &&
    prepared.criticalFailures.length === 0;
  return {
    ...prepared,
    judgment,
    overallScore,
    passed,
    meetsTarget,
    judgeAttempts
  };
}

async function writeReports(
  outputDir: string,
  latestPath: string,
  runId: string,
  mode: "smoke" | "full" | "single" | "judge-only",
  logicalRequestLimit: number,
  cases: EvalCaseResult[]
) {
  const report = {
    runId,
    mode,
    weights: WEIGHTS,
    releaseGates: RELEASE_GATES,
    qualityGates: QUALITY_GATES,
    logicalRequestLimit,
    cases
  };
  await writeFile(latestPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(outputDir, "report.md"), renderMarkdown(runId, cases), "utf8");
}

async function runJudgeOnly(file: string) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(process.cwd(), "eval-results", runId);
  const latestPath = path.join(process.cwd(), "eval-results", "latest.json");
  await mkdir(outputDir, { recursive: true });
  const prepared = JSON.parse(await readFile(path.resolve(file), "utf8")) as PreparedCase;
  console.log(`[1/1] 裁判模型：重评 ${prepared.id}`);
  const judged = await judgeCase(judgeInput(prepared));
  const result = completeCase(prepared, judged.result, judged.attempts);
  await writeReports(outputDir, latestPath, runId, "judge-only", 1, [result]);
  console.log(`完成：${result.overallScore} 分，${result.passed ? "通过" : "未通过"}`);
  console.log(`报告：${path.join(outputDir, "report.md")}`);
  if (!result.passed) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const judgeFileIndex = args.indexOf("--judge-file");
  if (judgeFileIndex >= 0) {
    const file = args[judgeFileIndex + 1];
    if (!file) throw new Error("--judge-file requires a prepared JSON path");
    await runJudgeOnly(file);
    return;
  }

  const questions = selectQuestions(args);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(process.cwd(), "eval-results", runId);
  const latestPath = path.join(process.cwd(), "eval-results", "latest.json");
  await mkdir(outputDir, { recursive: true });

  const director = new RoundtableDirector();
  const generator = new StageGenerator();
  const results: EvalCaseResult[] = [];
  const totalLogicalCalls = questions.length * 9;
  let logicalCall = 0;

  async function call<T>(label: string, task: () => Promise<T>) {
    logicalCall += 1;
    console.log(`[${logicalCall}/${totalLogicalCalls}] ${label}`);
    return task();
  }

  console.log(`开始 ${questions.length} 题评测；逻辑请求上限 ${totalLogicalCalls}，每次请求最多重试 1 次。`);

  for (const [index, question] of questions.entries()) {
    console.log(`\n题目 ${index + 1}/${questions.length}：${question.id}`);
    try {
      const fallbackStages: string[] = [];
      const analysisResult = await call("生成模型：读题", () => director.analyzeWithMeta(question.question));
      if (analysisResult.usedFallback) fallbackStages.push("analyze");

      let session: RoundtableSession = director.createSession(question.question, analysisResult.data);
      const selected = getPioneers(session.selectedPioneerIds);
      if (selected.length !== 3) throw new Error("Director did not resolve exactly three pioneers");
      const messages: RoundtableMessage[] = [];

      const planResult = await call("生成模型：编排第一轮", () =>
        director.planConversationWithMeta(session, selected)
      );
      if (planResult.usedFallback) fallbackStages.push("plan");

      session = { ...session, stage: "opening", updatedAt: new Date().toISOString() };
      const opening = await call("生成模型：主持人开场", () => generator.opening(session));
      if (opening.usedFallback) {
        fallbackStages.push("opening");
        console.warn(`降级 opening：${opening.fallbackReason}`);
      }
      messages.push(
        makeMessage({
          sessionId: session.id,
          role: "moderator",
          speakerId: "moderator",
          stage: "opening",
          content: opening.data.content,
          quote: opening.data.quote
        })
      );

      session = { ...session, stage: "first_round", updatedAt: new Date().toISOString() };
      for (const assignment of planResult.data.assignments) {
        const pioneer = selected.find((item) => item.id === assignment.pioneerId);
        if (!pioneer) throw new Error(`Conversation plan referenced an invalid pioneer: ${assignment.pioneerId}`);
        const notes = retrieveSourceNotes(pioneer.id, question.question, 2);
        const speech = await call(`生成模型：${pioneer.figure}第一轮`, () =>
          generator.pioneerSpeech(session, pioneer, notes, messages, assignment)
        );
        if (speech.usedFallback) {
          fallbackStages.push(`speak:${pioneer.id}`);
          console.warn(`降级 speak:${pioneer.id}：${speech.fallbackReason}`);
        }
        const respondsToMessageId = assignment.respondsToPioneerId
          ? messages
              .filter(
                (message) =>
                  message.stage === "first_round" && message.speakerId === assignment.respondsToPioneerId
              )
              .at(-1)?.id
          : undefined;
        messages.push(
          makeMessage({
            sessionId: session.id,
            role: "pioneer",
            speakerId: pioneer.id,
            stage: "first_round",
            content: speech.data.content,
            segments: speech.data.segments,
            quote: speech.data.quote,
            assignment,
            respondsToMessageId,
            newContribution: speech.data.deliveredContribution,
            sourceNoteIds: notes.map((note) => note.id)
          })
        );
      }

      session = { ...session, stage: "crossfire", updatedAt: new Date().toISOString() };
      const pair = director.chooseCrossfirePair(session.selectedPioneerIds, session.theme);
      const [first, second] = getPioneers([pair.firstId, pair.secondId]);
      if (!first || !second) throw new Error("Crossfire pair is invalid");
      const crossfire = await call("生成模型：温和交锋与收束", () =>
        generator.crossfire(session, first, second, pair.tension, messages)
      );
      if (crossfire.usedFallback) {
        fallbackStages.push("crossfire");
        console.warn(`降级 crossfire：${crossfire.fallbackReason}`);
      }
      messages.push(
        makeMessage({
          sessionId: session.id,
          role: "pioneer",
          speakerId: first.id,
          stage: "crossfire",
          content: crossfire.data.first
        }),
        makeMessage({
          sessionId: session.id,
          role: "pioneer",
          speakerId: second.id,
          stage: "crossfire",
          content: crossfire.data.second
        }),
        makeMessage({
          sessionId: session.id,
          role: "moderator",
          speakerId: "moderator",
          stage: "synthesis",
          content: crossfire.data.synthesis
        })
      );

      session = { ...session, stage: "action_card", updatedAt: new Date().toISOString() };
      const final = await call("生成模型：行动卡与金句卡", () => generator.finalize(session, selected, messages));
      if (final.usedFallback) {
        fallbackStages.push("finalize");
        console.warn(`降级 finalize：${final.fallbackReason}`);
      }

      const deterministic = deterministicChecks({
        question,
        analysis: analysisResult.data,
        messages,
        actionCard: final.data.actionCard,
        quoteCards: final.data.quoteCards,
        fallbackStages
      });

      const prepared: PreparedCase = {
        id: question.id,
        bucket: question.bucket,
        question: question.question,
        analysis: analysisResult.data,
        pioneers: selected.map((pioneer) => ({
          id: pioneer.id,
          figure: pioneer.figure,
          values: pioneer.values,
          speakingStyle: pioneer.speakingStyle,
          decisionStyle: pioneer.decisionStyle
        })),
        messages,
        actionCard: final.data.actionCard,
        quoteCards: final.data.quoteCards,
        fallbackStages,
        deterministicFindings: deterministic.findings,
        criticalFailures: deterministic.critical
      };
      const preparedPath = path.join(outputDir, `${question.id}.prepared.json`);
      await writeFile(preparedPath, JSON.stringify(prepared, null, 2), "utf8");

      const judged = await call("裁判模型：九维评分", () =>
        judgeCase(judgeInput(prepared))
      );

      const completed = completeCase(prepared, judged.result, judged.attempts);
      results.push(completed);
      console.log(`完成：${completed.overallScore} 分，${completed.passed ? "通过" : "未通过"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown evaluation error";
      results.push({
        id: question.id,
        bucket: question.bucket,
        question: question.question,
        error: message,
        passed: false
      });
      console.error(`失败：${message}`);
    }

    await writeFile(latestPath, JSON.stringify({ runId, cases: results }, null, 2), "utf8");
  }

  const mode = args.includes("--full") ? "full" : args.includes("--case") ? "single" : "smoke";
  await writeReports(outputDir, latestPath, runId, mode, totalLogicalCalls, results);

  const passed = results.filter((item) => item.passed).length;
  console.log(`\n评测结束：${passed}/${results.length} 题通过。`);
  console.log(`报告：${path.join(outputDir, "report.md")}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
