/**
 * codex-gateway
 * A zero-dependency OpenAI-compatible HTTP gateway that wraps the Codex CLI.
 * Models are auto-discovered by watching ~/.codex/models_cache.json —
 * any new model Codex CLI fetches from upstream becomes available immediately.
 *
 * Endpoints:
 *   GET  /v1/models              → list available Codex models
 *   POST /v1/chat/completions    → forward to Codex CLI (any model name)
 *
 * Config (environment variables):
 *   PORT              Server port (default: 8319)
 *   CODEX_PATH        Path to codex binary (auto-detected)
 *   CODEX_HOME        Codex data dir (default: ~/.codex)
 *   WORK_DIR          Working directory for codex CLI (default: cwd)
 *   HTTPS_PROXY       Upstream proxy (forwarded to codex subprocess)
 *   HTTP_PROXY        Upstream proxy (forwarded to codex subprocess)
 *   ALL_PROXY         Upstream proxy (forwarded to codex subprocess)
 *   NO_PROXY          Proxy bypass list
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs, watch as fsWatch } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "8319", 10);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const MODELS_CACHE_FILE = path.join(CODEX_HOME, "models_cache.json");
const WORK_DIR = process.env.WORK_DIR || process.cwd();

// Resolve the codex binary: CODEX_PATH env > same node_modules as the running
// node > well-known paths > fallback to "codex" on PATH.
function resolveCodexPath() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  // Prefer the same nvm node version that started this process
  const nodeDir = path.dirname(process.execPath);
  const candidate = path.join(nodeDir, "codex");
  if (existsSync(candidate)) return candidate;
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    if (existsSync(p)) return p;
  }
  return "codex"; // rely on PATH
}
const CODEX_PATH = resolveCodexPath();
const NODE_PATH = process.execPath; // same node that launched us

// ---------------------------------------------------------------------------
// Model cache (auto-refreshed by watching models_cache.json)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1", "gpt-5"];

let cachedModels = FALLBACK_MODELS.map(buildModelEntry);

function buildModelEntry(slug, created) {
  return {
    id: slug,
    object: "model",
    created: created ?? Math.floor(Date.now() / 1000),
    owned_by: "openai",
  };
}

async function refreshModels() {
  try {
    const raw = await fs.readFile(MODELS_CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.models)) return;
    const ts = data.fetched_at ? Math.floor(new Date(data.fetched_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const models = data.models
      .filter((m) => m.visibility !== "hidden" && m.slug)
      .map((m) => buildModelEntry(m.slug, ts));
    if (models.length > 0) {
      cachedModels = models;
      console.log(`[codex-gateway] models refreshed (${models.length}): ${models.map((m) => m.id).join(", ")}`);
    }
  } catch {
    // cache file missing or malformed — keep current list
  }
}

// Watch models_cache.json for changes written by the Codex CLI
function watchModelCache() {
  try {
    fsWatch(MODELS_CACHE_FILE, { persistent: false }, (event) => {
      if (event === "change") refreshModels();
    });
    console.log(`[codex-gateway] watching ${MODELS_CACHE_FILE}`);
  } catch {
    console.warn(`[codex-gateway] could not watch ${MODELS_CACHE_FILE}, will use cached/fallback list`);
  }
}

// ---------------------------------------------------------------------------
// Codex CLI invocation
// ---------------------------------------------------------------------------

/** Build the env for the codex subprocess, ensuring proxy and HOME are set. */
function buildSpawnEnv() {
  const env = { ...process.env };

  // Ensure HOME so codex can find ~/.codex/auth.json
  if (!env.HOME) env.HOME = os.homedir();

  // Propagate proxy settings from our own env (already set by launchd plist or shell)
  // If caller set explicit proxy vars, those take precedence.
  const proxyVars = ["https_proxy", "http_proxy", "all_proxy", "no_proxy", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
  for (const v of proxyVars) {
    if (process.env[v] && !env[v]) env[v] = process.env[v];
  }

  // Make sure the node bin directory is on PATH so the codex shebang resolves
  const nodeDir = path.dirname(process.execPath);
  const existingPath = env.PATH || "";
  if (!existingPath.includes(nodeDir)) {
    env.PATH = `${nodeDir}:${existingPath}`;
  }

  return env;
}

/**
 * Convert an OpenAI messages array into a plain-text prompt for the Codex CLI.
 * Codex is an agentic model — we format the conversation clearly so it
 * understands the context and only needs to reply to the last user turn.
 */
function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return messages
    .map((m) => {
      const role = m.role === "system" ? "[System]" : m.role === "assistant" ? "[Assistant]" : "[User]";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}\n${content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Run `codex exec` and return the assistant's last message.
 */
async function runCodex(model, prompt) {
  const tmpFile = path.join(os.tmpdir(), `cgw-${crypto.randomBytes(8).toString("hex")}.txt`);

  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE_PATH,
      [
        CODEX_PATH,
        "-a", "never",              // never ask for approval
        "-s", "workspace-write",    // minimal sandbox
        "exec",
        "--skip-git-repo-check",    // allow non-git work dirs (needed on Linux servers)
        "--model", model,
        "--output-last-message", tmpFile,
        "-",                        // read prompt from stdin
      ],
      { cwd: WORK_DIR, env: buildSpawnEnv(), stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    const started = Date.now();

    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", reject);

    child.on("close", async (code) => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      let lastMsg = "";
      try { lastMsg = (await fs.readFile(tmpFile, "utf-8")).trim(); } catch {}
      try { await fs.unlink(tmpFile); } catch {}

      const content = lastMsg || stdout.trim() || stderr.trim() || "(no response)";
      console.log(`[codex-gateway] model=${model} code=${code} elapsed=${elapsed}s len=${content.length}`);
      resolve(content);
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url?.split("?")[0] ?? "/";

  // Strip /v1 prefix so the server works whether mounted at / or /v1
  const route = url.startsWith("/v1") ? url.slice(3) : url;

  // GET /models
  if (req.method === "GET" && route === "/models") {
    return json(res, 200, { object: "list", data: cachedModels });
  }

  // POST /chat/completions
  if (req.method === "POST" && route === "/chat/completions") {
    let payload;
    try { payload = await readBody(req); }
    catch { return json(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } }); }

    const model = payload.model || "gpt-5.4";
    const prompt = messagesToPrompt(payload.messages);

    console.log(`[codex-gateway] -> model=${model} messages=${payload.messages?.length ?? 0}`);

    let content;
    try {
      content = await runCodex(model, prompt);
    } catch (err) {
      console.error(`[codex-gateway] codex error: ${err.message}`);
      return json(res, 500, { error: { message: err.message, type: "server_error", code: "internal_server_error" } });
    }

    return json(res, 200, {
      id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
    });
  }

  return json(res, 404, { error: { message: `${req.method} ${req.url} not found`, type: "not_found" } });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await refreshModels();
watchModelCache();

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("[codex-gateway] unhandled:", err);
    json(res, 500, { error: { message: "Internal server error", type: "server_error" } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[codex-gateway] listening on http://127.0.0.1:${PORT}`);
  console.log(`[codex-gateway] codex binary: ${CODEX_PATH}`);
  console.log(`[codex-gateway] work dir:     ${WORK_DIR}`);
  console.log(`[codex-gateway] models cache: ${MODELS_CACHE_FILE}`);
});
