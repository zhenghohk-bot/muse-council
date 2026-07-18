import { pioneerById } from "@/data/pioneers";
import { buildHarvestTranscript, describePioneer } from "@/lib/harness/context-builder";
import { generateJson } from "@/lib/harness/openai-client";
import {
  compactQuote,
  compactText,
  composePioneerTurn,
  ensureFirstPerson,
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

type PioneerTurnDraft = PioneerTurnParts & { quote: string };

const pioneerTurnSchema = {
  type: "object",
  additionalProperties: false,
  required: ["acknowledgement", "judgment", "reason", "nextStep", "quote"],
  properties: {
    acknowledgement: { type: "string" },
    judgment: { type: "string" },
    reason: { type: "string" },
    nextStep: { type: "string" },
    quote: { type: "string" }
  }
};

function renderPioneerTurn(draft: PioneerTurnDraft, maxChars = 100) {
  return {
    content: composePioneerTurn(draft, maxChars),
    quote: compactQuote(draft.quote)
  };
}

function sourceList(sourceNotes: SourceNote[]) {
  return sourceNotes.map((note) => `- ${note.id}｜${note.title}：${note.note} 用法：${note.usageHint}`).join("\n");
}

function fallbackOpening(session: RoundtableSession) {
  return {
    content: compactText(`你正在面对「${session.theme}」，其中最难的是${session.tension}。先不用急着决定，我们把愿望、担心和现实条件分别看清。`, 80),
    quote: "先把问题看清，再决定下一步。"
  };
}

function fallbackPioneerSpeech(session: RoundtableSession, pioneer: PioneerProfile, sourceNotes: SourceNote[]) {
  const primary = sourceNotes[0];
  return {
    content: composePioneerTurn({
      acknowledgement: `你现在卡在${session.tension}`,
      judgment: `我更在意的是，${pioneer.decisionStyle}`,
      reason: pioneer.pushback,
      nextStep: pioneer.practice
    }),
    quote: compactQuote(primary ? pioneer.pushback : `先把${pioneer.values[0]}变成一个动作`)
  };
}

function fallbackCrossfire(session: RoundtableSession, first: PioneerProfile, second: PioneerProfile, tension: string) {
  return {
    first: `我会提醒你，${tension}不能只靠热情撑住。先看清手里的牌，再行动。`,
    second: `我同意要看代价，但也要保住真实愿望。稳妥不能变成无限期推迟。`,
    synthesis: `这场分歧已经够了：你要保护愿望，也要给愿望一个能活下来的结构。下一步不必宏大，但要真实、可做、可复盘。`
  };
}

function fallbackFollowUp(question: string, pioneer: PioneerProfile) {
  return {
    content: composePioneerTurn(
      {
        acknowledgement: `你追问的是「${question}」`,
        judgment: `我建议先按${pioneer.decisionStyle}`,
        reason: "一次想通并不可靠",
        nextStep: pioneer.practice
      },
      90
    ),
    quote: "先做一次，再看证据。"
  };
}

function getQuoteCandidates(messages: RoundtableMessage[]) {
  return messages.filter(
    (message): message is RoundtableMessage & { quote: string } =>
      message.role === "pioneer" && Boolean(message.quote?.trim())
  );
}

function renderActionCard(sessionId: string, card: Omit<ActionCard, "sessionId">): ActionCard {
  return {
    sessionId,
    within24h: compactText(card.within24h, 90),
    sevenDayExperiment: compactText(card.sevenDayExperiment, 110),
    thirtyDayPractice: compactText(card.thirtyDayPractice, 110),
    evidenceToReview: compactText(card.evidenceToReview, 90)
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
  return {
    actionCard: renderActionCard(session.id, {
      within24h: `把「${session.question}」拆成一个 20 分钟内能完成的小动作，并留下截图、文字或清单。`,
      sevenDayExperiment: lead?.practice ?? "连续 7 天做一个最小实验，并每天记录一个证据。",
      thirtyDayPractice: second?.practice ?? "每周固定一次复盘：我做了什么、我逃避了什么、我下一步要守住什么。",
      evidenceToReview: synthesis
        ? `带着圆桌收束「${synthesis}」复盘四类证据：真实投入时间、外界反馈、身体感受、是否更接近你想要的生活。`
        : "复盘时只看四类证据：真实投入时间、外界反馈、身体感受、是否更接近你想要的生活。"
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
      "要求：用用户能直接理解的现代中文；先准确说清困境，不替用户解释原因，不急着建议；50-80 个中文字；最多一个比喻；不要连续使用“不是…而是…”；给一句 8-20 字的 quote。"
    ].join("\n");

    try {
      const result = await generateJson<{ content: string; quote: string }>("roundtable_opening", textWithQuoteSchema, prompt);
      return {
        ...result,
        data: {
          content: compactText(softenUnsupportedInference(result.data.content), 80),
          quote: compactQuote(result.data.quote)
        }
      };
    } catch {
      return { data: fallbackOpening(session), usedFallback: true as const };
    }
  }

  async pioneerSpeech(session: RoundtableSession, pioneer: PioneerProfile, sourceNotes: SourceNote[]) {
    const prompt = [
      "请生成一位先行者的第一轮发言。",
      `用户问题：${session.question}`,
      `主题：${session.theme}`,
      `核心张力：${session.tension}`,
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "请分别填写五个字段，页面会把它们自然连接，不要在字段里写标题。",
      "acknowledgement：12-20 字，只承接用户明确说出的处境，不推断隐藏原因。",
      "judgment：18-26 字，使用第一人称，给出该先行者独有的判断。",
      "reason：16-22 字，说明判断依据，不重复 judgment。",
      "nextStep：18-28 字，只给一个具体、可执行的小动作。",
      "quote：8-22 字，来自本轮判断，不冒充历史名言。",
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
      "此前圆桌发言：",
      buildHarvestTranscript(
        messages,
        new Map(messages.map((message) => [message.speakerId, pioneerById.get(message.speakerId)?.figure ?? message.speakerId]))
      ),
      "要求：围绕价值张力形成一个明确争点；first 和 second 必须回应对方可能忽略的部分，均为第一人称，各 40-60 个中文字；不要重复第一轮建议。synthesis 用 50-75 个中文字说清分歧与共同下一步，并把未参与交锋的先行者观点带回整场讨论；全程使用清楚的现代中文，每段最多一个比喻。"
    ].join("\n");

    try {
      const result = await generateJson<{ first: string; second: string; synthesis: string }>("roundtable_crossfire", schema, prompt);
      return {
        ...result,
        data: {
          ...result.data,
          first: compactText(ensureFirstPerson(result.data.first), 60),
          second: compactText(ensureFirstPerson(result.data.second), 60),
          synthesis: compactText(softenUnsupportedInference(result.data.synthesis), 75)
        }
      };
    } catch {
      return { data: fallbackCrossfire(session, first, second, tension), usedFallback: true as const };
    }
  }

  async followUp(session: RoundtableSession, pioneer: PioneerProfile, followUpQuestion: string, sourceNotes: SourceNote[]) {
    const prompt = [
      "请生成用户追问后的单人回应。",
      `原始问题：${session.question}`,
      `用户追问：${followUpQuestion}`,
      `主题：${session.theme}`,
      "先行者角色卡：",
      describePioneer(pioneer),
      "可用来源注释：",
      sourceList(sourceNotes),
      "请分别填写 acknowledgement、judgment、reason、nextStep、quote 五个字段，不要写字段标题。",
      "acknowledgement 只回应追问中明确出现的内容；judgment 必须第一人称并符合声音协议；reason 不得替用户下心理结论；nextStep 只给一个具体动作；quote 不冒充历史名言。整段组合后应为 60-90 个中文字。禁止无来源地声称“我曾经/我也曾”。"
    ].join("\n");

    try {
      const result = await generateJson<PioneerTurnDraft>(
        `follow_up_${pioneer.id.replaceAll("-", "_")}`,
        pioneerTurnSchema,
        prompt
      );
      return { ...result, data: renderPioneerTurn(result.data, 90) };
    } catch {
      return { data: fallbackFollowUp(followUpQuestion, pioneer), usedFallback: true as const };
    }
  }

  async finalize(session: RoundtableSession, selected: PioneerProfile[], messages: RoundtableMessage[] = []) {
    const quoteCandidates = getQuoteCandidates(messages);
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["actionCard", "quoteCards"],
      properties: {
        actionCard: {
          type: "object",
          additionalProperties: false,
          required: ["within24h", "sevenDayExperiment", "thirtyDayPractice", "evidenceToReview"],
          properties: {
            within24h: { type: "string" },
            sevenDayExperiment: { type: "string" },
            thirtyDayPractice: { type: "string" },
            evidenceToReview: { type: "string" }
          }
        },
        quoteCards: {
          type: "array",
          minItems: 1,
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
      "可选金句（只能从这些实际发言中选择，不得另编历史名言）：",
      quoteCandidates.length
        ? quoteCandidates.map((message) => `- ${message.id}｜${message.speakerId}｜${message.quote}`).join("\n")
        : "本轮没有可选金句，可基于角色视角生成，但 context 必须注明“本轮圆桌提炼”。",
      "要求：行动卡必须承接真实谈话中的具体判断与主持人收束；24 小时动作 45-90 字且今天能完成；7 天实验 60-110 字且可验证；30 天练习 60-110 字且可持续；复盘证据 45-90 字，不能空泛。每张金句卡的 context 只说明它与本轮问题的关系，30-65 字。金句 1-3 条；有候选金句时必须返回对应 sourceMessageId。"
    ].join("\n");

    try {
      const result = await generateJson<{
        actionCard: Omit<ActionCard, "sessionId">;
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

      const quoteCards = groundedQuoteCards.length
        ? groundedQuoteCards.slice(0, 3)
        : fallbackFinal(session, selected, messages).quoteCards;
      return {
        data: {
          actionCard: renderActionCard(session.id, result.data.actionCard),
          quoteCards
        },
        usedFallback: false as const
      };
    } catch {
      return { data: fallbackFinal(session, selected, messages), usedFallback: true as const };
    }
  }
}
