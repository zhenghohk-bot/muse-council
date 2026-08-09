import { pioneerById, pioneers } from "@/data/pioneers";
import { generateJson } from "@/lib/harness/openai-client";
import { compactText, softenUnsupportedInference } from "@/lib/harness/output-guard";
import {
  classifyQuestionIntent,
  isExpressionSkillQuestion,
  questionIntentInstruction,
  questionTaskFrame
} from "@/lib/harness/question-intent";
import { classifySupportContext, supportModeInstruction } from "@/lib/harness/support-mode";
import type {
  ConversationAssignment,
  ConversationPlan,
  DiscussionPlan,
  FollowUpPlan,
  PioneerProfile,
  RoundtableMessage,
  RoundtableSession,
  RoundtableStage,
  SpeechAct,
  ThemeAnalysis,
  TurnRelation,
  UserTurnIntent
} from "@/lib/types";

type ThemeAnalysisDraft = Omit<ThemeAnalysis, "supportMode" | "explicitEmotionTerms">;

const themeRules: Array<{ match: RegExp; analysis: ThemeAnalysisDraft }> = [
  {
    match: /副业|创业|赚钱|产品|小红书|变现|自由职业|辞职|AI|网站|app|模板/i,
    analysis: {
      theme: "事业与副业",
      tension: "自由感、收入安全感和被看见之间的拉扯",
      emotion: "兴奋里带着担心，想快一点验证，又怕投入太多没有回报",
      need: "一个低成本、可验证、能积累作品证据的起步方式",
      recommendedPioneerIds: ["wu-zetian", "ada-lovelace", "marie-curie"],
      reason: "武则天看筹码与风险，阿达把灵感转成原型，居里夫人负责长期证据。"
    }
  },
  {
    match: /恋爱|关系|分手|前任|朋友|家人|伴侣|相亲|消耗|边界/i,
    analysis: {
      theme: "关系与边界",
      tension: "被爱、被认可和保留自我的拉扯",
      emotion: "既想被理解，也害怕表达真实需求后关系改变",
      need: "先看清关系结构，再决定表达、靠近或退出的方式",
      recommendedPioneerIds: ["jane-austen", "qin-liangyu", "ban-zhao"],
      reason: "奥斯汀看关系结构，秦良玉守边界，班昭帮你稳住内在分寸。"
    }
  },
  {
    match: /自律|拖延|坚持|焦虑|迷茫|内耗|羡慕|自信|成长|变好/i,
    analysis: {
      theme: "自我秩序",
      tension: "想变好和害怕失败之间的拉扯",
      emotion: "对自己有期待，也容易把停滞解释成不够好",
      need: "降低自我攻击，把愿望拆成今天能完成的证据",
      recommendedPioneerIds: ["ban-zhao", "marie-curie", "virginia-woolf"],
      reason: "班昭稳定心神，居里夫人建立证据，伍尔夫提醒你找回自己的空间。"
    }
  },
  {
    match: /表达能力|表达.{0,8}(?:清楚|重点|训练|练习|提升)|汇报|沟通|演讲|说不清|听不懂|没重点/i,
    analysis: {
      theme: "表达训练",
      tension: "信息完整、重点清楚和听者理解之间的取舍",
      emotion: "",
      need: "明确表达场景、核心信息和听者需要，再用具体反馈修改下一版",
      recommendedPioneerIds: ["li-qingzhao", "jane-austen", "ada-lovelace"],
      reason: "李清照看字句是否准确，奥斯汀看听者需要什么，阿达把练习变成可迭代的反馈。"
    }
  },
  {
    match: /写作|内容|账号|笔记|作品|发布|被看见/i,
    analysis: {
      theme: "表达与被看见",
      tension: "真实表达、他人评价和作品化之间的拉扯",
      emotion: "想被看见，又怕显得幼稚、用力或不够好",
      need: "先允许真实存在，再把真实锻造成一个小作品",
      recommendedPioneerIds: ["li-qingzhao", "virginia-woolf", "ada-lovelace"],
      reason: "李清照处理真实感受，伍尔夫保护精神空间，阿达把表达做成可迭代系统。"
    }
  }
];

const fallbackAnalysis: ThemeAnalysisDraft = {
  theme: "人生选择",
  tension: "想要改变和害怕代价之间的拉扯",
  emotion: "心里已经有愿望，但还没有足够清晰的下一步",
  need: "把问题从反复想象，拆成一次可观察的小实验",
  recommendedPioneerIds: ["li-qingzhao", "wu-zetian", "ban-zhao"],
  reason: "李清照保留真实感受，武则天看资源代价，班昭让节奏更稳定。"
};

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["theme", "tension", "emotion", "need", "recommendedPioneerIds", "reason"],
  properties: {
    theme: { type: "string" },
    tension: { type: "string" },
    emotion: { type: "string" },
    need: { type: "string" },
    recommendedPioneerIds: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string", enum: pioneers.map((pioneer) => pioneer.id) }
    },
    reason: { type: "string" }
  }
};

const validPioneerIds = new Set(pioneers.map((pioneer) => pioneer.id));
const speechActs: SpeechAct[] = [
  "name_emotion",
  "reframe",
  "distinguish",
  "challenge",
  "share_experience",
  "ask_question",
  "propose_action"
];
const turnRelations: TurnRelation[] = ["open", "independent", "extend", "challenge", "clarify", "redirect"];

