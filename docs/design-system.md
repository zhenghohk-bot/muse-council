# 设计系统

这个项目没有引第三方组件库。视觉一致性靠一套集中在 `app/globals.css` `:root` 里的设计 token 维护——**改 token = 改全站**。组件里不写颜色/字体/圆角的字面量，一律走 `var(--*)`。

这么做的理由：产品的差异化在于「不像模板」，通用组件库的默认长相会稀释它。手写 + 自建 token，既拿到一致性，又保住 bespoke 的气质。

## Token 一览（`app/globals.css`）

### 颜色
| Token | 值 | 用途 |
| --- | --- | --- |
| `--ink` | `#121310` | 主文字（近黑） |
| `--muted` | `#626760` | 次要文字（灰绿） |
| `--line` | `rgba(28,26,24,0.1)` | 发丝边框 |
| `--paper` / `--cream` | `#f8f8f4` / `#efeee8` | 米白底 |
| `--rose` | `#765f59` | 玫瑰木强调（eyebrow / 来源注释） |
| `--moss` | `#6d786a` | 苔绿强调 |
| `--sage` | `#dce2da` | 浅鼠尾草 |
| `--panel` / `--panel-strong` | `rgba(250,250,246,0.76 / 0.94)` | 面板 / 卡片底 |
| `--bg-gradient` | `linear-gradient(135deg,#f8f8f4,#f1f2ec,#e7ede7)` | 全站背景 |

### 字体
| Token | 用途 |
| --- | --- |
| `--font-serif` | 正文 / 标题（`Songti SC` / `Noto Serif SC` 链） |
| `--font-sans` | 标签 / eyebrow / 小字 |

### 字号
| Token | 值 | 用途 |
| --- | --- | --- |
| `--text-label` | `0.78rem` | eyebrow / 标签 / 小字（高频，已收敛） |

其余标题字号仍按需在组件里写（多为一次性 `clamp()`），未强行 token 化——过度收敛反而降低可读性。

### 圆角
| Token | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | `8px` | 小卡格 |
| `--radius-md` | `10px` | 卡片默认 |
| `--radius-lg` | `12px` | 大面板 |
| `--radius-pill` | `999px` | 胶囊按钮 / 标签 |

装饰性一次性圆角（如 hero 的 `52px 52px 44px 44px`）保留字面量，不进 scale。

### 间距
`--space-1`…`--space-8`（`4 / 8 / 10 / 14 / 18 / 22 / 28 / 34 px`）——描述现有高频值，供**新写**样式使用。存量间距未做全局 retrofit（`18px` 等值同时出现在 padding 与 shadow 中，盲替风险大于收益）。

### 高程 / 动效
`--shadow`、`--ease-out`。

## ⚠️ 分享图的同步点

`app/card/ShareCard.tsx` 用 `html-to-image` 把 DOM 导出成 PNG，**导出时读不到 CSS 变量**，所以它顶部有一组内联常量 `T`（`ink/muted/rose/bg/serif/sans`）镜像上面的 token。

**改了 `:root` 的颜色或字体，必须同步 `ShareCard.tsx` 的 `T`**，否则分享图不会跟着变。文件里已有醒目注释标注这一点。这是整套系统里唯一不能自动联动的地方。

## 加/改视觉的成本速查

- **换整套配色 / 字体**：改 `:root` 一处 + 同步 `ShareCard.tsx` 的 `T`。最省事。
- **加先行者头像**：数据集中在 `data/pioneers.ts`（`avatar` / `color` 字段）；渲染在 `roundtable/page.tsx`、`choose/page.tsx`。把 `<span>{avatar}</span>` 换成 `<img>` 即可。
- **改按钮 / 卡片 / 气泡**：类名清晰的 vanilla CSS，直接改。
- **圆桌座位环**（`roundtable/page.tsx` 的 `seat-layer`）：`seat-0`…`seat-4` 逐位绝对定位，调布局 / 移动端自适应成本最高，需单独处理。
