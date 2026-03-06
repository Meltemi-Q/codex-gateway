# codex-gateway

将 [Codex CLI](https://github.com/openai/codex) 包装成本地 OpenAI 兼容 API 服务，零依赖，开箱即用。

**核心特性：** 自动监听 `~/.codex/models_cache.json`，Codex CLI 每次运行后会刷新模型列表，网关立即感知，无需重启或手动配置。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/models` | 获取可用模型列表（实时） |
| `POST` | `/v1/chat/completions` | 转发聊天请求给 Codex CLI |

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

或者一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/setup.sh | bash
```

向导会自动：
- 检测 Node.js 和 codex 路径
- 提示配置端口（默认 `8319`）、工作目录、代理地址
- 注册 **launchd** 服务（macOS，登录后自动启动）或 **systemd** 服务（Linux，开机自动启动）

### Windows

```powershell
git clone https://github.com/Meltemi-Q/codex-gateway.git
cd codex-gateway
powershell -ExecutionPolicy Bypass -File setup.ps1
```

向导会自动注册 **Task Scheduler** 任务（登录后自动启动）。

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
| `HTTPS_PROXY` | — | 上游代理，转发给 codex 子进程 |
| `HTTP_PROXY` | — | 上游代理 |
| `ALL_PROXY` | — | 上游代理（socks5） |
| `NO_PROXY` | — | 代理豁免列表 |

## 使用示例

### curl 测试

```bash
curl http://127.0.0.1:8319/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "用 Go 写一个 hello world"}]
  }'
```

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
