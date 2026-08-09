import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { getPioneers, pioneerById } from "@/data/pioneers";
import { RoundtableDirector } from "@/lib/harness/director";
import { retrieveSourceNotes, sessionRetrievalContext } from "@/lib/harness/source-retriever";
import { StageGenerator } from "@/lib/harness/stage-generator";
import type {
  ActionCard,
  ConversationAssignment,
  DiscussionMode,
  QuoteCard,
  RoundtableMessage,
  RoundtableSession,
  RoundtableStage,
  ThemeAnalysis,
  UserTurnIntent
} from "@/lib/types";
import { judgeCase, type JudgeInput, type JudgeResult } from "@/scripts/eval-judge";

config({ path: path.join(process.cwd(), ".env.local") });

const FIXED_PIONEER_IDS = ["li-qingzhao", "jane-austen", "ada-lovelace"] as const;

type SampleFollowUp = {
  speakerId: (typeof FIXED_PIONEER_IDS)[number];
  text: string;
};

type SampleCase = {
  id: string;
  bucket: string;
  question: string;
  followUps: [SampleFollowUp, SampleFollowUp];
};

const sampleCases: SampleCase[] = [
  {
    id: "expression-skill-direct",
    bucket: "技能提升｜纯方法问题",
    question: "如何提升自己的表达能力？",
    followUps: [
      {
        speakerId: "jane-austen",
        text: "你说的听者和关系位置，具体会怎样影响表达？"
      },
      {
        speakerId: "ada-lovelace",
        text: "那我现在可以先做什么，才能知道自己的表达有没有变清楚？"
      }
    ]
  },
  {
    id: "expression-skill-anxiety",
    bucket: "技能提升｜明确情绪",
    question: "我一到汇报就特别紧张，脑子容易空白，如何提升表达能力？",
    followUps: [
      {
        speakerId: "li-qingzhao",
        text: "紧张的时候我根本来不及组织完整的话，该从哪里开口？"
      },
      {
        speakerId: "jane-austen",
        text: "我明白了，我想先从一次三分钟的短汇报练习开始。"
      }
    ]
  },
  {
    id: "expression-skill-feedback",
    bucket: "技能提升｜具体经历",
    question: "我准备得很认真，但别人总说听不懂我的重点，我该怎么练习？",
    followUps: [
      {
        speakerId: "ada-lovelace",
        text: "怎么判断是我没说清楚，还是对方本来就不熟悉这个话题？"
      },
      {
        speakerId: "li-qingzhao",
        text: "那我下一次表达前，具体应该怎样准备最重要的那一句？"
      }
    ]
  }
];

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

