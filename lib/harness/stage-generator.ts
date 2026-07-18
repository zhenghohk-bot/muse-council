import { pioneerById } from "@/data/pioneers";
import { buildHarvestTranscript, describePioneer } from "@/lib/harness/context-builder";
import { generateJson } from "@/lib/harness/openai-client";
import {
  breakLongSentences,
  compactQuote,
  compactText,
  composePioneerTurn,
  ensureFirstPerson,
  guardPioneerContent,
  groundQuoteInContent,
  softenUnsupportedInference,
  type PioneerTurnParts
} from "@/lib/harness/output-guard";
import type {
  ActionCard,
  PioneerProfile,
  QuoteCard,
  RoundtableMessage,
  RoundtableSession,
  SourceNote
} from "@/lib/types";

const textWithQuoteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "quote"],
  properties: {
    content: { type: "string" },
    quote: { type: "string" }
  }
};

type PioneerTurnDraft = PioneerTurnParts & { content: string; quote: string };
type ActionCardDraft = Omit<ActionCard, "sessionId" | "sourceMessageIds"> & { sourceMessageIds?: string[] };

const pioneerTurnSchema = {
  type: "object",
  additionalProperties: false,
  required: ["acknowledgement", "judgment", "reason", "nextStep", "content", "quote"],
  properties: {
    acknowledgement: { type: "string" },
    judgment: { type: "string" },
    reason: { type: "string" },
    nextStep: { type: "string" },
    content: { type: "string" },
    quote: { type: "string" }
  }
};

function renderPioneerTurn(draft: PioneerTurnDraft, maxChars = 100) {
  let directContent = guardPioneerContent(draft.content, maxChars);
  const hasConcreteAction = /(今天|今晚|现在|立刻|先写|先做|记录|列出|画出|整理|安排|删掉|完成|试一次)/.test(
    directContent
  );
  if (!hasConcreteAction && draft.nextStep.trim()) {
    const action = compactText(softenUnsupportedInference(draft.nextStep), 32).replace(/[。！？]+$/, "");
    const sentences = directContent.match(/[^。！？]+[。！？]?/g) ?? [directContent];
    while (sentences.length > 1 && `${sentences.join("")}${action}。`.length > maxChars) {
      sentences.pop();
    }
    directContent = `${sentences.join("")}${action}。`;
  }
  const content = directContent.length >= 45 ? directContent : composePioneerTurn(draft, maxChars);
  return {
    content,
    quote: groundQuoteInContent(content, draft.quote, draft.judgment)
  };
}

function renderCrossfireTurn(content: string, pioneer: PioneerProfile, maxChars = 52) {
  const guarded = compactText(
    breakLongSentences(ensureFirstPerson(content, `我从${pioneer.values[0]}来看：`)),
    maxChars
  );
  const hasPriorityAndReason = /(先|优先|主张)/.test(guarded) && guarded.length >= 28;
  if (hasPriorityAndReason) return guarded;
  return compactText(
    `${pioneer.voiceProfile.crossfireClaim}。${pioneer.voiceProfile.counterRisk}。`,
    maxChars
  );
}

function sourceList(sourceNotes: SourceNote[]) {
  return sourceNotes.map((note) => `- ${note.id}｜${note.title}：${note.note} 用法：${note.usageHint}`).join("\n");
}

function fallbackOpening(session: RoundtableSession) {
  return {
    content: compactText(`你现在难以决定，是因为${session.tension}。我们先听听不同看法，再找一个你愿意尝试的小步骤。`, 64),
    quote: "先把问题看清，再决定下一步。"
  };
}

function fallbackPioneerSpeech(session: RoundtableSession, pioneer: PioneerProfile, sourceNotes: SourceNote[]) {
  const primary = sourceNotes[0];
  return renderPioneerTurn({
      acknowledgement: `你现在卡在${session.tension}`,
      judgment: `我更在意的是，${pioneer.decisionStyle}`,
      reason: pioneer.pushback,
      nextStep: pioneer.practice,
      content: `你现在还在权衡。我会先按${pioneer.decisionStyle}。${pioneer.practice}`,
      quote: primary ? pioneer.pushback : `先把${pioneer.values[0]}变成一个动作`
    });
}

