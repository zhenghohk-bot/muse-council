export type JsonSchema = Record<string, unknown>;

// OpenAI Chat-Completions 兼容端点。默认走 OpenAI，接火山方舟（Ark）等聚合平台时
// 用 OPENAI_BASE_URL 覆盖为对应网关，例如：
//   OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
// 注意：这里用的是 /chat/completions（Chat-Completions），不是 OpenAI 的 /responses，
// 因为 DeepSeek / Qwen / GLM 这类模型在方舟上只提供 Chat-Completions 兼容接口。
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2;

function chatEndpoint() {
  const base = (process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/responses")) return base.replace(/\/responses$/, "/chat/completions");
  return `${base}/chat/completions`;
}

export function systemInstruction() {
  return [
    "你是「她们会怎么想？」的 Roundtable Harness 生成器。",
    "定位：自我反思与成长工具，不提供心理治疗、诊断、医学、法律、投资保证。",
    "称呼历史人物为「先行者视角」，不要宣称真人本人正在回答。",
    "先行者主发言必须使用第一人称。",
    "使用简洁、自然、一次能读懂的现代中文；可以有韵味，但不要用抽象套话、咨询师术语或连续比喻。",
    "只反映用户明确说出的信息；无法确认的感受和原因必须保留不确定性。",
    "每位先行者要按自己的价值系统推理，换成人名仍成立的万能建议视为失败。",
    "引用来源只做原创转述和注释，不直接长篇引用作品或传记。"
  ].join("\n");
}

// Chat-Completions 返回 choices[].message.content（字符串）。部分推理模型会额外带
// reasoning_content，我们只取 content。
export function extractOutputText(response: unknown) {
  const data = response as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

// 各平台的 json_object 模式只保证「是合法 JSON」，不保证符合 schema（enum 约束尤其保不住）。
// 所以把 schema 直接写进 prompt 引导模型，真正的字段/枚举校验交给调用方（见 director 的 id 兜底）。
function withSchemaHint(prompt: string, schema: JsonSchema) {
  return [
    prompt,
    "",
    "请只输出一个 JSON 对象，不要输出 Markdown 代码块或任何多余文字。",
    "输出必须严格符合以下 JSON Schema：",
    JSON.stringify(schema)
  ].join("\n");
}

// 去掉个别模型可能包裹的 ```json ... ``` 代码块围栏，再解析。
function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

function requestTimeoutMs() {
  const configured = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function generationTemperature(name: string) {
  const configured = Number(process.env.OPENAI_TEMPERATURE);
  if (Number.isFinite(configured) && configured >= 0 && configured <= 2) return configured;
  if (name === "theme_analysis" || name === "roundtable_finalize") return 0.25;
  if (name === "roundtable_opening") return 0.35;
  if (name === "roundtable_crossfire") return 0.45;
  if (name.startsWith("pioneer_") || name.startsWith("follow_up_")) return 0.55;
  return 0.4;
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function generateJson<T>(
  name: string,
  schema: JsonSchema,
  prompt: string
): Promise<{ data: T; usedFallback: false }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(chatEndpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
          messages: [
            { role: "system", content: systemInstruction() },
            { role: "user", content: withSchemaHint(prompt, schema) }
          ],
          // json_object 模式跨平台通用（OpenAI / 方舟 DeepSeek 等都支持）；
          // schema 已写进 prompt，字段校验在调用方兜底。
          response_format: { type: "json_object" },
          temperature: generationTemperature(name)
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed (${name}): ${response.status} ${body}`);
      }

      const payload = await response.json();
      const text = extractOutputText(payload);
      return { data: parseJsonLoose<T>(text), usedFallback: false };
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`LLM request failed (${name})`);
}
