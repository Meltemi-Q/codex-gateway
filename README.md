# codex-gateway

A zero-dependency, OpenAI-compatible HTTP gateway that wraps the [Codex CLI](https://github.com/openai/codex) and exposes it as a local API server.

**Key feature:** Models are auto-discovered by watching `~/.codex/models_cache.json` — whenever the Codex CLI fetches a new model list from upstream, the gateway picks it up instantly with no restart or manual configuration needed.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available Codex models (live from cache) |
| `POST` | `/v1/chat/completions` | Forward a chat request to the Codex CLI |

The API is OpenAI-compatible — any client that works with the OpenAI SDK will work with codex-gateway.

## Requirements

- Node.js 18+
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`)
- A working directory that Codex trusts (listed in `~/.codex/config.toml`)

## Usage

```bash
# Start with defaults (port 8319, auto-detect codex binary)
node index.mjs

# Custom port and codex path
PORT=8400 CODEX_PATH=/usr/local/bin/codex node index.mjs
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8319` | Listening port (binds to 127.0.0.1) |
| `CODEX_PATH` | auto-detected | Path to the `codex` binary |
| `CODEX_HOME` | `~/.codex` | Codex data directory (contains auth and model cache) |
| `WORK_DIR` | `process.cwd()` | Working directory passed to `codex exec` |
| `HTTPS_PROXY` | — | Upstream proxy forwarded to the codex subprocess |

### Example request

```bash
curl http://127.0.0.1:8319/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Write a hello world in Go"}]
  }'
```

### Use with cliproxyapi

Add codex-gateway as an `openai-compatibility` provider in `~/.cli-proxy-api/config.yaml` to make all its models available through cliproxyapi's unified endpoint:

```yaml
openai-compatibility:
  - name: "codex-gateway"
    base-url: "http://127.0.0.1:8319"
    api-key-entries:
      - api-key: "any-key"   # codex-gateway does not validate keys
    models:
      - name: "gpt-5.4"
        alias: "gpt-5.4"
      # add more models as needed — or query /v1/models for the live list
```

### Run as a macOS service (launchd)

Create `~/Library/LaunchAgents/com.codex-gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex-gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/path/to/codex-gateway/index.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WORK_DIR</key>
        <string>/your/trusted/directory</string>
        <key>HTTPS_PROXY</key>
        <string>http://127.0.0.1:7890</string>
        <key>HTTP_PROXY</key>
        <string>http://127.0.0.1:7890</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/codex-gateway.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/codex-gateway.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.codex-gateway.plist
```

## How model auto-discovery works

The Codex CLI caches the upstream model list at `~/.codex/models_cache.json` after each run. codex-gateway watches this file with `fs.watch` and reloads the model list whenever it changes — no restart needed. If the file is unavailable, a built-in fallback list is used.

## License

MIT — see [LICENSE](LICENSE).
