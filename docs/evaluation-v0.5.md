# v0.5 Harness 质量评测与迭代记录

## 目标

验证「她们会怎么想？」不是一次性角色生成，而是能被检查和迭代的多角色对话产品。评测由生成模型完成整场圆桌，独立裁判模型从九个维度评分：读题、人物区分、谈话推进、重复控制、贴题、语言、安全、行动卡、金句卡。

固定题集覆盖副业选择、关系边界、家庭期待、自我价值、表达困境、原因不明的低落感、已命名情绪，以及用户纠正误读。

## Harness

```mermaid
flowchart LR
  A[用户问题] --> B[Director: 主题、张力、入席与任务]
  B --> C[ContextBuilder + SourceRetriever]
  C --> D[StageGenerator: 逐阶段发言]
  D --> E[OutputGuard: 安全、去重、承接、清晰度]
  E --> F[行动卡 / 本场赠言 / 历史回声]
  F --> G[独立裁判评测]
  G --> H[定位到具体 Harness 层后修复]
```

关键取舍：

- 不一次性生成整篇“圆桌报告”，而是开场、逐人发言、讨论、追问、收束分别生成。
- 不强制温和交锋；Director 可选择递进、澄清、互补或跳过。
- 历史回声来自核验过的 curated 资料库；模型不凭记忆现场编名言。
- 行动卡沿一条主线展开，赠言绑定同一位先行者的本场真实发言。

## 基线

基线全量运行：`2026-07-20T17-16-11-630Z`，平均 `85`，MVP `4/8`，无 fallback、无硬性失败。裁判模型为 GLM-5.2（火山方舟部署 `glm-5-2-260617`）。

## 定位到的系统性问题与修复

基线报告暴露三类系统性问题，逐条定位到具体 Harness 层：

| 问题 | 定位 | 修复 |
| --- | --- | --- |
| 金句卡脱离本场：退回通用格言，或不同人物退回同一句兜底（如 probe-heavy 场景伍尔夫与奥斯汀赠言一字不差） | `renderClosingCard` / `sourceDerivedClosingQuote` / `matchHistoricalEcho` | 兜底提炼优先从该人物**自己**的本场贡献重新压缩（天然区分）；通用格言仅作最后 fallback；新增 `dedupeClosingQuotes` 跨卡去重，撞车时改用该人物唯一的收束语；历史回声要求 ≥1 个具体标签命中，宽泛标签不再单独触发 |
| 行动型发言直接跳到建议，不承接前文 | `assignedTurnIssues` / repair prompt | 对 `offer_one_step` 增加软校验 `actionAcknowledgesContext`：先承接或推进前文的具体判断，再给动作；不足时触发 repair 重试；不做机械复述要求 |
| 感受承认型（`name_emotion`）复述主持人读题分析 | `pioneerSpeech` / `assignedTurnIssues` | 把读题摘要（tension/emotion/need）传入发言生成与校验；`name_emotion` 除与其他人物比对外，也检测与 ThemeAnalysis 文本的重合；人物差异靠语气、观察角度、承接方式和下一步体现 |

在这一版基础上又发现并修复了一个由上述改动间接放大的回归：

| 问题 | 定位 | 修复 |
| --- | --- | --- |
| 同一人物在 first_round 与 follow_up 两轮都掉进确定性兜底 → 两轮发言**逐字完全相同**（relationship-boundary 场景奥斯汀，导致该题从 89 掉到 73） | `hasHardTurnIssue` / `followUp` 兜底路径 | ① 把新加的 `contributionIsVisibleInContent`（正文与元数据相似度 0.18）从**硬失败降为软失败**——它仍触发 repair，但即使未修好也保留真实模型输出，不再丢进兜底；② 新增 `dedupeFollowUpFallback`：follow_up 兜底若与本人前一轮高度相似，改用一句真正承接追问的替代内容 |

问题根因诊断依据：给评测运行器临时加日志，打印 `pioneerSpeech`/`followUp` 中静默的 `usedGuardRepair` 与 `guardIssues`（这些字段原本不落盘）。实测确认奥斯汀掉兜底的直接原因是 `contributionIsVisibleInContent` 被判硬失败，而非最初推测的“开场概念重复”。诊断日志在提交前已移除。

## 脱离裁判的结构性验证

以下验证不依赖裁判分数，可复现：

