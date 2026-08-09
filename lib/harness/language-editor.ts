import type { RoundtableSession } from "@/lib/types";

export type LanguageIssueCategory = "fact_boundary" | "grammar" | "naturalness" | "coherence";

export type LanguageIssue = {
  category: LanguageIssueCategory;
  issue: string;
};

/**
 * Language Editor 层。
 *
 * 职责：
 * 1. 事实边界：不添加原文没有的感受、经历、行为、关系和目标。
 * 2. 中文语法：杂糅句式、主宾搭配、指代不明。
 * 3. 自然表达：抽象名词堆叠、产品术语、翻译腔。
 * 4. 对话衔接：新句要承接当前问题或前文新增信息，不靠套话。
 *
 * 权限边界：只产出「问题清单 + repair 指令」，不改写判断、不新增建议、不虚构人物经历。
 * 高置信度问题才进确定性拦截，其余作为 repair 信号与评测信号，避免退化成无限增长的禁用词表。
 */

// 只保留高置信度的「未授权心理前提」词。这些词一旦出现在正文而用户没说过，
// 就属于替用户补写内心状态，跨问题复现，因此适合确定性检查。
const unauthorizedInnerStateTerms = [
  "紧张",
  "害怕",
  "羞耻",
  "失落",
  "悲伤",
  "焦虑",
  "创伤",
  "依恋",
  "原生家庭",
  "潜意识",
  "身份滑落",
  "社会评价",
  "获取认可",
  "证明自己",
  "自尊",
  "迎合",
  "讨好",
  "亏欠",
  "愧疚"
];

// 产品化 / 评测化术语：真实中文对话里不会这样说话。
const productTerms = [
  "线索库",
  "数据点",
  "反馈回路",
  "反馈循环",
  "基线评分",
  "情绪劳动",
  "内在空间被侵占"
];

/**
 * 听者框定失败：把「让对方听懂」这件事写成物件转移或责任归属。
 *
 * 这两种句式此前分别绑定在 jane-austen 与 ada-lovelace 的 id 上，
 * 只能拦住某一位人物在某一道题上的某一种说法。实际缺陷与人物无关，
 * 是「抽象动作被写成对听者的取物或责备」这一句法形态，任何人物、任何题型都可能出现，
 * 因此改为按句式判断。
 */
const listenerFramingPatterns: Array<{ pattern: RegExp; label: string }> = [
  {
    // 从你话里拿走 / 带走 / 取走 / 挑出；对方要用的那一样
    pattern:
      /从[^。；]{0,6}话(?:里|中)[^。；]{0,4}(?:拿走|带走|取走|挑出|取出|拿出)|对方(?:必须|要|得)从[^。；]{0,6}话(?:里|中)|(?:对方|听者)要用的那一样/,
    label: "把听者理解写成了从话里取走某件东西"
  },
  {
    // 把判断 / 理解 / 反馈的责任推给 / 交给 / 留给 听者或对方
    pattern:
      /(?:判断|理解|反馈|听懂)(?:的)?责任[^。；]{0,8}(?:推给|交给|留给|丢给)|把[^。；]{0,10}责任[^。；]{0,6}(?:推给|交给|留给|丢给)[^。；]{0,4}(?:听者|对方|别人)/,
    label: "把理解或反馈写成了对听者的责任归属"
  }
];

// 杂糅或主宾失配的高置信度句式。
const awkwardPatterns: Array<{ pattern: RegExp; label: string }> = [
  // 「你要把 X，让 Y 更 Z」：把字句与让字句杂糅。
  { pattern: /你要把[^。；]{2,24}[，,]?\s*让[^。；]{2,24}更/, label: "把字句与让字句杂糅" },
  // 「A 是来自 B 还是 C 的」：判断句与选择问句杂糅。
  { pattern: /是来自[^。；]{2,12}还是[^。；]{2,12}的/, label: "判断句与选择问句杂糅" },
  // 「不是 A，而是 B 在 C」：替用户改写内心成因。
  { pattern: /不是[^。；]{2,14}，而是[^。；]{2,14}在[^。；]{2,14}/, label: "用对比句替用户改写成因" },
  { pattern: /并非[^。；]{2,14}本身，而是它/, label: "过度强调结构的对比句" },
  { pattern: /这[^。；]{0,10}意味着你正在/, label: "把推测写成确定结论" }
];