const speechActPurpose: Record<SpeechAct, string> = {
  name_emotion: "只说清用户已经表达、但还没有说透的感受",
  reframe: "换一个判断框架，让问题出现新的理解方式",
  distinguish: "区分责任、边界、事实或可控范围",
  challenge: "质疑一个证据不足或过早形成的结论",
  share_experience: "用一条有来源的人物经历或作品经验提供参照",
  ask_question: "提出一个能改变用户判断的具体问题",
  propose_action: "给出一个当下可以完成并留下结果的小动作"
};

function profileForPlan(pioneer: PioneerProfile) {
  const mind = pioneer.mind;
  return [
    `${pioneer.id}｜${pioneer.figure}｜${pioneer.archetype}`,
    `推理方式：${pioneer.voiceProfile.reasoningMove}`,
    `擅长谈话动作：${pioneer.voiceProfile.preferredSpeechActs.join("、")}`,
    `价值：${pioneer.values.join("、")}`,
    `适合问题：${pioneer.suitableFor.join("、")}`,
    mind ? `能力边界：${mind.capabilities.avoids.join("；")}` : "",
    mind ? `观察顺序：${mind.reasoning.attentionOrder.join("；")}` : "",
    mind ? `互动边界：${mind.interaction.boundaries.join("；")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function defaultAssignmentText(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  speechAct: SpeechAct
) {
  const mind = pioneer.mind;
  const attention = mind?.reasoning.attentionOrder[0] ?? pioneer.voiceProfile.reasoningMove;
  const distinction = mind?.reasoning.coreDistinctions[0];
  return {
    objective: `${speechActPurpose[speechAct]}，并用${pioneer.figure}的方式先${attention}`,
    newContribution: distinction ?? `${pioneer.figure}从${pioneer.voiceProfile.reasoningMove}推进讨论`
  };
}

function expressionConversationPlan(
  selected: PioneerProfile[]
): ConversationPlan | undefined {
  const selectedIds = new Set(selected.map((pioneer) => pioneer.id));
  if (
    !["li-qingzhao", "jane-austen", "ada-lovelace"].every((id) => selectedIds.has(id))
  ) {
    return undefined;
  }
  return {
    assignments: [
      {
        pioneerId: "li-qingzhao",
        speechAct: "reframe",
        relation: "open",
        objective: "检查内容是否太多、重点是否后置，让最重要的一句话更准确",
        newContribution: "区分必要信息与盖住重点的解释",
        actionMode: "none"
      },
      {
        pioneerId: "jane-austen",
        speechAct: "distinguish",
        relation: "extend",
        respondsToPioneerId: "li-qingzhao",
        objective: "区分说话者想表达什么，以及听者需要从中听明白什么",
        newContribution: "用听者任务校准重点与必要背景",
        actionMode: "none"
      },
      {
        pioneerId: "ada-lovelace",
        speechAct: "propose_action",
        relation: "extend",
        respondsToPioneerId: "jane-austen",
        objective: "把重点、必要信息和反馈做成一次可以重复修改的练习",
        newContribution: "设计一次只改一个环节的反馈循环",
        actionMode: "offer_one_step"
      }
    ],
    rationale: "先确定表达重点，再校准听者需要，最后把两者放进一次可反馈的练习。"
  };
}

function fallbackConversationPlan(
  session: RoundtableSession,
  selected: PioneerProfile[]
): ConversationPlan {
  if (isExpressionSkillQuestion(session.question)) {
    const expressionPlan = expressionConversationPlan(selected);
    if (expressionPlan) return expressionPlan;
  }
  const usedActs = new Set<SpeechAct>();
  const asksForAction = /怎么办|怎么做|如何|下一步|要不要|该不该|该怎么/.test(session.question);
  let actionAssigned = false;
  const assignments = [...selected]
    .map((pioneer) => {
      const candidates = pioneer.voiceProfile.preferredSpeechActs.filter(
        (act) => act !== "propose_action" || (asksForAction && !actionAssigned)
      );
      const speechAct = candidates.find((act) => !usedActs.has(act)) ?? candidates[0] ?? "reframe";
      if (speechAct === "propose_action") actionAssigned = true;
      usedActs.add(speechAct);
      return { pioneer, speechAct };
    })
    .sort((a, b) => {
      const order: Record<SpeechAct, number> = {
        name_emotion: 0,
        reframe: 1,
        share_experience: 1,
        distinguish: 2,
        challenge: 3,
        ask_question: 4,
        propose_action: 5
      };
      return order[a.speechAct] - order[b.speechAct];
    })
    .map(({ pioneer, speechAct }, index, ordered): ConversationAssignment => ({
      pioneerId: pioneer.id,
      speechAct,
      relation: index === 0 ? "open" : "independent",
      respondsToPioneerId: undefined,
      ...defaultAssignmentText(session, pioneer, speechAct),
      actionMode: speechAct === "propose_action" ? "offer_one_step" : "none"
    }));

  return {
    assignments,
    rationale: "按人物擅长的推理动作安排互补发言，先理解问题，再区分或校正判断，必要时才给一步行动。"
  };
}

function sanitizeConversationPlan(
  raw: ConversationPlan,
  session: RoundtableSession,
  selected: PioneerProfile[]
): ConversationPlan {
  const fallback = fallbackConversationPlan(session, selected);
  if (isExpressionSkillQuestion(session.question)) {
    const expressionPlan = expressionConversationPlan(selected);
    if (expressionPlan) return expressionPlan;
  }
  const selectedById = new Map(selected.map((pioneer) => [pioneer.id, pioneer]));
  const rawAssignments = Array.isArray(raw?.assignments) ? raw.assignments : [];
  const orderedIds: string[] = [];
  for (const assignment of rawAssignments) {
    if (selectedById.has(assignment?.pioneerId) && !orderedIds.includes(assignment.pioneerId)) {
      orderedIds.push(assignment.pioneerId);
    }
  }
  for (const pioneer of selected) {
    if (!orderedIds.includes(pioneer.id)) orderedIds.push(pioneer.id);
  }

  const usedActs = new Set<SpeechAct>();
  let actionAssigned = false;
  const assignments = orderedIds.map((pioneerId, index): ConversationAssignment => {
    const pioneer = selectedById.get(pioneerId)!;
    const candidate = rawAssignments.find((assignment) => assignment.pioneerId === pioneerId);
    const rawAct = candidate?.speechAct;
    const candidateAct = rawAct && speechActs.includes(rawAct) ? rawAct : undefined;
    const allowedCandidate =
      candidateAct &&
      pioneer.voiceProfile.preferredSpeechActs.includes(candidateAct) &&
      !usedActs.has(candidateAct) &&
      (candidateAct !== "propose_action" || !actionAssigned)
        ? candidateAct
        : undefined;
    const preferredAct = pioneer.voiceProfile.preferredSpeechActs.find(
      (act) => !usedActs.has(act) && (act !== "propose_action" || !actionAssigned)
    );
    const speechAct = allowedCandidate ?? preferredAct ?? pioneer.voiceProfile.preferredSpeechActs[0] ?? "reframe";
    usedActs.add(speechAct);
    if (speechAct === "propose_action") actionAssigned = true;

    const previousIds = orderedIds.slice(0, index);
    const relation =
      index === 0
        ? "open"
        : candidate?.relation && turnRelations.includes(candidate.relation) && candidate.relation !== "open"
          ? candidate.relation
          : "independent";
    const respondsToPioneerId =
      index === 0 || relation === "independent"
        ? undefined
        : candidate?.respondsToPioneerId && previousIds.includes(candidate.respondsToPioneerId)
          ? candidate.respondsToPioneerId
          : previousIds.at(-1);
    const defaults = defaultAssignmentText(session, pioneer, speechAct);
    const rawContribution = softenUnsupportedInference(candidate?.newContribution || defaults.newContribution);
    const safeContribution = /(身份滑落|社会评价|创伤|羞耻|依恋|原生家庭|潜意识)/.test(rawContribution)
      ? defaults.newContribution
      : rawContribution;
    return {
      pioneerId,
      speechAct,
      relation,
      respondsToPioneerId,
      objective: compactText(softenUnsupportedInference(candidate?.objective || defaults.objective), 72),
      newContribution: compactText(safeContribution, 48),
      actionMode: speechAct === "propose_action" ? "offer_one_step" : "none"
    };
  });

  return {
    assignments: assignments.length === selected.length ? assignments : fallback.assignments,
    rationale: compactText(raw?.rationale || fallback.rationale, 90)
  };
}

function conversationPlanSchema(selected: PioneerProfile[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["assignments", "rationale"],
    properties: {
      assignments: {
        type: "array",
        minItems: selected.length,
        maxItems: selected.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "pioneerId",
            "speechAct",
            "relation",
            "objective",
            "newContribution",
            "actionMode"
          ],
          properties: {
            pioneerId: { type: "string", enum: selected.map((pioneer) => pioneer.id) },
            speechAct: { type: "string", enum: speechActs },
            relation: { type: "string", enum: turnRelations },
            respondsToPioneerId: { type: "string" },
            objective: { type: "string" },
            newContribution: { type: "string" },
            actionMode: { type: "string", enum: ["none", "offer_one_step"] }
          }
        }
      },
      rationale: { type: "string" }
    }
  };
}

function conversationPlanPrompt(session: RoundtableSession, selected: PioneerProfile[]) {
  const intent = classifyQuestionIntent(session.question);
  return [
    "你是圆桌导演。请根据本次问题和人物能力，为第一轮安排一组彼此互补的谈话任务。",
    `用户问题：${session.question}`,
    `主题：${session.theme}`,
    `核心张力：${session.tension}`,
    questionIntentInstruction(intent),
    questionTaskFrame(session.question),
    supportModeInstruction({ mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms }),
    "在席人物：",
    selected.map(profileForPlan).join("\n\n"),
    "可用谈话动作：",
    speechActs.map((act) => `- ${act}：${speechActPurpose[act]}`).join("\n"),
    "规则：",
    "- 任务不能随机分配。每项任务必须同时匹配本场需要和人物擅长的谈话动作。",
    "- 可以重新安排发言顺序，但每位人物必须且只能出现一次。",
    "- 第一位 relation=open。后续人物只有在前文真的提供了可承接、澄清或质疑的主张时，才使用 extend、challenge、clarify 或 redirect，并填写 respondsToPioneerId。",
    "- 如果这一位更适合从独立视角提供新信息，使用 relation=independent，并省略 respondsToPioneerId。不要为了显得像圆桌而强制表态。",
    "- 不强制制造反对。存在真实冲突时才用 challenge；观点可以互补时使用 extend 或 clarify。用户意图和当前谈话已经足够清楚时，优先减少多余互动。",
    "- 尽量让 speechAct 不重复；全场最多一位 propose_action，其他人只推进理解、判断或提问。",
    "- objective 写清这一位本场要完成的任务，不规定统一句式。newContribution 写清她必须带来的新信息，不能只是换词复述用户问题。",
    "- 不得在 objective 或 newContribution 中替用户发明身份焦虑、社会评价、创伤、羞耻、依恋等未明确提到的心理原因。",
    "- actionMode 只有 propose_action 可以填 offer_one_step，其余必须为 none。",
    "- rationale 用一句话解释这组安排为何能形成推进。"
  ].join("\n");
}

// Chat-Completions 的 json_object 模式不保证 enum 约束，模型可能返回不存在的 id、
// 重复 id 或数量不足 3。这里收敛回 9 人名册、去重并补足到 3 位，避免下游 getPioneers 静默丢人导致缺席。
function sanitizeAnalysis(raw: ThemeAnalysisDraft, question: string): ThemeAnalysis {
  const topUp = themeRules.find((rule) => rule.match.test(question))?.analysis ?? fallbackAnalysis;
  const supportContext = classifySupportContext(question);
  const intent = classifyQuestionIntent(question);
  const source: ThemeAnalysisDraft = isExpressionSkillQuestion(question)
    ? {
        ...raw,
        theme: "表达训练",
        tension: "信息完整、重点清楚和听者理解之间的取舍",
        emotion: "",
        need: "明确表达场景、核心信息和听者需要，再用具体反馈修改下一版",
        recommendedPioneerIds: ["li-qingzhao", "jane-austen", "ada-lovelace"],
        reason: "李清照看字句是否准确，奥斯汀看听者需要什么，阿达把练习变成可迭代的反馈。"
      }
    : raw;
  const ids: string[] = [];
  for (const id of [...(source.recommendedPioneerIds ?? []), ...topUp.recommendedPioneerIds]) {
    if (ids.length >= 3) break;
    if (validPioneerIds.has(id) && !ids.includes(id)) ids.push(id);
  }
  while (ids.length < 3) {
    const next = pioneers.find((pioneer) => !ids.includes(pioneer.id));
    if (!next) break;
    ids.push(next.id);
  }
  const need = compactText(softenUnsupportedInference(source.need), 55);
  const givesDecision = /(应该|必须|建议|暂不|先别|不要|可以.{0,6}先|可以在)/.test(need);
  const inventsCauses =
    supportContext.mode === "unknown_cause" &&
    /(源于|来自|是因为|由于|^.*是.*还是|可能与.*相关|哪些.*相关)/.test(need);
  const safeNeed = givesDecision
    ? compactText(`一起厘清「${source.theme}」中的事实和判断标准，再由你决定下一步。`, 55)
    : inventsCauses
      ? "看清这种感受何时出现、何时变化，以及哪些线索值得继续追问。"
      : need;
  return {
    ...source,
    theme: source.theme.replace(/[。！？]/g, "").slice(0, 14),
    tension: compactText(softenUnsupportedInference(source.tension), 48),
    emotion:
      supportContext.mode === "unknown_cause"
        ? "这份感受真实存在，却暂时说不清原因；不必急着为它下结论。"
        : !supportContext.explicitEmotionTerms.length &&
            ["skill_building", "problem_solving", "creative_exploration"].includes(intent.primary)
          ? ""
        : compactText(softenUnsupportedInference(source.emotion), 55),
    need: safeNeed,
    supportMode: supportContext.mode,
    explicitEmotionTerms: supportContext.explicitEmotionTerms,
    reason: compactText(source.reason, 80),
    recommendedPioneerIds: ids
  };
}

function pioneerRoster() {
  return pioneers
    .map((pioneer) => {
      const intentFit = pioneer.mind?.capabilities.strongestIntents.join("、");
      const boundaries = pioneer.mind?.capabilities.avoids.join("；");
      return [
        `- ${pioneer.id}｜${pioneer.figure}｜${pioneer.archetype}｜擅长：${pioneer.suitableFor.join("、")}`,
        intentFit ? `  任务意图：${intentFit}` : "",
        boundaries ? `  能力边界：${boundaries}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function analysisPrompt(question: string) {
  const supportContext = classifySupportContext(question);
  const intent = classifyQuestionIntent(question);
  return [
    "请先读懂用户的人生困惑，再为一场女性先行者圆桌做主持人分析。",
    `用户的问题：${question}`,
    questionIntentInstruction(intent),
    supportModeInstruction(supportContext),
    "",
    "可入席的先行者名册（只能从中挑选）：",
    pioneerRoster(),
    "",
    "请输出：",
    "- theme：4-10 个字，用普通短语命名主题，不写文学标题。",
    "- tension：25-45 字，说清两种难以兼顾的需要，不使用比喻。",
    "- emotion：只反映用户明确表达的情绪。用户没有提供情绪词且主要在询问技能、方法或创作时，返回空字符串，不要为了显得温柔而补写感受。",
    "- need：25-50 字，只说这场谈话需要帮用户厘清什么事实、边界或判断标准；不替用户做决定，不写“应该、暂不、先别、建议、可以先”。",
    "- recommendedPioneerIds：从名册里选 3 位最能就这个问题形成视角张力的先行者 id。",
    "- reason：45-75 字，说明三位各自能看见什么。",
    "要求：使用直接、自然、容易理解的现代中文；贴合用户的具体处境，不套模板。必须以问题意图为主线，情绪支持只能承接用户亲自说出的感受，不能取代技能、方法、决策或创作任务。禁止使用“未被认领的……”“生命在要求……”“长回自己”等抽象说法；禁止断言用户没有说出的创伤、悲伤、羞耻或心理动机。无法确认时使用“可能”“也许”“可以先观察”。"
  ].join("\n");
}

const discussionModes: DiscussionPlan["mode"][] = ["crossfire", "sequence", "complement", "clarify", "skip"];

function activeMessages(messages: RoundtableMessage[]) {
  return messages.filter((message) => message.status !== "retracted" && message.status !== "superseded");
}

function fallbackDiscussionPlan(): DiscussionPlan {
  return {
    mode: "skip",
    label: "继续追问",
    speakerIds: [],
    primaryMessageIds: [],
    focus: "",
    rationale: "无法可靠判断讨论关系，本轮不补写内容。",
    hasTrueConflict: false
  };
}

function discussionPlanSchema(messages: RoundtableMessage[]) {
  const pioneerMessages = activeMessages(messages).filter(
    (message) => message.role === "pioneer" && message.stage === "first_round"
  );
  return {
    type: "object",
    additionalProperties: false,
    required: ["mode", "label", "speakerIds", "primaryMessageIds", "focus", "rationale", "hasTrueConflict"],
    properties: {
      mode: { type: "string", enum: discussionModes },
      label: { type: "string" },
      speakerIds: {
        type: "array",
        minItems: 0,
        maxItems: 2,
        items: { type: "string", enum: [...new Set(pioneerMessages.map((message) => message.speakerId))] }
      },
      primaryMessageIds: {
        type: "array",
        minItems: 0,
        maxItems: 2,
        items: { type: "string", enum: pioneerMessages.map((message) => message.id) }
      },
      focus: { type: "string" },
      rationale: { type: "string" },
      hasTrueConflict: { type: "boolean" }
    }
  };
}

function discussionPlanPrompt(session: RoundtableSession, messages: RoundtableMessage[]) {
  const firstRound = activeMessages(messages).filter(
    (message) => message.role === "pioneer" && message.stage === "first_round"
  );
  return [
    "你是圆桌导演。请根据用户原问题和已经真实说出的观点，判断第一轮之后是否还需要一轮讨论。",
    `用户问题：${session.question}`,
    `主题：${session.theme}`,
    `核心张力：${session.tension}`,
    "第一轮真实发言：",
    firstRound.map((message) => `[${message.id}] ${pioneerById.get(message.speakerId)?.figure ?? message.speakerId}：${message.content}`).join("\n"),
    "模式定义：",
    "- crossfire：两条真实主张在同一个决策点上不能同时优先，才允许温和交锋。",
    "- sequence：观点可以组成有先后关系的步骤，后一位推进前一位。",
    "- complement：观点互补，共同补全同一个判断。",
    "- clarify：当前最需要澄清一个概念、标准或事实，不必争论。",
    "- skip：第一轮已经足够清楚，或无法找到可靠推进点。",
    "规则：",
    "- 不能根据人物身份预设她们必然争论；只能依据上面真实发言中的主张。",
    "- 不能发明任何人没有说过的立场，也不能把一位人物的观点归给另一位。",
    "- crossfire 必须 hasTrueConflict=true，且 focus 写清双方争夺的同一个优先级；否则降为 sequence、complement 或 clarify。",
    "- 只是把同一个观察或动作从一次延长到三天、七天，不算推进；只是换一种说法重复前文，也不算互补。这两种情况应选 skip。",
    "- 如果第一轮已提供清楚且彼此不同的视角，没有尚待澄清的判断，也应选 skip，把空间留给用户追问。",
    "- speakerIds 与 primaryMessageIds 必须一一对应，最多两位。skip 时两者为空。",
    "- label 使用“温和交锋 / 逐层推进 / 共同完善 / 关键澄清 / 继续追问”之一。",
    "- focus 必须直接回答这轮如何继续贴近用户问题，不得转到人物惯用主题。"
  ].join("\n");
}

function fallbackFollowUpPlan(primaryPioneerId: string): FollowUpPlan {
  return {
    primaryPioneerId,
    secondaryMode: "none",
    focus: "只回应用户本轮真正提出的内容",
    rationale: "没有足够依据邀请第二位，避免为了热闹重复发言。"
  };
}

function textBigrams(value: string) {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function similarity(left: string, right: string) {
  const a = textBigrams(left);
  const b = textBigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function chooseDistinctSecondary(
  selected: PioneerProfile[],
  primaryPioneerId: string,
  messages: RoundtableMessage[]
) {
  const primary = selected.find((pioneer) => pioneer.id === primaryPioneerId);
  const recentPrimary = activeMessages(messages)
    .filter((message) => message.speakerId === primaryPioneerId)
    .at(-1)?.content ?? "";
  const primaryProfile = primary
    ? `${primary.voiceProfile.responsePosture} ${primary.voiceProfile.reasoningMove} ${primary.voiceProfile.preferredWords.join(" ")}`
    : "";

  return selected
    .filter((pioneer) => pioneer.id !== primaryPioneerId)
    .map((pioneer, index) => {
      const recentCandidate = activeMessages(messages)
        .filter((message) => message.speakerId === pioneer.id)
        .at(-1)?.content ?? "";
      const candidateProfile = `${pioneer.voiceProfile.responsePosture} ${pioneer.voiceProfile.reasoningMove} ${pioneer.voiceProfile.preferredWords.join(" ")}`;
      const difference =
        (1 - similarity(primaryProfile, candidateProfile)) * 0.6 +
        (1 - similarity(recentPrimary, recentCandidate)) * 0.4;
      return { pioneer, difference, index };
    })
    .sort((left, right) => right.difference - left.difference || left.index - right.index)[0]?.pioneer;
}

export function ensureRequestedSecondary(
  plan: FollowUpPlan,
  selected: PioneerProfile[],
  primaryPioneerId: string,
  intent: UserTurnIntent,
  messages: RoundtableMessage[]
): FollowUpPlan {
  if (intent !== "request_other_view" || plan.secondaryPioneerId) return plan;
  const secondary = chooseDistinctSecondary(selected, primaryPioneerId, messages);
  if (!secondary) return plan;
  return {
    ...plan,
    secondaryPioneerId: secondary.id,
    secondaryMode: "alternate",
    focus: "从不同角度补充一个直接影响用户判断的新观察点",
    rationale: "用户明确邀请了另一位先行者，按观点差异选择回应者。"
  };
}

function followUpPlanSchema(
  selected: PioneerProfile[],
  primaryPioneerId: string,
  intent: UserTurnIntent
) {
  const otherIds = selected.filter((pioneer) => pioneer.id !== primaryPioneerId).map((pioneer) => pioneer.id);
  const requiresSecondary = intent === "request_other_view";
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "primaryPioneerId",
      ...(requiresSecondary ? ["secondaryPioneerId"] : []),
      "secondaryMode",
      "focus",
      "rationale"
    ],
    properties: {
      primaryPioneerId: { type: "string", enum: [primaryPioneerId] },
      secondaryPioneerId: { type: "string", enum: otherIds },
      secondaryMode: {
        type: "string",
        enum: requiresSecondary ? ["alternate"] : ["none", "extend", "challenge", "alternate"]
      },
      focus: { type: "string" },
      rationale: { type: "string" }
    }
  };
}

function followUpPlanPrompt(
  session: RoundtableSession,
  selected: PioneerProfile[],
  primaryPioneerId: string,
  followUp: string,
  intent: UserTurnIntent,
  messages: RoundtableMessage[]
) {
  const recent = activeMessages(messages).slice(-10);
  return [
    "你是圆桌导演。用户刚刚继续说了一句话。被点名的先行者必须回应；请判断是否还值得邀请第二位入场。",
    `原始问题：${session.question}`,
    `本轮用户原话：${followUp}`,
    `本轮意图：${intent}`,
    `被点名者：${primaryPioneerId}`,
    "在席先行者：",
    selected.map((pioneer) => `- ${pioneer.id}｜${pioneer.figure}｜${pioneer.voiceProfile.responsePosture}｜${pioneer.voiceProfile.reasoningMove}`).join("\n"),
    "最近谈话：",
    recent.map((message) => `[${message.id}] ${message.speakerId}：${message.content}`).join("\n") || "无",
    "规则：",
    "- 用户纠正误读、已经确认行动或明确准备结束时，secondaryMode 必须为 none。",
    "- 只有第二位能补充一个被点名者尚未覆盖、且直接影响用户判断的新角度时，才邀请她。",
    "- extend 表示沿着用户刚形成的方向推进新一步；challenge 表示双方对同一个决策点确有不同优先级；alternate 表示用户明确想听另一种视角。",
    "- 不得为了保持热闹而安排第二位；不能只是换词重复、再次提醒同一种风险，或把一次行动延长成七天。",
    "- focus 用 18-45 字写清第二位具体增加什么。secondaryMode 为 none 时不要输出 secondaryPioneerId。",
    "- 必须紧扣本轮用户原话，不得转去讨论人物惯用主题。"
  ].join("\n");
}

export function sanitizeFollowUpPlan(
  raw: FollowUpPlan,
  selected: PioneerProfile[],
  primaryPioneerId: string,
  intent: UserTurnIntent
): FollowUpPlan {
  const allowedSecondary = new Set(selected.filter((pioneer) => pioneer.id !== primaryPioneerId).map((pioneer) => pioneer.id));
  const forcedSingle = intent === "user_correction" || intent === "commitment" || intent === "closure";
  const allowedModes: FollowUpPlan["secondaryMode"][] = ["none", "extend", "challenge", "alternate"];
  let mode = allowedModes.includes(raw?.secondaryMode) ? raw.secondaryMode : "none";
  if (forcedSingle || !raw?.secondaryPioneerId || !allowedSecondary.has(raw.secondaryPioneerId)) mode = "none";
  if (intent !== "request_other_view" && mode === "alternate") mode = "extend";

  return {
    primaryPioneerId,
    secondaryPioneerId: mode === "none" ? undefined : raw.secondaryPioneerId,
    secondaryMode: mode,
    focus: compactText(raw?.focus || "补充一个不同的判断条件", 48),
    rationale: compactText(raw?.rationale || "", 72)
  };
}

export function sanitizeDiscussionPlan(raw: DiscussionPlan, messages: RoundtableMessage[]): DiscussionPlan {
  const firstRound = activeMessages(messages).filter(
    (message) => message.role === "pioneer" && message.stage === "first_round"
  );
  const byId = new Map(firstRound.map((message) => [message.id, message]));
  const messageIds = Array.isArray(raw?.primaryMessageIds)
    ? raw.primaryMessageIds.filter((id, index, all) => byId.has(id) && all.indexOf(id) === index).slice(0, 2)
    : [];
  const speakers = messageIds.map((id) => byId.get(id)!.speakerId);
  let mode = discussionModes.includes(raw?.mode) ? raw.mode : "skip";
  if (messageIds.length < 1 || speakers.length !== new Set(speakers).size) mode = "skip";
  if (mode === "crossfire" && (!raw.hasTrueConflict || messageIds.length !== 2)) mode = "sequence";
  if (mode !== "skip" && messageIds.length < 2) mode = "clarify";
  const labelByMode: Record<DiscussionPlan["mode"], string> = {
    crossfire: "温和交锋",
    sequence: "逐层推进",
    complement: "共同完善",
    clarify: "关键澄清",
    skip: "继续追问"
  };
  return {
    mode,
    label: labelByMode[mode],
    speakerIds: mode === "skip" ? [] : speakers,
    primaryMessageIds: mode === "skip" ? [] : messageIds,
    focus: mode === "skip" ? "" : compactText(softenUnsupportedInference(raw.focus || "继续回应用户问题"), 56),
    rationale: compactText(raw.rationale || "", 72),
    hasTrueConflict: mode === "crossfire"
  };
}

// 用户确认理解的表述。单独出现时是 closure；
// 后面还跟着一个真实新问题时，只是礼貌前缀，本轮意图应由那个问题决定。
const acknowledgementPattern =
  /(?:清楚了|明白了|懂了|知道了|了解了|有数了|可以结束|可以收束|没有(?:别的|其他)(?:问题|疑问)|就这样(?:做)?|谢谢)/;

// 真实的新请求：出现疑问句式或明确的求教结构。
// 「没有别的问题」里的「问题」不算提问，因此这里不把裸「什么」「问题」当信号。
function asksSomethingNew(text: string) {
  if (/[？?]/.test(text)) {
    // 问号存在，但要排除「没有别的问题？」这类仍属收束的说法。
    const withoutAcknowledgement = text.replace(acknowledgementPattern, "").replace(/[^一-鿿]/g, "");
    if (withoutAcknowledgement.length >= 2) return true;
  }
  return /(?:为什么|怎么(?:办|做|样|判断|练|开始)?|如何|怎样|该从哪|从哪里|哪一(?:个|种|步)|是不是|能不能|可以吗|要不要)/.test(
    text
  );
}

export function classifyUserTurnIntent(text: string): UserTurnIntent {
  const normalized = text.trim();
  // 真正的纠正必须否认「系统归到用户身上的内容」，而不是仅仅同时出现疑问词和否定词。
  // 此前的 `什么.{1,8}[？?].*(?:没|没有)` 会把「什么算重点？我没有想清楚」误判成反驳，
  // 于是角色向一个只是提问的用户道歉。这里要求出现明确的归属否认或误读指认。
  if (
    /(?:我没(?:有)?说(?!清楚|明白|好|完|出来|出口)|我没(?:有)?提(?:到|过)|我(?:并)?没有这样说|不是我说的|我不是这个意思|这不是我的意思|你理解错|你误解|你搞错|我(?:可)?没这么说)/.test(
      normalized
    )
  ) {
    return "user_correction";
  }
  if (/(其他人|另一位|她们怎么看|换个人|别的视角)/.test(normalized)) return "request_other_view";
  if (/(我不同意|我不认同|但我觉得不是|不是这样的)/.test(normalized)) return "disagreement";
  if (/(我担心|我害怕|我难过|我羞耻|我焦虑|我生气|我很累|我委屈)/.test(normalized)) return "emotion";

  const acknowledges = acknowledgementPattern.test(normalized);
  const asksNew = asksSomethingNew(normalized);

  // 先判断收束：只有在用户没有提出新请求时才成立。
  // 这样「好的，我明白了。」进入 closure，而「我明白了，那我可以如何锻炼呢？」仍是提问。
  if (acknowledges && !asksNew) {
    return /(我决定|那我就|我会先|接下来我会|我准备(?:先|去|从)|我可以去)/.test(normalized)
      ? "commitment"
      : "closure";
  }

  if (asksNew) return "question";
  if (/(我决定|那我就|我会先|接下来我会|我准备(?:先|去|从)|我可以去)/.test(normalized)) return "commitment";
  if (/(但是|可是|不过|只是)/.test(normalized)) return "concern";
  return "reflection";
}

export function findCorrectionTerm(text: string, messages: RoundtableMessage[]) {
  const candidates = [
    text.match(/什么(?:是)?([\u4e00-\u9fff]{2,8})[？?]/)?.[1],
    text.match(/没有提到(?:任何的)?[“\"‘']?([\u4e00-\u9fff]{2,8})/)?.[1],
    text.match(/[“\"‘']([^”\"’']{1,12})[”\"’']/)?.[1]
  ].filter((value): value is string => Boolean(value));
  const priorAssistantText = activeMessages(messages)
    .filter((message) => message.role !== "user")
    .map((message) => message.content)
    .join("\n");
  return candidates.find((candidate) => priorAssistantText.includes(candidate));
}

export class RoundtableDirector {
  async planFollowUpWithMeta(
    session: RoundtableSession,
    selected: PioneerProfile[],
    primaryPioneerId: string,
    followUp: string,
    intent: UserTurnIntent,
    messages: RoundtableMessage[]
  ): Promise<{ data: FollowUpPlan; usedFallback: boolean }> {
    if (intent === "user_correction" || intent === "commitment" || intent === "closure") {
      return { data: fallbackFollowUpPlan(primaryPioneerId), usedFallback: false };
    }

    try {
      const result = await generateJson<FollowUpPlan>(
        "roundtable_follow_up_plan",
        followUpPlanSchema(selected, primaryPioneerId, intent),
        followUpPlanPrompt(session, selected, primaryPioneerId, followUp, intent, messages)
      );
      const sanitized = sanitizeFollowUpPlan(result.data, selected, primaryPioneerId, intent);
      return {
        data: ensureRequestedSecondary(sanitized, selected, primaryPioneerId, intent, messages),
        usedFallback: false
      };
    } catch {
      if (intent === "request_other_view") {
        return {
          data: ensureRequestedSecondary(
            fallbackFollowUpPlan(primaryPioneerId),
            selected,
            primaryPioneerId,
            intent,
            messages
          ),
          usedFallback: true
        };
      }
      return { data: fallbackFollowUpPlan(primaryPioneerId), usedFallback: true };
    }
  }

  async planDiscussionWithMeta(
    session: RoundtableSession,
    messages: RoundtableMessage[]
  ): Promise<{ data: DiscussionPlan; usedFallback: boolean }> {
    const firstRound = activeMessages(messages).filter(
      (message) => message.role === "pioneer" && message.stage === "first_round"
    );
    if (firstRound.length < 2) return { data: fallbackDiscussionPlan(), usedFallback: true };
    try {
      const result = await generateJson<DiscussionPlan>(
        "roundtable_discussion_plan",
        discussionPlanSchema(messages),
        discussionPlanPrompt(session, messages)
      );
      return { data: sanitizeDiscussionPlan(result.data, messages), usedFallback: false };
    } catch {
      return { data: fallbackDiscussionPlan(), usedFallback: true };
    }
  }

  classifyUserTurn(text: string) {
    return classifyUserTurnIntent(text);
  }

  findCorrectionTerm(text: string, messages: RoundtableMessage[]) {
    return findCorrectionTerm(text, messages);
  }

  async planConversationWithMeta(
    session: RoundtableSession,
    selected: PioneerProfile[]
  ): Promise<{ data: ConversationPlan; usedFallback: boolean }> {
    if (!selected.length) {
      return { data: { assignments: [], rationale: "没有可安排的先行者。" }, usedFallback: true };
    }

    try {
      const result = await generateJson<ConversationPlan>(
        "roundtable_plan",
        conversationPlanSchema(selected),
        conversationPlanPrompt(session, selected)
      );
      return { data: sanitizeConversationPlan(result.data, session, selected), usedFallback: false };
    } catch {
      return { data: fallbackConversationPlan(session, selected), usedFallback: true };
    }
  }

  async planConversation(session: RoundtableSession, selected: PioneerProfile[]) {
    return (await this.planConversationWithMeta(session, selected)).data;
  }

  async analyzeWithMeta(question: string): Promise<{ data: ThemeAnalysis; usedFallback: boolean }> {
    try {
      const result = await generateJson<ThemeAnalysisDraft>("theme_analysis", analysisSchema, analysisPrompt(question));
      return { data: sanitizeAnalysis(result.data, question), usedFallback: false };
    } catch {
      const fallback = themeRules.find((rule) => rule.match.test(question))?.analysis ?? fallbackAnalysis;
      return {
        data: sanitizeAnalysis(fallback, question),
        usedFallback: true
      };
    }
  }

  async analyze(question: string): Promise<ThemeAnalysis> {
    return (await this.analyzeWithMeta(question)).data;
  }

  createSession(question: string, analysis: ThemeAnalysis, userId?: string): RoundtableSession {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      userId,
      question,
      theme: analysis.theme,
      tension: analysis.tension,
      supportMode: analysis.supportMode,
      explicitEmotionTerms: analysis.explicitEmotionTerms,
      selectedPioneerIds: analysis.recommendedPioneerIds.slice(0, 3),
      stage: "recommend",
      createdAt: now,
      updatedAt: now
    };
  }

  nextStage(current: RoundtableStage): RoundtableStage {
    const order: RoundtableStage[] = [
      "intake",
      "analyze",
      "recommend",
      "opening",
      "first_round",
      "crossfire",
      "follow_up",
      "synthesis",
      "action_card",
      "quote_card"
    ];
    return order[Math.min(order.indexOf(current) + 1, order.length - 1)] ?? "intake";
  }

}
