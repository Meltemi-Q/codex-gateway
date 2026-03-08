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
const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
const WORK_DIR = process.env.WORK_DIR || process.cwd();

// Daily token budget (configurable via env, default 10M tokens — rough Codex Pro daily limit)
const DAILY_TOKEN_BUDGET = parseInt(process.env.DAILY_TOKEN_BUDGET || "10000000", 10);
// Warning threshold percentage
const WARN_THRESHOLD = parseFloat(process.env.WARN_THRESHOLD || "0.8"); // 80%

// ---------------------------------------------------------------------------
// Account info (decoded from JWT in auth.json)
// ---------------------------------------------------------------------------

let accountInfo = null;

async function loadAccountInfo() {
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf-8");
    const auth = JSON.parse(raw);
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) return;

    // Decode JWT payload (no verification needed, just reading claims)
    const parts = accessToken.split(".");
    if (parts.length < 2) return;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());

    const authClaims = payload["https://api.openai.com/auth"] || {};
    const profileClaims = payload["https://api.openai.com/profile"] || {};

    accountInfo = {
      plan: authClaims.chatgpt_plan_type || "unknown",
      account_id: authClaims.chatgpt_account_id || null,
      user_id: authClaims.chatgpt_user_id || null,
      email: profileClaims.email || null,
      compute_residency: authClaims.chatgpt_compute_residency || null,
      token_expires: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      token_issued: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    };

    console.log(`[codex-gateway] account: plan=${accountInfo.plan} email=${accountInfo.email} expires=${accountInfo.token_expires}`);
  } catch {
    // auth.json missing or malformed
  }
}

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
// Model pricing ($ per 1M tokens, source: openai.com/api/pricing 2026-03-05)
// ---------------------------------------------------------------------------

const MODEL_PRICING = {
  // { input, cached_input, output } per 1M tokens
  "gpt-5":                { input: 1.25,  cached: 0.125,  output: 10.00 },
  "gpt-5-codex":          { input: 1.25,  cached: 0.125,  output: 10.00 },
  "gpt-5-codex-mini":     { input: 0.25,  cached: 0.025,  output: 2.00  },
  "gpt-5.1":              { input: 1.25,  cached: 0.125,  output: 10.00 },
  "gpt-5.1-codex":        { input: 1.25,  cached: 0.125,  output: 10.00 },
  "gpt-5.1-codex-max":    { input: 1.25,  cached: 0.125,  output: 10.00 },
  "gpt-5.1-codex-mini":   { input: 0.25,  cached: 0.025,  output: 2.00  },
  "gpt-5.2":              { input: 1.75,  cached: 0.175,  output: 14.00 },
  "gpt-5.2-codex":        { input: 1.75,  cached: 0.175,  output: 14.00 },
  "gpt-5.3-codex":        { input: 1.75,  cached: 0.175,  output: 14.00 },
  "gpt-5.4":              { input: 1.75,  cached: 0.175,  output: 14.00 }, // same tier as 5.3
};

// Fallback pricing for unknown models (use gpt-5.1 tier as safe default)
const DEFAULT_PRICING = { input: 1.25, cached: 0.125, output: 10.00 };

function getModelPricing(model) {
  return MODEL_PRICING[model] || DEFAULT_PRICING;
}