function fallbackCrossfire(session: RoundtableSession, first: PioneerProfile, second: PioneerProfile, tension: string) {
  return {
    first: compactText(`我更担心只顾${second.values[0]}，会忽略${first.values[0]}所需的条件。`, 52),
    second: compactText(`我会追问：若只守${first.values[0]}，你会不会一直等不到开始？`, 52),
    synthesis: compactText(`先用一个小实验验证：你能否同时保住${first.values[0]}，又向${second.values[0]}迈一步。`, 58)
  };
}

function fallbackFollowUp(question: string, pioneer: PioneerProfile) {
  return renderPioneerTurn(
    {
      acknowledgement: `你追问的是「${question}」`,
      judgment: `我建议先按${pioneer.decisionStyle}`,
      reason: "一次想通并不可靠",
      nextStep: pioneer.practice,
      content: `你问得很具体。我的判断是，${pioneer.decisionStyle}。${pioneer.practice}`,
      quote: "先做一次，再看证据"
    },
    82
  );
}

function getQuoteCandidates(messages: RoundtableMessage[]) {
  return messages.filter(
    (message): message is RoundtableMessage & { quote: string } =>
      message.role === "pioneer" &&
      Boolean(message.quote?.trim()) &&
      message.content.includes(message.quote?.trim() ?? "")
  );
}

function chooseActionLead(
  session: RoundtableSession,
  selected: PioneerProfile[],
  messages: RoundtableMessage[]
) {
  const preferences = [
    { match: /父母|家里|家庭|考编|催婚/, ids: ["qin-liangyu", "jane-austen", "ban-zhao"] },
    { match: /朋友|恋爱|关系|亏欠|伴侣|前任/, ids: ["jane-austen", "qin-liangyu", "ban-zhao"] },
    { match: /副业|创业|辞职|变现|赚钱|产品/, ids: ["wu-zetian", "ada-lovelace", "marie-curie"] },
    { match: /写作|表达|发布|内容|账号|作品/, ids: ["li-qingzhao", "virginia-woolf", "ada-lovelace"] },
    { match: /同龄|落后|比较|羡慕|自我价值/, ids: ["jane-austen", "marie-curie", "ban-zhao"] },
    { match: /说不清|压在心口|身体沉|沉重/, ids: ["virginia-woolf", "li-qingzhao", "ban-zhao"] }
  ];
  const rule = preferences.find(({ match }) => match.test(`${session.question}\n${session.theme}`));
  const selectedIds = new Set(selected.map((pioneer) => pioneer.id));
  const leadId = rule?.ids.find((id) => selectedIds.has(id)) ?? selected[0]?.id;
  const message = messages.find(
    (item) => item.stage === "first_round" && item.speakerId === leadId
  );
  const pioneer = selected.find((item) => item.id === leadId);
  return message && pioneer ? { message, pioneer } : undefined;
}

function renderActionCard(sessionId: string, card: ActionCardDraft): ActionCard {
  return {
    sessionId,
    chosenPath: compactText(card.chosenPath, 60),
    within24h: compactText(card.within24h, 58),
    sevenDayExperiment: compactText(card.sevenDayExperiment, 78),
    thirtyDayPractice: compactText(card.thirtyDayPractice, 82),
    guardrail: compactText(card.guardrail, 70),
    evidenceToReview: compactText(card.evidenceToReview, 64),
    sourceMessageIds: card.sourceMessageIds?.slice(0, 4)
  };
}

