import type { QuestionIntent } from "@/lib/types";

export type QuestionIntentAnalysis = {
  primary: QuestionIntent;
  secondary?: QuestionIntent;
  reason: string;
};

const expressionSkillPattern =
  /表达|沟通|汇报|演讲|说清|重点|听不懂|没听懂|不理解|复述|开口|措辞/;

const intentPatterns: Array<{
  intent: QuestionIntent;
  patterns: RegExp[];
  reason: string;
}> = [
  {
    intent: "skill_building",
    patterns: [
      /如何(?:提升|提高|改善|练习|训练)/,
      /怎么(?:提升|提高|改善|练习|训练)/,
      /(?:表达|沟通|写作|演讲|汇报|创作|管理|领导|学习).{0,8}(?:能力|技巧|水平|方法)/,
      /(?:学会|练好|掌握).{0,12}(?:能力|技巧|方法)/
    ],
    reason: "用户在询问一种能力如何拆解、练习并获得反馈"
  },
  {
    intent: "decision",
    patterns: [
      /要不要|该不该|应不应该|是否应该/,
      /(?:选择|决定|取舍|辞职|转行|离开|继续还是|留下还是)/,
      /哪一个更适合|该选/
    ],
    reason: "用户需要比较选项、代价和判断条件"
  },
  {
    intent: "creative_exploration",
    patterns: [
      /(?:创作|写作|产品|项目|副业).{0,10}(?:方向|灵感|想法|选题|风格)/,
      /不知道(?:写|做|创作|设计)什么/,
      /想尝试.{0,12}(?:创作|作品|项目)/
    ],
    reason: "用户需要扩展可能性，再筛出值得试做的方向"
  },
  {
    intent: "self_reflection",
    patterns: [
      /为什么我/,
      /我到底(?:想要|在意|害怕|适合|是怎样)/,
      /(?:总是|反复).{0,16}(?:在意|比较|迎合|否定|怀疑)/,
      /不知道自己(?:想要|适合|喜欢)什么/
    ],
    reason: "用户希望理解一种反复出现的自我模式"
  },
  {
    intent: "emotional_support",
    patterns: [
      /(?:很|特别|非常)?(?:难过|痛苦|焦虑|羞耻|孤独|无助|崩溃).{0,16}(?:陪|安慰|缓一缓|撑不住|怎么办)/,
      /想有人陪我|想被安慰|只想说一说/,
      /不知道怎么面对这种(?:情绪|感受)/
    ],
    reason: "用户此刻更需要被理解和承接，而不是立即得到方案"
  },
  {
    intent: "problem_solving",
    patterns: [
      /怎么办|怎么做|如何解决|如何处理/,
      /(?:卡住|做不到|总失败|总拖延|总说不清|总做不好)/,
      /下一步(?:做什么|怎么走)/
    ],
    reason: "用户需要定位阻碍并形成可操作的解决路径"
  }
];

export function classifyQuestionIntent(question: string): QuestionIntentAnalysis {
  const matches = intentPatterns
    .map((candidate) => ({
      ...candidate,
      score: candidate.patterns.reduce((score, pattern) => score + (pattern.test(question) ? 1 : 0), 0)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const primary = matches[0];
  const secondary = matches.find((candidate) => candidate.intent !== primary?.intent);
  if (!primary) {
    return {
      primary: "problem_solving",
      reason: "问题尚未呈现明确意图，先按问题解决处理，并允许主持人必要时追问"
    };
  }

  return {
    primary: primary.intent,
    secondary: secondary?.intent,
    reason: primary.reason
  };
}

export function isExpressionSkillQuestion(question: string) {
  const intent = classifyQuestionIntent(question);
  return (
    expressionSkillPattern.test(question) &&
    ["skill_building", "problem_solving"].includes(intent.primary)
  );
}

export function questionTaskFrame(question: string) {
  if (isExpressionSkillQuestion(question)) {
    return [
      "共享任务：帮助用户在具体场景中把重点表达得更容易理解，并形成可练习、可反馈的方法。",
      "共同定义：这里的“表达”首先指信息是否清楚、重点是否突出、听者需要的背景是否足够。",
      "范围边界：除非用户亲自提到，不把它改写成坦白内心、害怕评价、关系交换、公开发布或汇报表演。",
      "推理边界：用户认真准备，不等于准备导致表达不清；只能条件化检查信息是否过多、重点是否后置或背景是否不足。",
      "反馈原则：由表达者先说明自己在练习什么，再礼貌询问对方最先听懂了什么、哪里仍需补充；不能把反馈设计成考听者复述重点。"
    ].join("\n");
  }

  return "共享任务：围绕用户亲自提出的问题推进判断，不擅自替换问题、补写情绪或发明隐藏原因。";
}

export function questionIntentInstruction(analysis: QuestionIntentAnalysis) {
  const secondary = analysis.secondary ? `；次要意图：${analysis.secondary}` : "";
  return `问题意图：${analysis.primary}${secondary}。${analysis.reason}。不要把该意图擅自改写成心理分析。`;
}
