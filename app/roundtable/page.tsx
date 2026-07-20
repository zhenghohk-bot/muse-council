"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionCard, ApiEnvelope, ConversationPlan, DiscussionPlan, PioneerProfile, QuoteCard, RoundtableMessage, RoundtableSession, SourceNote, ThemeAnalysis } from "@/lib/types";
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
  discussionPlan?: DiscussionPlan;
};

const harnessSteps = ["读题", "入席", "回应", "讨论", "收束", "行动"];

// 按在席人数把先行者均匀铺在圆桌四周的椭圆弧上：从左上(190°)扫过正上方到右上(-10°)，
// 共 200° 张开角，两侧端点接近桌心水平线（略偏下），底部留足空间给「当前发言」气泡。
// 椭圆中心贴着桌心(cy≈48%)、半径收得比桌子略大，让头像紧挨桌沿；3/4/5 人都对称分布。
function seatPosition(index: number, total: number) {
  const cx = 50;
  const cy = 48;
  const rx = 25;
  const ry = 21;
  const start = 190;
  const sweep = 200;
  const angle = total <= 1 ? 90 : start - (index * sweep) / (total - 1);
  const rad = (angle * Math.PI) / 180;
  const x = cx + rx * Math.cos(rad);
  const y = cy - ry * Math.sin(rad);
  return {
    left: `${x}%`,
    top: `${y}%`,
    transform: "translate(-50%, -50%)"
  };
}

// 每句发言在圆桌里停留多久：按字数估算中文阅读时间，短句也保底 2.4s，长句最多 9s，
// 让用户来得及读完当前这句，再让下一位开口。
function readingTime(text?: string) {
  const chars = text?.length ?? 0;
  return Math.min(9000, Math.max(2400, chars * 85));
}

function messageSegments(message: RoundtableMessage) {
  const segments = message.segments?.map((segment) => segment.trim()).filter(Boolean);
  return segments?.length && segments.length <= 2 && segments.join("") === message.content
    ? segments
    : [message.content];
}

