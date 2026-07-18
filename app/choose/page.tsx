"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ActionCard, ConversationPlan, PioneerProfile, QuoteCard, RoundtableMessage, RoundtableSession, SourceNote, ThemeAnalysis } from "@/lib/types";
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
  conversationPlan?: ConversationPlan;
};

export default function ChoosePage() {
  const router = useRouter();
  const [store, setStore] = useState<StoredRoundtable | undefined>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    const saved = window.localStorage.getItem("muse-council:last-roundtable");
    if (!saved) {
      router.replace("/ask");
      return;
    }
    const parsed = JSON.parse(saved) as StoredRoundtable;
    setStore(parsed);
    setSelectedIds(parsed.selectedPioneerIds ?? parsed.session?.selectedPioneerIds ?? []);
  }, [router]);

  function persist(nextIds: string[]) {
    if (!store) return;
    const nextStore = {
      ...store,
      messages: [],
      actionCard: undefined,
      quoteCards: [],
      conversationPlan: undefined,
      selectedPioneerIds: nextIds,
      session: store.session ? { ...store.session, selectedPioneerIds: nextIds } : store.session
    };
    setStore(nextStore);
    window.localStorage.setItem("muse-council:last-roundtable", JSON.stringify(nextStore));
  }

  function toggle(id: string) {
    setSelectedIds((current) => {
      const next = current.includes(id)
        ? current.length <= 3
          ? current
          : current.filter((item) => item !== id)
        : current.length >= 5
          ? current
          : [...current, id];
      persist(next);
      return next;
    });
  }

  function enterRoundtable() {
    persist(selectedIds);
    router.push("/roundtable");
  }

  if (!store) return null;

  const selectedNames = store.pioneers
    .filter((pioneer) => selectedIds.includes(pioneer.id))
    .map((pioneer) => pioneer.figure)
    .join("、");

  return (
    <main className="site-shell choose-shell">
      <nav className="site-nav" aria-label="主导航">
        <Link href="/ask" className="ghost-button">
          修改问题
        </Link>
        <span>选择先行者</span>
        <Link href="/" className="brand-mark">
          她们会怎么想？
        </Link>
      </nav>

      <section className="council-brief" aria-labelledby="choose-title">
        <div>
          <p className="quiet-kicker">HOST READS</p>
          <h1 id="choose-title">{store.analysis?.theme ?? "这是一场需要多种视角的谈话"}</h1>
          <p>{store.analysis?.emotion}</p>
        </div>
        <aside>
          <span>你的问题</span>
          <strong>{store.question}</strong>
          <p>{store.analysis?.tension}</p>
        </aside>
      </section>

      <section className="council-stage" aria-label="邀请先行者">
        <div className="stage-copy">
          <p className="quiet-kicker">INVITE THE COUNCIL</p>
          <h2>保留 3 位核心声音，也可以再请 1-2 位补足张力。</h2>
        </div>
        <div className="orbit-selection">
          {store.pioneers.map((pioneer, index) => (
            <button
              key={pioneer.id}
              type="button"
              className={`orbit-person orbit-person-${index}${selectedIds.includes(pioneer.id) ? " is-selected" : ""}`}
              style={{ "--speaker-color": pioneer.color } as React.CSSProperties}
              onClick={() => toggle(pioneer.id)}
            >
              <span className="portrait-head" aria-hidden="true">
                <PioneerAvatar pioneerId={pioneer.id} fallback={pioneer.avatar} name={pioneer.figure} />
              </span>
              <strong>{pioneer.figure}</strong>
              <small>{pioneer.archetype}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="sticky-next">
        <div>
          <strong>即将入席</strong>
          <span>{selectedNames}</span>
        </div>
        <button className="primary-button" type="button" onClick={enterRoundtable}>
          推开圆桌的门
        </button>
      </div>
    </main>
  );
}
