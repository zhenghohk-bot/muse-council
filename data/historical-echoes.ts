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
    id: "lovelace-analytical-engine-develop-truths",
    pioneerId: "ada-lovelace",
    originalText:
      "It may be desirable to explain, that by the word operation, we mean any process which alters the mutual relation of two or more things.",
    translatedText: "有必要说明：我们所说的运算，指任何改变两个或更多事物之间相互关系的过程。",
    work: "《分析机概论》译注",
    locator: "注释 A",
    sourceUrl: "https://www.gutenberg.org/files/75107/75107-h/75107-h.htm",
    tags: ["步骤", "拆解", "练习", "方法", "结构", "顺序"]
  },
  {
    id: "lovelace-analytical-engine-degrees-of-development",
    pioneerId: "ada-lovelace",
    originalText:
      "In studying the action of the Analytical Engine, we find that the peculiar and independent nature of the considerations which in all mathematical analysis belong to operations, as distinguished from the objects operated upon.",
    translatedText:
      "研究分析机的运作时会发现：在一切数学分析中，运算本身的性质与被运算的对象是各自独立的两件事。",
    work: "《分析机概论》译注",
    locator: "注释 A",
    sourceUrl: "https://www.gutenberg.org/files/75107/75107-h/75107-h.htm",
    tags: ["区分", "方法", "重点", "结构", "判断", "练习"]
  },
  {
    id: "austen-pride-and-prejudice-be-understood",
    pioneerId: "jane-austen",
    originalText: "We all love to instruct, though we can teach only what is not worth knowing.",
    translatedText: "我们都爱指点别人，尽管能教的往往并不值得知道。",
    work: "《傲慢与偏见》",
    locator: "第二卷，第八章",
    sourceUrl: "https://www.gutenberg.org/files/1342/1342-h/1342-h.htm",
    tags: ["听者", "表达", "分寸", "关系", "理解", "沟通"]
  },
  {
    id: "austen-emma-plain-speaking",
    pioneerId: "jane-austen",
    originalText:
      "Seldom, very seldom, does complete truth belong to any human disclosure; seldom can it happen that something is not a little disguised, or a little mistaken.",
    translatedText:
      "人所说出的话，极少极少是完整的真相；总难免有一点被掩饰，或有一点被误解。",
    work: "《爱玛》",
    locator: "第三卷，第十三章",
    sourceUrl: "https://www.gutenberg.org/files/158/158-h/158-h.htm",
    tags: ["误解", "表达", "听者", "沟通", "理解", "重点"]
  },
  {
    id: "li-qingzhao-cilun-diction",
    pioneerId: "li-qingzhao",
    originalText: "乃知词别是一家，知之者少。",
    translatedText: "才知道词自成一家，懂得这一点的人很少。",
    work: "《词论》",
    sourceUrl: "https://zh.wikisource.org/zh-hans/%E8%A9%9E%E8%AB%96",
    tags: ["字句", "表达", "标准", "作品", "准确", "形式"]
  },
  {
    id: "li-qingzhao-jinshilu-postface-collation",
    pioneerId: "li-qingzhao",
    originalText: "每获一书，即同共勘校，整集签题。",
    translatedText: "每得到一本书，就一同校勘，整理成集并写上标题。",
    work: "《金石录后序》",
    sourceUrl: "https://zh.wikisource.org/zh-hans/%E9%87%91%E7%9F%B3%E9%8C%84%E5%BE%8C%E5%BA%8F",
    tags: ["整理", "删改", "重点", "准确", "作品", "练习"]
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