- **无逐字复读**：扫描最终全量运行的全部 8 份 prepared JSON，任一人物在同一场内没有两条 `content` 完全相同。上一轮 73 分的根因（奥斯汀两轮一字不差）消除。
- **guard-repair 降软生效**：`"正文没有落实 deliveredContribution"` 在运行日志中标记为 `[GUARD-SOFT]` 而非 `[GUARD-FALLBACK]`，即保留了模型真实输出。
- `npm run check:harness` 与 `npx tsc --noEmit` 通过。

## 裁判模型迁移（重要：影响可比性）

基线与前几轮对比使用火山方舟的 `glm-5-2-260617`。该账号免费额度耗尽后（返回 `429 SetLimitExceeded`），裁判迁移到**智谱官网**的 `glm-5.2`（`https://open.bigmodel.cn/api/paas/v4`）。

- 两者是**同一模型家族（GLM-5.2）**，但一个是带日期快照的火山部署、一个是智谱官方端点，是否解析到同一份权重无法确认。
- 因此：**跨裁判的绝对通过数与分数不能直接比较**。基线的 `4/8` 在火山尺子上，下方修复后全量的 `3/8` 在智谱尺子上，二者不是同一把尺子量出的。
- 该评测本身有已观测到的真实方差：relationship-boundary 在几乎相同条件下曾走出 89 → 73 → 88 的波动（约 ±15 分）。单次运行的通过数应视为一个样本，而非稳态。

## 全量结果（智谱裁判，修复版）

运行：`2026-07-21T09-45-44-932Z`，裁判 `glm-5.2`（智谱官网）。

- 平均分：`84`
- MVP：`3/8`（career-side-hustle、relationship-boundary、named-emotion-shame）
- 高质量目标：`0/8`

| 场景 | 结果 | 备注 |
| --- | ---: | --- |
| career-side-hustle | 86 通过 | |
| relationship-boundary | 88 通过 | 上一轮 73 的逐字复读已修复 |
| named-emotion-shame | 86 通过 | |
| family-expectations | 86 未通过 | 某核心维度低于门槛 |
| self-worth-comparison | 84 未通过 | 落在方差区间 |
| probe-heavy-mornings | 85 未通过 | 金句仍受 unknown_cause 确定性兜底限制 |
| expression-visibility | 75 未通过 | 李清照/伍尔夫意象趋同、假交锋（既有人物同质化问题，非本轮改动所致） |
| correction-recovery | 85 未通过 | 本轮生成阶段 discussion 随机降级（DeepSeek fallback，未改动该路径） |

这是一个应保留在作品集中的诚实结论：三个交办问题与 73 分回归已在代码层修复并通过结构性验证；但把多角色质量稳定到可重复的高质量水平，仍是尚未达成的目标，且评测尺子的迁移让本轮绝对分数无法与基线直接对齐。

## 已知边界与下一轮优先级

1. **同尺子 before/after 对比（待补）**：为在智谱 `glm-5.2` 上取得干净的修复前/后对比，需用基线代码（提交 `fde7885`）在智谱裁判下重跑一次全量。这是恢复可比性的唯一办法，但受方差限制，仍应标注为单样本。
2. **稳定性评测**：每题至少重复 3 次，报告均值、方差和硬性失败率，而非用单次运行代表模型能力。
3. **人物同质化**：expression-visibility 暴露的李清照/伍尔夫意象趋同、假交锋，是比金句兜底更深的结构问题，需要在 Director 任务分配层拉开人物姿态。
4. **unknown_cause 金句天花板**：该模式下卡片整段走确定性兜底以守安全边界，金句只能从元数据派生，无法真正“从本场发言提炼”。若要提升，需让金句走模型生成并保留 `findUnknownCauseIssues` 安全兜底——是有安全回归风险的改动，未在本轮实施。
5. **正文与元数据一致性**：将 `newContribution` 变为可验证的正文锚点，而非仅依赖相似度阈值。

## 复现

```bash
npm run check:harness
npm run eval -- --case self-worth-comparison
npm run eval -- --full
```

裁判模型通过 `.env.local` 的 `EVAL_API_KEY` / `EVAL_BASE_URL` / `EVAL_JUDGE_MODEL` 配置；切换裁判端点会改变判分尺子，跨尺子结果不可直接比较。原始运行结果位于本地 `eval-results/<run-id>/report.md`；该目录不提交，避免将大量模型输出和用户问题样本纳入仓库历史。