function calcCost(model, usage) {
  if (!usage) return 0;
  const p = getModelPricing(model);
  const inputTokens = (usage.input_tokens || 0) - (usage.cached_input_tokens || 0);
  const cachedTokens = usage.cached_input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  return (inputTokens * p.input + cachedTokens * p.cached + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Usage statistics (resets daily)
// ---------------------------------------------------------------------------

const STATS_FILE = path.join(CODEX_HOME, "gateway_stats.json");
const HISTORY_FILE = path.join(CODEX_HOME, "gateway_stats_history.json");
const HISTORY_KEEP_DAYS = parseInt(process.env.HISTORY_KEEP_DAYS || "90", 10);

const usageStats = {
  date: todayStr(),
  total_input_tokens: 0,
  total_cached_input_tokens: 0,
  total_output_tokens: 0,
  total_requests: 0,
  total_errors: 0,
  by_model: {},        // { model: { input, cached_input, output, requests, cost_usd } }
  started_at: new Date().toISOString(),
};

// Daily history: array of past day snapshots
let statsHistory = [];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Archive current day's stats to history, then reset for new day. */
async function archiveAndReset(newDay) {
  // Only archive if there were any requests
  if (usageStats.total_requests > 0) {
    // Build a compact summary for the archive
    let totalCost = 0;
    for (const m of Object.values(usageStats.by_model)) totalCost += m.cost_usd || 0;

    const summary = {
      date: usageStats.date,
      tokens: {
        input: usageStats.total_input_tokens,
        cached_input: usageStats.total_cached_input_tokens,
        output: usageStats.total_output_tokens,
        total: usageStats.total_input_tokens + usageStats.total_output_tokens,
      },
      requests: usageStats.total_requests,
      errors: usageStats.total_errors,
      cost_usd: parseFloat(totalCost.toFixed(6)),
      by_model: usageStats.by_model,
    };

    statsHistory.push(summary);

    // Prune old entries beyond HISTORY_KEEP_DAYS
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - HISTORY_KEEP_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    statsHistory = statsHistory.filter((s) => s.date >= cutoffStr);

    // Persist history
    await fs.writeFile(HISTORY_FILE, JSON.stringify(statsHistory, null, 2)).catch(() => {});
    console.log(`[codex-gateway] archived ${usageStats.date}: ${usageStats.total_requests} reqs, $${totalCost.toFixed(4)}`);
  }

  // Reset for new day
  usageStats.date = newDay;
  usageStats.total_input_tokens = 0;
  usageStats.total_cached_input_tokens = 0;
  usageStats.total_output_tokens = 0;
  usageStats.total_requests = 0;
  usageStats.total_errors = 0;
  usageStats.by_model = {};
  usageStats.started_at = new Date().toISOString();
  console.log(`[codex-gateway] stats reset for new day: ${newDay}`);
}

function ensureTodayStats() {
  const today = todayStr();
  if (usageStats.date !== today) {
    archiveAndReset(today); // fire-and-forget (async but we don't await in hot path)
  }
}

function recordUsage(model, usage) {
  ensureTodayStats();
  const inp = usage.input_tokens || 0;
  const cached = usage.cached_input_tokens || 0;
  const out = usage.output_tokens || 0;

  usageStats.total_input_tokens += inp;
  usageStats.total_cached_input_tokens += cached;
  usageStats.total_output_tokens += out;
  usageStats.total_requests += 1;

  const cost = calcCost(model, usage);

  if (!usageStats.by_model[model]) {
    usageStats.by_model[model] = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, requests: 0, cost_usd: 0 };
  }
  const m = usageStats.by_model[model];
  m.input_tokens += inp;
  m.cached_input_tokens += cached;
  m.output_tokens += out;
  m.requests += 1;
  m.cost_usd = parseFloat((m.cost_usd + cost).toFixed(6));

  // Persist async (best-effort)
  fs.writeFile(STATS_FILE, JSON.stringify(usageStats, null, 2)).catch(() => {});

  // Warn if approaching budget
  const totalUsed = usageStats.total_input_tokens + usageStats.total_output_tokens;
  const pct = totalUsed / DAILY_TOKEN_BUDGET;
  if (pct >= 1.0) {
    console.warn(`[codex-gateway] ⚠️  BUDGET EXCEEDED: ${totalUsed.toLocaleString()} / ${DAILY_TOKEN_BUDGET.toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)`);
  } else if (pct >= WARN_THRESHOLD) {
    console.warn(`[codex-gateway] ⚠️  Budget warning: ${totalUsed.toLocaleString()} / ${DAILY_TOKEN_BUDGET.toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)`);
  }
}

function getStatsSnapshot() {
  ensureTodayStats();
  const totalUsed = usageStats.total_input_tokens + usageStats.total_output_tokens;
  const pct = totalUsed / DAILY_TOKEN_BUDGET;
  let status = "ok";
  if (pct >= 1.0) status = "exceeded";
  else if (pct >= WARN_THRESHOLD) status = "warning";

  // Sum cost across all models
  let totalCost = 0;
  for (const m of Object.values(usageStats.by_model)) {
    totalCost += m.cost_usd || 0;
  }

  return {
    date: usageStats.date,
    budget: {
      daily_limit: DAILY_TOKEN_BUDGET,
      total_used: totalUsed,
      remaining: Math.max(0, DAILY_TOKEN_BUDGET - totalUsed),
      usage_percent: parseFloat((pct * 100).toFixed(2)),
      status,
      warn_threshold_percent: WARN_THRESHOLD * 100,
    },
    cost: {
      total_usd: parseFloat(totalCost.toFixed(6)),
      note: "Estimated API-equivalent cost based on openai.com/api/pricing. Codex Pro/Teams subscriptions have flat monthly pricing.",
    },
    tokens: {
      input: usageStats.total_input_tokens,
      cached_input: usageStats.total_cached_input_tokens,
      output: usageStats.total_output_tokens,
    },
    requests: {
      total: usageStats.total_requests,
      errors: usageStats.total_errors,
    },
    by_model: usageStats.by_model,
    account: accountInfo,
    started_at: usageStats.started_at,
    // Last 7 days summary for quick glance
    recent_days: getRecentDaysSummary(7),
  };
}

function getRecentDaysSummary(days) {
  const recent = statsHistory.slice(-days);
  if (recent.length === 0) return { days: 0, total_tokens: 0, total_cost_usd: 0, avg_daily_cost_usd: 0 };
  let totalTokens = 0, totalCost = 0;
  for (const d of recent) {
    totalTokens += d.tokens?.total || 0;
    totalCost += d.cost_usd || 0;
  }
  return {
    days: recent.length,
    total_tokens: totalTokens,
    total_cost_usd: parseFloat(totalCost.toFixed(6)),
    avg_daily_cost_usd: parseFloat((totalCost / recent.length).toFixed(6)),
    entries: recent.map((d) => ({ date: d.date, requests: d.requests, tokens: d.tokens?.total || 0, cost_usd: d.cost_usd })),
  };
}

function getFullHistory() {
  // Include today as the last entry
  ensureTodayStats();
  let todayCost = 0;
  for (const m of Object.values(usageStats.by_model)) todayCost += m.cost_usd || 0;

  const todayEntry = {
    date: usageStats.date,
    requests: usageStats.total_requests,
    tokens: usageStats.total_input_tokens + usageStats.total_output_tokens,
    cost_usd: parseFloat(todayCost.toFixed(6)),
    is_today: true,
  };

  const history = statsHistory.map((d) => ({
    date: d.date,
    requests: d.requests,
    tokens: d.tokens?.total || 0,
    cost_usd: d.cost_usd,
  }));

  // Grand totals
  let grandTokens = todayEntry.tokens, grandCost = todayEntry.cost_usd, grandReqs = todayEntry.requests;
  for (const d of history) {
    grandTokens += d.tokens;
    grandCost += d.cost_usd;
    grandReqs += d.requests;
  }

  return {
    total_days: history.length + 1,
    grand_total: {
      tokens: grandTokens,
      cost_usd: parseFloat(grandCost.toFixed(6)),
      requests: grandReqs,
    },
    days: [...history, todayEntry],
  };
}

// Load stats from disk on startup (resume today's counts)
async function loadStats() {
  // Load history
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf-8");
    statsHistory = JSON.parse(raw);
    if (!Array.isArray(statsHistory)) statsHistory = [];
    console.log(`[codex-gateway] loaded ${statsHistory.length} days of history`);
  } catch {
    statsHistory = [];
  }

  // Load today's stats
  try {
    const raw = await fs.readFile(STATS_FILE, "utf-8");
    const saved = JSON.parse(raw);
    if (saved.date === todayStr()) {
      Object.assign(usageStats, saved);
      // Backfill cost_usd for models loaded from old stats format
      for (const [model, m] of Object.entries(usageStats.by_model)) {
        if (m.cost_usd == null) {
          m.cost_usd = calcCost(model, {
            input_tokens: m.input_tokens,
            cached_input_tokens: m.cached_input_tokens,
            output_tokens: m.output_tokens,
          });
        }
      }
      const totalUsed = usageStats.total_input_tokens + usageStats.total_output_tokens;
      let totalCost = 0;
      for (const m of Object.values(usageStats.by_model)) totalCost += m.cost_usd || 0;
      console.log(`[codex-gateway] resumed today's stats: ${totalUsed.toLocaleString()} tokens, ${usageStats.total_requests} requests, $${totalCost.toFixed(4)}`);
    } else if (saved.date && saved.date !== todayStr() && saved.total_requests > 0) {
      // Yesterday's stats not yet archived — archive now
      Object.assign(usageStats, saved);
      await archiveAndReset(todayStr());
    }
  } catch {
    // No stats file — start fresh
  }
}

