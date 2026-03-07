# codex-gateway

A zero-dependency, OpenAI-compatible HTTP gateway that wraps the [Codex CLI](https://github.com/openai/codex) and exposes it as a local API server.

**Key feature:** Models are auto-discovered by watching `~/.codex/models_cache.json` — whenever the Codex CLI fetches a new model list from upstream, the gateway picks it up instantly with no restart or manual configuration needed.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available Codex models (live from cache) |
| `POST` | `/v1/chat/completions` | Forward chat requests to the Codex CLI (streaming and non-streaming) |

The API is OpenAI-compatible — any client that works with the OpenAI SDK will work with codex-gateway.

## Requirements

- Node.js 18+
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`)
- A working directory that Codex trusts (listed in `~/.codex/config.toml`)

## Quick install (recommended)

Clone the repo and run the setup wizard — it detects your environment, asks a few questions, and installs a system service automatically.

```bash
git clone https://github.com/Meltemi-Q/codex-gateway.git
cd codex-gateway
bash setup.sh
```

If you want a real one-liner, use the bootstrap installer instead:

```bash
curl -fsSL https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.sh | \
  bash -s -- --yes --sync-droid --set-default-droid
```

That command:
- clones or updates `~/codex-gateway`
- installs `codex-gateway` as a launchd/systemd service
- imports the current model list into Droid
- sets `GPT-5.4 [Codex Gateway]` as the default Droid session model

No trailing `&` is needed. The installer registers a system service, so the gateway keeps running after the shell exits.

The wizard will:
- Detect your Node.js and codex binary paths automatically
- Ask for port (default `8319`), working directory, and optional proxy
- Install a **launchd** service on macOS (auto-starts on login)
- Install a **systemd** service on Linux (auto-starts on boot)

After setup, test with:

```bash
curl http://127.0.0.1:8319/v1/models
```

For a non-interactive local install without the bootstrap helper:

```bash
bash setup.sh --yes --sync-droid --set-default-droid
```

### Windows

```powershell
git clone https://github.com/Meltemi-Q/codex-gateway.git
cd codex-gateway
powershell -ExecutionPolicy Bypass -File setup.ps1
```

If you want the Windows one-line bootstrap installer:

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.ps1))) -Yes -SyncDroid -SetDefaultDroid"
```

That command:
- clones or updates `%USERPROFILE%\codex-gateway`
- installs `codex-gateway` as a Task Scheduler job
- imports the current model list into Droid
- sets `GPT-5.4 [Codex Gateway]` as the default Droid session model

No trailing `&` is needed. The installer registers a scheduled task, so the gateway keeps running after the shell exits.

For a non-interactive local install from an existing clone:

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1 -Yes -SyncDroid -SetDefaultDroid
```

## Manual usage

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
| `HTTP_PROXY` | — | Upstream proxy forwarded to the codex subprocess |
| `ALL_PROXY` | — | Upstream proxy forwarded to the codex subprocess |
| `NO_PROXY` | — | Proxy bypass list |

### Example request

```bash
curl http://127.0.0.1:8319/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Write a hello world in Go"}]
  }'
```

### Use with any OpenAI-compatible client

Point your client's base URL to `http://127.0.0.1:8319` and use any API key (not validated):

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8319/v1", api_key="any")
response = client.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### One-click import into Droid

If you use Droid locally, import the current codex-gateway model list into `~/.factory/config.json` and `~/.factory/settings.json` with one command:

```bash
npm run sync:droid
```

Useful flags:

```bash
# Also make GPT-5.4 [Codex Gateway] the default Droid session model
npm run sync:droid -- --set-default

# Write a different Droid base URL
npm run sync:droid -- --base-url http://127.0.0.1:8400/v1
```

The importer:
- writes Droid entries with `provider: "generic-chat-completion-api"`
- creates `config.json.bak` and `settings.json.bak` before overwriting
- reads the live gateway `/v1/models` endpoint when available, then falls back to `~/.codex/models_cache.json`

### Use with cliproxyapi

Add codex-gateway as an `openai-compatibility` provider in `~/.cli-proxy-api/config.yaml`:

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

## How model auto-discovery works

The Codex CLI caches the upstream model list at `~/.codex/models_cache.json` after each run. codex-gateway watches this file with `fs.watch` and reloads the model list whenever it changes — no restart needed. If the file is unavailable, a built-in fallback list is used.

New models released by OpenAI appear automatically the next time the Codex CLI runs.

## Authentication

codex-gateway uses the credentials stored by `codex login` (`~/.codex/auth.json`). Tokens are valid for 10 days and auto-refresh. Run `codex login` again if you see auth errors.

## License

MIT — see [LICENSE](LICENSE).
