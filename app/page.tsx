import Link from "next/link";

const salonSteps = [
  {
    title: "写下一句话",
    body: "不必完整，也不必先想清楚。"
  },
  {
    title: "请她们入席",
    body: "从九位古今女性先行者中发出邀请。"
  },
  {
    title: "听她们谈谈",
    body: "她们回应、补充，也可能彼此不同意。"
  },
  {
    title: "带走喜欢的部分",
    body: "留下赠言、行动，或一个新的念头。"
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
          <p className="quiet-kicker">A ROUNDTABLE ACROSS TIME</p>
          <h1 id="page-title">与她们坐一桌，聊聊你在想的事</h1>
          <p className="subtitle">
            从李清照、简・奥斯汀到阿达・洛夫莱斯，选择 3–5 位女性先行者入席。她们从各自的作品、经历与思维方式出发，回应彼此，也回应你。
          </p>
          <div className="landing-actions">
            <Link href="/ask" className="primary-link">
              发起圆桌
            </Link>
            <span>写下问题，再邀请她们入席</span>
          </div>
        </div>

        <div className="hero-visual landing-visual" aria-label="女性先行者圆桌视觉">
          <img src="/assets/hero-women-roundtable-lineart.png" alt="古今女性先行者围坐在圆桌旁讨论" />
          <div className="visual-caption">
            <p>Ask the council</p>
            <strong>同一件事，她们会从哪里说起？</strong>
          </div>
        </div>
      </section>

      <section className="salon-program" aria-label="产品流程">
        <div className="program-heading">
          <p className="quiet-kicker">SALON PROGRAM</p>
          <h2>一场圆桌，慢慢展开。</h2>
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
