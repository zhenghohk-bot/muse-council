# 榜样圆桌研究笔记

## 我们要解决的问题

当前原型的问题不是 UI，而是“圆桌感”不够强：

- 角色只是观点分类，不像真正的女性榜样参与。
- 输出像泛建议，缺少心理引导里的承接、追问、反思和行动落地。
- 名人信息没有形成“人格档案 + 代表记忆 + 说话方式 + 能力模型”。

产品方向应该从“给建议”升级为：

> 用户提出人生问题，系统用不同女性榜样的能力模型和思想脉络，帮助她反思、辨认矛盾、形成下一步行动。

## 关键论文与项目

### 1. RoleLLM / RoleBench

论文：RoleLLM: Benchmarking, Eliciting, and Enhancing Role-Playing Abilities of Large Language Models

链接：https://arxiv.org/abs/2310.00746

GitHub：https://github.com/InteractiveNLP-Team/RoleLLM-public

有用点：

- 不是只写“请扮演某某”，而是先构建 role profile。
- 再从长文本中抽取角色知识和情境记忆。
- 再生成角色特定问答/指令数据。
- 再用角色 prompt 或微调提升 roleplay 稳定性。

对我们的启发：

- 每位女性榜样需要一张结构化角色卡。
- 角色卡不能只有一句“她很自律”，要包含生平处境、核心价值、决策方式、语言风格、典型冲突。

### 2. ChatHaruhi

论文：ChatHaruhi: Reviving Anime Character in Reality via Large Language Model

链接：https://arxiv.org/abs/2308.09597

GitHub：https://github.com/LC1332/Chat-Haruhi-Suzumiya

有用点：

- 使用角色文本/台词/剧情记忆做检索，而不是只靠 system prompt。
- 支持从 HuggingFace 或本地 jsonl 加载角色数据库。
- 项目强调角色知识库、embedding 检索和 prompt 结合。

对我们的启发：

- “名人分身”不应只靠 prompt。
- 我们可以为每位榜样建立一个小型 memory bank：事实、作品、处境、选择、代表性观念。
- 用户提问后，每位榜样先检索 2-3 条相关记忆，再发言。

### 3. Two Tales of Persona in LLMs

论文：Two Tales of Persona in LLMs: A Survey of Role-Playing and Personalization

链接：https://arxiv.org/abs/2406.01171

GitHub：https://github.com/MiuLab/PersonaLLM-Survey

有用点：

- 区分两条线：LLM Role-Playing 和 LLM Personalization。
- Role-playing 是让模型适配角色；personalization 是让模型适配用户。

对我们的启发：

- 我们的产品同时需要两层：
  - 榜样 persona：她们从什么视角说话。
  - 用户 persona：用户当前处境、目标、犹豫和行动能力。
- 真正高级的体验不是“榜样表演”，而是“榜样视角适配用户问题”。

### 4. Character is Destiny / CHARMAP

论文：Character is Destiny: Can Role-Playing Language Agents Make Persona-Driven Decisions?

链接：https://arxiv.org/abs/2404.12138

有用点：

- 角色扮演不只是语气模仿，还要做 persona-driven decision。
- 论文提出基于 persona memory retrieval 的 CHARMAP 方法。

对我们的启发：

- 每位榜样发言时要体现她会如何判断取舍，而不是只换一种口吻讲鸡汤。
- 输出结构应包含：她看见的矛盾、她优先保护的价值、她反对的做法、她建议的练习。

### 5. Motivational Interviewing / Reflective Listening

动机式访谈综述与 LLM 相关论文：

- Generation, Distillation and Evaluation of Motivational Interviewing-Style Reflections with a Foundational Language Model

  https://arxiv.org/abs/2402.01051
- Few-shot Dialogue Strategy Learning for Motivational Interviewing via Inductive Reasoning

  https://arxiv.org/abs/2403.15737
- Modeling Motivational Interviewing Strategies On An Online Peer-to-Peer Counseling Platform

  https://arxiv.org/abs/2211.05182

有用点：

- 有效心理引导不是立刻建议，而是先反映用户处境。
- 常见结构：开放式提问、肯定、反映、总结。
- 研究显示反思和肯定会提高对话满意度。
- 好的系统应该减少 unsolicited advice，避免居高临下。

对我们的启发：

- 主持人必须先做“反映式开场”：
  - 我听见你在 A 和 B 之间拉扯。
  - 你不是不够努力，而是在同时处理 X、Y、Z。
- 每位榜样不能只说建议，要先承接用户语境。
- 行动计划前必须有“你真正的问题可能是...”。

## 产品输出结构建议

用户输入问题后，不要直接给长文。建议改成 6 层：

1. 主持人反映
   - 复述问题。
   - 命名核心矛盾。
   - 降低羞耻感。

2. 圆桌成员入场
   - 头像 / 人物名 / 能力标签。
   - 一句灵感句。
   - “她会先看见什么”。

3. 第一轮发言
   - 每位榜样从自己的价值系统解释问题。

4. 第二轮交锋
   - 不是吵架，而是观点张力。
   - 例如：武则天提醒筹码，李清照提醒真实感受，居里夫人提醒长期证据。

5. 她们追问你
   - 每位榜样提出一个问题。
   - 用户可以点选一个问题继续深入。

6. 行动落地
   - 24 小时动作。
   - 7 天实验。
   - 30 天能力练习。
   - 可复制到飞书成长模板。

## 榜样角色卡格式

每位女性榜样应该有：

```json
{
  "id": "li-qingzhao",
  "displayName": "李清照式表达创作",
  "figure": "李清照",
  "archetype": "表达创作者",
  "coreValues": ["真实", "才情", "情感辨认", "作品化"],
  "historicalContext": "才华、婚姻、流离、时代变化中的女性表达",
  "decisionStyle": "先辨认真实感受，再把感受转为语言和作品",
  "speakingStyle": "细腻、清醒、含蓄但锋利",
  "watchFor": "用户是否把敏感当成弱点",
  "pushback": "不要一直等准备好才表达",
  "practice": "写下最诚实的第一句",
  "memoryBank": [
    "她以词表达私人经验和时代变迁。",
    "她的生命包含才情、失去、流离和自我保存。",
    "她的价值不是情绪化，而是把情绪炼成作品。"
  ]
}
```

## 合规与气质边界

- 不说“某某本人在回答你”。
- 不使用在世名人的肖像和商业化姓名包装。
- 公版人物也不直接大量引用现代译本、传记原文。
- 优先使用原创转述、能力模型、公开事实。
- 不做心理治疗承诺，不处理危机干预；定位为自我反思与成长工具。

## 下一步实现建议

1. 把 `app.js` 里的 mentors 拆成 `data/mentors.js`。
2. 为每位榜样补充角色卡字段。
   - 重点候选：李清照、班昭、秦良玉、武则天、居里夫人、南丁格尔、简·奥斯汀、阿达·洛夫莱斯、伍尔夫。
3. 为每种问题主题建立主持人反映模板。
4. 增加“继续追问”交互：用户点击某位榜样的问题，展开第二层回应。
5. 后续接 AI API 时，使用：
   - user context
   - selected mentor card
   - retrieved memory snippets
   - response schema
   - safety/voice rules
