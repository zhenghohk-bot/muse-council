import { pioneers } from "@/data/pioneers";
import { generateJson } from "@/lib/harness/openai-client";
import { compactText, softenUnsupportedInference } from "@/lib/harness/output-guard";
import { classifySupportContext, supportModeInstruction } from "@/lib/harness/support-mode";
import type {
  ConversationAssignment,
  ConversationPlan,
  PioneerProfile,
  RoundtableSession,
  RoundtableStage,
  SpeechAct,
  ThemeAnalysis,
  TurnRelation
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
    match: /写作|表达|内容|账号|笔记|作品|发布|被看见/i,
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
const turnRelations: TurnRelation[] = ["open", "extend", "challenge", "clarify", "redirect"];

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
  return [
    `${pioneer.id}｜${pioneer.figure}｜${pioneer.archetype}`,
    `推理方式：${pioneer.voiceProfile.reasoningMove}`,
    `擅长谈话动作：${pioneer.voiceProfile.preferredSpeechActs.join("、")}`,
    `价值：${pioneer.values.join("、")}`,
    `适合问题：${pioneer.suitableFor.join("、")}`
  ].join("\n");
}

function defaultAssignmentText(
  session: RoundtableSession,
  pioneer: PioneerProfile,
  speechAct: SpeechAct
) {
  return {
    objective: `${speechActPurpose[speechAct]}，并使用${pioneer.figure}的判断方式回应「${session.theme}」`,
    newContribution: `${pioneer.figure}从${pioneer.voiceProfile.reasoningMove}推进讨论`
  };
}

