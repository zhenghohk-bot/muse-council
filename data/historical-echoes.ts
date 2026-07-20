import type { HistoricalEcho } from "@/lib/types";

// Only source-checked public-domain texts live here. Missing is better than a
// familiar but unverifiable internet quote.
export const historicalEchoes: HistoricalEcho[] = [
  {
    id: "li-qingzhao-summer-quatrain",
    pioneerId: "li-qingzhao",
    originalText: "生当作人杰，死亦为鬼雄。",
    work: "《夏日绝句》",
    sourceUrl: "https://www.gushiwen.cn/shiwenv.aspx?id=e4cd80aceb52",
    tags: ["勇气", "选择", "行动", "自我", "担当", "人生"]
  },
  {
    id: "wu-zetian-chen-gui-integrity",
    pioneerId: "wu-zetian",
    originalText: "动不失正，天地可感，而况于人乎！",
    translatedText: "行动不失其正，连天地都能感应，何况是人。",
    work: "《臣轨》",
    sourceUrl: "https://zh.wikisource.org/zh-hans/%E8%87%A3%E8%BB%8C",
    tags: ["行动", "正直", "选择", "责任", "事业", "判断"]
  },
  {
    id: "curie-nobel-lecture-evidence",
    pioneerId: "marie-curie",
    originalText: "This shows how fundamental the work carried out to prove the chemical individuality of radium has been.",
    translatedText: "由此可见，为证明镭在化学上的独立性所做的工作何等根本。",
    work: "1911 年诺贝尔化学奖演讲",
    sourceUrl: "https://www.nobelprize.org/prizes/chemistry/1911/marie-curie/lecture/",
    tags: ["证据", "验证", "研究", "积累", "长期", "作品"]
  },
  {
    id: "nightingale-notes-on-nursing-condition",
    pioneerId: "florence-nightingale",
    originalText: "What nursing has to do is to put the patient in the best condition for nature to act upon him.",
    translatedText: "护理要做的，是让病人处在最有利于自然发挥作用的条件中。",
    work: "《护理札记》",
    locator: "结论",
    sourceUrl: "https://www.gutenberg.org/files/17366/17366-h/17366-h.htm",
    tags: ["照护", "环境", "系统", "条件", "专业", "可持续"]
  },
  {
    id: "austen-emma-tenderness",
    pioneerId: "jane-austen",
    originalText: "There is no charm equal to tenderness of heart.",
    translatedText: "没有什么魅力能与内心的温柔相比。",
    work: "《爱玛》",
    locator: "第三卷，第十一章",
    sourceUrl: "https://www.gutenberg.org/files/158/158-h/158-h.htm",
    tags: ["温柔", "关系", "自尊", "朋友", "爱", "相处"]
  },
  {
    id: "lovelace-analytical-engine-patterns",
    pioneerId: "ada-lovelace",
    originalText: "The Analytical Engine weaves algebraical patterns just as the Jacquard-loom weaves flowers and leaves.",
    translatedText: "分析机编织代数的纹样，正如提花织机编织花朵与叶片。",
    work: "《分析机概论》译注",
    locator: "注释 A",
    sourceUrl: "https://www.gutenberg.org/files/75107/75107-h/75107-h.htm",
    tags: ["想象", "结构", "技术", "原型", "创作", "副业"]
  },
  {
    id: "woolf-room-money-space",
    pioneerId: "virginia-woolf",
    originalText: "A woman must have money and a room of her own if she is to write fiction.",
    translatedText: "一个女人若要写小说，必须有钱，也必须有一间自己的房间。",
    work: "《一间自己的房间》",
    locator: "第一章",
    sourceUrl: "https://anthology.lib.virginia.edu/work/Woolf/woolf-room-of-ones-own",
    tags: ["空间", "金钱", "创作", "独处", "自由", "边界"]
  }
];

export function matchHistoricalEcho(pioneerId: string, context: string) {
  const candidates = historicalEchoes.filter((echo) => echo.pioneerId === pioneerId);
  const broadTags = new Set(["人生", "自我", "行动", "选择", "责任", "判断", "作品", "积累", "长期", "创作"]);
  const ranked = candidates
    .map((echo) => {
      const matchedTags = echo.tags.filter((tag) => context.includes(tag));
      const specificMatches = matchedTags.filter((tag) => !broadTags.has(tag));
      return {
        echo,
        matchedTags,
        specificMatches,
        score: matchedTags.length + specificMatches.length
      };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return best && best.matchedTags.length >= 2 && best.specificMatches.length >= 1 ? best.echo : undefined;
}