// ---------------------------------------------------------------------------
// Model cache (auto-refreshed by watching models_cache.json)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1", "gpt-5"];

let cachedModels = FALLBACK_MODELS.map((s) => buildModelEntry(s));

// Store full model metadata for context_window, reasoning levels, etc.
let modelMetadata = new Map();

function buildModelEntry(slug, created, meta) {
  const entry = {
    id: slug,
    object: "model",
    created: created ?? Math.floor(Date.now() / 1000),
    owned_by: "openai",
  };
  // Expose context_window and supported reasoning levels in model info
  if (meta) {
    entry.context_window = meta.context_window;
    entry.effective_context_window_percent = meta.effective_context_window_percent;
    if (meta.supported_reasoning_levels) {
      entry.supported_reasoning_levels = meta.supported_reasoning_levels.map((l) => l.effort);
    }
  }
  return entry;
}

async function refreshModels() {
  try {
    const raw = await fs.readFile(MODELS_CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.models)) return;
    const ts = data.fetched_at ? Math.floor(new Date(data.fetched_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const newMeta = new Map();
    const models = data.models
      .filter((m) => m.visibility !== "hidden" && m.slug)
      .map((m) => {
        newMeta.set(m.slug, m);
        return buildModelEntry(m.slug, ts, m);
      });
    if (models.length > 0) {
      cachedModels = models;
      modelMetadata = newMeta;
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
      const content = Array.isArray(m.content)
        ? m.content
            .map((part) => {
              if (typeof part === "string") return part;
              if (part?.type === "text") return part.text ?? "";
              return JSON.stringify(part);
            })
            .join("\n")
        : typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);
      return `${role}\n${content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Resolve reasoning effort for a model.
 * Priority: client request > auto-detect from model name.
 * Validates against supported levels from model metadata.
 */
function resolveReasoningEffort(model, clientEffort) {
  const meta = modelMetadata.get(model);
  const supported = meta?.supported_reasoning_levels?.map((l) =>
    typeof l === "string" ? l : l.effort
  );

  if (clientEffort && supported?.includes(clientEffort)) return clientEffort;
  if (clientEffort && !supported) return clientEffort; // no metadata, trust client

  // Default: mini → high, others → xhigh
  const defaultEffort = /mini/i.test(model) ? "high" : "xhigh";
  if (supported?.includes(defaultEffort)) return defaultEffort;
  // Fallback to highest supported
  if (supported?.length) return supported[supported.length - 1];
  return defaultEffort;
}

/**
 * Run `codex exec` and return the assistant's last message.
 * @param {string} model - Model slug
 * @param {string} prompt - Plain-text prompt
 * @param {object} [opts] - Extra options from client request
 * @param {string} [opts.reasoning_effort] - Reasoning effort level
 * @param {number} [opts.max_tokens] - Max output tokens (mapped to model_max_output_tokens)
 * @param {boolean} [opts.fast_mode] - Enable/disable fast mode (default: false)
 */
async function runCodex(model, prompt, opts = {}) {
  const effort = resolveReasoningEffort(model, opts.reasoning_effort);

  // Build config overrides
  const configArgs = ["-c", `model_reasoning_effort=${effort}`];
  if (opts.max_tokens && Number.isFinite(opts.max_tokens)) {
    configArgs.push("-c", `model_max_output_tokens=${opts.max_tokens}`);
  }

  // Feature toggles — fast_mode defaults to OFF for higher quality
  const featureArgs = [];
  if (opts.fast_mode === true) {
    featureArgs.push("--enable", "fast_mode");
  } else {
    featureArgs.push("--disable", "fast_mode");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE_PATH,
      [
        CODEX_PATH,
        "-a", "never",              // never ask for approval
        "-s", "workspace-write",    // minimal sandbox
        "exec",
        "--ephemeral",              // no session persistence
        "--skip-git-repo-check",    // allow non-git work dirs (needed on Linux servers)
        "--json",                   // JSONL output for precise token tracking
        "--model", model,
        ...configArgs,
        ...featureArgs,
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

    child.on("close", (code) => {
      const elapsed = Math.floor((Date.now() - started) / 1000);

      // Parse JSONL output from codex --json
      let lastAgentText = "";
      let turnUsage = null;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          // Capture the last agent_message text
          if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
            lastAgentText = evt.item.text || "";
          }
          // Capture token usage from turn.completed
          if (evt.type === "turn.completed" && evt.usage) {
            turnUsage = evt.usage;
          }
        } catch {
          // non-JSON line, ignore
        }
      }

      const content = lastAgentText || stderr.trim() || "(no response)";

      // Record token usage for stats tracking
      if (turnUsage) {
        recordUsage(model, turnUsage);
        console.log(
          `[codex-gateway] model=${model} effort=${effort} code=${code} elapsed=${elapsed}s len=${content.length} tokens=${turnUsage.input_tokens}+${turnUsage.output_tokens} cached=${turnUsage.cached_input_tokens || 0} cost=$${calcCost(model, turnUsage).toFixed(6)}`
        );
      } else {
        console.log(
          `[codex-gateway] model=${model} effort=${effort} code=${code} elapsed=${elapsed}s len=${content.length} tokens=unknown`
        );
      }

      if (code === 0) {
        resolve({ content, usage: turnUsage });
        return;
      }
      if (code !== 0) usageStats.total_errors += 1;
      reject(new Error(content));
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

function createChatCompletionPayload(model, content, turnUsage) {
  const usage = turnUsage
    ? {
        prompt_tokens: turnUsage.input_tokens || 0,
        completion_tokens: turnUsage.output_tokens || 0,
        total_tokens: (turnUsage.input_tokens || 0) + (turnUsage.output_tokens || 0),
        cached_tokens: turnUsage.cached_input_tokens || 0,
      }
    : { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 };
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  };
}

function sendChatCompletionStream(res, model, content, includeUsage = false, turnUsage = null) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = turnUsage
    ? {
        prompt_tokens: turnUsage.input_tokens || 0,
        completion_tokens: turnUsage.output_tokens || 0,
        total_tokens: (turnUsage.input_tokens || 0) + (turnUsage.output_tokens || 0),
        cached_tokens: turnUsage.cached_input_tokens || 0,
      }
    : { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 };

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const writeChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeChunk({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  if (content) {
    writeChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  }

  writeChunk({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(includeUsage ? { usage } : {}),
  });

  if (includeUsage) {
    writeChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage,
    });
  }

  res.end("data: [DONE]\n\n");
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

  // GET / or /help — machine & human readable usage info
  if (req.method === "GET" && (route === "/" || route === "/help")) {
    return json(res, 200, {
      name: "codex-gateway",
      version: "1.1.0",
      description: "OpenAI-compatible HTTP gateway wrapping the Codex CLI",
      endpoints: {
        "GET /v1/models": "List available models with context_window, supported_reasoning_levels",
        "POST /v1/chat/completions": "Chat completion (OpenAI-compatible)",
        "GET /v1/stats": "Today's token usage, budget, per-model breakdown, USD cost, and 7-day summary",
        "GET /v1/stats/history": "Full daily history with grand totals (up to 90 days)",
        "GET /v1/help": "This help page",
      },
      request_parameters: {
        model: { type: "string", default: "gpt-5.4", description: "Model slug" },
        messages: { type: "array", required: true, description: "OpenAI-format messages [{role, content}]" },
        stream: { type: "boolean", default: false, description: "Enable SSE streaming" },
        reasoning_effort: {
          type: "string",
          values: ["low", "medium", "high", "xhigh"],
          default: "xhigh (non-mini) / high (mini)",
          description: "Reasoning depth. Auto-validated against model's supported levels.",
        },
        max_tokens: { type: "integer", description: "Max output tokens" },
        max_completion_tokens: { type: "integer", description: "Alias for max_tokens" },
        fast_mode: { type: "boolean", default: false, description: "Codex fast mode. Default off for higher quality. Set true to enable." },
      },
      context_budget: {
        model_context_window: 272000,
        platform_reserved_percent: 5,
        codex_system_overhead_tokens: "~3000",
        effective_user_budget_tokens: "~254000",
      },
      models_count: cachedModels.length,
      account: accountInfo,
      config: { port: PORT, work_dir: WORK_DIR, codex_path: CODEX_PATH },
    });
  }

  // GET /stats — today's usage statistics and budget info
  if (req.method === "GET" && route === "/stats") {
    return json(res, 200, getStatsSnapshot());
  }

  // GET /stats/history — full daily history with grand totals
  if (req.method === "GET" && route === "/stats/history") {
    return json(res, 200, getFullHistory());
  }

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
    const stream = Boolean(payload.stream);
    const includeUsage = Boolean(payload.stream_options?.include_usage);
    const payloadKeys = Object.keys(payload || {}).sort().join(",");

    // Extract extra options from client request
    const runOpts = {};
    // reasoning_effort: OpenAI-compatible field or custom header
    if (payload.reasoning_effort) runOpts.reasoning_effort = payload.reasoning_effort;
    // max_tokens / max_completion_tokens
    if (payload.max_tokens) runOpts.max_tokens = payload.max_tokens;
    if (payload.max_completion_tokens) runOpts.max_tokens = payload.max_completion_tokens;
    // fast_mode: explicit boolean toggle
    if (typeof payload.fast_mode === "boolean") runOpts.fast_mode = payload.fast_mode;

    console.log(
      `[codex-gateway] -> model=${model} stream=${stream} messages=${payload.messages?.length ?? 0} keys=${payloadKeys}`
    );

    let result;
    try {
      result = await runCodex(model, prompt, runOpts);
    } catch (err) {
      console.error(`[codex-gateway] codex error: ${err.message}`);
      return json(res, 500, { error: { message: err.message, type: "server_error", code: "internal_server_error" } });
    }

    if (stream) {
      return sendChatCompletionStream(res, model, result.content, includeUsage, result.usage);
    }

    return json(res, 200, createChatCompletionPayload(model, result.content, result.usage));
  }

  return json(res, 404, { error: { message: `${req.method} ${req.url} not found`, type: "not_found" } });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await refreshModels();
await loadAccountInfo();
await loadStats();
watchModelCache();

// Watch auth.json for token refreshes (plan info may change)
try {
  fsWatch(AUTH_FILE, { persistent: false }, (event) => {
    if (event === "change") loadAccountInfo();
  });
} catch {}


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
