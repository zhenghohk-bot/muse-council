import type { CardPreferences, QuoteCard } from "@/lib/types";

/**
 * 金句卡选择规则（纯函数，供 UI 与确定性契约测试共用）。
 *
 * 产品约定：
 * - 初始状态不默认选择任何金句卡；只有用户主动点击「加入组合」才进入组合。
 * - 点赞与「加入组合」是两个互相独立的状态，互不影响。
 * - 列表顺序、人物位置、是否存在历史回声，都不得改变组合选择。
 * - 持久化只恢复用户在当前这组卡片里明确选择过的状态；卡片重新生成后，
 *   旧选择中已不存在的卡片一律丢弃，绝不按位置回填。
 */

export function quoteCardId(card: Pick<QuoteCard, "speakerId" | "quote">) {
  return `${card.speakerId}:${card.quote}`;
}

export function createDefaultCardPreferences(): CardPreferences {
  return {
    likedQuoteCardIds: [],
    selectedQuoteCardIds: [],
    includeActionCard: true,
    myLine: "",
    includeMyLine: true,
    layout: "long"
  };
}

/**
 * 合并持久化偏好与当前卡片。只保留仍然存在于当前卡片中的 id，
 * 其余字段回退到默认；空选择保持空选择，不做任何代选。
 */
export function restoreCardPreferences(
  stored: Partial<CardPreferences> | undefined,
  cards: QuoteCard[]
): CardPreferences {
  const defaults = createDefaultCardPreferences();
  if (!stored) return defaults;
  const validIds = new Set(cards.map(quoteCardId));
  return {
    likedQuoteCardIds: (stored.likedQuoteCardIds ?? []).filter((id) => validIds.has(id)),
    selectedQuoteCardIds: (stored.selectedQuoteCardIds ?? []).filter((id) => validIds.has(id)),
    includeActionCard: stored.includeActionCard ?? defaults.includeActionCard,
    myLine: stored.myLine ?? defaults.myLine,
    includeMyLine: stored.includeMyLine ?? defaults.includeMyLine,
    layout: stored.layout ?? defaults.layout
  };
}

/** 切换某个 id 的开关状态；只作用于传入的那一份列表，不触碰其他状态。 */
export function toggleCardId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

/** 组合只包含用户明确选择过的金句卡；空选择返回空数组，绝不代选。 */
export function selectedQuoteCardsFor(
  preferences: Pick<CardPreferences, "selectedQuoteCardIds">,
  cards: QuoteCard[]
): QuoteCard[] {
  const selected = new Set(preferences.selectedQuoteCardIds);
  return cards.filter((card) => selected.has(quoteCardId(card)));
}

/** 组合保存的可用条件：至少有一项用户明确要保留的内容。 */
export function canComposeComposite(
  preferences: Pick<CardPreferences, "includeActionCard" | "myLine" | "includeMyLine">,
  selectedQuoteCount: number
) {
  return (
    preferences.includeActionCard ||
    selectedQuoteCount > 0 ||
    Boolean(preferences.includeMyLine && preferences.myLine.trim())
  );
}
