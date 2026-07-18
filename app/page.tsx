import Link from "next/link";

const salonSteps = [
  {
    title: "写下问题",
    body: "把一件难以开口的事交给主持人。"
  },
  {
    title: "邀请先行者",
    body: "选择 3 到 5 位古今女性入席。"
  },
  {
    title: "入席谈话",
    body: "她们按顺序回应、交锋、收束。"
  },
  {
    title: "收成行动卡",
    body: "把讨论落成今天就能开始的动作。"
  }
];

export default function HomePage() {
  return (
    <main className="site-shell landing-shell">
      <nav className="site-nav" aria-label="主导航">
        <Link href="/" className="brand-mark">
          她们会怎么想？
        </Link>
        <Link href="/ask" className="ghost-button">
          开始
        </Link>
      </nav>

      <section className="landing-hero" aria-labelledby="page-title">
        <div className="landing-copy">
          <p className="quiet-kicker">AI ROUNDTABLE HARNESS</p>
          <h1 id="page-title">把一件难以开口的事，放进一间有光的圆桌。</h1>
          <p className="subtitle">
            写下你的困惑，邀请古今女性先行者从不同人生经验里回应你。她们不替你决定，而是帮你看清问题、整理心绪，找到下一步。
          </p>
          <div className="landing-actions">
            <Link href="/ask" className="primary-link">
              进入圆桌
            </Link>
            <span>约 3 分钟完成第一轮谈话</span>
          </div>
        </div>

        <div className="hero-visual landing-visual" aria-label="女性先行者圆桌视觉">
          <img src="/assets/hero-women-roundtable-lineart.png" alt="古今女性先行者围坐在圆桌旁讨论" />
          <div className="visual-caption">
            <p>Ask the council</p>
            <strong>听见不同的女性经验，再做自己的选择</strong>
          </div>
        </div>
      </section>

      <section className="salon-program" aria-label="产品流程">
        <div className="program-heading">
          <p className="quiet-kicker">SALON PROGRAM</p>
          <h2>一场圆桌，从提问到行动。</h2>
        </div>
        <ol className="program-line">
          {salonSteps.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