function fallbackFinal(
  session: RoundtableSession,
  selected: PioneerProfile[],
  messages: RoundtableMessage[] = []
): { actionCard: ActionCard; quoteCards: QuoteCard[] } {
  const lead = selected[0];
  const second = selected[1];
  const synthesis = messages.filter((message) => message.stage === "synthesis").at(-1)?.content;
  const candidates = getQuoteCandidates(messages);
  const sourceMessageIds = messages
    .filter((message) => message.role === "pioneer" || message.stage === "synthesis")
    .slice(-3)
    .map((message) => message.id);
  return {
    actionCard: renderActionCard(session.id, {
      chosenPath: `本轮先沿${lead?.figure ?? "第一位先行者"}的练习推进，用一次行动代替继续猜测。`,
      within24h: `用 20 分钟完成一个与「${session.theme}」有关的小动作，留下截图、文字或清单。`,
      sevenDayExperiment: lead?.practice ?? "连续 7 天做一个最小实验，并每天记录一个证据。",
      thirtyDayPractice: second?.practice ?? "每周固定一次复盘：我做了什么、我逃避了什么、我下一步要守住什么。",
      guardrail: "如果连续 7 天没有留下任何结果，就缩小动作或换一条圆桌主线，不用责备自己。",
      evidenceToReview: synthesis
        ? `对照圆桌收束复盘：投入时间、实际反馈、完成后的感受。`
        : "复盘三类证据：投入时间、实际反馈、完成后的感受。",
      sourceMessageIds
    }),
    quoteCards: candidates.length
      ? candidates.slice(0, 3).map((message) => ({
          sessionId: session.id,
          speakerId: message.speakerId,
          quote: message.quote,
          sourceMessageId: message.id,
          context: compactText(`本轮圆桌提炼｜${pioneerById.get(message.speakerId)?.figure ?? "先行者"}对「${session.theme}」的提醒`, 70)
        }))
      : selected.slice(0, 3).map((pioneer) => ({
          sessionId: session.id,
          speakerId: pioneer.id,
          quote: `不要急着成为谁，先把${pioneer.values[0]}练成你自己的能力。`,
          context: compactText(`本轮圆桌提炼｜${pioneer.figure}对「${session.theme}」的提醒`, 70)
        }))
  };
}

export class StageGenerator {
  async opening(session: RoundtableSession) {
    const prompt = [
      "请生成主持人的反映式开场。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      "要求：直接用“你”称呼用户，不使用“她”“我听到的是”“我看见”；抓住用户原话中的一个具体细节，用 2-3 句自然的现代中文说清她正在权衡什么；只承接她明确说出的感受，无法确认的地方保留不确定；不分析隐藏原因，不给建议；42-64 个中文字，不用比喻和抽象心理术语；给一句 8-20 字的 quote。"
    ].join("\n");

    try {
      const result = await generateJson<{ content: string; quote: string }>("roundtable_opening", textWithQuoteSchema, prompt);
      return {
        ...result,
        data: {
          content: compactText(breakLongSentences(softenUnsupportedInference(result.data.content)), 64),
          quote: compactQuote(result.data.quote)
        }
      };
    } catch {
      return { data: fallbackOpening(session), usedFallback: true as const };
    }
  }