// 空壳承接语：本身不违规，但如果只有它、没有实质承接，就是套话开场。
const weakBridges = [
  "我想先",
  "换个角度",
  "我会先问",
  "我来提供一个",
  "让我们",
  "我的判断是",
  "我的观察是",
  "在我看来"
];

const ABSTRACT_NOUN_WINDOW = 40;
const PRONOUN_DENSITY_LIMIT = 3;

export function checkFactBoundary(
  content: string,
  userQuestion: string,
  explicitEmotionTerms: string[] = []
): LanguageIssue[] {
  const invented = unauthorizedInnerStateTerms.filter(
    (term) =>
      content.includes(term) &&
      !userQuestion.includes(term) &&
      !explicitEmotionTerms.some((allowed) => allowed.includes(term) || term.includes(allowed))
  );

  return invented.length
    ? [
        {
          category: "fact_boundary",
          issue: `正文新增了用户没有表达的感受或前提：${invented.join("、")}`
        }
      ]
    : [];
}

export function checkGrammar(content: string): LanguageIssue[] {
  const issues: LanguageIssue[] = [];

  for (const { pattern, label } of awkwardPatterns) {
    const matched = content.match(pattern);
    if (matched) {
      issues.push({ category: "grammar", issue: `中文句式不通顺（${label}）：${matched[0]}` });
    }
  }

  const pronouns = content.match(/[它这那]/g) ?? [];
  if (content.length > 0 && content.length < 120 && pronouns.length > PRONOUN_DENSITY_LIMIT) {
    issues.push({ category: "grammar", issue: "短段落内指代词过密，容易指代不明" });
  }

  return issues;
}

// 单独导出，供 turn 级硬校验直接调用。
export function checkListenerFraming(content: string): LanguageIssue[] {
  return listenerFramingPatterns
    .map(({ pattern, label }) => ({ pattern, label, matched: content.match(pattern) }))
    .filter((entry) => entry.matched)
    .map((entry) => ({
      category: "naturalness" as const,
      issue: `${entry.label}：${entry.matched?.[0]}`
    }));
}

/**
 * 指代明确性：被「具体／这／那」锁定成指称的短语，必须能回指到用户原话或前文中的具体内容。
 * 这是跨题型的回指检查：只匹配「具体 X」处于断定位置（具体经历只是……）和
 * 没有名词的空指示词（那一样、那一件），不绑定任何题目关键词。
 */
const metaReferenceStopheads = /^(?:到|来说|而言|一点|一些|一下|化)/;

export function checkReferenceClarity(content: string, contextTexts: string[] = []): LanguageIssue[] {
  const issues: LanguageIssue[] = [];
  const context = contextTexts.join("\n");
  const flaggedHeads = new Set<string>();
  for (const match of content.matchAll(/具体([一-龥]{2,4})(?:只是|只|就|都|也|并非|不是|本身)/g)) {
    const head = match[1];
    if (metaReferenceStopheads.test(head) || flaggedHeads.has(head)) continue;
    if (!context.includes(head)) {
      flaggedHeads.add(head);
      issues.push({
        category: "grammar",
        issue: `指代不明：「具体${head}」在用户原话和此前谈话中没有可以回指的内容`
      });
    }
  }
  const bareDemonstrative = content.match(/(?:这|那)一样(?![一-龥])|(?:这|那)一件(?![一-龥])/);
  if (bareDemonstrative) {
    issues.push({
      category: "naturalness",
      issue: `翻译腔空指代：「${bareDemonstrative[0]}」没有跟上具体名词，读者不知道指的是什么`
    });
  }
  return issues;
}

/**
 * 强造比喻：比喻的职责是帮助理解。以下两种句法形态高置信度不成立：
 * 1. 感官或身体部位充当空间运动主语（耳朵最先通向哪里）——主谓搭配不自然；
 * 2. 喻体本身是抽象概念（像一种理解）——比喻没有把意思变得更具体。
 * 只拦形态，不拦具体意象词；其余文学化问题交给 repair 指令与质量评测。
 */
