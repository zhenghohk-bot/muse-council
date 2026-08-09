"use client";

import { useRef, useState } from "react";
import { toPng } from "html-to-image";
import { Download } from "lucide-react";
import type { ActionCard, QuoteCard } from "@/lib/types";

/* ⚠️ 设计 token 同步点
   下面这组常量是 app/globals.css :root token 的镜像。分享图用 html-to-image
   导出，导出时读不到 CSS 变量，所以必须内联。改了 globals.css 的颜色/字体，
   请同步这里，否则导出的分享图不会跟着变。对应关系：
   INK=--ink  MUTED=--muted  ROSE=--rose  BG=--bg-gradient
   SERIF=--font-serif  SANS=--font-sans */
const T = {
  ink: "#121310",
  muted: "#626760",
  rose: "#765f59",
  bg: "linear-gradient(135deg, #f8f8f4 0%, #f1f2ec 58%, #e7ede7 100%)",
  serif: 'ui-serif, "Songti SC", "Noto Serif SC", Georgia, serif',
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
};
const BRAND = "她们会怎么想？";

// 离屏包裹层：把待导出节点移出视口。定位只放在【包裹层】上，
// 被截的节点(CANVAS)本身必须是中性定位——否则 html-to-image 克隆时会连
// left:-99999px 一起复制，把内容推到画布外，导出就成了一片空白。
// width/height:0 + overflow:hidden：让里面 1440px 高的画布不计入页面滚动高度，
// 否则绝对定位的离屏节点会把文档撑高，页面底部凭空多出一大段可滚的空白。
const OFFSCREEN: React.CSSProperties = {
  position: "absolute",
  left: "-99999px",
  top: 0,
  width: 0,
  height: 0,
  overflow: "hidden",
  pointerEvents: "none"
};

// 3:4 竖版为下限，内容长了就往下增高（用 minHeight 而非固定 height），
// 避免行动卡文字多时被固定画布裁掉。导出时也不锁死 height，让它抓完整高度。
const CANVAS: React.CSSProperties = {
  position: "relative",
  width: 1080,
  minHeight: 1440,
  boxSizing: "border-box",
  padding: "96px 88px",
  display: "flex",
  flexDirection: "column",
  background: T.bg,
  color: T.ink,
  fontFamily: T.serif
};

const KICKER: React.CSSProperties = {
  fontFamily: T.sans,
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: 0,
  textTransform: "uppercase",
  color: T.rose
};

const WATERMARK: React.CSSProperties = {
  marginTop: "auto",
  // 保底上间距：内容满时 marginTop:auto 会被压到 0，靠 paddingTop 撑开与正文的距离，
  // 不至于紧贴最后一格；内容短时 auto 仍把水印推到画布底部。
  paddingTop: 56,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontFamily: T.sans,
  fontSize: 26,
  color: T.muted
};

function useExport() {
  const [busy, setBusy] = useState(false);
  async function exportNode(node: HTMLElement | null, filename: string) {
    if (!node || busy) return;
    setBusy(true);
    try {
      // 按节点实际高度导出（内容长了会超过 1440），不写死 height 否则会裁掉超出部分。
      const height = Math.max(1440, Math.ceil(node.scrollHeight));
      const options = { pixelRatio: 2, cacheBust: true, width: 1080, height };
      // 等中文衬线字体加载完再截，否则会截到「字体还没就绪」的空白帧。
      if (document.fonts?.ready) await document.fonts.ready;
      // 预热一次：html-to-image 首帧常因图片/样式未 inline 完而产出空白，
      // 丢弃第一帧、用第二帧作为最终结果，稳定得多。
      await toPng(node, options);
      const dataUrl = await toPng(node, options);
      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();
    } finally {
      setBusy(false);
    }
  }
  return { busy, exportNode };
}

function stamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function QuoteShareCard({
  quote,
  speakerName,
  speakerArchetype
}: {
  quote: QuoteCard;
  speakerName?: string;
  speakerArchetype?: string;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const { busy, exportNode } = useExport();
  // 用普通 <img> 指向源肖像；不能用 Next <Image>（它渲染成 /_next/image 优化 URL，
  // html-to-image 无法内联，导出会缺图）。crossOrigin 同源留空即可。
  const portraitSrc = quote.speakerId ? `/portraits/${quote.speakerId}.png` : undefined;

  return (
    <>
      <button
        type="button"
        className="ghost-button share-button"
        disabled={busy}
        onClick={() => exportNode(nodeRef.current, `muse-council-金句-${stamp()}.png`)}
      >
        <Download size={15} aria-hidden="true" />
        {busy ? "生成中..." : "保存金句卡"}
      </button>

      <div style={OFFSCREEN} aria-hidden="true">
      <div ref={nodeRef} style={CANVAS}>
        <p style={KICKER}>A NOTE FOR YOU</p>
        {/* 正文块 flex:1 + 居中：金句短时把多余留白均分到上下，不再在中间留一个大洞 */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <blockquote
          style={{
            margin: 0,
            fontSize: 68,
            lineHeight: 1.35,
            fontWeight: 500,
            textWrap: "balance"
          }}
        >
          {quote.quote}
        </blockquote>
        <p style={{ marginTop: 44, fontSize: 30, lineHeight: 1.7, color: T.muted }}>{quote.context}</p>
        {quote.historicalEcho ? (
          <div
            style={{
              marginTop: 42,
              paddingTop: 30,
              borderTop: "1px solid rgba(28, 26, 24, 0.14)"
            }}
          >
            <span style={{ ...KICKER, fontSize: 20 }}>HISTORICAL ECHO</span>
            <p style={{ margin: "16px 0 0", fontSize: 31, lineHeight: 1.55 }}>
              {quote.historicalEcho.translatedText ?? quote.historicalEcho.originalText}
            </p>
            {quote.historicalEcho.translatedText ? (
              <p style={{ margin: "12px 0 0", fontFamily: T.sans, fontSize: 22, lineHeight: 1.55, color: T.muted }}>
                {quote.historicalEcho.originalText}
              </p>
            ) : null}
            <p style={{ margin: "12px 0 0", fontFamily: T.sans, fontSize: 21, color: T.muted }}>
              {quote.historicalEcho.work}{quote.historicalEcho.locator ? ` · ${quote.historicalEcho.locator}` : ""}
            </p>
          </div>
        ) : null}
        {portraitSrc ? (
          <div style={{ marginTop: 48, display: "flex", alignItems: "center", gap: 22 }}>
            <img
              src={portraitSrc}
              alt={speakerName ?? ""}
              width={96}
              height={96}
              style={{
                width: 96,
                height: 96,
                borderRadius: "50%",
                objectFit: "cover",
                border: `2px solid ${T.rose}`
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {speakerName ? (
                <span style={{ fontFamily: T.serif, fontSize: 36, color: T.ink }}>{speakerName}</span>
              ) : null}
              {speakerArchetype ? (
                <span style={{ fontFamily: T.sans, fontSize: 24, color: T.muted }}>{speakerArchetype}</span>
              ) : null}
            </div>
          </div>
        ) : null}
        </div>
        <div style={WATERMARK}>
          <span style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, fontWeight: 600 }}>{BRAND}</span>
          <span>听见不同的视角，做自己的选择</span>
        </div>
      </div>
      </div>
    </>
  );
}

type ActionTextKey =
  | "chosenPath"
  | "within24h"
  | "sevenDayExperiment"
  | "thirtyDayPractice"
  | "guardrail"
  | "evidenceToReview";

const ACTION_ROWS: Array<{ key: ActionTextKey; label: string; en: string }> = [
  { key: "chosenPath", label: "本轮练习路径", en: "PRACTICE PATH" },
  { key: "within24h", label: "24 小时内", en: "TODAY" },
  { key: "sevenDayExperiment", label: "7 天实验", en: "7 DAYS" },
  { key: "thirtyDayPractice", label: "30 天练习", en: "30 DAYS" },
  { key: "guardrail", label: "行动护栏", en: "GUARDRAIL" },
  { key: "evidenceToReview", label: "复盘证据", en: "REVIEW" }
];

export function ActionShareCard({ actionCard, question }: { actionCard: ActionCard; question?: string }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const { busy, exportNode } = useExport();

  return (
    <>
      <button
        type="button"
        className="primary-button share-button"
        disabled={busy}
        onClick={() => exportNode(nodeRef.current, `muse-council-行动卡-${stamp()}.png`)}
      >
        <Download size={15} aria-hidden="true" />
        {busy ? "生成中..." : "保存行动卡"}
      </button>

      <div style={OFFSCREEN} aria-hidden="true">
      <div ref={nodeRef} style={CANVAS}>
        <p style={KICKER}>ACTION CARD</p>
        {question ? (
          <p style={{ margin: "40px 0 0", fontSize: 40, lineHeight: 1.4, fontWeight: 500, textWrap: "balance" }}>
            {question}
          </p>
        ) : null}
        <div style={{ marginTop: 56, display: "flex", flexDirection: "column", gap: 28 }}>
          {ACTION_ROWS.filter((row) => Boolean(actionCard[row.key])).map((row) => (
            <div
              key={row.key}
              style={{
                padding: "26px 30px",
                border: "1px solid rgba(28, 26, 24, 0.12)",
                borderRadius: 16,
                background: "rgba(255, 252, 247, 0.66)"
              }}
            >
              <span style={{ fontFamily: T.sans, fontSize: 24, fontWeight: 800, letterSpacing: "0.06em" }}>
                {row.label}
              </span>
              <p style={{ margin: "12px 0 0", fontSize: 30, lineHeight: 1.6, color: "#3a3a34" }}>
                {actionCard[row.key]}
              </p>
            </div>
          ))}
        </div>
        <div style={WATERMARK}>
          <span style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, fontWeight: 600 }}>{BRAND}</span>
          <span>听见不同的视角，做自己的选择</span>
        </div>
      </div>
      </div>
    </>
  );
}

