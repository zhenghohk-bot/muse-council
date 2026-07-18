import { pioneers } from "@/data/pioneers";
import { generateJson } from "@/lib/harness/openai-client";
import { compactText, softenUnsupportedInference } from "@/lib/harness/output-guard";
import type { RoundtableSession, RoundtableStage, ThemeAnalysis } from "@/lib/types";

const themeRules = [
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

const fallbackAnalysis: ThemeAnalysis = {
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

// Chat-Completions 的 json_object 模式不保证 enum 约束，模型可能返回不存在的 id、
// 重复 id 或数量不足 3。这里收敛回 9 人名册、去重并补足到 3 位，避免下游 getPioneers 静默丢人导致缺席。
function sanitizeAnalysis(raw: ThemeAnalysis, question: string): ThemeAnalysis {
  const topUp = themeRules.find((rule) => rule.match.test(question))?.analysis ?? fallbackAnalysis;
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
  return {
    ...raw,
    theme: raw.theme.replace(/[。！？]/g, "").slice(0, 14),
    tension: compactText(softenUnsupportedInference(raw.tension), 48),
    emotion: compactText(softenUnsupportedInference(raw.emotion), 55),
    need: compactText(softenUnsupportedInference(raw.need), 55),
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
  return [
    "请先读懂用户的人生困惑，再为一场女性先行者圆桌做主持人分析。",
    `用户的问题：${question}`,
    "",
    "可入席的先行者名册（只能从中挑选）：",
    pioneerRoster(),
    "",
    "请输出：",
    "- theme：4-10 个字，用普通短语命名主题，不写文学标题。",
    "- tension：25-45 字，说清两种难以兼顾的需要，不使用比喻。",
    "- emotion：25-50 字，只反映用户明确表达或可以谨慎推测的情绪；不替她解释隐藏原因。",
    "- need：25-50 字，说明下一步方向，具体但不急着给完整方案。",
    "- recommendedPioneerIds：从名册里选 3 位最能就这个问题形成视角张力的先行者 id。",
    "- reason：45-75 字，说明三位各自能看见什么。",
    "要求：使用直接、自然、容易理解的现代中文；贴合用户的具体处境，不套模板。禁止使用“未被认领的……”“生命在要求……”“长回自己”等抽象说法；禁止断言用户没有说出的创伤、悲伤、羞耻或心理动机。无法确认时使用“可能”“也许”“可以先观察”。"
  ].join("\n");
}

export class RoundtableDirector {
  async analyzeWithMeta(question: string): Promise<{ data: ThemeAnalysis; usedFallback: boolean }> {
    try {
      const result = await generateJson<ThemeAnalysis>("theme_analysis", analysisSchema, analysisPrompt(question));
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
      ["jane-austen", "qin-liangyu", "关系观察与边界守护"],
      ["ban-zhao", "virginia-woolf", "自持秩序与精神空间"],
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
