"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, Grid2X2, Heart, List, Square, Sparkles } from "lucide-react";
import type {
  ActionCard,
  CardPreferences,
  PioneerProfile,
  QuoteCard,
  RoundtableMessage,
  RoundtableSession,
  SourceNote,
  ThemeAnalysis
} from "@/lib/types";
import { ActionShareCard, CompositeShareCard, MyLineShareCard, QuoteShareCard } from "./ShareCard";
import { PioneerAvatar } from "@/components/PioneerAvatar";

type StoredRoundtable = {
  question: string;
  session?: RoundtableSession;
  analysis?: ThemeAnalysis;
  pioneers: PioneerProfile[];
  messages: RoundtableMessage[];
  sourceNotes: Record<string, SourceNote>;
  selectedPioneerIds: string[];
  actionCard?: ActionCard;
  quoteCards?: QuoteCard[];
  cardPreferences?: CardPreferences;
};

function quoteCardId(card: QuoteCard) {
  return `${card.speakerId}:${card.quote}`;
}

function defaultPreferences(cards: QuoteCard[]): CardPreferences {
  return {
    likedQuoteCardIds: [],
    selectedQuoteCardIds: cards.slice(0, 2).map(quoteCardId),
    includeActionCard: true,
    myLine: "",
    includeMyLine: true,
    layout: "long"
  };
}