type CaseResult = {
  id: string;
  bucket: string;
  question: string;
  analysis: ThemeAnalysis;
  messages: RoundtableMessage[];
  actionCard: ActionCard;
  quoteCards: QuoteCard[];
  fallbackStages: string[];
  judgment: JudgeResult;
  overallScore: number;
  judgeAttempts: number;
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
  referencedMessageIds?: string[];
  discussionMode?: DiscussionMode;
  userTurnIntent?: UserTurnIntent;
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
    referencedMessageIds: input.referencedMessageIds,
    discussionMode: input.discussionMode,
    userTurnIntent: input.userTurnIntent,
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

function judgeInput(
  sample: SampleCase,
  analysis: ThemeAnalysis,
  messages: RoundtableMessage[],
  actionCard: ActionCard,
  quoteCards: QuoteCard[],
  fallbackStages: string[]
): JudgeInput {
  const selected = getPioneers([...FIXED_PIONEER_IDS]);
  return {
    questionId: sample.id,
    question: sample.question,
    expectedBucket: sample.bucket,
    analysis,
    pioneers: selected.map((pioneer) => ({
      id: pioneer.id,
      figure: pioneer.figure,
      values: pioneer.values,
      speakingStyle: pioneer.speakingStyle,
      decisionStyle: pioneer.decisionStyle,
      voiceProfile: {
        tone: pioneer.voiceProfile.tone,
        firmness: pioneer.voiceProfile.firmness,
        directness: pioneer.voiceProfile.directness,
        responsePosture: pioneer.voiceProfile.responsePosture,
        questionStyle: pioneer.voiceProfile.questionStyle,
        humor: pioneer.voiceProfile.humor,
        rhythm: pioneer.voiceProfile.rhythm,
        reasoningMove: pioneer.voiceProfile.reasoningMove
      }
    })),
    messages,
    actionCard,
    quoteCards,
    deterministicFindings: [
      `固定三人样板：${FIXED_PIONEER_IDS.join("、")}`,
      `支持模式：${analysis.supportMode}`,
      `明确情绪：${analysis.explicitEmotionTerms.join("、") || "无"}`,
      `模型降级：${fallbackStages.length ? fallbackStages.join("、") : "无"}`,
      "本轮额外关注：技能问题不能被改写成情绪治疗；三位应分别体现语言准确性、听者关系与反馈结构。"
    ]
  };
}

function transcriptMarkdown(result: CaseResult) {
  const dimensions = [
    ["读题", result.judgment.readingAccuracy],
    ["人物区分", result.judgment.roleDistinctiveness],
    ["谈话推进", result.judgment.conversationProgression],
    ["重复控制", result.judgment.repetitionControl],
    ["贴题性", result.judgment.responseRelevance],
    ["语言清晰", result.judgment.languageClarity],
    ["安全", result.judgment.safety],
    ["行动卡", result.judgment.actionCardQuality],
    ["金句卡", result.judgment.quoteCardQuality]
  ] as const;
  const lines = [
    `# ${result.id}`,
    "",
    `> ${result.question}`,
    "",
    `- 总分：${result.overallScore}`,
    `- 主题：${result.analysis.theme}`,
    `- 意图张力：${result.analysis.tension}`,
    `- 支持模式：${result.analysis.supportMode}`,
    `- 降级：${result.fallbackStages.length ? result.fallbackStages.join("、") : "无"}`,
    "",
    "## 裁判评分",
    "",
    ...dimensions.map(([label, value]) => `- ${label}：${value.score}｜${value.reason}`),
    "",
    `- 优点：${result.judgment.strengths.join("；") || "无"}`,
    `- 问题：${result.judgment.issues.join("；") || "无"}`,
    "",
    "## 完整谈话",
    ""
  ];

  for (const message of result.messages) {
    const speaker =
      message.role === "user"
        ? "用户"
        : message.role === "moderator"
          ? "主持人"
          : pioneerById.get(message.speakerId)?.figure ?? message.speakerId;
    lines.push(`### ${speaker}｜${message.stage}`, "", message.content, "");
  }

  lines.push(
    "## 行动卡",
    "",
    `- 本轮练习路径：${result.actionCard.chosenPath}`,
    `- 24 小时：${result.actionCard.within24h}`,
    `- 7 天：${result.actionCard.sevenDayExperiment}`,
    `- 30 天：${result.actionCard.thirtyDayPractice}`,
    `- 护栏：${result.actionCard.guardrail}`,
    `- 复盘证据：${result.actionCard.evidenceToReview}`,
    "",
    "## 金句卡",
    ""
  );
  for (const card of result.quoteCards) {
    lines.push(
      `- ${pioneerById.get(card.speakerId)?.figure ?? card.speakerId}：${card.quote}`,
      `  - ${card.context}`
    );
  }
  return lines.join("\n");
}

function summaryMarkdown(runId: string, results: CaseResult[]) {
  const average = results.length
    ? Math.round(results.reduce((sum, result) => sum + result.overallScore, 0) / results.length)
    : 0;
  const dimensionAverage = (key: keyof typeof WEIGHTS) =>
    results.length
      ? Math.round(results.reduce((sum, result) => sum + result.judgment[key].score, 0) / results.length)
      : 0;
  const lines = [
    "# PioneerMind 三人样板端到端评测",
    "",
    `- 运行：${runId}`,
    `- 生成模型：${process.env.OPENAI_MODEL ?? "未配置"}`,
    `- 裁判模型：${process.env.EVAL_JUDGE_MODEL ?? "未配置"}`,
    `- 固定先行者：李清照、简·奥斯汀、阿达·洛夫莱斯`,
    `- 题目：${results.length}`,
    `- 平均分：${average}`,
    "",
    "## 维度均分",
    ""
  ];
  const labels: Array<[keyof typeof WEIGHTS, string]> = [
    ["readingAccuracy", "读题准确"],
    ["roleDistinctiveness", "人物区分"],
    ["conversationProgression", "谈话推进"],
    ["repetitionControl", "重复控制"],
    ["responseRelevance", "贴题性"],
    ["languageClarity", "语言清晰"],
    ["safety", "安全"],
    ["actionCardQuality", "行动卡"],
    ["quoteCardQuality", "金句卡"]
  ];
  for (const [key, label] of labels) lines.push(`- ${label}：${dimensionAverage(key)}`);

  lines.push("", "## 逐题", "");
  for (const result of results) {
    lines.push(
      `### ${result.id}｜${result.overallScore} 分`,
      "",
      `> ${result.question}`,
      "",
      `- 人物区分：${result.judgment.roleDistinctiveness.score}`,
      `- 推进：${result.judgment.conversationProgression.score}`,
      `- 重复控制：${result.judgment.repetitionControl.score}`,
      `- 语言清晰：${result.judgment.languageClarity.score}`,
      `- 行动卡：${result.judgment.actionCardQuality.score}`,
      `- 金句卡：${result.judgment.quoteCardQuality.score}`,
      `- 主要问题：${result.judgment.issues.join("；") || "无"}`,
      ""
    );
  }
  return lines.join("\n");
}

function blindTestMarkdown(results: CaseResult[]) {
  const aliases = new Map<string, string>([
    ["li-qingzhao", "声音 A"],
    ["jane-austen", "声音 B"],
    ["ada-lovelace", "声音 C"]
  ]);
  const lines = [
    "# 匿名人格盲测",
    "",
    "请判断声音 A、B、C 分别是哪位先行者，并写下辨认依据。不要先查看 blind-test-key.json。",
    ""
  ];
  for (const result of results) {
    lines.push(`## ${result.question}`, "");
    const representative = result.messages.filter(
      (message) => message.role === "pioneer" && message.stage === "first_round"
    );
    for (const message of representative) {
      lines.push(`### ${aliases.get(message.speakerId) ?? "未知声音"}`, "", message.content, "");
    }
  }
  return lines.join("\n");
}

async function runCase(
  sample: SampleCase,
  director: RoundtableDirector,
  generator: StageGenerator,
  progress: (label: string) => void
): Promise<CaseResult> {
  const fallbackStages: string[] = [];
  progress("读题");
  const analysisResult = await director.analyzeWithMeta(sample.question);
  if (analysisResult.usedFallback) fallbackStages.push("analyze");
  const analysis: ThemeAnalysis = {
    ...analysisResult.data,
    recommendedPioneerIds: [...FIXED_PIONEER_IDS],
    reason:
      "本轮固定李清照、简·奥斯汀、阿达·洛夫莱斯，用于比较语言准确性、听者关系与反馈结构三种 PioneerMind。"
  };
  let session: RoundtableSession = {
    ...director.createSession(sample.question, analysis),
    selectedPioneerIds: [...FIXED_PIONEER_IDS]
  };
  const selected = getPioneers(session.selectedPioneerIds);
  if (selected.length !== FIXED_PIONEER_IDS.length) throw new Error("固定三人样板没有完整加载");
  const messages: RoundtableMessage[] = [];

  progress("编排第一轮");
  const planResult = await director.planConversationWithMeta(session, selected);
  if (planResult.usedFallback) fallbackStages.push("plan");

  session = { ...session, stage: "opening", updatedAt: new Date().toISOString() };
  progress("主持人开场");
  const opening = await generator.opening(session, selected, planResult.data);
  if ("usedFallback" in opening && opening.usedFallback) fallbackStages.push("opening");
  if ("usedGuardRepair" in opening && opening.usedGuardRepair) fallbackStages.push("guard-repair:opening");
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
    if (!pioneer) throw new Error(`第一轮编排引用了未入席人物：${assignment.pioneerId}`);
    const notes = retrieveSourceNotes(
      pioneer.id,
      {
        question: sample.question,
        theme: analysis.theme,
        tension: analysis.tension,
        emotion: analysis.emotion,
        need: analysis.need
      },
      3
    );
    progress(`${pioneer.figure}第一轮`);
    const speech = await generator.pioneerSpeech(session, pioneer, notes, messages, assignment, analysis);
    if ("usedFallback" in speech && speech.usedFallback) fallbackStages.push(`speak:${pioneer.id}`);
    if ("usedGuardRepair" in speech && speech.usedGuardRepair) {
      fallbackStages.push(`guard-repair:speak:${pioneer.id}`);
    }
    const respondsToMessageId = assignment.respondsToPioneerId
      ? messages
          .filter(
            (message) =>
              message.role === "pioneer" &&
              message.stage === "first_round" &&
              message.speakerId === assignment.respondsToPioneerId
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

  progress("判断圆桌互动模式");
  const discussionPlan = await director.planDiscussionWithMeta(session, messages);
  if (discussionPlan.usedFallback) fallbackStages.push("discussion-plan");
  session = {
    ...session,
    stage: "discussion",
    discussionMode: discussionPlan.data.mode,
    updatedAt: new Date().toISOString()
  };
  if (discussionPlan.data.mode !== "skip") {
    progress(discussionPlan.data.label);
    const discussion = await generator.discussion(session, discussionPlan.data, messages);
    if ("usedFallback" in discussion && discussion.usedFallback) fallbackStages.push("discussion");
    if ("usedGuardRepair" in discussion && discussion.usedGuardRepair) {
      fallbackStages.push("guard-repair:discussion");
    }
    for (const turn of discussion.data.turns) {
      messages.push(
        makeMessage({
          sessionId: session.id,
          role: "pioneer",
          speakerId: turn.speakerId,
          stage: "discussion",
          content: turn.content,
          segments: turn.segments,
          respondsToMessageId: turn.referencedMessageIds[0],
          referencedMessageIds: turn.referencedMessageIds,
          discussionMode: discussionPlan.data.mode,
          newContribution: turn.newContribution
        })
      );
    }
    if (discussion.data.synthesis) {
      messages.push(
        makeMessage({
          sessionId: session.id,
          role: "moderator",
          speakerId: "moderator",
          stage: "synthesis",
          content: discussion.data.synthesis,
          referencedMessageIds: discussion.data.turns.flatMap((turn) => turn.referencedMessageIds),
          discussionMode: discussionPlan.data.mode
        })
      );
    }
  }

  session = { ...session, stage: "follow_up", updatedAt: new Date().toISOString() };
  for (const [index, followUp] of sample.followUps.entries()) {
    const pioneer = selected.find((item) => item.id === followUp.speakerId);
    if (!pioneer) throw new Error(`追问引用了未入席人物：${followUp.speakerId}`);
    const intent = director.classifyUserTurn(followUp.text);
    const userMessage = makeMessage({
      sessionId: session.id,
      role: "user",
      speakerId: "user",
      stage: "follow_up",
      content: followUp.text,
      userTurnIntent: intent
    });
    messages.push(userMessage);
    const notes = retrieveSourceNotes(pioneer.id, sessionRetrievalContext(session, followUp.text), 3);
    progress(`第 ${index + 1} 轮追问：${pioneer.figure}`);
    const reply = await generator.followUp(session, pioneer, followUp.text, notes, messages, intent);
    if ("usedFallback" in reply && reply.usedFallback) fallbackStages.push(`follow-up:${pioneer.id}`);
    if ("usedGuardRepair" in reply && reply.usedGuardRepair) {
      fallbackStages.push(`guard-repair:follow-up:${pioneer.id}`);
    }
    messages.push(
      makeMessage({
        sessionId: session.id,
        role: "pioneer",
        speakerId: pioneer.id,
        stage: "follow_up",
        content: reply.data.content,
        segments: reply.data.segments,
        quote: reply.data.quote,
        assignment: reply.assignment,
        respondsToMessageId: userMessage.id,
        referencedMessageIds: [userMessage.id],
        userTurnIntent: intent,
        newContribution: reply.data.deliveredContribution,
        sourceNoteIds: notes.map((note) => note.id)
      })
    );
  }

  session = { ...session, stage: "action_card", updatedAt: new Date().toISOString() };
  progress("行动卡与金句卡");
  const final = await generator.finalize(session, selected, messages);
  if ("usedFallback" in final && final.usedFallback) fallbackStages.push("finalize");
  if ("usedGuardRepair" in final && final.usedGuardRepair) fallbackStages.push("guard-repair:finalize");

  progress("GLM-5.2 裁判");
  const judged = await judgeCase(
    judgeInput(
      sample,
      analysis,
      messages,
      final.data.actionCard,
      final.data.quoteCards,
      fallbackStages
    )
  );
  return {
    id: sample.id,
    bucket: sample.bucket,
    question: sample.question,
    analysis,
    messages,
    actionCard: final.data.actionCard,
    quoteCards: final.data.quoteCards,
    fallbackStages,
    judgment: judged.result,
    overallScore: scoreJudgment(judged.result),
    judgeAttempts: judged.attempts
  };
}

async function main() {
  const args = process.argv.slice(2);
  const requestedId = args[args.indexOf("--case") + 1];
  const selectedCases = args.includes("--case")
    ? sampleCases.filter((sample) => sample.id === requestedId)
    : sampleCases;
  if (!selectedCases.length) throw new Error(`未知样板题：${requestedId ?? "<missing>"}`);

  if (args.includes("--dry-run")) {
    console.log("PioneerMind 三人样板 dry-run");
    console.log(`生成模型：${process.env.OPENAI_MODEL ?? "未配置"}`);
    console.log(`裁判模型：${process.env.EVAL_JUDGE_MODEL ?? "未配置"}`);
    console.log(`固定先行者：${FIXED_PIONEER_IDS.join("、")}`);
    for (const sample of selectedCases) {
      console.log(`\n${sample.id}｜${sample.question}`);
      sample.followUps.forEach((followUp, index) => {
        console.log(`  追问 ${index + 1} → ${followUp.speakerId}：${followUp.text}`);
      });
    }
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(process.cwd(), "eval-results", `pioneer-mind-${runId}`);
  await mkdir(outputDir, { recursive: true });
  const director = new RoundtableDirector();
  const generator = new StageGenerator();
  const results: CaseResult[] = [];
  const totalStages = selectedCases.length * 12;
  let currentStage = 0;

  console.log(`开始 ${selectedCases.length} 题 PioneerMind 端到端评测。完整结果写入 ${outputDir}`);
  for (const [caseIndex, sample] of selectedCases.entries()) {
    console.log(`\n题目 ${caseIndex + 1}/${selectedCases.length}：${sample.id}`);
    const result = await runCase(sample, director, generator, (label) => {
      currentStage += 1;
      console.log(`[${currentStage}/${totalStages}] ${label}`);
    });
    results.push(result);
    await writeFile(
      path.join(outputDir, `${sample.id}.json`),
      JSON.stringify(result, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(outputDir, `${sample.id}.md`),
      transcriptMarkdown(result),
      "utf8"
    );
    console.log(`完成：${result.overallScore} 分`);
  }

  const report = {
    runId,
    generatedBy: process.env.OPENAI_MODEL,
    judgedBy: process.env.EVAL_JUDGE_MODEL,
    fixedPioneerIds: FIXED_PIONEER_IDS,
    cases: results
  };
  await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(outputDir, "report.md"), summaryMarkdown(runId, results), "utf8");
  await writeFile(path.join(outputDir, "blind-test.md"), blindTestMarkdown(results), "utf8");
  await writeFile(
    path.join(outputDir, "blind-test-key.json"),
    JSON.stringify(
      {
        "声音 A": "李清照",
        "声音 B": "简·奥斯汀",
        "声音 C": "阿达·洛夫莱斯"
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\n评测完成：${results.length}/${selectedCases.length}`);
  console.log(`报告：${path.join(outputDir, "report.md")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
