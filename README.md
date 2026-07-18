# 她们会怎么想？— AI 女性先行者圆桌

**MVP v0.1.0** · Roundtable Harness + 9 Pioneer Voice Profiles + Dual-model Evaluation

> 写下你的困惑，邀请古今女性先行者从不同人生经验里回应你。
> 她们不替你决定，而是帮你看清问题、整理心绪，找到下一步。

一个探索**可控多角色 LLM 编排**的 AI 产品 MVP。用户输入一个人生困惑，系统经「问题分析 → 角色推荐 → 分阶段圆桌对话 → 行动卡 + 金句卡」，把一段模糊的内耗，转化成一个今天就能开始的动作。

<!-- 建议在此放两张核心截图：圆桌页（seat-layer + 对话流）、行动卡页（action-card + 金句卡） -->
<!-- ![圆桌页](docs/roundtable.png) -->
<!-- ![行动卡](docs/action-card.png) -->

---

## 产品叙事

一场圆桌被拆成有秩序的几个阶段，用户像旁听一场真实的思想沙龙：

1. **提问**（`/ask`）— 写下一件难以开口的事，不必写得漂亮。
2. **问题分析** — 主持人先读懂困惑：命名主题、核心张力、被看见的情绪、真正的需要。
3. **角色推荐 / 选人**（`/choose`）— 系统按问题推荐 3 位先行者，用户可保留 3–5 位补足视角张力。
4. **分阶段圆桌**（`/roundtable`）—
   - 主持人**反映式开场**（先承接，不急着建议）
   - 每位先行者**第一轮发言**（第一人称，从各自价值系统看问题）
   - 两位先行者**温和交锋**（不是吵架，是价值张力）+ 主持人收束
   - 用户可**继续追问**某位先行者
5. **收成**（`/card`）— 生成**行动卡**（24 小时 / 7 天 / 30 天 / 复盘证据）与**金句卡**，可一键导出竖版分享图。

---

## AI 架构：把 LLM 关进结构里

这个项目的核心不是「调一次大模型」，而是一套**确定性编排 + LLM 生成**的可控管线。开放式 LLM 负责内容表达，可控层负责路由、阶段与安全边界，让产出稳定、可信、不越界。

| 模块 | 职责 | 实现 |
| --- | --- | --- |
| **Director** (`lib/harness/director.ts`) | 问题分析、阶段调度、交锋配对 | LLM 主路分析问题并从名册中选角，失败时降级到关键词规则；阶段顺序与配对为确定性逻辑 |
| **StageGenerator** (`lib/harness/stage-generator.ts`) | 逐阶段生成开场 / 发言 / 交锋 / 追问 / 行动卡 | 每阶段一次独立 LLM 调用，用 **JSON Schema 引导 + 应用层字段校验** 约束输出，附本地 fallback 文案 |
| **SourceRetriever** (`lib/harness/source-retriever.ts`) | 为每位先行者按问题召回来源注释 | 从角色卡的 `sourceNotes` 里选取最相关的片段，喂给生成 prompt |
| **OutputGuard** (`lib/harness/output-guard.ts`) | 合规与语气兜底 | 校验第一人称、拦截越界表述 |
| **PioneerProfile** (`data/pioneers.ts`) | 9 位古今女性的结构化角色卡 | 核心价值 / 决策方式 / 温和推回 / 练习方向 / 来源注释 |

**为什么这样设计**：

- **可控性** — 阶段调度和安全边界用规则控制，而非寄望模型每次都听话。LLM 只在每个被框定的阶段里生成一小段结构化内容。
- **可靠降级** — 每次 LLM 调用都有 fallback（Director 降级到规则分析，StageGenerator 降级到本地文案），缺 API key 也能完整演示整条流程。
- **对抗人物同质化** — 角色扮演产品的通病是「所有角色都在说同一套鸡汤」。结构化角色卡 + 差异化 prompt，让武则天谈筹码、伍尔夫谈精神空间、奥斯汀谈关系结构，视角各异。

---

## 设计思考

这个产品不是从「做个 AI 聊天」出发，而是从用户心理和角色扮演的研究方法倒推的：