const strainedMetaphorPatterns: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /(?:耳朵|眼睛|舌尖|喉咙|呼吸|手指)[^。；，]{0,8}(?:通向|通往|流向|抵达|伸向)/,
    label: "感官或身体词被用作空间运动主语，主谓搭配不自然"
  },
  {
    pattern:
      /(?:像|仿佛|如同|犹如)(?:一(?:种|场|面|段|次))?(?:理解|认知|感受|体验|秩序|结构|意义|价值|取舍|平衡)(?:[。；，]|$|的)/,
    label: "喻体本身是抽象概念，比喻没有帮助理解，应改为自然直述"
  }
];

export function checkMetaphorNaturalness(content: string): LanguageIssue[] {
  return strainedMetaphorPatterns
    .map(({ pattern, label }) => ({ label, matched: content.match(pattern) }))
    .filter((entry) => entry.matched)
    .map((entry) => ({
      category: "naturalness" as const,
      issue: `${entry.label}：${entry.matched?.[0]}`
    }));
}

export function checkNaturalness(content: string): LanguageIssue[] {
  const issues: LanguageIssue[] = [];

  const foundProductTerms = productTerms.filter((term) => content.includes(term));
  if (foundProductTerms.length) {
    issues.push({
      category: "naturalness",
      issue: `使用了产品化或评测化术语：${foundProductTerms.join("、")}`
    });
  }

  issues.push(...checkListenerFraming(content));

  const abstractNouns = [...content.matchAll(/[一-龥]{1,3}[性度感化]/g)];
  for (let index = 0; index + 2 < abstractNouns.length; index += 1) {
    const start = abstractNouns[index].index ?? 0;
    const end = abstractNouns[index + 2].index ?? 0;
    if (end - start <= ABSTRACT_NOUN_WINDOW) {
      issues.push({
        category: "naturalness",
        issue: `抽象名词密集堆叠：${abstractNouns
          .slice(index, index + 3)
          .map((match) => match[0])
          .join("、")}`
      });
      break;
    }
  }

  return issues;
}

function sharesConcreteAnchor(opening: string, previousContents: string[]) {
  // 4 字以上的连续片段重合，才算真的承接了前文的具体内容。
  for (let size = 5; size >= 4; size -= 1) {
    for (let start = 0; start + size <= opening.length; start += 1) {
      const fragment = opening.slice(start, start + size);
      if (/^[一-龥]+$/.test(fragment) && previousContents.some((prev) => prev.includes(fragment))) {
        return true;
      }
    }
  }
  return false;
}

