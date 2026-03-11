# codex-gateway

将 [Codex CLI](https://github.com/openai/codex) 包装成本地 OpenAI 兼容 API 服务，零依赖，开箱即用。

**核心特性：** 自动监听 `~/.codex/models_cache.json`，Codex CLI 每次运行后会刷新模型列表，网关立即感知，无需重启或手动配置。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/help` | 使用说明 — 参数、context 预算、配置信息（机器和人类都可读） |
| `GET` | `/v1/models` | 获取可用模型列表，含 context_window 和支持的推理级别 |
| `POST` | `/v1/chat/completions` | 转发聊天请求给 Codex CLI（支持流式和非流式） |

完全兼容 OpenAI API 格式，任何支持 OpenAI SDK 的客户端都可以直接使用。

## 前置要求

1. **Node.js 18+**
2. **Codex CLI** — 安装并登录

```bash
# 安装 Codex CLI
npm install -g @openai/codex

# 登录（需要 OpenAI 账号，使用 ChatGPT 授权）
codex login
```

> 登录后，凭证保存在 `~/.codex/auth.json`，有效期约 10 天，会自动续期。

## 快速安装（推荐）

克隆仓库后运行安装向导，自动检测环境、交互配置、注册系统服务：

### macOS / Linux

```bash
git clone https://github.com/Meltemi-Q/codex-gateway.git
cd codex-gateway
bash setup.sh
```

如果你想直接一条命令装好并顺手把 Droid 也配上，可以用：

```bash
curl -fsSL https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.sh | \
  bash -s -- --yes --sync-droid --set-default-droid
```

这条命令会：
- 克隆或更新 `~/codex-gateway`
- 安装 `codex-gateway` 到 launchd / systemd
- 把当前模型列表导入 Droid
- 把 `GPT-5.4 [Codex Gateway]` 设为 Droid 默认会话模型

不需要额外加 `&`。安装完成后它就是系统服务，shell 退出后也会继续运行。

向导会自动：
- 检测 Node.js 和 codex 路径
- 提示配置端口（默认 `8319`）、工作目录、代理地址
- 注册 **launchd** 服务（macOS，登录后自动启动）或 **systemd** 服务（Linux，开机自动启动）

如果你已经在本地仓库目录里，也可以直接无交互执行：

```bash
bash setup.sh --yes --sync-droid --set-default-droid
```

### Windows

```powershell
git clone https://github.com/Meltemi-Q/codex-gateway.git
cd codex-gateway
powershell -ExecutionPolicy Bypass -File setup.ps1
```

如果你想在 Windows 上也一条命令装好并顺手同步 Droid，可以用：

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.ps1))) -Yes -SyncDroid -SetDefaultDroid"
```

这条命令会：
- 克隆或更新 `%USERPROFILE%\codex-gateway`
- 把 `codex-gateway` 注册成 **Task Scheduler** 任务
- 把当前模型列表导入 Droid
- 把 `GPT-5.4 [Codex Gateway]` 设为 Droid 默认会话模型

不需要额外加 `&`。安装完成后它是计划任务，shell 退出后也会继续运行。

如果你已经在本地仓库目录里，也可以直接无交互执行：

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1 -Yes -SyncDroid -SetDefaultDroid
```

### 安装完成后验证

```bash
curl http://127.0.0.1:8319/v1/models
```

## 手动启动

```bash
# 默认配置（端口 8319，自动检测 codex）
node index.mjs

# 自定义端口和路径
PORT=8400 CODEX_PATH=/usr/local/bin/codex node index.mjs
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8319` | 监听端口（绑定 127.0.0.1） |
| `CODEX_PATH` | 自动检测 | codex 二进制路径 |
| `CODEX_HOME` | `~/.codex` | Codex 数据目录 |
| `WORK_DIR` | 当前目录 | 传给 `codex exec` 的工作目录 |
| `CODEX_EXEC_TIMEOUT_MS` | `120000` | 单次 `codex exec` 超时毫秒数；超时后会杀掉子进程并返回 HTTP 504 |
| `HTTPS_PROXY` | — | 上游代理，转发给 codex 子进程 |
| `HTTP_PROXY` | — | 上游代理 |
| `ALL_PROXY` | — | 上游代理（socks5） |
| `NO_PROXY` | — | 代理豁免列表 |

## 使用示例

### curl 测试

基础请求：

```bash
curl http://127.0.0.1:8319/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "用 Go 写一个 hello world"}]
  }'
```

指定推理强度和最大输出 token：

```bash
curl http://127.0.0.1:8319/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "解释量子计算"}],
    "reasoning_effort": "high",
    "max_tokens": 8000
  }'
