#!/usr/bin/env node
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import os from "node:os";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT = "path"; // path|image

const server = new Server(
  { name: "gemini-image-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, logging: {} } },
);

// 发送 MCP 日志消息
function sendLog(level, data) {
  const message = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  // 同时也打印到 stderr 以便终端调试
  console.error(`[${level}] ${message}`);
  
  // 尝试通过 MCP 协议发送日志（如果 server 已连接）
  try {
    if (server && server.transport) {
      server.sendLoggingMessage({
        level: level,
        data: message,
      }).catch(() => {}); // 忽略发送失败（可能是连接未就绪）
    }
  } catch (e) {
    // 忽略错误
  }
}

function debugLog(...args) {
  if (isDebugEnabled()) {
    sendLog("debug", args.join(" "));
  }
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "http://127.0.0.1:8317";
  return trimmed.replace(/\/+$/, "");
}

function toV1BaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/v1")) return normalized;
  return `${normalized}/v1`;
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, n));
}

function extFromMime(mimeType) {
  switch (String(mimeType || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

function resolveOutDir(rawOutDir) {
  let outDir = String(rawOutDir ?? "").trim();
  if (!outDir) return path.join(PROJECT_ROOT, "debug-output");
  
  // 处理 ~ 路径 (Home 目录)
  if (outDir.startsWith("~")) {
    outDir = path.join(os.homedir(), outDir.slice(1));
  }
  
  if (path.isAbsolute(outDir)) return outDir;
  return path.resolve(PROJECT_ROOT, outDir);
}

function toDisplayPath(filePath) {
  return String(filePath ?? "").replaceAll("\\", "/");
}

function formatDateForFilename(date) {
  const d = date instanceof Date ? date : new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function isDebugEnabled() {
  return process.env.OPENAI_DEBUG === "1" || process.env.DEBUG === "1";
}

function parseDataUrl(maybeDataUrl) {
  const s = String(maybeDataUrl ?? "");
  const match = /^data:([^;]+);base64,(.+)$/s.exec(s);
  if (!match) return null;
  return {
    mimeType: match[1].trim() || "application/octet-stream",
    base64: match[2],
  };
}

function stripDataUrlPrefix(maybeDataUrl) {
  const parsed = parseDataUrl(maybeDataUrl);
  return parsed ? parsed.base64 : String(maybeDataUrl ?? "");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒），请检查网络或增加 OPENAI_TIMEOUT_MS`);
    }
    throw new Error(`网络请求失败: ${err.message || err}`);
  } finally {
    clearTimeout(timeout);
  }
}

function isValidBase64(str) {
  if (typeof str !== "string" || !str.trim()) return false;
  try {
    const decoded = Buffer.from(str, "base64");
    return decoded.length > 0 && Buffer.from(decoded).toString("base64") === str.replace(/\s/g, "");
  } catch {
    return false;
  }
}

async function fetchUrlAsBase64(url, timeoutMs) {
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`拉取图片失败: HTTP ${res.status} ${body}`);
  }
  const mimeTypeHeader = res.headers.get("content-type") ?? "image/png";
  const mimeType = mimeTypeHeader.split(";")[0].trim() || "image/png";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

class HttpError extends Error {
  constructor(message, { status, url, body }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

async function generateImagesViaImagesApi({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  n,
  timeoutMs,
}) {
  const v1BaseUrl = toV1BaseUrl(baseUrl);
  const url = `${v1BaseUrl}/images/generations`;

  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    prompt,
    size,
    n,
    response_format: "b64_json",
  };

  debugLog(
    `[upstream] POST ${url} (images/generations) model=${model} size=${size} n=${n} hasApiKey=${Boolean(apiKey)}`,
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 ? "（看起来需要 API Key，请设置 OPENAI_API_KEY）" : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url,
      body: text,
    });
  }

  /** @type {{ data?: Array<{ b64_json?: string; url?: string }>} } */
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];

  /** @type {Array<{base64:string; mimeType:string}>} */
  const images = [];
  for (const item of data) {
    if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
      const parsed = parseDataUrl(item.b64_json);
      images.push({
        base64: stripDataUrlPrefix(item.b64_json),
        mimeType: parsed?.mimeType ?? "image/png",
      });
      continue;
    }
    if (typeof item?.url === "string" && item.url.trim()) {
      images.push(await fetchUrlAsBase64(item.url, timeoutMs));
    }
  }

  if (images.length === 0) throw new Error("接口未返回可用的图片数据");
  return images;
}

async function generateImagesViaChatCompletions({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  timeoutMs,
}) {
  const v1BaseUrl = toV1BaseUrl(baseUrl);
  const url = `${v1BaseUrl}/chat/completions`;

  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    modalities: ["image"],
    image_config: {
      image_size: size,
    },
  };

  debugLog(
    `[upstream] POST ${url} (chat/completions) model=${model} image_config.image_size=${size} hasApiKey=${Boolean(apiKey)}`,
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 ? "（看起来需要 API Key，请设置 OPENAI_API_KEY）" : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url,
      body: text,
    });
  }

  /** @type {{ choices?: Array<{ message?: { images?: Array<any> } }> }} */
  const json = await res.json();
  const choices = Array.isArray(json?.choices) ? json.choices : [];

  /** @type {Array<{base64:string; mimeType:string}>} */
  const images = [];

  for (const choice of choices) {
    const messageImages = choice?.message?.images;
    if (!Array.isArray(messageImages)) continue;
    for (const img of messageImages) {
      const imageUrl =
        img?.image_url?.url ?? img?.url ?? img?.imageUrl ?? img?.image_url ?? "";
      if (typeof imageUrl !== "string" || !imageUrl.trim()) continue;

      const parsed = parseDataUrl(imageUrl);
      if (parsed) {
        images.push({ base64: parsed.base64, mimeType: parsed.mimeType });
        continue;
      }
      images.push(await fetchUrlAsBase64(imageUrl, timeoutMs));
    }
  }

  if (images.length === 0) {
    throw new Error(
      "接口未返回可用的图片数据（chat/completions 未找到 choices[].message.images）",
    );
  }

  return images;
}

async function generateImages(params) {
  const mode = String(process.env.OPENAI_IMAGE_MODE ?? "chat")
    .trim()
    .toLowerCase();

  if (mode === "images") {
    return await generateImagesViaImagesApi(params);
  }

  const count = clampInt(parseIntOr(params?.n, 1), 1, 4);

  if (mode === "auto") {
    try {
      return await generateImagesViaImagesApi(params);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        debugLog("[upstream] images/generations 返回 404，改用 chat/completions");
        /** @type {Array<{base64:string; mimeType:string}>} */
        const out = [];
        for (let i = 0; i < count; i += 1) {
          const batch = await generateImagesViaChatCompletions(params);
          out.push(...batch);
          if (out.length >= count) break;
        }
        return out.slice(0, count);
      }
      throw err;
    }
  }

  // chat (default)
  /** @type {Array<{base64:string; mimeType:string}>} */
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const batch = await generateImagesViaChatCompletions(params);
    out.push(...batch);
    if (out.length >= count) break;
  }
  return out.slice(0, count);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description: `生成 AI 图片。当用户需要创建、绘制、生成图片/图像/插图/照片时使用此工具。

使用场景：
- 用户说"画一个..."、"生成一张..."、"创建图片..."
- 需要可视化某个概念或想法
- 制作插图、图标、艺术作品

返回说明：
- 默认会保存图片到本地并返回文件路径，同时返回图片数据供直接展示
- 设置 output="image" 则只返回图片数据不保存文件

提示词技巧：prompt 越详细效果越好，建议包含：主体、风格、颜色、构图、光线等`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "图片描述（必填）。详细描述想要生成的图片内容，如：'一只橙色的猫咪坐在窗台上，阳光透过窗户照进来，水彩画风格'",
          },
          size: {
            oneOf: [{ type: "string" }, { type: "number" }, { type: "integer" }],
            description: "图片尺寸。默认 1024x1024。可选：512x512、1024x1024、1024x1792（竖版）、1792x1024（横版）。传数字如 512 会自动变成 512x512",
          },
          n: {
            oneOf: [{ type: "integer" }, { type: "number" }, { type: "string" }],
            description: "生成数量。默认 1，最多 4。生成多张可以挑选最满意的",
          },
          output: {
            type: "string",
            description: "返回格式。默认 'path'（保存文件+返回路径+展示图片）。设为 'image' 只返回图片数据不保存文件",
          },
          outDir: {
            type: "string",
            description: "保存目录。默认为项目下的 debug-output 文件夹。可指定绝对路径或相对路径",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  if (toolName !== "generate_image") {
    return {
      isError: true,
      content: [{ type: "text", text: `未知工具: ${toolName}` }],
    };
  }

  const args = request.params?.arguments ?? {};
  
  // 宽松解析 prompt：支持 string、array、或其他类型
  let prompt = "";
  if (Array.isArray(args.prompt)) {
    prompt = args.prompt.map((x) => String(x ?? "")).join(" ").trim();
  } else {
    prompt = String(args.prompt ?? "").trim();
  }
  if (!prompt) {
    return { isError: true, content: [{ type: "text", text: "参数 prompt 不能为空" }] };
  }

  // 宽松解析 size：支持 string、number（如 1024 → "1024x1024"）
  let size = String(args.size ?? process.env.OPENAI_IMAGE_SIZE ?? DEFAULT_SIZE).trim();
  if (/^\d+$/.test(size)) {
    size = `${size}x${size}`;
  }

  // 宽松解析 n：支持 integer、number、string
  const n = clampInt(parseIntOr(args.n, 1), 1, 4);
  
  // 宽松解析 output：识别多种同义词
  const outputRaw = String(args.output ?? process.env.OPENAI_IMAGE_RETURN ?? DEFAULT_OUTPUT)
    .trim()
    .toLowerCase();
  const output = ["image", "base64", "b64", "data", "inline"].includes(outputRaw) ? "image" : "path";
  
  // 宽松解析 outDir：支持多种参数命名风格
  const outDir = resolveOutDir(
    args.outDir ?? args.out_dir ?? args.outdir ?? args.output_dir ?? process.env.OPENAI_IMAGE_OUT_DIR
  );

  const baseUrl = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8317";
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  
  // 模型由环境变量控制，不在工具调用时指定
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  
  const timeoutMs = clampInt(
    parseIntOr(process.env.OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    5_000,
    600_000,
  );

  try {
    const images = await generateImages({
      baseUrl,
      apiKey,
      model,
      prompt,
      size,
      n,
      timeoutMs,
    });

    if (output === "image") {
      return {
        content: images.map((img) => ({
          type: "image",
          mimeType: img.mimeType,
          data: img.base64,
        })),
      };
    }

    await fs.mkdir(outDir, { recursive: true });
    const batchId = `${formatDateForFilename(new Date())}-${crypto.randomBytes(4).toString("hex")}`;
    const saved = [];
    const errors = [];
    
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const ext = extFromMime(img.mimeType);
      const filePath = path.join(outDir, `image-${batchId}-${i + 1}.${ext}`);
      
      try {
        // 验证 base64 有效性
        if (!img.base64 || typeof img.base64 !== "string") {
          errors.push(`图片 ${i + 1}: 无效的图片数据`);
          continue;
        }
        const buffer = Buffer.from(img.base64, "base64");
        if (buffer.length === 0) {
          errors.push(`图片 ${i + 1}: 图片数据为空`);
          continue;
        }
        await fs.writeFile(filePath, buffer);
        saved.push(filePath);
      } catch (writeErr) {
        errors.push(`图片 ${i + 1}: 保存失败 - ${writeErr.message}`);
      }
    }

    debugLog(`[local] 已保存 ${saved.length} 张图片到 ${outDir}`);
    
    // 构建结构化返回
    const resultLines = [];
    if (saved.length > 0) {
      resultLines.push(`✅ 成功生成 ${saved.length} 张图片：\n`);
      // 使用 Markdown 图片语法，让支持的客户端可以直接渲染
      saved.forEach((p) => {
        const displayPath = toDisplayPath(p);
        // file:// URI 格式，兼容大多数 Markdown 渲染器
        const fileUri = `file:///${displayPath.replace(/^\//, '')}`;
        resultLines.push(`![${path.basename(p)}](${fileUri})`);
        resultLines.push(`📁 ${displayPath}\n`);
      });
    }
    if (errors.length > 0) {
      resultLines.push(`⚠️ 部分失败：`);
      errors.forEach((e) => resultLines.push(e));
    }

    // 构建返回内容
    const content = [
      {
        type: "text",
        text: resultLines.join("\n"),
      },
    ];
    
    // 智能判断是否附带图片数据（作为备选，某些客户端可能不支持 file:// URI）：
    // - 小图片（< 阈值）：附带图片数据，确保能展示
    // - 大图片（≥ 阈值）：只用 Markdown 路径，避免 token 爆炸
    // 可通过环境变量 OPENAI_IMAGE_INLINE_MAX_SIZE 调整阈值（单位：字节，默认 512KB）
    // 设为 0 可完全禁用 base64 内联，只使用 Markdown 路径
    const inlineMaxSize = parseIntOr(process.env.OPENAI_IMAGE_INLINE_MAX_SIZE, 512 * 1024);
    
    if (inlineMaxSize > 0) {
      for (const img of images) {
        if (img.base64 && typeof img.base64 === "string") {
          const estimatedSize = img.base64.length * 0.75;
          if (estimatedSize <= inlineMaxSize) {
            content.push({
              type: "image",
              mimeType: img.mimeType || "image/png",
              data: img.base64,
            });
          }
        }
      }
    }

    return { content };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // 提供更友好的错误信息和建议
    let suggestion = "";
    if (errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND")) {
      suggestion = "\n💡 建议：检查 OPENAI_BASE_URL 是否正确，服务是否已启动";
    } else if (errMsg.includes("401") || errMsg.includes("API Key")) {
      suggestion = "\n💡 建议：设置 OPENAI_API_KEY 或 GEMINI_API_KEY 环境变量";
    } else if (errMsg.includes("超时")) {
      suggestion = "\n💡 建议：增加 OPENAI_TIMEOUT_MS 环境变量（当前默认 120 秒）";
    } else if (errMsg.includes("ENOSPC")) {
      suggestion = "\n💡 建议：磁盘空间不足，请清理后重试";
    } else if (errMsg.includes("EACCES") || errMsg.includes("EPERM")) {
      suggestion = "\n💡 建议：没有写入权限，请检查 outDir 目录权限";
    }
    
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `❌ 生成失败: ${errMsg}${suggestion}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();

// 全局异常处理
process.on("uncaughtException", (err) => {
  console.error(`[gemini-image-mcp] 未捕获异常: ${err.message}`);
  debugLog(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[gemini-image-mcp] 未处理的 Promise 拒绝: ${reason}`);
});

await server.connect(transport);
console.error("gemini-image-mcp 已启动（stdio）");
