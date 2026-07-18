// 评测问题集。随时增删这个数组即可。
//
// bucket：预期主题桶（仅用于报告分组，不参与判分）。
// expectsKeyword：这道题是否含 director.ts themeRules 的关键词。
//   - true  ：命中某条正则，即使 LLM 挂了也能靠规则兜底出合理主题。
//   - false ：不含任何关键词（「读题探针」）——LLM 正常时主题不该是「人生选择」，
//             一旦落到兜底，就是没读懂 / 降级的信号。这是「读题准确性」维度的主要判据。
//
// 注意：后两道探针刻意避开了四条正则里的所有词
// （副业/AI…、关系/边界…、拖延/焦虑/内耗/迷茫…、写作/表达/被看见…），
// 用来逼出「真读懂」而不是「关键词命中兜底」。

export type EvalQuestion = {
  id: string;
  question: string;
  bucket: string;
  expectsKeyword: boolean;
};

export const evalQuestions: EvalQuestion[] = [
  {
    id: "career-side-hustle",
    question:
      "我在一家还算稳定的公司上班，最近很想做个副业变现，甚至动过辞职的念头，但一想到收入不稳定又退缩，怕折腾半天什么都没积累下来。",
    bucket: "事业与副业",
    expectsKeyword: true
  },
  {
    id: "relationship-boundary",
    question:
      "和一个朋友的关系让我越来越消耗，每次见完都很累，可真要拉开边界又觉得亏欠，不知道该继续维持还是慢慢退出。",
    bucket: "关系与边界",
    expectsKeyword: true
  },
  {
    id: "self-order",
    question:
      "我总是拖延，明明列好了计划却一拖再拖，然后陷入内耗和自我否定，越焦虑越动不了，很想改变这种状态。",
    bucket: "自我秩序",
    expectsKeyword: true
  },
  {
    id: "expression-visibility",
    question:
      "我很想开始写作、做自己的内容账号被更多人看见，但又怕写出来的东西太幼稚、不够好，迟迟不敢发布第一篇。",
    bucket: "表达与被看见",
    expectsKeyword: true
  },
  {
    id: "probe-heavy-mornings",
    question:
      "我每天醒来都觉得身体沉沉的，好像有件事一直压在心口，可我说不清那到底是什么，也不知道该怎么让自己轻一点。",
    bucket: "读题探针 A（无关键词）",
    expectsKeyword: false
  },
  {
    id: "probe-late-nights",
    question:
      "最近我总在深夜舍不得睡，明明很累却一直刷手机，好像在等一个不会来的东西，第二天又后悔，这样循环了很久。",
    bucket: "读题探针 B（无关键词）",
    expectsKeyword: false
  }
];
