"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApiEnvelope, PioneerProfile, RoundtableMessage, RoundtableSession, SourceNote, ThemeAnalysis } from "@/lib/types";

type StartPayload = {
  session: RoundtableSession;
  analysis: ThemeAnalysis;
  pioneers: PioneerProfile[];
};

type StoredRoundtable = {
  question: string;
  session?: RoundtableSession;
  analysis?: ThemeAnalysis;
  pioneers: PioneerProfile[];
  messages: RoundtableMessage[];
  sourceNotes: Record<string, SourceNote>;
  selectedPioneerIds: string[];
};

const prompts = [
  {
    label: "想改变，又怕只是一时冲动",
    text: "我心里一直有个想改变的念头——换个方向、开始一件事，可我总怀疑自己是不是只有三分钟热度，怕刚开了头又坚持不下来。"
  },
  {
    label: "不知道自己到底想要什么",
    text: "外人看我好像什么都不缺，可一旦安静下来问自己到底想要什么，心里却是一片空，说不上来，也不太敢深想。"
  },
  {
    label: "总在照顾别人，先亏待自己",
    text: "我习惯先照顾别人的感受，把自己的需要往后放，等真的轮到自己，又常常一句“算了”就过去了。时间久了，有点累，也有点委屈。"
  }
];

async function readEnvelope<T>(response: Response) {
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

export default function AskPage() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function start() {
    if (!question.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/roundtable/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question })
      });
      const envelope = await readEnvelope<StartPayload>(response);
      const store: StoredRoundtable = {
        question,
        session: envelope.data.session,
        analysis: envelope.data.analysis,
        pioneers: envelope.data.pioneers,
        messages: [],
        sourceNotes: {},
        selectedPioneerIds: envelope.data.analysis.recommendedPioneerIds
      };
      window.localStorage.setItem("muse-council:last-roundtable", JSON.stringify(store));
      router.push("/choose");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "分析失败，请再试一次。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="site-shell ask-shell">
      <nav className="site-nav" aria-label="主导航">
        <Link href="/" className="brand-mark">
          她们会怎么想？
        </Link>
        <span>提问</span>
      </nav>

      <section className="ask-stage" aria-labelledby="ask-title">
        <div className="ask-copy">
          <p className="quiet-kicker">THE FIRST QUESTION</p>
          <h1 id="ask-title">先把问题写下来，不必写得漂亮。</h1>
          <p className="subtitle">你可以写一个选择、一段关系、一个正在酝酿的副业，或一句说不清的内耗。主持人会先读懂它，再为你安排入席的人。</p>
        </div>

        <div className="ask-console">
          <label className="question-box">
            <span>此刻最需要被看见的问题</span>
            <textarea
              rows={6}
              maxLength={260}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：我想辞职做自由职业，但又很害怕不稳定，怎么办？"
            />
          </label>
          <div className="quick-prompts">
            {prompts.map((prompt) => (
              <button type="button" key={prompt.label} onClick={() => setQuestion(prompt.text)}>
                <span>{prompt.label}</span>
              </button>
            ))}
          </div>
          <button className="primary-button" type="button" onClick={start} disabled={busy}>
            {busy ? "主持人正在读..." : "交给主持人"}
          </button>
          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </section>
    </main>
  );
}
