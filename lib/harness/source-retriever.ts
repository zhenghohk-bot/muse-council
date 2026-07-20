import { pioneerById } from "@/data/pioneers";
import type { RoundtableSession, SourceNote } from "@/lib/types";

export type SourceRetrievalContext =
  | string
  | {
      question: string;
      theme?: string;
      tension?: string;
      emotion?: string;
      need?: string;
      followUp?: string;
    };

export type SourceNoteMatch = {
  note: SourceNote;
  score: number;
  matchedTerms: string[];
  signals: string[];
};

type ScoredSourceNoteMatch = SourceNoteMatch & { index: number };

const stopWords = new Set([
  "一个",
  "一些",
  "这个",
  "那个",
  "自己",
  "觉得",
  "还是",
  "可以",
  "怎么",
  "什么",
  "为什么",
  "现在",
  "已经",
  "可能",
  "需要",
  "问题",
  "事情",
  "但是",
  "因为",
  "所以",
  "没有",
  "不是"
]);

const conceptGroups: Array<{ label: string; terms: string[] }> = [
  { label: "副业", terms: ["副业", "兼职", "变现", "赚钱", "收入", "服务", "产品"] },
  { label: "创作", terms: ["创作", "写作", "表达", "作品", "灵感", "内容"] },
  { label: "原型", terms: ["原型", "样稿", "最小版本", "测试", "迭代", "反馈", "验证"] },
  { label: "长期", terms: ["长期", "坚持", "积累", "复利", "耐心", "反复"] },
  { label: "证据", terms: ["证据", "记录", "数据", "观察", "比较", "复盘"] },
  { label: "关系", terms: ["关系", "恋爱", "伴侣", "婚姻", "朋友", "家庭", "相处"] },
  { label: "边界", terms: ["边界", "拒绝", "照顾别人", "讨好", "责任", "委屈", "消耗"] },
  { label: "资源", terms: ["资源", "时间", "金钱", "预算", "风险", "退路", "选择权"] },
  { label: "职业", terms: ["职业", "工作", "职场", "辞职", "转型", "学业", "读博"] },
  { label: "空间", terms: ["空间", "独处", "安静", "房间", "注意力", "日程"] },
  { label: "情绪", terms: ["焦虑", "害怕", "羞耻", "失落", "内耗", "疲惫", "沉重"] },
  { label: "评价", terms: ["认可", "评价", "看见", "证明", "赞美", "否定", "比较"] }
];

function contextText(context: SourceRetrievalContext) {
  if (typeof context === "string") return context;
  return [context.question, context.theme, context.tension, context.emotion, context.need, context.followUp]
    .filter(Boolean)
    .join("。 ");
}

function tokenize(text: string) {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();

  try {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    for (const item of segmenter.segment(normalized)) {
      const token = item.segment.trim();
      if (item.isWordLike && token.length >= 2 && !stopWords.has(token)) tokens.add(token);
    }
  } catch {
    for (const token of normalized.split(/[\s,，。！？、；;：:（）()]+/)) {
      if (token.length >= 2 && !stopWords.has(token)) tokens.add(token);
    }
  }

  return [...tokens];
}

function noteText(note: SourceNote) {
  return `${note.title} ${note.note} ${note.usageHint}`.toLowerCase();
}

function scoreNotes(notes: SourceNote[], context: SourceRetrievalContext): ScoredSourceNoteMatch[] {
  const query = contextText(context).toLowerCase();
  const queryTokens = tokenize(query);
  const activeConcepts = conceptGroups.filter((group) => group.terms.some((term) => query.includes(term)));
  const documentFrequency = new Map<string, number>();

  for (const token of queryTokens) {
    documentFrequency.set(token, notes.filter((note) => noteText(note).includes(token)).length);
  }

  return notes.map((note, index) => {
    const title = note.title.toLowerCase();
    const body = note.note.toLowerCase();
    const usage = note.usageHint.toLowerCase();
    const document = `${title} ${body} ${usage}`;
    const matchedTerms: string[] = [];
    const signals: string[] = [];
    let score = 0;

    for (const token of queryTokens) {
      if (!document.includes(token)) continue;
      const frequency = documentFrequency.get(token) ?? notes.length;
      const specificity = 1 + Math.log((notes.length + 1) / (frequency + 1));
      const fieldWeight = title.includes(token) ? 6 : usage.includes(token) ? 4 : 2;
      score += fieldWeight * specificity;
      matchedTerms.push(token);
    }

    for (const concept of activeConcepts) {
      const noteTerms = concept.terms.filter((term) => document.includes(term));
      if (noteTerms.length === 0) continue;
      score += 3 + Math.min(3, noteTerms.length);
      matchedTerms.push(concept.label, ...noteTerms);
      signals.push(`主题「${concept.label}」与资料用途相符`);
    }

    if (typeof context !== "string") {
      const analyzedFocus = [context.theme, context.tension, context.need].filter(Boolean).join(" ").toLowerCase();
      const analyzedMatches = tokenize(analyzedFocus).filter((token) => document.includes(token));
      if (analyzedMatches.length > 0) {
        score += analyzedMatches.length * 3;
        matchedTerms.push(...analyzedMatches);
        signals.push("命中主持人的读题重点");
      }

      if (context.followUp) {
        const followUpMatches = tokenize(context.followUp).filter((token) => document.includes(token));
        if (followUpMatches.length > 0) {
          score += followUpMatches.length * 4;
          matchedTerms.push(...followUpMatches);
          signals.push("回应本轮追问");
        }
      }
    }

    return {
      note,
      score: Number(score.toFixed(2)),
      matchedTerms: [...new Set(matchedTerms)].slice(0, 8),
      signals: [...new Set(signals)],
      index
    };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}

export function retrieveSourceNoteMatches(
  pioneerId: string,
  context: SourceRetrievalContext,
  limit = 2
) {
  const pioneer = pioneerById.get(pioneerId);
  if (!pioneer) return [];
  return scoreNotes(pioneer.sourceNotes, context)
    .slice(0, limit)
    .map(({ index: _index, ...match }) => match);
}

export function retrieveSourceNotes(
  pioneerId: string,
  context: SourceRetrievalContext,
  limit = 2
) {
  return retrieveSourceNoteMatches(pioneerId, context, limit).map((match) => match.note);
}

export function sessionRetrievalContext(session: RoundtableSession, followUp?: string): SourceRetrievalContext {
  return {
    question: session.question,
    theme: session.theme,
    tension: session.tension,
    followUp
  };
}

export function getSourceNotesByIds(ids: string[]) {
  return ids
    .map((id) => {
      for (const pioneer of pioneerById.values()) {
        const note = pioneer.sourceNotes.find((sourceNote) => sourceNote.id === id);
        if (note) return note;
      }
      return undefined;
    })
    .filter((note): note is SourceNote => Boolean(note));
}
