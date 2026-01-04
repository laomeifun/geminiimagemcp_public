# @laomeifun/gemini-image-mcp

[![npm version](https://img.shields.io/npm/v/@laomeifun/gemini-image-mcp.svg)](https://www.npmjs.com/package/@laomeifun/gemini-image-mcp)

一个基于 **MCP (Model Context Protocol)** 的图片生成工具，通过 OpenAI-compatible 接口调用 Gemini 图片模型生成图片。支持 Claude Desktop、VS Code Copilot 等 MCP 客户端。

## ✨ 特性

- 🎨 **AI 图片生成**：通过自然语言描述生成图片
- 📁 **自动保存**：图片自动保存到指定目录
- 🖼️ **Markdown 展示**：返回 Markdown 图片语法，支持直接预览
- 🔧 **灵活配置**：支持多种环境变量配置
- 🌍 **跨平台**：支持 Windows、macOS、Linux
- 📦 **即装即用**：通过 npx 直接运行，无需手动安装

## 🚀 快速开始

### 方式一：使用 npx（推荐）

在 MCP 客户端配置中直接使用：

```json
{
  "mcpServers": {
    "gemini-image": {
      "command": "npx",
      "args": ["-y", "@laomeifun/gemini-image-mcp"],
      "env": {
        "OPENAI_BASE_URL": "http://127.0.0.1:8317",
        "OPENAI_API_KEY": "<YOUR_API_KEY>",
        "OPENAI_MODEL": "gemini-3-pro-image-preview"
      }
    }
  }
}
```

### 方式二：全局安装

```bash
npm install -g @laomeifun/gemini-image-mcp
```

然后在 MCP 配置中使用：

```json
{
  "mcpServers": {
    "gemini-image": {
      "command": "gemini-image-mcp",
      "env": {
        "OPENAI_BASE_URL": "http://127.0.0.1:8317",
        "OPENAI_API_KEY": "<YOUR_API_KEY>"
      }
    }
  }
}
```

### 方式三：从源码运行

```bash
git clone https://github.com/laomeifun/geminiimagemcp_public.git
cd geminiimagemcp_public
npm install
```

MCP 配置：

```json
{
  "mcpServers": {
    "gemini-image": {
      "command": "node",
      "args": ["<PATH_TO>/geminiimagemcp_public/src/index.js"],
      "env": {
        "OPENAI_BASE_URL": "http://127.0.0.1:8317",
        "OPENAI_API_KEY": "<YOUR_API_KEY>"
      }
    }
  }
}
```

## ⚙️ 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `OPENAI_BASE_URL` | 否 | `http://127.0.0.1:8317` | OpenAI-compatible API 地址 |
| `OPENAI_API_KEY` | 视情况 | - | API Key（如果你的网关需要鉴权） |
| `OPENAI_MODEL` | 否 | `gemini-3-pro-image-preview` | 使用的模型名称 |
| `OPENAI_IMAGE_SIZE` | 否 | `1024x1024` | 默认图片尺寸 |
| `OPENAI_IMAGE_MODE` | 否 | `chat` | API 模式：`chat`、`images`、`auto` |
| `OPENAI_IMAGE_OUT_DIR` | 否 | - | 默认保存目录（如果工具调用时未指定） |
| `OPENAI_IMAGE_INLINE_MAX_SIZE` | 否 | `524288` (512KB) | 内联展示的最大图片大小（字节），超过则只返回路径 |
| `OPENAI_TIMEOUT_MS` | 否 | `120000` | 请求超时时间（毫秒） |
| `OPENAI_DEBUG` | 否 | - | 设为 `1` 开启调试日志 |

## 🛠️ 工具参数

### `generate_image`

生成 AI 图片的 MCP 工具。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string / string[] | ✅ | 图片描述，越详细效果越好 |
| `outDir` | string | ✅* | 保存目录。支持绝对路径、相对路径、`~` 开头的用户目录 |
| `size` | string / number | 否 | 图片尺寸，默认 `1024x1024`。可选：`512x512`、`1024x1792`（竖版）、`1792x1024`（横版） |
| `n` | number | 否 | 生成数量，默认 1，最多 4 |
| `output` | string | 否 | 返回格式：`path`（默认，保存文件）或 `image`（只返回数据不保存） |

> *注：当 `output=path` 时，`outDir` 为必填参数

### 使用示例

在 Claude 或其他 MCP 客户端中：

```
画一只橙色的猫咪坐在窗台上，阳光透过窗户照进来，水彩画风格
```

AI 会自动调用工具：

```json
{
  "prompt": "一只橙色的猫咪坐在窗台上，阳光透过窗户照进来，水彩画风格",
  "outDir": "~/Pictures/ai-generated",
  "size": "1024x1024"
}
```

### 返回格式

```markdown
✅ 成功生成 1 张图片：

![image-20260104-123456-abc1.png](file:///C:/Users/xxx/Pictures/ai-generated/image-20260104-123456-abc1.png)
📁 C:/Users/xxx/Pictures/ai-generated/image-20260104-123456-abc1.png
```

## 🔧 本地调试

```bash
# 复制环境变量配置
cp .env.example .env
# 编辑 .env 填入你的配置

# 测试上游 API 连通性
npm run debug:upstream -- --prompt "A cute cat" --size 1024x1024

# 测试 MCP 工具调用
npm run debug:mcp -- --prompt "A cute cat" --out ~/Pictures
```

## 📝 配置文件位置

- **Claude Desktop (Windows)**：`%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Desktop (macOS)**：`~/Library/Application Support/Claude/claude_desktop_config.json`
- **VS Code Copilot**：参考 VS Code MCP 扩展文档

## 🤝 兼容性

- **Node.js**：>= 18
- **MCP 客户端**：Claude Desktop、VS Code Copilot、其他支持 MCP 的客户端
- **API 后端**：任何 OpenAI-compatible 的图片生成 API

## 📄 License

MIT