function fallbackConversationPlan(
  session: RoundtableSession,
  selected: PioneerProfile[]
): ConversationPlan {
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
      relation: index === 0 ? "open" : index === 1 ? "extend" : "redirect",
      respondsToPioneerId: index === 0 ? undefined : ordered[index - 1]?.pioneer.id,
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
          : "extend";
    const respondsToPioneerId =
      index === 0
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

  if (
    assignments.length >= 3 &&
    !assignments.slice(1).some((assignment) => assignment.relation === "challenge" || assignment.relation === "redirect")
  ) {
    assignments[assignments.length - 1] = {
      ...assignments[assignments.length - 1],
      relation: "redirect",
      objective: `${assignments[assignments.length - 1].objective}；改用不同于前文的判断标准`
    };
  }

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
            "respondsToPioneerId",
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
  return [
    "你是圆桌导演。请根据本次问题和人物能力，为第一轮安排一组彼此互补的谈话任务。",
    `用户问题：${session.question}`,
    `主题：${session.theme}`,
    `核心张力：${session.tension}`,
    supportModeInstruction({ mode: session.supportMode, explicitEmotionTerms: session.explicitEmotionTerms }),
    "在席人物：",
    selected.map(profileForPlan).join("\n\n"),
    "可用谈话动作：",
    speechActs.map((act) => `- ${act}：${speechActPurpose[act]}`).join("\n"),
    "规则：",
    "- 任务不能随机分配。每项任务必须同时匹配本场需要和人物擅长的谈话动作。",
    "- 可以重新安排发言顺序，但每位人物必须且只能出现一次。",
    "- 第一位 relation=open、respondsToPioneerId 为空字符串；后续人物必须回应一位已经发言的人，使用 extend、challenge、clarify 或 redirect。",
    "- 三位以上入席时，后续至少一位必须使用 challenge 或 redirect，真正改变判断标准，不能所有人都顺着第一位补充。",
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
  const ids: string[] = [];
  for (const id of [...(raw.recommendedPioneerIds ?? []), ...topUp.recommendedPioneerIds]) {
    if (ids.length >= 3) break;
    if (validPioneerIds.has(id) && !ids.includes(id)) ids.push(id);
  }
  while (ids.length < 3) {
    const next = pioneers.find((pioneer) => !ids.includes(pioneer.id));
    if (!next) break;
    ids.push(next.id);
  }
  const need = compactText(softenUnsupportedInference(raw.need), 55);
  const givesDecision = /(应该|必须|建议|暂不|先别|不要|可以.{0,6}先|可以在)/.test(need);
  const inventsCauses =
    supportContext.mode === "unknown_cause" &&
    /(源于|来自|是因为|由于|^.*是.*还是|可能与.*相关|哪些.*相关)/.test(need);
  const safeNeed = givesDecision
    ? compactText(`一起厘清「${raw.theme}」中的事实和判断标准，再由你决定下一步。`, 55)
    : inventsCauses
      ? "看清这种感受何时出现、何时变化，以及哪些线索值得继续追问。"
      : need;
  return {
    ...raw,
    theme: raw.theme.replace(/[。！？]/g, "").slice(0, 14),
    tension: compactText(softenUnsupportedInference(raw.tension), 48),
    emotion:
      supportContext.mode === "unknown_cause"
        ? "这份感受真实存在，却暂时说不清原因；不必急着为它下结论。"
        : compactText(softenUnsupportedInference(raw.emotion), 55),
    need: safeNeed,
    supportMode: supportContext.mode,
    explicitEmotionTerms: supportContext.explicitEmotionTerms,
    reason: compactText(raw.reason, 80),
    recommendedPioneerIds: ids
  };
}

function pioneerRoster() {
  return pioneers
    .map((pioneer) => `- ${pioneer.id}｜${pioneer.figure}｜${pioneer.archetype}｜擅长：${pioneer.suitableFor.join("、")}`)
    .join("\n");
}

function analysisPrompt(question: string) {
  const supportContext = classifySupportContext(question);
  return [
    "请先读懂用户的人生困惑，再为一场女性先行者圆桌做主持人分析。",
    `用户的问题：${question}`,
    supportModeInstruction(supportContext),
    "",
    "可入席的先行者名册（只能从中挑选）：",
    pioneerRoster(),
    "",
    "请输出：",
    "- theme：4-10 个字，用普通短语命名主题，不写文学标题。",
    "- tension：25-45 字，说清两种难以兼顾的需要，不使用比喻。",
    "- emotion：25-50 字，只反映用户明确表达或可以谨慎推测的情绪；不替她解释隐藏原因。",
    "- need：25-50 字，只说这场谈话需要帮用户厘清什么事实、边界或判断标准；不替用户做决定，不写“应该、暂不、先别、建议、可以先”。",
    "- recommendedPioneerIds：从名册里选 3 位最能就这个问题形成视角张力的先行者 id。",
    "- reason：45-75 字，说明三位各自能看见什么。",
    "要求：使用直接、自然、容易理解的现代中文；贴合用户的具体处境，不套模板。禁止使用“未被认领的……”“生命在要求……”“长回自己”等抽象说法；禁止断言用户没有说出的创伤、悲伤、羞耻或心理动机。无法确认时使用“可能”“也许”“可以先观察”。"
  ].join("\n");
}

export class RoundtableDirector {
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

  chooseCrossfirePair(selectedPioneerIds: string[], theme: string) {
    const pairs = [
      ["wu-zetian", "li-qingzhao", "策略与真实感受"],
      ["marie-curie", "ada-lovelace", "长期证据与快速原型"],
      ["jane-austen", "ban-zhao", "关系观察与相处节奏"],
      ["li-qingzhao", "virginia-woolf", "先表达还是先留空间"],
      ["jane-austen", "virginia-woolf", "先看清关系交换还是先保住精神空间"],
      ["jane-austen", "qin-liangyu", "关系观察与边界守护"],
      ["wu-zetian", "ban-zhao", "外部筹码与内在稳定"]
    ] as const;

    const pair = pairs.find(([a, b]) => selectedPioneerIds.includes(a) && selectedPioneerIds.includes(b));
    if (pair) return { firstId: pair[0], secondId: pair[1], tension: pair[2] };

    const [firstId, secondId] = selectedPioneerIds;
    return {
      firstId: firstId ?? pioneers[0].id,
      secondId: secondId ?? pioneers[1].id,
      tension: `${theme}里的两种重要价值`
    };
  }
}