async function readEnvelope<T>(response: Response) {
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

function speakerName(message: RoundtableMessage, pioneers: PioneerProfile[]) {
  if (message.role === "moderator") return "主持人";
  if (message.role === "user") return "你";
  return pioneers.find((pioneer) => pioneer.id === message.speakerId)?.figure ?? "先行者";
}

function stageLabel(message: RoundtableMessage) {
  const labels: Partial<Record<RoundtableMessage["stage"], string>> = {
    opening: "主持人开场",
    first_round: "第一轮回应",
    discussion:
      message.discussionMode === "crossfire"
        ? "温和交锋"
        : message.discussionMode === "sequence"
          ? "逐层推进"
          : message.discussionMode === "complement"
            ? "共同完善"
            : "关键澄清",
    crossfire: "讨论",
    synthesis: "主持人收束",
    follow_up: "继续追问"
  };
  return labels[message.stage];
}

export default function RoundtablePage() {
  const router = useRouter();
  const [store, setStore] = useState<StoredRoundtable | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [followUp, setFollowUp] = useState("");
  const [activeSpeaker, setActiveSpeaker] = useState<string | undefined>();
  const [speed, setSpeed] = useState(1);
  const [visibleSegmentCounts, setVisibleSegmentCounts] = useState<Record<string, number>>({});
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const followUpRef = useRef<HTMLTextAreaElement | null>(null);
  const [dismissedClosePrompts, setDismissedClosePrompts] = useState<string[]>([]);
  // 当前这句发言的「阅读停留」等待句柄：点击圆桌框可提前结束，直接跳到下一位。
  const skipRef = useRef<(() => void) | null>(null);
  // 用 ref 存倍速，运行中的对话循环能立刻读到最新值（state 会被闭包捕获成旧值）。
  const speedRef = useRef(1);

  function changeSpeed(next: number) {
    speedRef.current = next;
    setSpeed(next);
  }

  // 一句发言的阅读停留：按字数估算时间再除以当前倍速；可被点击圆桌提前结束。
  function dwell(text?: string) {
    return waitOrSkip(readingTime(text) / speedRef.current);
  }

  // 可被打断的停留：到时间自动继续，或用户点击圆桌时立即继续（读得快的用户不用干等）。
  function waitOrSkip(ms: number) {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        skipRef.current = null;
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      skipRef.current = finish;
    });
  }

  // —— 生成 / 播放 分离（生产者-消费者）——
  // 后台「生成器」把先行者的发言一句句灌进缓冲区（不占用阅读时间），
  // 前台「播放器」按阅读节奏从缓冲区取一句显示；点击圆桌 = 让播放器立即取下一句。
  // 因为生成通常已跑在播放前面，所以点击几乎总能立刻亮出已备好的下一句。
  const bufferRef = useRef<Array<{ message: RoundtableMessage; sourceNotes: SourceNote[] }>>([]);
  const genDoneRef = useRef(false);
  const wakeRef = useRef<(() => void) | null>(null);

  function pushToBuffer(message: RoundtableMessage, sourceNotes: SourceNote[] = []) {
    bufferRef.current.push({ message, sourceNotes });
    wakeRef.current?.();
  }

  // 缓冲区为空时挂起播放器，等生成器灌入新内容（或宣告生成结束）再唤醒。
  function waitForBuffer() {
    return new Promise<void>((resolve) => {
      wakeRef.current = resolve;
    });
  }

  // 点击圆桌框：正在阅读停留时立即跳到下一句（下一句多半已在缓冲区里备好）。
  function advanceSpeaker() {
    skipRef.current?.();
  }

  // 只更新 session（不动 messages）——生成器边生成边把最新 session 存回 store 以便持久化。
  function updateSession(session: RoundtableSession) {
    setStore((current) => (current ? { ...current, session } : current));
  }

  function updateConversationPlan(conversationPlan: ConversationPlan) {
    setStore((current) => (current ? { ...current, conversationPlan } : current));
  }

  const selectedPioneers = useMemo(() => {
    if (!store) return [];
    return store.pioneers.filter((pioneer) => store.selectedPioneerIds.includes(pioneer.id));
  }, [store]);

  useEffect(() => {
    const saved = window.localStorage.getItem("muse-council:last-roundtable");
    if (!saved) {
      router.replace("/ask");
      return;
    }
    const parsed = JSON.parse(saved) as StoredRoundtable;
    setStore(parsed);
    setActiveSpeaker(parsed.selectedPioneerIds[0]);
  }, [router]);

  useEffect(() => {
    if (store?.session) {
      window.localStorage.setItem("muse-council:last-roundtable", JSON.stringify(store));
    }
  }, [store]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [store?.messages.length, visibleSegmentCounts]);


  async function callApi<T>(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readEnvelope<T>(response);
  }

  function mergeMessages(messages: RoundtableMessage[], sourceNotes: SourceNote[] = []) {
    setStore((current) => {
      if (!current) return current;
      const noteMap = { ...current.sourceNotes };
      sourceNotes.forEach((note) => {
        noteMap[note.id] = note;
      });
      return {
        ...current,
        messages: [...current.messages, ...messages],
        sourceNotes: noteMap
      };
    });
  }

  async function revealMessage(message: RoundtableMessage, sourceNotes: SourceNote[] = []) {
    const segments = messageSegments(message);
    setVisibleSegmentCounts((current) => ({ ...current, [message.id]: 1 }));
    mergeMessages([message], sourceNotes);
    for (let index = 0; index < segments.length; index += 1) {
      if (index > 0) {
        setVisibleSegmentCounts((current) => ({ ...current, [message.id]: index + 1 }));
      }
      await dwell(segments[index]);
    }
  }

  // 后台生成器：尽快把 开场 → 逐位发言 → 交锋 都生成好、灌进缓冲区，不占用阅读时间。
  async function generateConversation(session: RoundtableSession, selectedPioneerIds: string[]) {
    const generatedMessages: RoundtableMessage[] = [];
    try {
      const opening = await callApi<{
        session: RoundtableSession;
        message: RoundtableMessage;
        conversationPlan: ConversationPlan;
        planUsedFallback: boolean;
      }>("/api/roundtable/opening", {
        session,
        selectedPioneerIds
      });
      let activeSession = opening.data.session;
      updateSession(activeSession);
      updateConversationPlan(opening.data.conversationPlan);
      pushToBuffer(opening.data.message);
      generatedMessages.push(opening.data.message);

      const assignments = opening.data.conversationPlan.assignments.length
        ? opening.data.conversationPlan.assignments
        : activeSession.selectedPioneerIds.map((pioneerId) => ({ pioneerId, assignment: undefined }));
      for (const item of assignments) {
        const pioneerId = item.pioneerId;
        const assignment = "speechAct" in item ? item : item.assignment;
        const speech = await callApi<{ session: RoundtableSession; message: RoundtableMessage; sourceNotes: SourceNote[] }>(
          "/api/roundtable/speak",
          { session: activeSession, pioneerId, messages: generatedMessages, assignment, analysis: store?.analysis }
        );
        activeSession = speech.data.session;
        updateSession(activeSession);
        pushToBuffer(speech.data.message, speech.data.sourceNotes);
        generatedMessages.push(speech.data.message);
      }

      const discussion = await callApi<{
        session: RoundtableSession;
        discussionPlan: DiscussionPlan;
        messages: RoundtableMessage[];
      }>("/api/roundtable/crossfire", {
        session: activeSession,
        messages: generatedMessages
      });
      updateSession(discussion.data.session);
      setStore((current) => (current ? { ...current, discussionPlan: discussion.data.discussionPlan } : current));
      for (const message of discussion.data.messages) {
        pushToBuffer(message);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "圆桌生成失败，可以再试一次。");
    } finally {
      genDoneRef.current = true;
      wakeRef.current?.(); // 生成结束也要唤醒播放器，让它在放完缓冲后收尾
    }
  }

  // 前台播放器：按阅读节奏从缓冲区一句句取出显示；缓冲区空了就挂起等生成器灌入。
  // 点击圆桌 = 提前结束当前停留、立刻取下一句（下一句多半已在缓冲区备好）。
  async function playFromBuffer() {
    while (true) {
      if (bufferRef.current.length === 0) {
        if (genDoneRef.current) break; // 生成完 + 缓冲空 = 全部放完
        await waitForBuffer();
        continue;
      }
      const next = bufferRef.current.shift();
      if (!next) continue;
      if (next.message.role === "pioneer") setActiveSpeaker(next.message.speakerId);
      await revealMessage(next.message, next.sourceNotes);
    }
  }

  async function beginConversation() {
    if (!store?.session) return;
    setError(undefined);
    setStore((current) =>
      current
        ? { ...current, messages: [], actionCard: undefined, quoteCards: [], conversationPlan: undefined }
        : current
    );
    // 重置缓冲区与信号
    bufferRef.current = [];
    genDoneRef.current = false;
    wakeRef.current = null;
    setVisibleSegmentCounts({});
    setBusy("playing");

    try {
      // 生成器与播放器并行跑：生成通常跑在播放前面，所以点击几乎总能立刻拿到下一句。
      await Promise.all([
        generateConversation(store.session, store.selectedPioneerIds),
        playFromBuffer()
      ]);
    } finally {
      setBusy(undefined);
    }
  }

  async function submitFollowUp() {
    if (!store?.session || !activeSpeaker || !followUp.trim()) return;
    const askedId = activeSpeaker;
    const question = followUp;
    setBusy(`speak:${askedId}`);
    setError(undefined);
    setFollowUp("");
    try {
      const response = await callApi<{
        session: RoundtableSession;
        messages: RoundtableMessage[];
        sourceNotes: SourceNote[];
        retractedMessageIds: string[];
      }>(
        "/api/roundtable/follow-up",
        { session: store.session, pioneerId: askedId, followUp: question, messages: store.messages }
      );
      setActiveSpeaker(askedId);
      setStore((current) => {
        if (!current) return current;
        const retracted = new Set(response.data.retractedMessageIds);
        return {
          ...current,
          session: response.data.session,
          messages: current.messages.map((message) =>
            retracted.has(message.id)
              ? { ...message, status: "retracted", retractedReason: "用户指出该前提并非来自原话" }
              : message
          )
        };
      });
      const userMessage = response.data.messages.find((message) => message.role === "user");
      if (userMessage) mergeMessages([userMessage]);
      for (const reply of response.data.messages.filter((message) => message.role !== "user")) {
        setActiveSpeaker(reply.role === "pioneer" ? reply.speakerId : askedId);
        await revealMessage(reply, response.data.sourceNotes);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "追问失败。");
    } finally {
      setBusy(undefined);
    }
  }

  async function finalize() {
    if (!store?.session) return;
    setBusy("finalize");
    setError(undefined);
    try {
      const envelope = await callApi<{ session: RoundtableSession; actionCard: ActionCard; quoteCards: QuoteCard[] }>(
        "/api/roundtable/finalize",
        { session: store.session, messages: store.messages }
      );
      const nextStore = {
        ...store,
        session: envelope.data.session,
        actionCard: envelope.data.actionCard,
        quoteCards: envelope.data.quoteCards
      };
      window.localStorage.setItem("muse-council:last-roundtable", JSON.stringify(nextStore));
      setStore(nextStore);
      router.push("/card");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "行动卡生成失败。");
    } finally {
      setBusy(undefined);
    }
  }

  const currentStepIndex = store?.actionCard
    ? 5
    : store?.messages.some((message) => message.stage === "synthesis")
      ? 4
      : store?.messages.some((message) => message.stage === "discussion" || message.stage === "crossfire")
        ? 3
        : store?.messages.some((message) => message.stage === "first_round")
          ? 2
          : store?.messages.length
            ? 1
            : 0;

  if (!store?.session) return null;

  const latestMessage = store.messages.at(-1);
  const latestSegments = latestMessage ? messageSegments(latestMessage) : [];
  const latestVisibleCount = latestMessage
    ? visibleSegmentCounts[latestMessage.id] ?? latestSegments.length
    : 0;
  const latestVisibleSegment = latestSegments.slice(0, latestVisibleCount).at(-1);
  const latestSpeaker = latestMessage
    ? selectedPioneers.find((pioneer) => pioneer.id === latestMessage.speakerId)
    : undefined;

  return (
    <main className="roundtable-shell">
      <nav className="site-nav roundtable-nav" aria-label="主导航">
        <Link href="/choose" className="ghost-button">
          调整先行者
        </Link>
        <span>{store.analysis?.theme ?? "圆桌"}</span>
        <Link href="/" className="brand-mark">
          她们会怎么想？
        </Link>
      </nav>

      <section className="harness-rail" aria-label="圆桌导演流程">
        {harnessSteps.map((step, index) => (
          <span key={step} className={index <= currentStepIndex ? "is-active" : ""}>
            {step}
          </span>
        ))}
      </section>

      <section
        className={`roundtable-room${busy === "playing" || busy?.startsWith("speak:") ? " is-advanceable" : ""}`}
        aria-label="沉浸式圆桌"
        onClick={advanceSpeaker}
      >
        <div className="room-question">
          <p className="quiet-kicker">YOUR QUESTION</p>
          <h1>{store.question}</h1>
        </div>

        <div className="round-table" aria-hidden="true">
          <div className="table-ring" />
          <div className="table-core">Roundtable</div>
        </div>

        <div className="seat-layer">
          {selectedPioneers.map((pioneer, index) => {
            return (
              <article
                key={pioneer.id}
                className={`seat-card${activeSpeaker === pioneer.id ? " is-active" : ""}`}
                style={{ "--speaker-color": pioneer.color, ...seatPosition(index, selectedPioneers.length) } as React.CSSProperties}
              >
                <button type="button" className="round-portrait" onClick={() => setActiveSpeaker(pioneer.id)}>
                  <PioneerAvatar pioneerId={pioneer.id} fallback={pioneer.avatar} name={pioneer.figure} />
                </button>
                <div className="seat-name">
                  <strong>{pioneer.figure}</strong>
                  <small>{pioneer.archetype}</small>
                </div>
              </article>
            );
          })}
        </div>

        {latestMessage ? (
          <div
            className={`room-stage ${latestMessage.role}-stage`}
            style={{ "--speaker-color": latestSpeaker?.color ?? "#6d786a" } as React.CSSProperties}
          >
            {latestMessage.role !== "moderator" ? (
              <div className="room-stage-avatar" aria-hidden="true">
                <PioneerAvatar
                  pioneerId={latestMessage.role === "pioneer" ? latestSpeaker?.id : undefined}
                  fallback={latestMessage.role === "user" ? "你" : latestSpeaker?.avatar ?? ""}
                  name={latestSpeaker?.figure}
                />
              </div>
            ) : null}
            <div className="room-stage-bubble">
              <p className="room-stage-name">
                {speakerName(latestMessage, store.pioneers)}
                {busy === "playing" || busy?.startsWith("speak:") ? (
                  <span className="room-stage-dots" aria-hidden="true" />
                ) : null}
              </p>
              <p className="room-stage-text">{latestVisibleSegment}</p>
            </div>
          </div>
        ) : null}

        {busy === "playing" ? (
          <p className="room-advance-hint" aria-hidden="true">
            点圆桌任意处，看下一位 →
          </p>
        ) : null}
      </section>

      <section className="conversation-dock" aria-label="圆桌对话">
        <div className="section-heading split-heading">
          <div>
            <p className="quiet-kicker">LIVE CONVERSATION</p>
            <h2>圆桌正在说话</h2>
          </div>
          <div className="dock-controls">
            {store.messages.length > 0 ? (
              <div className="speed-toggle" role="group" aria-label="播放速度">
                {[1, 2].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={speed === option ? "is-active" : ""}
                    onClick={() => changeSpeed(option)}
                  >
                    {option}×
                  </button>
                ))}
              </div>
            ) : null}
            {store.messages.length === 0 ? (
              <button className="primary-button" type="button" onClick={beginConversation} disabled={Boolean(busy)}>
                {busy ? "她们正在入席..." : "请她们入席"}
              </button>
            ) : (
              <button className="ghost-button" type="button" onClick={finalize} disabled={Boolean(busy)}>
                {busy === "finalize" ? "生成中..." : "收束并生成行动卡"}
              </button>
            )}
          </div>
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="chat-stream">
          {store.messages.length === 0 ? (
            <div className="chat-empty">
              <p>先让她们入席。接下来每一句话都会按顺序浮现，你可以像旁听一场真实圆桌一样慢慢看。</p>
            </div>
          ) : null}
          {store.messages.map((message, index) => {
            const speaker = selectedPioneers.find((pioneer) => pioneer.id === message.speakerId);
            const previous = store.messages[index - 1];
            const showDivider = stageLabel(message) && previous?.stage !== message.stage;
            const segments = messageSegments(message);
            const visibleCount = visibleSegmentCounts[message.id] ?? segments.length;
            const visibleSegments = segments.slice(0, visibleCount);
            return (
              <div key={message.id}>
                {showDivider ? <p className="chat-stage-divider">{stageLabel(message)}</p> : null}
                <article
                  className={`chat-message ${message.role}-message${message.role === "user" ? " is-user" : ""}${message.status === "retracted" ? " is-retracted" : ""}`}
                  style={{ "--speaker-color": speaker?.color ?? "#6d786a" } as React.CSSProperties}
                >
                  <div className="chat-avatar" aria-hidden="true">
                    <PioneerAvatar
                      pioneerId={message.role === "pioneer" ? speaker?.id : undefined}
                      fallback={message.role === "moderator" ? "主" : message.role === "user" ? "你" : speaker?.avatar ?? ""}
                      name={speaker?.figure}
                    />
                  </div>
                  <div className="chat-bubble-stack">
                    {visibleSegments.map((segment, segmentIndex) => (
                      <div
                        className={`chat-bubble${segmentIndex > 0 ? " is-continuation" : ""}`}
                        key={`${message.id}:${segmentIndex}`}
                      >
                        {segmentIndex === 0 ? (
                          <header>
                            <strong>{speakerName(message, store.pioneers)}</strong>
                            {message.role === "pioneer" && speaker ? <span>{speaker.archetype}</span> : null}
                          </header>
                        ) : null}
                        <p>{message.status === "retracted" ? "这条发言已撤回。" : segment}</p>
                      </div>
                    ))}
                    {message.messageKind === "ready_to_close" && !dismissedClosePrompts.includes(message.id) ? (
                      <div className="close-prompt-actions">
                        <button className="primary-button" type="button" onClick={finalize} disabled={Boolean(busy)}>
                          生成行动卡
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => {
                            setDismissedClosePrompts((current) => [...current, message.id]);
                            window.setTimeout(() => followUpRef.current?.focus(), 0);
                          }}
                        >
                          继续聊
                        </button>
                      </div>
                    ) : null}
                  </div>
                </article>
              </div>
            );
          })}
          <div ref={chatEndRef} />
        </div>
      </section>

      <div className="roundtable-inputbar">
        <div className="speaker-tabs">
          {selectedPioneers.map((pioneer) => (
            <button
              type="button"
              key={pioneer.id}
              className={activeSpeaker === pioneer.id ? "is-active" : ""}
              onClick={() => setActiveSpeaker(pioneer.id)}
            >
              {pioneer.figure}
            </button>
          ))}
        </div>
        <textarea
          ref={followUpRef}
          rows={2}
          value={followUp}
          onChange={(event) => setFollowUp(event.target.value)}
          placeholder="继续说出你的困惑，或选择一位先行者追问。"
        />
        <button className="primary-button" type="button" onClick={submitFollowUp} disabled={Boolean(busy)}>
          发送
        </button>
      </div>
    </main>
  );
}