```

### 支持的请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型标识（默认 `gpt-5.4`） |
| `messages` | array | OpenAI 格式消息数组 |
| `stream` | boolean | 启用 SSE 流式输出（默认 `false`） |
| `reasoning_effort` | string | 推理深度：`low`、`medium`、`high`、`xhigh`（因模型而异，自动校验降级） |
| `max_tokens` | integer | 最大输出 token 数（映射到 `model_max_output_tokens`） |
| `max_completion_tokens` | integer | `max_tokens` 的别名 |
| `fast_mode` | boolean | Codex 快速模式（默认 `false`）。设为 `true` 可开启以加速响应，但质量略低。 |

> **注意：** 不是所有模型都支持所有推理级别。网关会自动校验并降级到该模型支持的最高级别。可通过 `GET /v1/models` 查看每个模型的 `supported_reasoning_levels`。

### 模型元数据

`GET /v1/models` 现在返回扩展元数据：

```json
{
  "id": "gpt-5.4",
  "object": "model",
  "context_window": 272000,
  "effective_context_window_percent": 95,
  "supported_reasoning_levels": ["low", "medium", "high", "xhigh"]
}
```

**Context 预算：** 每个模型有 272k token 的上下文窗口。平台保留约 5%，Codex CLI 本身的系统提示和工具定义消耗约 3k token。用户实际可用约 **254k tokens**。

### 用量统计与额度预警

`GET /v1/stats` 返回当日 token 用量和预算状态：

```bash
curl http://127.0.0.1:8319/v1/stats
```

```json
{
  "date": "2026-03-08",
  "budget": {
    "daily_limit": 10000000,
    "total_used": 85200,
    "remaining": 9914800,
    "usage_percent": 0.85,
    "status": "ok",
    "warn_threshold_percent": 80
  },
  "tokens": { "input": 80000, "cached_input": 60000, "output": 5200 },
  "requests": { "total": 12, "errors": 0 },
  "by_model": { "gpt-5.4": { "input_tokens": 80000, "output_tokens": 5200, "requests": 12 } }
}
```

- **费用估算**：按 [OpenAI API 定价](https://openai.com/api/pricing/) 计算每次请求和每个模型的美元费用（注意：Codex Pro/Teams 订阅是固定月费，这里是 API 等价估算）
- **预算状态**：`ok` → `warning`（达到 80%）→ `exceeded`（达到 100%）
- 每天 UTC 午夜自动重置
- 统计数据跨重启持久化（保存在 `~/.codex/gateway_stats.json`）
- 可通过环境变量配置：`DAILY_TOKEN_BUDGET`（默认 1000 万）、`WARN_THRESHOLD`（默认 0.8）

网关现在在每个 chat completion 响应中返回**真实 token 计数**（`usage.prompt_tokens`、`usage.completion_tokens`、`usage.cached_tokens`）。

### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8319/v1", api_key="any")
response = client.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role": "user", "content": "你好！"}]
)
print(response.choices[0].message.content)
```

### 一键导入到 Droid

如果你本地也在用 Droid，可以用一条命令把当前 codex-gateway 模型列表写入 `~/.factory/config.json` 和 `~/.factory/settings.json`：

```bash
npm run sync:droid
```

常用参数：

```bash
# 同时把 GPT-5.4 [Codex Gateway] 设为 Droid 默认会话模型
npm run sync:droid -- --set-default

# 指向不同的 Droid baseUrl
npm run sync:droid -- --base-url http://127.0.0.1:8400/v1
```

如果 Droid 在 **Mac** 上，而网关跑在 **VPS** 上，可以直接在 Mac 上运行这个远程同步脚本。它会通过 SSH 到 VPS 读取网关 key，再写入本机 `~/.factory/config.json` 和 `~/.factory/settings.json`，不用手抄 key：

```bash
ssh root@100.74.249.26 'cat /root/codex-gateway/scripts/sync-droid-remote-from-vps.sh' | bash
```

常见场景：

```bash
# 改成走 VPS 上的 Tailscale 地址，并设为默认模型
ssh root@100.74.249.26 'cat /root/codex-gateway/scripts/sync-droid-remote-from-vps.sh' | bash

# 不改默认模型，只导入模型列表
ssh root@100.74.249.26 'cat /root/codex-gateway/scripts/sync-droid-remote-from-vps.sh' | \
  bash -s -- --no-set-default
```

导入脚本会：
- 使用 `provider: "generic-chat-completion-api"` 写入 Droid 模型
- 在覆盖前自动生成 `config.json.bak` 和 `settings.json.bak`
- 优先读取正在运行的网关 `/v1/models`，不可用时回退到 `~/.codex/models_cache.json`
- 如果没检测到 Droid（PATH 里没有 `droid`，且 `~/.factory` 不存在），就直接跳过，不会写任何文件

### 配合 cliproxyapi 使用

在 `~/.cli-proxy-api/config.yaml` 中添加：

```yaml
openai-compatibility:
  - name: "codex-gateway"
    base-url: "http://127.0.0.1:8319"
    api-key-entries:
      - api-key: "any-key"
    models:
      - name: "gpt-5.4"
        alias: "gpt-5.4"
```

## 模型自动发现原理

Codex CLI 每次运行后会将最新模型列表写入 `~/.codex/models_cache.json`。codex-gateway 用 `fs.watch` 监听该文件，模型有变化时立即热加载，无需重启。新发布的模型会在下次 Codex CLI 运行后自动出现。

## 鉴权说明

codex-gateway 使用 `codex login` 保存的凭证（`~/.codex/auth.json`），access token 有效期约 10 天，refresh token 会自动续期。如遇鉴权错误，重新运行 `codex login` 即可。

网关本身**不校验**客户端传来的 API key，随意填写即可。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