  async pioneerSpeech(
    session: RoundtableSession,
    pioneer: PioneerProfile,
    sourceNotes: SourceNote[],
    messages: RoundtableMessage[] = []
  ) {
    const prompt = [
      "请生成一位先行者的第一轮发言。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "此前已经说过的话：",
      buildHarvestTranscript(
        messages,
        new Map(messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ) || "你是第一位发言者，暂无前序发言。",
      "请先在心里做一次换名检查：如果这段话换成另一位先行者仍成立，就重写。然后填写六个字段，不要在内容中写字段标题。",
      "你必须推进一个前面没有说过的判断或动作；不要重复其他先行者已经给出的清单、记录方式或关键词。若观点相近，要明确说明你与前一位的判断标准有何不同。",
      "acknowledgement：10-18 字，承接用户原话中的一个具体处境，不使用“我懂”“我看见”。",
      "judgment：16-26 字，使用第一人称，落实该角色的推理动作，并自然使用一个偏好概念。",
      "reason：12-20 字，给出这位角色才会强调的判断依据，不重复 judgment。",
      "nextStep：16-26 字，只给一个今天能开始、能留下结果的小动作。",
      "content：把前四项按这位角色的语言节奏写成 2-3 句自然对话，65-96 个中文字；必须包含明确判断和那个具体动作，不必逐字段原样复述。",
      "quote：8-22 字，必须是 content 中原样出现的一个完整短句或分句，不冒充历史名言。",
      "语言要求：像真实对话，不用古风腔、论文腔或咨询师术语；允许句式与其他角色不同，但不要堆角色关键词。",
      "禁止：固定套话开场；说“她会”；无来源地声称“我曾经/我也曾”；替用户定义心理原因；连续堆叠比喻；使用角色卡中列出的禁止模式。"
    ].join("\n");

    try {
      const result = await generateJson<PioneerTurnDraft>(
        `pioneer_${pioneer.id.replaceAll("-", "_")}`,
        pioneerTurnSchema,
        prompt
      );
      return { ...result, data: renderPioneerTurn(result.data) };
    } catch {
      return { data: fallbackPioneerSpeech(session, pioneer, sourceNotes), usedFallback: true as const };
    }
  }

  async crossfire(
    session: RoundtableSession,
    first: PioneerProfile,
    second: PioneerProfile,
    tension: string,
    messages: RoundtableMessage[] = []
  ) {
    const firstPrior = messages.find(
      (message) => message.speakerId === first.id && message.stage === "first_round"
    )?.content;
    const secondPrior = messages.find(
      (message) => message.speakerId === second.id && message.stage === "first_round"
    )?.content;
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["first", "second", "synthesis"],
      properties: {
        first: { type: "string" },
        second: { type: "string" },
        synthesis: { type: "string" }
      }
    };
    const prompt = [
      "请生成温和交锋，不是吵架。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `价值张力：${tension}`,
      `第一位：${describePioneer(first)}`,
      `第二位：${describePioneer(second)}`,
      `第一位此前判断：${firstPrior ?? "无"}`,
      `第二位此前判断：${secondPrior ?? "无"}`,
      "此前圆桌发言：",
      buildHarvestTranscript(
        messages,
        new Map(messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ),
      "要求：只争论“用户现在应该先做什么”。first 必须明确主张先采用自己的方案，并说出第二位方案先做的直接代价；second 必须明确表示不同意这个优先级，主张先采用自己的方案，并说出第一位方案先做的直接代价。两人都要延续各自声音协议，使用第一人称，各 34-52 个中文字，不复述第一轮，不使用“我同意，但”式假交锋，也不能只罗列条件。",
      "synthesis 用 38-58 个中文字说清分歧，并把它转成用户可以验证的一道选择题或判断条件；不判谁赢，不逐人复述，不使用比喻。"
    ].join("\n");

    try {
      const result = await generateJson<{ first: string; second: string; synthesis: string }>("roundtable_crossfire", schema, prompt);
      return {
        ...result,
        data: {
          ...result.data,
          first: renderCrossfireTurn(result.data.first, first),
          second: renderCrossfireTurn(result.data.second, second),
          synthesis: compactText(softenUnsupportedInference(result.data.synthesis), 58)
        }
      };
    } catch {
      return { data: fallbackCrossfire(session, first, second, tension), usedFallback: true as const };
    }
  }

  async followUp(
    session: RoundtableSession,
    pioneer: PioneerProfile,
    followUpQuestion: string,
    sourceNotes: SourceNote[],
    messages: RoundtableMessage[] = []
  ) {
    const prompt = [
      "请生成用户追问后的单人回应。",
      `原始问题：${session.question}`,
      `用户追问：${followUpQuestion}`,
      `主题：${session.theme}`,
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "本场此前谈话：",
      buildHarvestTranscript(
        messages,
        new Map(messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ) || "无",
      "先回答追问本身，不重复第一轮。请填写 acknowledgement、judgment、reason、nextStep、content、quote 六个字段，不要写字段标题。",
      "acknowledgement 只回应追问中的一个具体信息；judgment 必须第一人称并落实角色推理动作；reason 不替用户下心理结论；nextStep 只给一个能留下结果的动作；content 将前四项写成 2-3 句、55-82 个中文字；quote 必须是 content 中原样出现的完整短句或分句。禁止无来源地声称“我曾经/我也曾”。"
    ].join("\n");

    try {
      const result = await generateJson<PioneerTurnDraft>(
        `follow_up_${pioneer.id.replaceAll("-", "_")}`,
        pioneerTurnSchema,
        prompt
      );
      return { ...result, data: renderPioneerTurn(result.data, 82) };
    } catch {
      return { data: fallbackFollowUp(followUpQuestion, pioneer), usedFallback: true as const };
    }
  }

  async finalize(session: RoundtableSession, selected: PioneerProfile[], messages: RoundtableMessage[] = []) {
    const quoteCandidates = getQuoteCandidates(messages);
    const actionSourceMessages = messages.filter(
      (message) => message.role === "pioneer" || message.stage === "synthesis"
    );
    const actionSourceIds = actionSourceMessages.map((message) => message.id);
    const actionSourceAliases = actionSourceMessages.map((message, index) => ({
      alias: `m${index + 1}`,
      message
    }));
    const actionSourceIdByAlias = new Map(
      actionSourceAliases.map(({ alias, message }) => [alias, message.id])
    );
    const actionLead = chooseActionLead(session, selected, messages);
    const actionLeadAlias = actionSourceAliases.find(
      ({ message }) => message.id === actionLead?.message.id
    )?.alias;
    const actionCardRequired = [
      "chosenPath",
      "within24h",
      "sevenDayExperiment",
      "thirtyDayPractice",
      "guardrail",
      "evidenceToReview"
    ];
    if (actionSourceIds.length) actionCardRequired.push("sourceMessageIds");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["actionCard", "quoteCards"],
      properties: {
        actionCard: {
          type: "object",
          additionalProperties: false,
          required: actionCardRequired,
          properties: {
            chosenPath: { type: "string" },
            within24h: { type: "string" },
            sevenDayExperiment: { type: "string" },
            thirtyDayPractice: { type: "string" },
            guardrail: { type: "string" },
            evidenceToReview: { type: "string" },
            sourceMessageIds: actionSourceIds.length
              ? {
                  type: "array",
                  minItems: Math.min(2, actionSourceIds.length),
                  maxItems: Math.min(4, actionSourceIds.length),
                  items: { type: "string", enum: actionSourceAliases.map(({ alias }) => alias) }
                }
              : { type: "array", items: { type: "string" } }
          }
        },
        quoteCards: {
          type: "array",
          minItems: quoteCandidates.length >= 2 ? 2 : 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: quoteCandidates.length
              ? ["quote", "speakerId", "context", "sourceMessageId"]
              : ["quote", "speakerId", "context"],
            properties: {
              quote: { type: "string" },
              speakerId: { type: "string", enum: selected.map((pioneer) => pioneer.id) },
              context: { type: "string" },
              sourceMessageId: quoteCandidates.length
                ? { type: "string", enum: quoteCandidates.map((message) => message.id) }
                : { type: "string" }
            }
          }
        }
      }
    };
    const prompt = [
      "请为这场圆桌生成行动卡和金句卡。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      `入席先行者：${selected.map((pioneer) => `${pioneer.figure}（${pioneer.practice}）`).join("；")}`,
      "本轮真实谈话：",
      buildHarvestTranscript(messages, new Map(selected.map((pioneer) => [pioneer.id, pioneer.figure]))),
      "行动卡来源消息（sourceMessageIds 只填写左侧 m 编号，不要复制 UUID）：",
      actionSourceAliases.map(({ alias, message }) => `- ${alias}｜${message.content}`).join("\n") || "无",
      actionLead && actionLeadAlias
        ? `Harness 已决定行动主线：${actionLeadAlias}｜${actionLead.pioneer.figure}。chosenPath 和三段行动必须沿这条主线，sourceMessageIds 第一项必须是 ${actionLeadAlias}，不可自行换人。`
        : "Harness 未指定行动主线，请选择最贴近用户现实问题的一条。",
      "可选金句（只能从这些实际发言中选择，不得另编历史名言）：",
      quoteCandidates.length
        ? quoteCandidates.map((message) => `- ${message.id}｜${message.speakerId}｜${message.quote}`).join("\n")
        : "本轮没有可选金句，可基于角色视角生成，但 context 必须注明“本轮圆桌提炼”。",
      "要求：先从来源消息里选择一条最适合用户当前处境的主线，sourceMessageIds 的第一个编号就是主线，其余编号只用于补充或收束。chosenPath 用 25-60 字说明本轮先采用谁的哪条判断，以及为什么适合用户现在开始。行动都沿着这条主线递进，不要把不同先行者的练习拼成任务大礼包。",
      "再从交锋中找出对这条主线最有力的一条反对意见。guardrail 用 25-70 字写成明确的“如果主线行动导致了反方担心的风险，就缩小、暂停或调整”的条件；护栏必须降低风险，不能反过来强化主线。sourceMessageIds 至少包含主线发言和这条反对意见。不要增加第二套行动。",
      "24 小时动作 25-58 字，只交付一件东西，最多包含两个检查项；7 天实验 35-78 字，重复或验证同一个方法，写清频率和记录方式；30 天练习 40-82 字，把同一方法变成固定节奏且不能只是重复 7 天实验；复盘证据 25-64 字，只列 3 个可观察指标。每项只写一句，使用直接、自然的现代中文，并返回 2-4 个实际承接的 sourceMessageIds。",
      "每张金句卡的 quote 必须是一句脱离上下文也完整通顺的话，不能以“而是、但是、因为、如果”等连接词开头。context 只说明它与本轮问题的关系，20-55 字。有 2 条以上候选时返回 2-3 张金句卡；有候选金句时必须返回对应 sourceMessageId。"
    ].join("\n");

    try {
      const result = await generateJson<{
        actionCard: ActionCardDraft;
        quoteCards: Array<Omit<QuoteCard, "sessionId"> & { sourceMessageId?: string }>;
      }>("roundtable_finalize", schema, prompt);
      const candidateById = new Map(quoteCandidates.map((message) => [message.id, message]));
      const groundedQuoteCards = result.data.quoteCards
        .map((quoteCard) => {
          const source = quoteCard.sourceMessageId ? candidateById.get(quoteCard.sourceMessageId) : undefined;
          if (quoteCandidates.length && !source) return undefined;
          return {
            ...quoteCard,
            sessionId: session.id,
            speakerId: source?.speakerId ?? quoteCard.speakerId,
            quote: source?.quote ?? quoteCard.quote,
            context: compactText(
              quoteCard.context.startsWith("本轮圆桌提炼")
                ? quoteCard.context
                : `本轮圆桌提炼｜${quoteCard.context}`,
              70
            )
          } satisfies QuoteCard;
        })
        .filter((quoteCard): quoteCard is QuoteCard => Boolean(quoteCard));

      const selectedQuoteMessageIds = new Set(groundedQuoteCards.map((card) => card.sourceMessageId));
      const minimumQuoteCards = Math.min(2, quoteCandidates.length);
      const supplementalQuoteCards = quoteCandidates
        .filter((message) => !selectedQuoteMessageIds.has(message.id))
        .slice(0, Math.max(0, minimumQuoteCards - groundedQuoteCards.length))
        .map((message) => ({
          sessionId: session.id,
          speakerId: message.speakerId,
          quote: message.quote,
          sourceMessageId: message.id,
          context: compactText(
            `本轮圆桌提炼｜${pioneerById.get(message.speakerId)?.figure ?? "先行者"}对「${session.theme}」的提醒`,
            55
          )
        }));
      const quoteCards = groundedQuoteCards.length || supplementalQuoteCards.length
        ? [...groundedQuoteCards, ...supplementalQuoteCards].slice(0, 3)
        : fallbackFinal(session, selected, messages).quoteCards;
      const groundedActionSourceIds = (result.data.actionCard.sourceMessageIds ?? [])
        .map((alias) => actionSourceIdByAlias.get(alias))
        .filter((id): id is string => Boolean(id));
      if (actionLead && !groundedActionSourceIds.includes(actionLead.message.id)) {
        groundedActionSourceIds.unshift(actionLead.message.id);
      }
      if (actionSourceIds.length >= 2 && groundedActionSourceIds.length < 2) {
        throw new Error("Action card is not grounded in enough roundtable messages");
      }
      return {
        data: {
          actionCard: renderActionCard(session.id, {
            ...result.data.actionCard,
            chosenPath:
              actionLead && !result.data.actionCard.chosenPath.includes(actionLead.pioneer.figure)
                ? `本轮先沿${actionLead.pioneer.figure}的判断推进：${result.data.actionCard.chosenPath}`
                : result.data.actionCard.chosenPath,
            sourceMessageIds: groundedActionSourceIds.slice(0, 4)
          }),
          quoteCards
        },
        usedFallback: false as const
      };
    } catch {
      return { data: fallbackFinal(session, selected, messages), usedFallback: true as const };
    }
  }
}