export function checkCoherence(
  content: string,
  previousContents: string[] = [],
  isFirstSpeaker = false
): LanguageIssue[] {
  if (isFirstSpeaker || !previousContents.length) return [];

  const opening = content.split(/[。！？]/)[0]?.trim() ?? "";
  if (!opening) return [];

  const startsWithWeakBridge = weakBridges.some((bridge) => opening.startsWith(bridge));
  if (startsWithWeakBridge && !sharesConcreteAnchor(opening, previousContents)) {
    return [
      {
        category: "coherence",
        issue: "开场只用了空壳承接语，没有接住前文的具体判断或新信息"
      }
    ];
  }

  return [];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 主持人开场的产品口吻契约。
 *
 * 开场只负责确认入席、贴近用户原话并把谈话交给圆桌，不能像节目单一样
 * 逐位宣布人物分工，也不能用未经史料支持的相似经历制造亲近感。
 */
export function checkHostOpening(content: string, pioneerNames: string[] = []): LanguageIssue[] {
  const issues: LanguageIssue[] = [];
  const mentionedNames = pioneerNames.filter((name) => content.includes(name));
  const namesPattern = pioneerNames.length ? pioneerNames.map(escapeRegExp).join("|") : "";
  const assignmentLanguage = /(?:看|关注|负责|会帮你|将帮你|会从|将从)/;
  const agendaLanguage = /(?:本场|本轮)(?:要|将|会)?(?:讨论|围绕)|(?:会帮你|将帮你|负责)/;
  // 逐位分工的句法形态，与提到几个人名无关：
  // 1. 人名后紧跟分工动词（李清照看……、阿达负责……）；
  // 2. 把谈话切成角度或视角（从……角度、分别从……层面切入）。
  const rosterAssignment = namesPattern
    ? new RegExp(`(?:${namesPattern})[，、]?[^。；，]{0,4}(?:看|负责|分析|讲|会从|将从|带来)`).test(content)
    : false;
  const angleAssignment =
    /(?:分别|各自)[^。；]{0,16}(?:角度|视角|层面)/.test(content) ||
    (mentionedNames.length > 0 && /从[^。；]{0,12}(?:角度|视角|层面)/.test(content));

  if (
    (mentionedNames.length >= 2 && assignmentLanguage.test(content)) ||
    agendaLanguage.test(content) ||
    rosterAssignment ||
    angleAssignment
  ) {
    issues.push({
      category: "naturalness",
      issue: "主持人像在播报议程或分工，没有自然邀请圆桌开始"
    });
  }

  const subjectPattern = namesPattern ? `(?:${namesPattern}|她们)` : "她们";
  const fabricatedBiography = new RegExp(
    `${subjectPattern}.{0,18}(?:都曾|也曾|曾经|经历过|穿越过|面对过).{0,24}(?:相似|同样|这样的|迷雾|困境)`
  );

  if (fabricatedBiography.test(content)) {
    issues.push({
      category: "fact_boundary",
      issue: "主持人虚构先行者经历过与用户相似的处境"
    });
  }

  return issues;
}

export function checkLanguage(
  content: string,
  session: Pick<RoundtableSession, "question" | "explicitEmotionTerms">,
  previousContents: string[] = [],
  isFirstSpeaker = false
): LanguageIssue[] {
  return [
    ...checkFactBoundary(content, session.question, session.explicitEmotionTerms),
    ...checkGrammar(content),
    ...checkNaturalness(content),
    ...checkReferenceClarity(content, [session.question, ...previousContents]),
    ...checkMetaphorNaturalness(content),
    ...checkCoherence(content, previousContents, isFirstSpeaker)
  ];
}

// 事实边界属于硬红线，其余三类作为 repair 信号。
export function hasHardLanguageIssue(issues: LanguageIssue[]) {
  return issues.some((issue) => issue.category === "fact_boundary");
}

export function describeLanguageIssues(issues: LanguageIssue[]) {
  return issues.map((issue) => issue.issue);
}

export function buildLanguageRepairPrompt(issues: LanguageIssue[]): string {
  if (!issues.length) return "";

  const has = (category: LanguageIssueCategory) => issues.some((issue) => issue.category === category);
  const repairs: string[] = ["语言编辑要求（只改表达和顺序，不新增判断、建议或人物经历）："];

  if (has("fact_boundary")) {
    repairs.push(
      "- 删除用户没有说过的感受、经历、行为和目标。需要提到某种可能时，写成条件句或真正的问句，不要写成事实。"
    );
  }
  if (has("grammar")) {
    repairs.push(
      "- 把杂糅句拆成两句，让主语、谓语和宾语清楚对应；把「它、这、那」换成具体名词。"
    );
  }
  if (has("naturalness")) {
    repairs.push("- 删除产品术语和连续抽象名词，改成一遍就能听懂的日常中文。");
  }
  if (has("coherence")) {
    repairs.push(
      "- 删掉「我想先」「换个角度」这类空壳开头，第一句直接接住前文的具体判断、问题或新增信息。"
    );
  }

  repairs.push(
    "- 通用语言要求：每个代词都能回指到具体名词，指不清就换成那个名词本身；主谓宾与修饰搭配要在普通中文里真实成立；两个抽象概念之间要有一步过渡，不让读者自己搭桥；普通用户第一遍就能读懂，不需要反推作者想说什么；只保留真正帮助理解的比喻，只为制造文学感的比喻改成自然直述；不用翻译腔、产品术语或咨询话术；后一句自然承接当前问题与前文新增信息。"
  );
  repairs.push(`- 已检出的问题：${describeLanguageIssues(issues).join("；")}`);
  return repairs.join("\n");
}
