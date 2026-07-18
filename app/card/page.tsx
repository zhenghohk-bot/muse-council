"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ActionCard, PioneerProfile, QuoteCard, RoundtableMessage, RoundtableSession, SourceNote, ThemeAnalysis } from "@/lib/types";
import { ActionShareCard, QuoteShareCard } from "./ShareCard";
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
};

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
    setStore(parsed);
  }, [router]);

  if (!store?.actionCard) return null;

  const synthesis = store.messages.filter((message) => message.stage === "synthesis").at(-1);

  return (
    <main className="site-shell card-shell">
      <nav className="site-nav" aria-label="主导航">
        <Link href="/roundtable" className="ghost-button">
          回到圆桌
        </Link>
        <span>行动卡</span>
        <Link href="/" className="brand-mark">
          她们会怎么想？
        </Link>
      </nav>

      <section className="card-hero" aria-labelledby="card-title">
        <p className="quiet-kicker">CLOSING NOTE</p>
        <h1 id="card-title">这场谈话，先收成一个可以开始的动作。</h1>
        {synthesis ? <p>{synthesis.content}</p> : null}
      </section>

      <section className="action-card final-action">
        <div className="action-grid">
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
          <section>
            <span>复盘证据</span>
            <p>{store.actionCard.evidenceToReview}</p>
          </section>
        </div>
        <div className="share-row">
          <ActionShareCard actionCard={store.actionCard} question={store.question} />
        </div>
      </section>

      {store.quoteCards?.length ? (
        <section className="quote-wall final-quotes">
          <p className="quiet-kicker">QUOTES</p>
          <h2>先行者留下的几句话</h2>
          <div className="quote-grid">
            {store.quoteCards.map((quoteCard) => {
              const speaker = store.pioneers.find((pioneer) => pioneer.id === quoteCard.speakerId);
              return (
                <article key={`${quoteCard.speakerId}-${quoteCard.quote}`}>
                  <blockquote>{quoteCard.quote}</blockquote>
                  <p>{quoteCard.context}</p>
                  <div className="quote-foot">
                    <div className="quote-byline">
                      <span className="quote-avatar" aria-hidden="true">
                        <PioneerAvatar pioneerId={speaker?.id} fallback={speaker?.avatar ?? ""} name={speaker?.figure} />
                      </span>
                      {speaker ? <strong>{speaker.figure}</strong> : null}
                    </div>
                    <div className="share-row">
                      <QuoteShareCard
                        quote={quoteCard}
                        speakerName={speaker?.figure}
                        speakerArchetype={speaker?.archetype}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </main>
  );
}