export default function CardPage() {
  const router = useRouter();
  const [store, setStore] = useState<StoredRoundtable | undefined>();

  useEffect(() => {
    const saved = window.localStorage.getItem("muse-council:last-roundtable");
    if (!saved) {
      router.replace("/ask");
      return;
    }
    const parsed = JSON.parse(saved) as StoredRoundtable;
    if (!parsed.actionCard) {
      router.replace("/roundtable");
      return;
    }
    const defaults = defaultPreferences(parsed.quoteCards ?? []);
    setStore({
      ...parsed,
      cardPreferences: { ...defaults, ...parsed.cardPreferences }
    });
  }, [router]);

  function updatePreferences(next: Partial<CardPreferences>) {
    setStore((current) => {
      if (!current) return current;
      const preferences = {
        ...defaultPreferences(current.quoteCards ?? []),
        ...current.cardPreferences,
        ...next
      };
      const updated = { ...current, cardPreferences: preferences };
      window.localStorage.setItem("muse-council:last-roundtable", JSON.stringify(updated));
      return updated;
    });
  }

  const selectedQuoteCards = useMemo(() => {
    if (!store?.cardPreferences) return [];
    const selected = new Set(store.cardPreferences.selectedQuoteCardIds);
    return (store.quoteCards ?? []).filter((card) => selected.has(quoteCardId(card)));
  }, [store]);

  if (!store?.actionCard || !store.cardPreferences) return null;

  const synthesis = store.messages.filter((message) => message.stage === "synthesis").at(-1);
  const preferences = store.cardPreferences;
  const liked = new Set(preferences.likedQuoteCardIds);
  const selected = new Set(preferences.selectedQuoteCardIds);
  const combinedMyLine = preferences.includeMyLine ? preferences.myLine.trim() : "";

  function toggleQuote(card: QuoteCard, key: "likedQuoteCardIds" | "selectedQuoteCardIds") {
    const id = quoteCardId(card);
    const values = new Set(preferences[key]);
    if (values.has(id)) values.delete(id);
    else values.add(id);
    updatePreferences({ [key]: [...values] });
  }

  return (
    <main className="site-shell card-shell">
      <nav className="site-nav" aria-label="主导航">
        <Link href="/roundtable" className="ghost-button">
          回到圆桌
        </Link>
        <span>圆桌收成</span>
        <Link href="/" className="brand-mark">
          她们会怎么想？
        </Link>
      </nav>

      <section className="card-hero" aria-labelledby="card-title">
        <p className="quiet-kicker">AFTER THE ROUNDTABLE</p>
        <h1 id="card-title">把谈话留下，也把下一步带走。</h1>
        {synthesis ? <p>{synthesis.content}</p> : null}
      </section>

      <section className="action-card final-action">
        <div className="section-heading split-heading">
          <div>
            <p className="quiet-kicker">ACTION</p>
            <h2>先从这一小步开始</h2>
          </div>
          <ActionShareCard actionCard={store.actionCard} question={store.question} />
        </div>
        <div className="action-grid">
          {store.actionCard.chosenPath ? (
            <section>
              <span>本轮选择</span>
              <p>{store.actionCard.chosenPath}</p>
            </section>
          ) : null}
          <section>
            <span>24 小时内</span>
            <p>{store.actionCard.within24h}</p>
          </section>
          <section>
            <span>7 天实验</span>
            <p>{store.actionCard.sevenDayExperiment}</p>
          </section>
          <section>
            <span>30 天练习</span>
            <p>{store.actionCard.thirtyDayPractice}</p>
          </section>
          {store.actionCard.guardrail ? (
            <section>
              <span>行动护栏</span>
              <p>{store.actionCard.guardrail}</p>
            </section>
          ) : null}
          <section>
            <span>复盘证据</span>
            <p>{store.actionCard.evidenceToReview}</p>
          </section>
        </div>
      </section>

      {store.quoteCards?.length ? (
        <section className="quote-wall final-quotes">
          <div className="section-heading split-heading">
            <div>
              <p className="quiet-kicker">NOTES FOR YOU</p>
              <h2>她们为你留下的赠言</h2>
              <p className="section-intro">每一句都提炼自她在本场圆桌中的判断；历史回声只来自核验过的原作。</p>
            </div>
            <span className="selection-count">已选 {selectedQuoteCards.length} 句加入组合</span>
          </div>
          <div className="quote-grid gift-grid">
            {store.quoteCards.map((quoteCard) => {
              const id = quoteCardId(quoteCard);
              const speaker = store.pioneers.find((pioneer) => pioneer.id === quoteCard.speakerId);
              const isLiked = liked.has(id);
              const isSelected = selected.has(id);
              return (
                <article key={id} className={isSelected ? "is-selected" : ""}>
                  <div className="gift-card-head">
                    <div className="quote-byline">
                      <span className="quote-avatar" aria-hidden="true">
                        <PioneerAvatar pioneerId={speaker?.id} fallback={speaker?.avatar ?? ""} name={speaker?.figure} />
                      </span>
                      <div>
                        {speaker ? <strong>{speaker.figure}</strong> : null}
                        <small>{speaker?.archetype}</small>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`icon-button like-button${isLiked ? " is-active" : ""}`}
                      aria-label={isLiked ? "取消喜欢这句赠言" : "喜欢这句赠言"}
                      aria-pressed={isLiked}
                      title={isLiked ? "取消喜欢" : "喜欢"}
                      onClick={() => toggleQuote(quoteCard, "likedQuoteCardIds")}
                    >
                      <Heart size={18} fill={isLiked ? "currentColor" : "none"} aria-hidden="true" />
                    </button>
                  </div>
                  <span className="gift-label">本场赠言</span>
                  <blockquote>{quoteCard.quote}</blockquote>
                  <p>{quoteCard.context}</p>
                  {quoteCard.historicalEcho ? (
                    <div className="historical-echo">
                      <span>历史回声</span>
                      <blockquote>
                        {quoteCard.historicalEcho.translatedText ?? quoteCard.historicalEcho.originalText}
                      </blockquote>
                      {quoteCard.historicalEcho.translatedText ? <p>{quoteCard.historicalEcho.originalText}</p> : null}
                      <a href={quoteCard.historicalEcho.sourceUrl} target="_blank" rel="noreferrer">
                        {quoteCard.historicalEcho.work}
                        {quoteCard.historicalEcho.locator ? ` · ${quoteCard.historicalEcho.locator}` : ""}
                      </a>
                    </div>
                  ) : null}
                  <div className="quote-foot gift-actions">
                    <button
                      type="button"
                      className={`ghost-button selection-button${isSelected ? " is-active" : ""}`}
                      aria-pressed={isSelected}
                      onClick={() => toggleQuote(quoteCard, "selectedQuoteCardIds")}
                    >
                      {isSelected ? <Check size={15} aria-hidden="true" /> : <Square size={15} aria-hidden="true" />}
                      {isSelected ? "已加入组合" : "加入组合"}
                    </button>
                    <QuoteShareCard
                      quote={quoteCard}
                      speakerName={speaker?.figure}
                      speakerArchetype={speaker?.archetype}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="my-line-section">
        <div>
          <p className="quiet-kicker">MY WORDS</p>
          <h2>圆桌之后，我想留下这一句</h2>
          <p>可以是一句决定、一条提醒，或此刻终于说清的话。它不会改写行动卡。</p>
        </div>
        <div className="my-line-editor">
          <textarea
            rows={3}
            maxLength={80}
            value={preferences.myLine}
            onChange={(event) => updatePreferences({ myLine: event.target.value })}
            placeholder="例如：我可以温柔，也可以保留自己的边界。"
          />
          <div>
            <span>{preferences.myLine.length}/80</span>
            <MyLineShareCard myLine={preferences.myLine} question={store.question} />
          </div>
        </div>
      </section>

      <section className="card-composer">
        <div className="composer-copy">
          <p className="quiet-kicker">MAKE YOUR CARD</p>
          <h2>把喜欢的内容拼成一张</h2>
          <p>行动卡、先行者金句和“我的一句”彼此独立；这里只决定它们如何一起出现。</p>
        </div>
        <div className="composer-controls">
          <label className="check-control">
            <input
              type="checkbox"
              checked={preferences.includeActionCard}
              onChange={(event) => updatePreferences({ includeActionCard: event.target.checked })}
            />
            <span>行动卡</span>
          </label>
          {preferences.myLine.trim() ? (
            <label className="check-control">
              <input
                type="checkbox"
                checked={preferences.includeMyLine}
                onChange={(event) => updatePreferences({ includeMyLine: event.target.checked })}
              />
              <span>我的一句</span>
            </label>
          ) : null}
          <div className="layout-toggle" role="group" aria-label="组合卡版式">
            <button
              type="button"
              className={preferences.layout === "long" ? "is-active" : ""}
              onClick={() => updatePreferences({ layout: "long" })}
            >
              <List size={16} aria-hidden="true" />
              纵向长图
            </button>
            <button
              type="button"
              className={preferences.layout === "collage" ? "is-active" : ""}
              onClick={() => updatePreferences({ layout: "collage" })}
            >
              <Grid2X2 size={16} aria-hidden="true" />
              拼贴海报
            </button>
          </div>
        </div>
        <div className="composer-summary">
          <Sparkles size={18} aria-hidden="true" />
          <span>
            {preferences.includeActionCard ? "行动卡" : ""}
            {preferences.includeActionCard && selectedQuoteCards.length ? " + " : ""}
            {selectedQuoteCards.length ? `${selectedQuoteCards.length} 句先行者赠言` : ""}
            {(preferences.includeActionCard || selectedQuoteCards.length) && combinedMyLine ? " + " : ""}
            {combinedMyLine ? "我的一句" : ""}
          </span>
          <CompositeShareCard
            actionCard={store.actionCard}
            question={store.question}
            quoteCards={selectedQuoteCards}
            speakers={store.pioneers.map(({ id, figure, archetype }) => ({ id, figure, archetype }))}
            myLine={combinedMyLine}
            includeActionCard={preferences.includeActionCard}
            layout={preferences.layout}
          />
        </div>
      </section>
    </main>
  );
}