export function MyLineShareCard({ myLine, question }: { myLine: string; question?: string }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const { busy, exportNode } = useExport();

  return (
    <>
      <button
        type="button"
        className="ghost-button share-button"
        disabled={busy || !myLine.trim()}
        onClick={() => exportNode(nodeRef.current, `muse-council-我的一句-${stamp()}.png`)}
      >
        <Download size={15} aria-hidden="true" />
        {busy ? "生成中..." : "单独保存"}
      </button>
      <div style={OFFSCREEN} aria-hidden="true">
        <div ref={nodeRef} style={CANVAS}>
          <p style={KICKER}>MY WORDS</p>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            {question ? <p style={{ margin: 0, fontFamily: T.sans, fontSize: 25, lineHeight: 1.6, color: T.muted }}>{question}</p> : null}
            <blockquote style={{ margin: "46px 0 0", fontSize: 68, lineHeight: 1.4, fontWeight: 500 }}>
              {myLine}
            </blockquote>
            <p style={{ margin: "34px 0 0", fontFamily: T.sans, fontSize: 24, color: T.muted }}>圆桌之后，我想留下这一句。</p>
          </div>
          <div style={WATERMARK}>
            <span style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, fontWeight: 600 }}>{BRAND}</span>
            <span>听见不同的视角，做自己的选择</span>
          </div>
        </div>
      </div>
    </>
  );
}

type CompositeSpeaker = { id: string; figure: string; archetype: string };

export function CompositeShareCard({
  actionCard,
  question,
  quoteCards,
  speakers,
  myLine,
  includeActionCard
}: {
  actionCard: ActionCard;
  question: string;
  quoteCards: QuoteCard[];
  speakers: CompositeSpeaker[];
  myLine: string;
  includeActionCard: boolean;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const { busy, exportNode } = useExport();
  const hasContent = includeActionCard || quoteCards.length > 0 || Boolean(myLine.trim());

  return (
    <>
      <button
        type="button"
        className="primary-button share-button"
        disabled={busy || !hasContent}
        onClick={() => exportNode(nodeRef.current, `muse-council-圆桌收成-${stamp()}.png`)}
      >
        <Download size={16} aria-hidden="true" />
        {busy ? "生成中..." : "保存组合卡"}
      </button>
      <div style={OFFSCREEN} aria-hidden="true">
        <div ref={nodeRef} style={CANVAS}>
          <p style={KICKER}>AFTER THE ROUNDTABLE</p>
          <p style={{ margin: "34px 0 0", fontSize: 38, lineHeight: 1.45, fontWeight: 500 }}>{question}</p>
          <div
            style={{
              marginTop: 48,
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 22
            }}
          >
            {includeActionCard ? (
              <section
                style={{
                  padding: 34,
                  border: "1px solid rgba(28, 26, 24, 0.13)",
                  borderRadius: 16,
                  background: "rgba(255, 252, 247, 0.72)"
                }}
              >
                <span style={{ ...KICKER, fontSize: 20 }}>ACTION</span>
                <p style={{ margin: "18px 0 0", fontSize: 29, lineHeight: 1.55 }}>{actionCard.within24h}</p>
                <p style={{ margin: "14px 0 0", fontFamily: T.sans, fontSize: 22, lineHeight: 1.55, color: T.muted }}>
                  7 天：{actionCard.sevenDayExperiment}
                </p>
              </section>
            ) : null}
            {quoteCards.map((card) => {
              const speaker = speakers.find((item) => item.id === card.speakerId);
              return (
                <section
                  key={`${card.speakerId}-${card.quote}`}
                  style={{
                    padding: 30,
                    border: "1px solid rgba(28, 26, 24, 0.13)",
                    borderRadius: 16,
                    background: "rgba(255, 252, 247, 0.66)"
                  }}
                >
                  <span style={{ fontFamily: T.sans, fontSize: 21, color: T.rose }}>{speaker?.figure ?? "先行者"}</span>
                  <blockquote style={{ margin: "16px 0 0", fontSize: 38, lineHeight: 1.5 }}>
                    {card.quote}
                  </blockquote>
                  {card.historicalEcho ? (
                    <p style={{ margin: "22px 0 0", paddingTop: 18, borderTop: "1px solid rgba(28, 26, 24, 0.1)", fontSize: 21, lineHeight: 1.55, color: T.muted }}>
                      历史回声：{card.historicalEcho.translatedText ?? card.historicalEcho.originalText}
                      <br />— {card.historicalEcho.work}
                    </p>
                  ) : null}
                </section>
              );
            })}
            {myLine.trim() ? (
              <section
                style={{
                  padding: 34,
                  borderTop: `3px solid ${T.rose}`,
                  background: "rgba(255, 252, 247, 0.52)"
                }}
              >
                <span style={{ ...KICKER, fontSize: 20 }}>MY WORDS</span>
                <p style={{ margin: "16px 0 0", fontSize: 38, lineHeight: 1.5 }}>{myLine}</p>
              </section>
            ) : null}
          </div>
          <div style={WATERMARK}>
            <span style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, fontWeight: 600 }}>{BRAND}</span>
            <span>听见不同的视角，做自己的选择</span>
          </div>
        </div>
      </div>
    </>
  );
}