- [产品创作原则](docs/product-notes.md) — 目标用户的心理、榜样人物的使用边界、视觉与语气方向。
- [榜样圆桌研究笔记](docs/research-notes.md) — 参考 RoleLLM / ChatHaruhi / CHARMAP 等角色扮演论文，以及动机式访谈（Motivational Interviewing）的对话结构，推导出角色卡格式与分阶段输出设计。

## 负责任 AI 边界

- **不宣称真人本人在说话** — 使用已进入公版语境的历史人物，定位为「某种视角 / 气质 / 能力模型」，而非人物复刻或传记原文引用。
- **不做心理治疗承诺** — 产品定位为自我反思与成长工具，不提供诊断、医学 / 法律 / 投资建议；输出层对越界表述做兜底拦截。
- **人物尊重** — 古代女性不是装饰素材，角色卡呈现她们的处境、限制、才华、选择与代价。

---

## 本地运行

```bash
npm install
cp .env.example .env.local   # 填入 OPENAI_API_KEY（可选，缺失时自动降级到规则版）
npm run dev                  # http://localhost:3000
```

环境变量（见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | LLM key。缺失时全流程自动降级到规则分析 + 本地文案，仍可完整演示 |
| `OPENAI_MODEL` | 生成模型，默认 `gpt-4.1-mini`；接火山方舟时填 `deepseek-v4-pro` 等 |
| `OPENAI_BASE_URL` | 兼容网关地址，默认 OpenAI；接火山方舟（Ark）改为其 `/api/v3` 端点 |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 可选，用于会话与卡片持久化 |

模型接入走 **OpenAI Chat-Completions 兼容协议**，因此除 OpenAI 外，也可无改码接入火山方舟上的 DeepSeek / Qwen 等国产模型——只需切换 `OPENAI_BASE_URL` + `OPENAI_MODEL` + key。全站中文场景下，DeepSeek-V4 系列在人物语气区分度与情感细腻度上表现更好。

---

## 技术栈

- **Next.js 15**（App Router）+ **React 19** + **TypeScript**
- **OpenAI Chat-Completions 兼容协议**（JSON 结构化输出 + 应用层 schema 校验；可接 OpenAI / 火山方舟 DeepSeek 等）
- **html-to-image**（金句卡 / 行动卡竖版分享图，纯前端导出）
- **Supabase**（可选持久化）
- **自建设计 token 体系**（不引第三方组件库，视觉一致性靠 `:root` token 集中维护）——见 [设计系统](docs/design-system.md)

---

## 对话质量评测

评测使用生成模型完成圆桌，再由独立裁判模型从读题、人物区分、贴题性、语言清晰、安全、行动卡、金句卡七个维度评分。运行过程串行执行、每次请求最多重试一次；生成结束后会先保存 prepared JSON，裁判网络失败时不需要重新生成整场圆桌。

```bash
npm run eval -- --smoke
npm run eval -- --case career-side-hustle
npm run eval -- --full
npm run eval -- --judge-file eval-results/<run-id>/<case-id>.prepared.json
npm run check:harness
```

裁判模型使用独立配置：

| 变量 | 说明 |
| --- | --- |
| `EVAL_API_KEY` | 裁判模型 key |
| `EVAL_BASE_URL` | 裁判模型 Chat-Completions 端点或 base URL |
| `EVAL_JUDGE_MODEL` | 裁判模型 ID |

报告输出至 `eval-results/<run-id>/report.md` 和 `report.json`。当前两题 smoke 评测摘要见 [`eval-results/smoke-2026-07-18.md`](eval-results/smoke-2026-07-18.md)。

---

## 目录结构

```
app/
  ask/          提问页
  choose/       选人页
  roundtable/   沉浸式圆桌页
  card/         行动卡 + 金句卡 + 分享图
  api/roundtable/  分阶段成接口（start / opening / speak / crossfire / follow-up / finalize）
lib/harness/    Director / StageGenerator / SourceRetriever / OutputGuard / OpenAI 客户端
data/pioneers.ts  9 位先行者角色卡
scripts/         固定问题集 / 双模型评测 runner / 独立裁判客户端
```
