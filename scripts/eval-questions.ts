// 评测问题集。随时增删这个数组即可。
//
// bucket：预期主题桶（仅用于报告分组，不参与判分）。
// expectsKeyword：这道题是否含 director.ts themeRules 的关键词。
//   - true  ：命中某条正则，即使 LLM 挂了也能靠规则兜底出合理主题。
//   - false ：不含任何关键词（「读题探针」）——LLM 正常时主题不该是「人生选择」，
//             一旦落到兜底，就是没读懂 / 降级的信号。这是「读题准确性」维度的主要判据。
//
// 全量集覆盖副业、关系、家庭期待、自我价值、表达困境和模糊情绪。
// 最后一题刻意避开四条正则里的所有词，用来逼出「真读懂」而不是关键词兜底。

import type { SupportMode } from "@/lib/types";

export type EvalQuestion = {
  id: string;
  question: string;
  bucket: string;
  expectsKeyword: boolean;
  expectedSupportMode: SupportMode;
};

export const evalQuestions: EvalQuestion[] = [
  {
    id: "career-side-hustle",
    question:
      "我在一家还算稳定的公司上班，最近很想做个副业变现，甚至动过辞职的念头，但一想到收入不稳定又退缩，怕折腾半天什么都没积累下来。",
    bucket: "事业与副业",
    expectsKeyword: true,
    expectedSupportMode: "experience_context"
  },
  {
    id: "relationship-boundary",
    question:
      "和一个朋友的关系让我越来越消耗，每次见完都很累，可真要拉开边界又觉得亏欠，不知道该继续维持还是慢慢退出。",
    bucket: "关系与边界",
    expectsKeyword: true,
    expectedSupportMode: "experience_context"
  },
  {
    id: "family-expectations",
    question:
      "家里一直希望我考编，觉得女孩子稳定最重要，可我更想去做有创造性的工作。我怕让父母失望，也怕按他们的路走几年后怨自己。",
    bucket: "家庭期待",
    expectsKeyword: true,
    expectedSupportMode: "experience_context"
  },
  {
    id: "self-worth-comparison",
    question:
      "看到同龄人升职、结婚、买房，我会很羡慕，回头看自己就觉得什么都没做好。理智上知道不该比较，可还是会怀疑自己是不是落后了。",
    bucket: "自我价值",
    expectsKeyword: true,
    expectedSupportMode: "experience_context"
  },
  {
    id: "expression-visibility",
    question:
      "我很想开始写作、做自己的内容账号被更多人看见，但又怕写出来的东西太幼稚、不够好，迟迟不敢发布第一篇。",
    bucket: "表达困境",
    expectsKeyword: true,
    expectedSupportMode: "experience_context"
  },
  {
    id: "probe-heavy-mornings",
    question:
      "我每天醒来都觉得身体沉沉的，好像有件事一直压在心口，可我说不清那到底是什么，也不知道该怎么让自己轻一点。",
    bucket: "模糊情绪（无关键词）",
    expectsKeyword: false,
    expectedSupportMode: "unknown_cause"
  },
  {
    id: "named-emotion-shame",
    question: "我最近总有一种羞耻感，觉得自己好像哪里不够好，但我不想再一味否定自己。",
    bucket: "已命名情绪",
    expectsKeyword: false,
    expectedSupportMode: "named_emotion"
  }
];
