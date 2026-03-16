/**
 * codex-gateway
 * A zero-dependency OpenAI-compatible HTTP gateway that wraps the Codex CLI.
 * Models are auto-discovered by watching ~/.codex/models_cache.json —
 * any new model Codex CLI fetches from upstream becomes available immediately.
 *
 * Multi-account rotation: the gateway automatically discovers auth-*.json
 * files in CODEX_HOME, provisions isolated account directories under
 * CODEX_HOME/accounts/, and distributes requests evenly via round-robin.
 * When a rate-limit (429) or quota error is detected the failing account
 * enters a cooldown period and the request is retried on the next account.
 * Each account tracks its own consumption percentage independently;
 * aggregate cost is reported globally.
 *
 * Endpoints:
 *   GET  /v1/models              → list available Codex models
 *   POST /v1/chat/completions    → forward to Codex CLI (any model name)
 *   GET  /v1/stats               → usage stats (global + per-account)
 *   GET  /v1/stats/history       → daily history
 *   GET  /v1/accounts            → account pool status
 *   POST /v1/auth-sync           → manually trigger auth file sync to remote
 *
 * Config (environment variables):
 *   PORT              Server port (default: 8319)
 *   BIND_ADDR         Bind address (default: 127.0.0.1, set to 0.0.0.0 for external access)
 *   GATEWAY_API_KEY   API key for authentication (required when BIND_ADDR != 127.0.0.1)
 *   CODEX_PATH        Path to codex binary (auto-detected)
 *   CODEX_HOME        Codex data dir (default: ~/.codex)
 *   WORK_DIR          Working directory for codex CLI (default: cwd)
 *   CODEX_EXEC_TIMEOUT_MS  Kill a codex exec request after this many ms (default: 120000 = 120s)
 *   ACCOUNT_COOLDOWN_MS  Cooldown after rate-limit per account (default: 300000 = 5 min)
 *   AUTH_SYNC_TARGET  Remote scp target for auth file sync (e.g. "root@vps:~/.codex/")
 *   AUTH_SYNC_SSH_OPTS  Extra ssh/scp options (e.g. "-i ~/.ssh/id_rsa")
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
const BIND_ADDR = process.env.BIND_ADDR || "127.0.0.1";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const MODELS_CACHE_FILE = path.join(CODEX_HOME, "models_cache.json");
const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
const ACCOUNTS_DIR = path.join(CODEX_HOME, "accounts");
const WORK_DIR = process.env.WORK_DIR || process.cwd();
const DEFAULT_CODEX_EXEC_TIMEOUT_MS = 120000;
const CODEX_EXEC_TIMEOUT_MS_RAW = parseInt(
  process.env.CODEX_EXEC_TIMEOUT_MS || String(DEFAULT_CODEX_EXEC_TIMEOUT_MS),
  10
);
const CODEX_EXEC_TIMEOUT_MS =
  Number.isFinite(CODEX_EXEC_TIMEOUT_MS_RAW) && CODEX_EXEC_TIMEOUT_MS_RAW > 0
    ? CODEX_EXEC_TIMEOUT_MS_RAW
    : DEFAULT_CODEX_EXEC_TIMEOUT_MS;
const ACCOUNT_COOLDOWN_MS = parseInt(process.env.ACCOUNT_COOLDOWN_MS || "300000", 10); // 5 min default
const ACCOUNT_SCAN_INTERVAL_MS = parseInt(process.env.ACCOUNT_SCAN_INTERVAL_MS || "60000", 10); // rescan every 60s
const SELF_HEAL_INTERVAL_MS = 5 * 60 * 1000; // self-heal sweep every 5 min
const DISABLED_RETRY_AFTER_MS = 5 * 60 * 1000; // retry refreshable disabled accounts after 5 min (OAuth refresh is free)

// API key authentication (required when BIND_ADDR is not 127.0.0.1)
const API_KEY = process.env.GATEWAY_API_KEY || "";

// Auth-sync: push local auth files to a remote gateway instance via scp
// Set AUTH_SYNC_TARGET to enable, e.g. "root@vps:~/.codex/"
const AUTH_SYNC_TARGET = process.env.AUTH_SYNC_TARGET || "";
const AUTH_SYNC_SSH_OPTS = process.env.AUTH_SYNC_SSH_OPTS || ""; // e.g. "-i ~/.ssh/id_rsa" or "-o StrictHostKeyChecking=no"

// Daily token budget per account (configurable via env, default 10M tokens)
const DAILY_TOKEN_BUDGET = parseInt(process.env.DAILY_TOKEN_BUDGET || "10000000", 10);
const WARN_THRESHOLD = parseFloat(process.env.WARN_THRESHOLD || "0.8"); // 80%

// ---------------------------------------------------------------------------
// API key authentication
// ---------------------------------------------------------------------------

function verifyApiKey(req) {
  if (!API_KEY) return true; // no key configured = open access (local only)
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === API_KEY;
  if (auth === API_KEY) return true;
  // Also check x-api-key header
  return req.headers["x-api-key"] === API_KEY;
}

// ---------------------------------------------------------------------------
// Auth-sync: push auth files to remote gateway via scp
// ---------------------------------------------------------------------------

let authSyncDebounce = null;

async function syncAuthToRemote() {
  if (!AUTH_SYNC_TARGET) return;

  const files = [];
  try {
    const entries = await fs.readdir(CODEX_HOME);
    for (const name of entries) {
      if (name === "auth.json" || /^auth-.+\.json$/.test(name)) {
        files.push(path.join(CODEX_HOME, name));
      }
    }
  } catch { return; }

  if (files.length === 0) return;

  const sshOpts = AUTH_SYNC_SSH_OPTS ? AUTH_SYNC_SSH_OPTS.split(/\s+/) : [];
  const scpArgs = [...sshOpts, ...files, AUTH_SYNC_TARGET];

  console.log(`[auth-sync] pushing ${files.length} auth files to ${AUTH_SYNC_TARGET}`);

  try {
    const child = spawn("scp", scpArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    await new Promise((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          console.log(`[auth-sync] pushed ${files.length} files OK`);
          resolve();
        } else {
          console.error(`[auth-sync] scp failed (code=${code}): ${stderr.trim()}`);
          reject(new Error(stderr));
        }
      });
      child.on("error", reject);
    });
  } catch (err) {
    console.error(`[auth-sync] error: ${err.message}`);
  }
}

function triggerAuthSync() {
  if (!AUTH_SYNC_TARGET) return;
  clearTimeout(authSyncDebounce);
  authSyncDebounce = setTimeout(() => syncAuthToRemote(), 2000); // debounce 2s
}

// ---------------------------------------------------------------------------
// Multi-account pool
// ---------------------------------------------------------------------------

/**
 * Each account entry:
 * {
 *   label: string,          — human-readable label (e.g. "qq964", "gmail964", "primary")
 *   authFile: string,       — source auth-*.json path
 *   codexHome: string,      — isolated CODEX_HOME for this account (accounts/{label}/)
 *   info: object|null,      — decoded JWT info (plan, email, etc.)
 *   cooldownUntil: number,  — timestamp (ms) when cooldown expires (0 = available)
 *   stats: {                — per-account daily stats
 *     date, requests, errors, input_tokens, output_tokens, cached_input_tokens
 *   }
 * }
 */
let accountPool = [];
let roundRobinIndex = 0;

function decodeAccountJWT(authJson) {
  try {
    const accessToken = authJson.tokens?.access_token;
    if (!accessToken) return null;
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const authClaims = payload["https://api.openai.com/auth"] || {};
    const profileClaims = payload["https://api.openai.com/profile"] || {};
    return {
      plan: authClaims.chatgpt_plan_type || "unknown",
      account_id: authClaims.chatgpt_account_id || null,
      user_id: authClaims.chatgpt_user_id || null,
      email: profileClaims.email || null,
      compute_residency: authClaims.chatgpt_compute_residency || null,
      token_expires: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      token_issued: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    };
  } catch {
    return null;
  }
}

function freshAccountStats() {
  return {
    date: todayStr(),
    requests: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
  };
}

function ensureAccountStatsToday(acct) {
  const today = todayStr();
  if (acct.stats.date !== today) {
    acct.stats = freshAccountStats();
  }
}

// Shared files/dirs to symlink into each account's isolated CODEX_HOME
const SHARED_ITEMS = ["models_cache.json", "config.toml", "memories", "rules", "skills"];

async function provisionAccountDir(label) {
  const dir = path.join(ACCOUNTS_DIR, label);
  await fs.mkdir(dir, { recursive: true });

  for (const item of SHARED_ITEMS) {
    const src = path.join(CODEX_HOME, item);
    const dst = path.join(dir, item);
    try {
      await fs.lstat(dst);
    } catch {
      try {
        await fs.lstat(src);
        await fs.symlink(src, dst);
      } catch { /* source doesn't exist, skip */ }
    }
  }

  return dir;
}

async function discoverAndProvisionAccounts() {
  await fs.mkdir(ACCOUNTS_DIR, { recursive: true });

  // Collect all auth-*.json from CODEX_HOME root
  const sourceFiles = new Map(); // label -> source path
  try {
    const entries = await fs.readdir(CODEX_HOME);
    for (const name of entries) {
      // Match auth.json (primary) and auth-{label}.json
      if (name === "auth.json") {
        sourceFiles.set("primary", path.join(CODEX_HOME, name));
      } else {
        const m = name.match(/^auth-(.+)\.json$/);
        if (m) sourceFiles.set(m[1], path.join(CODEX_HOME, name));
      }
    }
  } catch { /* CODEX_HOME unreadable */ }

  // Also scan accounts/ for any manually placed auth files
  try {
    const acctDirs = await fs.readdir(ACCOUNTS_DIR, { withFileTypes: true });
    for (const d of acctDirs) {
      if (d.isDirectory()) {
        const authPath = path.join(ACCOUNTS_DIR, d.name, "auth.json");
        try {
          await fs.access(authPath);
          if (!sourceFiles.has(d.name)) {
            sourceFiles.set(d.name, authPath);
          }
        } catch { /* no auth.json in this dir */ }
      }
    }
  } catch { /* accounts dir doesn't exist yet */ }

  // Provision each account
  const pool = [];
  for (const [label, srcPath] of sourceFiles) {
    try {
      const raw = await fs.readFile(srcPath, "utf-8");
      const authJson = JSON.parse(raw);
      const codexHome = await provisionAccountDir(label);

      // Copy auth.json into the account's isolated dir (always named auth.json)
      const dstAuth = path.join(codexHome, "auth.json");
      // Only copy if source is outside the account dir (avoid self-copy)
      if (path.dirname(srcPath) !== codexHome) {
        await fs.writeFile(dstAuth, raw);
      }

      const info = decodeAccountJWT(authJson);
      pool.push({
        label,
        authFile: srcPath,
        codexHome,
        info,
        cooldownUntil: 0,
        stats: freshAccountStats(),
      });

      console.log(
        `[codex-gateway] account: ${label} plan=${info?.plan || "?"} email=${info?.email || "?"} expires=${info?.token_expires || "?"}`
      );
    } catch (err) {
      console.warn(`[codex-gateway] skipping account ${label}: ${err.message}`);
    }
  }

  if (pool.length === 0) {
    console.error("[codex-gateway] no accounts found! Place auth.json or auth-{label}.json in " + CODEX_HOME);
  }

  // Validate accounts: check JWT expiry and mark disabled
  const now = Date.now();
  for (const acct of pool) {
    if (acct.info?.token_expires) {
      const expiresMs = new Date(acct.info.token_expires).getTime();
      if (expiresMs < now) {
        acct.disabled = true;
        acct.disabledReason = `JWT expired at ${acct.info.token_expires}`;
        console.warn(`[codex-gateway] account ${acct.label} (${acct.info?.email}) DISABLED: JWT expired`);
      }
    }
  }

  // De-duplicate by account_id (same account logged in twice)
  const seen = new Map();
  for (const acct of pool) {
    const key = acct.info?.account_id || acct.label;
    if (!seen.has(key)) {
      seen.set(key, acct);
    } else {
      // Keep the one with later token expiry
      const existing = seen.get(key);
      const existExp = existing.info?.token_expires ? new Date(existing.info.token_expires).getTime() : 0;
      const newExp = acct.info?.token_expires ? new Date(acct.info.token_expires).getTime() : 0;
      if (newExp > existExp) {
        seen.set(key, acct);
        console.log(`[codex-gateway] dedup: ${acct.label} supersedes ${existing.label} (newer token)`);
      } else {
        console.log(`[codex-gateway] dedup: ${existing.label} kept over ${acct.label}`);
      }
    }
  }

  // Preserve per-account stats and cooldown state for accounts that already existed
  const newPool = [...seen.values()];
  const oldByLabel = new Map(accountPool.map((a) => [a.label, a]));
  for (const acct of newPool) {
    const old = oldByLabel.get(acct.label);
    if (old) {
      acct.stats = old.stats;
      acct.cooldownUntil = old.cooldownUntil;
      // Re-enable if the auth file was updated (new token), otherwise preserve disabled state
      if (old.disabled) {
        const oldExpiry = old.info?.token_expires ? new Date(old.info.token_expires).getTime() : 0;
        const newExpiry = acct.info?.token_expires ? new Date(acct.info.token_expires).getTime() : 0;
        if (newExpiry > oldExpiry) {
          console.log(`[codex-gateway] account ${acct.label} re-enabled (new token detected)`);
        } else {
          acct.disabled = old.disabled;
          acct.disabledReason = old.disabledReason;
          acct.disabledAt = old.disabledAt;
        }
      }
    }
  }

  const oldLabels = accountPool.map((a) => a.label).sort().join(",");
  const newLabels = newPool.map((a) => a.label).sort().join(",");
  accountPool = newPool;

  if (oldLabels !== newLabels) {
    console.log(`[codex-gateway] account pool: ${accountPool.length} accounts [${accountPool.map((a) => a.label).join(", ")}]`);
  }
}

/** Periodic re-sync: update auth.json inside each account dir from source files */
async function syncAccountAuthFiles() {
  for (const acct of accountPool) {
    try {
      const srcPath = acct.authFile;
      const dstPath = path.join(acct.codexHome, "auth.json");
      if (path.dirname(srcPath) === acct.codexHome) continue;

      const srcStat = await fs.stat(srcPath).catch(() => null);
      const dstStat = await fs.stat(dstPath).catch(() => null);
      if (!srcStat) continue;

      // Only copy if source is newer
      if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
        const raw = await fs.readFile(srcPath, "utf-8");
        await fs.writeFile(dstPath, raw);
        const authJson = JSON.parse(raw);
        const newInfo = decodeAccountJWT(authJson);
        if (newInfo) acct.info = newInfo;
        console.log(`[codex-gateway] synced auth for account ${acct.label}`);
      }
    } catch { /* best effort */ }
  }
}

function isMultiAccountMode() {
  return accountPool.filter((a) => !a.disabled).length > 1;
}

function pickNextAccount() {
  const available = accountPool.filter((a) => !a.disabled);
  if (available.length === 0) return null;
  if (available.length === 1) return available[0];

  const now = Date.now();

  // Try round-robin, skipping cooled-down and disabled accounts
  for (let i = 0; i < available.length; i++) {
    const idx = (roundRobinIndex + i) % available.length;
    const acct = available[idx];
    if (acct.cooldownUntil <= now) {
      roundRobinIndex = (idx + 1) % available.length;
      return acct;
    }
  }

  // All available accounts are on cooldown — pick the one that expires soonest
  let soonest = available[0];
  for (const acct of available) {
    if (acct.cooldownUntil < soonest.cooldownUntil) soonest = acct;
  }
  console.warn(
    `[codex-gateway] all accounts on cooldown, using ${soonest.label} (cooldown ends ${new Date(soonest.cooldownUntil).toISOString()})`
  );
  return soonest;
}

function markAccountCooldown(acct, reason) {
  acct.cooldownUntil = Date.now() + ACCOUNT_COOLDOWN_MS;
  acct.stats.errors += 1;
  console.warn(
    `[codex-gateway] account ${acct.label} rate-limited, cooldown until ${new Date(acct.cooldownUntil).toISOString()} reason=${reason || "rate_limit"}`
  );
}

function markAccountDisabled(acct, reason, errorCategory) {
  const category = errorCategory || classifyError(reason);
  const recoverability = errorRecoverability(category);

  // For refreshable errors: don't disable on first occurrence, try reprobe first
  if (recoverability === "refreshable" && !acct._reprobeAttempted) {
    acct._reprobeAttempted = true;
    acct.cooldownUntil = Date.now() + ACCOUNT_COOLDOWN_MS;
    acct.stats.errors += 1;
    console.warn(
      `[codex-gateway] account ${acct.label} refreshable error (category=${category}), cooldown + pending reprobe instead of immediate disable`
    );
    // Schedule async reprobe
    setTimeout(() => {
      refreshAccountRateLimits(acct, { force: true })
        .then(() => {
          acct._reprobeAttempted = false;
          console.log(`[codex-gateway] account ${acct.label} reprobe succeeded, keeping active`);
        })
        .catch((err) => {
          // Reprobe failed — now actually disable
          acct.disabled = true;
          acct.disabledReason = reason;
          acct.disabledAt = new Date().toISOString();
          acct.errorCategory = category;
          console.error(`[codex-gateway] account ${acct.label} reprobe failed, now DISABLED: ${err.message}`);
        });
    }, 5000);
    return;
  }

  // For cooldown-only: never disable, just cooldown
  if (recoverability === "cooldown-only") {
    markAccountCooldown(acct, reason);
    return;
  }

  // Non-refreshable or reprobe already attempted: disable
  acct.disabled = true;
  acct.disabledReason = reason;
  acct.disabledAt = new Date().toISOString();
  acct.errorCategory = category;
  acct._reprobeAttempted = false;
  acct.stats.errors += 1;
  console.error(
    `[codex-gateway] account ${acct.label} DISABLED: category=${category} recoverability=${recoverability} reason=${reason}`
  );
}

/**
 * Refresh an account's OAuth2 token.
 * Step 1: Try OAuth2 refresh_token grant (zero-cost, no API usage).
 * Step 2: If OAuth fails, check if auth file was updated externally.
 * Step 3: If opts.force, run a lightweight probe as last resort.
 */
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

async function oauthRefreshToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    let errMsg = `HTTP ${resp.status}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.error_description || errJson.error || errMsg;
    } catch {}
    throw new Error(`oauth refresh failed: ${errMsg}`);
  }
  return resp.json();
}

async function refreshAccountRateLimits(acct, opts = {}) {
  const authPath = acct.authFile;

  // Step 1: OAuth2 refresh_token grant (preferred — zero cost)
  if (authPath) {
    try {
      const raw = await fs.readFile(authPath, "utf-8");
      const authData = JSON.parse(raw);
      const oldRefreshToken = authData?.tokens?.refresh_token;

      if (oldRefreshToken) {
        console.log(`[codex-gateway] refresh: ${acct.label} attempting OAuth2 refresh...`);
        const newTokens = await oauthRefreshToken(oldRefreshToken);

        // Update auth file with new tokens (refresh token rotation)
        authData.tokens.access_token = newTokens.access_token || authData.tokens.access_token;
        if (newTokens.refresh_token) {
          authData.tokens.refresh_token = newTokens.refresh_token;
        }
        if (newTokens.id_token) {
          authData.tokens.id_token = newTokens.id_token;
        }
        authData.last_refresh = new Date().toISOString();
        await fs.writeFile(authPath, JSON.stringify(authData, null, 2));

        // Update in-memory account info from new JWT
        const at = newTokens.access_token || authData.tokens.access_token;
        const parts = at.split(".");
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
          if (acct.info) {
            acct.info.token_expires = new Date((payload.exp || 0) * 1000).toISOString();
            acct.info.plan = payload.plan || acct.info.plan;
            acct.info.email = payload.email || acct.info.email;
          }
        }

        // Also sync to account's isolated dir if it exists
        const acctDir = path.join(ACCOUNTS_DIR, acct.label);
        const acctAuth = path.join(acctDir, "auth.json");
        try { await fs.copyFile(authPath, acctAuth); } catch {}

        console.log(`[codex-gateway] refresh: ${acct.label} OAuth2 refresh succeeded, new expiry: ${acct.info?.token_expires}`);
        return { refreshed: true, method: "oauth2_refresh" };
      }
    } catch (e) {
      console.warn(`[codex-gateway] refresh: ${acct.label} OAuth2 refresh failed: ${e.message}`);
      // Fall through to other methods
    }
  }

  // Step 2: Check if auth file was updated externally (e.g., manual re-login)
  if (authPath) {
    try {
      const raw = await fs.readFile(authPath, "utf-8");
      const authData = JSON.parse(raw);
      const token = authData?.tokens?.access_token;
      if (token) {
        const parts = token.split(".");
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
          const newExpiry = new Date((payload.exp || 0) * 1000).toISOString();
          const oldExpiry = acct.info?.token_expires;
          if (newExpiry !== oldExpiry && new Date(newExpiry) > new Date()) {
            if (acct.info) {
              acct.info.token_expires = newExpiry;
              acct.info.plan = payload.plan || acct.info?.plan;
              acct.info.email = payload.email || acct.info?.email;
            }
            console.log(`[codex-gateway] refresh: ${acct.label} token updated externally (new expiry: ${newExpiry})`);
            return { refreshed: true, method: "external_update" };
          }
        }
      }
    } catch (e) {}
  }

  // Step 3: Lightweight probe (costs minimal tokens)
  if (opts.force) {
    const probeModel = "codex-mini-latest";
    console.log(`[codex-gateway] refresh: probing ${acct.label} with ${probeModel}...`);
    const result = await runCodexWithAccount(probeModel, "Reply OK", { max_tokens: 10, reasoning_effort: "low" }, acct);
    if (result.rateLimited) throw new Error("probe: rate limited");
    if (result.authFailed) throw new Error("probe: auth failed");
    if (result.workspaceFailed) throw new Error("probe: workspace deactivated");
    if (result.billingFailed) throw new Error("probe: billing failed");
    console.log(`[codex-gateway] refresh: ${acct.label} probe succeeded`);
    return { refreshed: true, method: "probe_success" };
  }

  throw new Error("No refresh method succeeded");
}

function recordAccountUsage(acct, usage) {
  if (!usage) return;
  ensureAccountStatsToday(acct);
  acct.stats.requests += 1;
  acct.stats.input_tokens += usage.input_tokens || 0;
  acct.stats.output_tokens += usage.output_tokens || 0;
  acct.stats.cached_input_tokens += usage.cached_input_tokens || 0;
}

function getAccountPoolStatus() {
  const now = Date.now();
  return accountPool.map((acct) => {
    ensureAccountStatsToday(acct);
    const totalTokens = acct.stats.input_tokens + acct.stats.output_tokens;
    const pct = totalTokens / DAILY_TOKEN_BUDGET;
    let status = "available";
    if (acct.disabled) status = "disabled";
    else if (acct.cooldownUntil > now) status = "cooldown";
    const entry = {
      label: acct.label,
      plan: acct.info?.plan || "unknown",
      email: acct.info?.email || null,
      token_expires: acct.info?.token_expires || null,
      status,
      cooldown_remaining_sec: acct.cooldownUntil > now ? Math.ceil((acct.cooldownUntil - now) / 1000) : 0,
      today: {
        requests: acct.stats.requests,
        errors: acct.stats.errors,
        tokens: totalTokens,
        usage_percent: parseFloat((pct * 100).toFixed(2)),
        budget: DAILY_TOKEN_BUDGET,
      },
    };
    if (acct.disabled) {
      entry.disabled_reason = acct.disabledReason;
      entry.disabled_at = acct.disabledAt;
      entry.error_category = acct.errorCategory || "unknown";
      entry.recoverability = errorRecoverability(acct.errorCategory || "unknown");
    }
    const expiry = getTokenExpiryWarning(acct);
    entry.token_expiry = expiry;
    return entry;
  });
}

function getProviderReadiness() {
  const now = Date.now();
  const healthyCount = accountPool.filter(a => !a.disabled && a.cooldownUntil <= now).length;
  const totalCount = accountPool.length;
  let status;
  if (healthyCount === 0) status = "down";
  else if (healthyCount === 1) status = "degraded";
  else status = "healthy";

  // Expiry warnings
  const expiringAccounts = accountPool
    .map(a => ({ label: a.label, ...getTokenExpiryWarning(a) }))
    .filter(e => e.warning_level !== "ok" && e.warning_level !== "unknown");

  return {
    status,
    healthy_accounts: healthyCount,
    total_accounts: totalCount,
    disabled_accounts: accountPool.filter(a => a.disabled).length,
    cooldown_accounts: accountPool.filter(a => !a.disabled && a.cooldownUntil > now).length,
    expiring_accounts: expiringAccounts.length > 0 ? expiringAccounts : undefined,
  };
}

// Backward-compat: expose the active account info as the legacy accountInfo
let accountInfo = null;
function updateLegacyAccountInfo() {
  if (accountPool.length > 0) {
    accountInfo = accountPool[0].info;
  }
}

// ---------------------------------------------------------------------------
// Resolve codex binary
// ---------------------------------------------------------------------------

function resolveCodexPath() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  const nodeDir = path.dirname(process.execPath);
  const candidate = path.join(nodeDir, "codex");
  if (existsSync(candidate)) return candidate;
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    if (existsSync(p)) return p;
  }
  return "codex";
}
const CODEX_PATH = resolveCodexPath();
const NODE_PATH = process.execPath;

// ---------------------------------------------------------------------------
// Model pricing ($ per 1M tokens, source: openai.com/api/pricing 2026-03-05)
// ---------------------------------------------------------------------------

const MODEL_PRICING = {
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
  "gpt-5.4":              { input: 1.75,  cached: 0.175,  output: 14.00 },
};

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
// Usage statistics — global aggregate (resets daily)
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
  by_model: {},
  started_at: new Date().toISOString(),
};

let statsHistory = [];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function archiveAndReset(newDay) {
  if (usageStats.total_requests > 0) {
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

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - HISTORY_KEEP_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    statsHistory = statsHistory.filter((s) => s.date >= cutoffStr);

    await fs.writeFile(HISTORY_FILE, JSON.stringify(statsHistory, null, 2)).catch(() => {});
    console.log(`[codex-gateway] archived ${usageStats.date}: ${usageStats.total_requests} reqs, $${totalCost.toFixed(4)}`);
  }

  usageStats.date = newDay;
  usageStats.total_input_tokens = 0;
  usageStats.total_cached_input_tokens = 0;
  usageStats.total_output_tokens = 0;
  usageStats.total_requests = 0;
  usageStats.total_errors = 0;
  usageStats.by_model = {};
  usageStats.started_at = new Date().toISOString();

  // Reset per-account stats and attempt to recover disabled accounts
  for (const acct of accountPool) {
    acct.stats = freshAccountStats();
    acct.cooldownUntil = 0;

    // Daily reset: give refreshable disabled accounts another chance
    if (acct.disabled) {
      const category = acct.errorCategory || "unknown";
      const recoverability = errorRecoverability(category);
      if (recoverability === "refreshable") {
        acct.disabled = false;
        acct.disabledReason = null;
        acct.disabledAt = null;
        acct.errorCategory = null;
        acct._reprobeAttempted = false;
        console.log(`[codex-gateway] daily-reset: re-enabled ${acct.label} (was disabled: ${category}, refreshable)`);
      } else {
        console.log(`[codex-gateway] daily-reset: ${acct.label} stays disabled (${category}, ${recoverability})`);
      }
    }
  }

  console.log(`[codex-gateway] stats reset for new day: ${newDay}`);
}

function ensureTodayStats() {
  const today = todayStr();
  if (usageStats.date !== today) {
    archiveAndReset(today);
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

  fs.writeFile(STATS_FILE, JSON.stringify(usageStats, null, 2)).catch(() => {});

  const totalUsed = usageStats.total_input_tokens + usageStats.total_output_tokens;
  const pct = totalUsed / (DAILY_TOKEN_BUDGET * Math.max(accountPool.length, 1));
  if (pct >= 1.0) {
    console.warn(`[codex-gateway] BUDGET EXCEEDED (all accounts): ${totalUsed.toLocaleString()} tokens`);
  } else if (pct >= WARN_THRESHOLD) {
    console.warn(`[codex-gateway] Budget warning (all accounts): ${(pct * 100).toFixed(1)}%`);
  }
}

function getStatsSnapshot() {
  ensureTodayStats();
  const totalUsed = usageStats.total_input_tokens + usageStats.total_output_tokens;
  const globalBudget = DAILY_TOKEN_BUDGET * Math.max(accountPool.length, 1);
  const pct = totalUsed / globalBudget;
  let status = "ok";
  if (pct >= 1.0) status = "exceeded";
  else if (pct >= WARN_THRESHOLD) status = "warning";

  let totalCost = 0;
  for (const m of Object.values(usageStats.by_model)) {
    totalCost += m.cost_usd || 0;
  }

  return {
    date: usageStats.date,
    budget: {
      daily_limit_per_account: DAILY_TOKEN_BUDGET,
      total_accounts: accountPool.length,
      total_budget: globalBudget,
      total_used: totalUsed,
      remaining: Math.max(0, globalBudget - totalUsed),
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
    accounts: getAccountPoolStatus(),
    started_at: usageStats.started_at,
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

async function loadStats() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf-8");
    statsHistory = JSON.parse(raw);
    if (!Array.isArray(statsHistory)) statsHistory = [];
    console.log(`[codex-gateway] loaded ${statsHistory.length} days of history`);
  } catch {
    statsHistory = [];
  }

  try {
    const raw = await fs.readFile(STATS_FILE, "utf-8");
    const saved = JSON.parse(raw);
    if (saved.date === todayStr()) {
      Object.assign(usageStats, saved);
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
let modelMetadata = new Map();

function buildModelEntry(slug, created, meta) {
  const entry = {
    id: slug,
    object: "model",
    created: created ?? Math.floor(Date.now() / 1000),
    owned_by: "openai",
  };
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

function buildSpawnEnv(acct) {
  const env = { ...process.env };
  if (!env.HOME) env.HOME = os.homedir();

  // Only override CODEX_HOME in multi-account mode
  if (acct && isMultiAccountMode()) {
    env.CODEX_HOME = acct.codexHome;
  }

  const proxyVars = ["https_proxy", "http_proxy", "all_proxy", "no_proxy", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
  for (const v of proxyVars) {
    if (process.env[v] && !env[v]) env[v] = process.env[v];
  }

  const nodeDir = path.dirname(process.execPath);
  const existingPath = env.PATH || "";
  if (!existingPath.includes(nodeDir)) {
    env.PATH = `${nodeDir}:${existingPath}`;
  }

  return env;
}

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

function resolveReasoningEffort(model, clientEffort) {
  const meta = modelMetadata.get(model);
  const supported = meta?.supported_reasoning_levels?.map((l) =>
    typeof l === "string" ? l : l.effort
  );

  if (clientEffort && supported?.includes(clientEffort)) return clientEffort;
  if (clientEffort && !supported) return clientEffort;

  const defaultEffort = /mini/i.test(model) ? "high" : "xhigh";
  if (supported?.includes(defaultEffort)) return defaultEffort;
  if (supported?.length) return supported[supported.length - 1];
  return defaultEffort;
}

// Rate-limit detection patterns in stderr/error output
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /quota/i,
  /capacity/i,
  /usage.?limit/i,
  /exceeded.*limit/i,
  /hit your.*limit/i,
  /try again at/i,
];

// Auth / account errors — account should be disabled, not just cooled down
const AUTH_ERROR_PATTERNS = [
  /refresh_token_reused/i,
  /refresh.?token.*already.*used/i,
  /please.*log\s*out.*sign\s*in/i,
  /401\s*Unauthorized/i,
  /invalid.*refresh.?token/i,
  /token.*expired/i,
  /authentication.*failed/i,
  /could not be refreshed/i,
  /sign\s*in\s*again/i,
  /subscription.*expired/i,
  /plan.*expired/i,
  /account.*suspended/i,
  /account.*disabled/i,
];

// Workspace / billing errors — account should be disabled with specific reason
const WORKSPACE_ERROR_PATTERNS = [
  /deactivated_workspace/i,
  /workspace.*deactivated/i,
  /workspace.*suspended/i,
  /workspace.*disabled/i,
];

const BILLING_ERROR_PATTERNS = [
  /insufficient_balance/i,
  /insufficient.*balance/i,
  /billing.*error/i,
  /payment.*failed/i,
  /payment.*required/i,
  /overdue/i,
  /past.?due/i,
];

function classifyError(errorText) {
  if (!errorText) return "unknown";
  if (WORKSPACE_ERROR_PATTERNS.some(re => re.test(errorText))) return "deactivated_workspace";
  if (BILLING_ERROR_PATTERNS.some(re => re.test(errorText))) return "insufficient_balance";
  if (AUTH_ERROR_PATTERNS.some(re => re.test(errorText))) return "auth_invalid";
  if (RATE_LIMIT_PATTERNS.some(re => re.test(errorText))) return "rate_limit";
  if (/timed?s*out|ETIMEDOUT/i.test(errorText)) return "timeout";
  return "unknown";
}

function isWorkspaceError(errorText) {
  return WORKSPACE_ERROR_PATTERNS.some(re => re.test(errorText));
}

function isBillingError(errorText) {
  return BILLING_ERROR_PATTERNS.some(re => re.test(errorText));
}

// Error recoverability classification
const REFRESHABLE_CATEGORIES = new Set(["auth_invalid", "timeout"]);
const COOLDOWN_ONLY_CATEGORIES = new Set(["rate_limit"]);
// Everything else (deactivated_workspace, insufficient_balance) is non-refreshable

function errorRecoverability(category) {
  if (REFRESHABLE_CATEGORIES.has(category)) return "refreshable";
  if (COOLDOWN_ONLY_CATEGORIES.has(category)) return "cooldown-only";
  return "non-refreshable";
}

function getTokenExpiryWarning(acct) {
  if (!acct.info?.token_expires) return { expires_in_sec: null, warning_level: "unknown" };
  const expiresMs = new Date(acct.info.token_expires).getTime();
  const nowMs = Date.now();
  const diffSec = Math.floor((expiresMs - nowMs) / 1000);
  let warning_level = "ok";
  if (diffSec <= 0) warning_level = "expired";
  else if (diffSec <= 86400) warning_level = "critical_24h";
  else if (diffSec <= 259200) warning_level = "warning_3d";
  else if (diffSec <= 604800) warning_level = "notice_7d";
  return { expires_in_sec: diffSec, warning_level };
}

function isRateLimitError(errorText) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(errorText));
}

function isAuthError(errorText) {
  return AUTH_ERROR_PATTERNS.some((re) => re.test(errorText));
}

function isRetryableError(errorText) {
  return isRateLimitError(errorText) || isAuthError(errorText);
}

function createTimeoutError(timeoutMs, elapsedSeconds, acctLabel, model) {
  const seconds = Number.isFinite(timeoutMs) ? Math.ceil(timeoutMs / 1000) : "?";
  const elapsed = Number.isFinite(elapsedSeconds) ? `${elapsedSeconds}s` : "?";
  const err = new Error(
    `Codex request timed out after ${seconds}s (account=${acctLabel}, model=${model}, elapsed=${elapsed})`
  );
  err.code = "ETIMEDOUT";
  err.timeoutMs = timeoutMs;
  err.elapsedSeconds = elapsedSeconds;
  return err;
}

/**
 * Run `codex exec` using a specific account.
 * Returns { content, usage, rateLimited }
 */
async function runCodexWithAccount(model, prompt, opts, acct) {
  const effort = resolveReasoningEffort(model, opts.reasoning_effort);

  const configArgs = [
    "-c", `model_reasoning_effort=${effort}`,
    "-c", "sandbox_workspace_write.network_access=true",
  ];
  if (opts.max_tokens && Number.isFinite(opts.max_tokens)) {
    configArgs.push("-c", `model_max_output_tokens=${opts.max_tokens}`);
  }

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
        "-a", "never",
        "-s", "workspace-write",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "--model", model,
        ...configArgs,
        ...featureArgs,
        "-",
      ],
      { cwd: WORK_DIR, env: buildSpawnEnv(acct), stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    const started = Date.now();
    let timedOut = false;
    let forceKilled = false;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      stderr += `\n[codex-gateway] request timed out after ${CODEX_EXEC_TIMEOUT_MS}ms`;
      child.kill("SIGTERM");
    }, CODEX_EXEC_TIMEOUT_MS);

    const forceKillTimer = setTimeout(() => {
      if (timedOut && child.exitCode === null) {
        forceKilled = true;
        child.kill("SIGKILL");
      }
    }, CODEX_EXEC_TIMEOUT_MS + 5000);

    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      clearTimeout(forceKillTimer);
      settle(reject, err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      clearTimeout(forceKillTimer);
      const elapsed = Math.floor((Date.now() - started) / 1000);

      let lastAgentText = "";
      let turnUsage = null;
      let codexError = "";
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
            lastAgentText = evt.item.text || "";
          }
          if (evt.type === "turn.completed" && evt.usage) {
            turnUsage = evt.usage;
          }
          // Capture error messages from codex JSONL output
          if (evt.type === "error" || evt.type === "turn.failed") {
            const msg = evt.message || evt.error?.message || "";
            if (msg) codexError = msg;
          }
        } catch {
          // non-JSON line
        }
      }

      const content = lastAgentText || codexError || stderr.trim() || "(no response)";
      const errorText = content + " " + stderr + " " + codexError;
      const rateLimited = code !== 0 && isRateLimitError(errorText);
      const authFailed = code !== 0 && isAuthError(errorText);
      const workspaceFailed = code !== 0 && isWorkspaceError(errorText);
      const billingFailed = code !== 0 && isBillingError(errorText);

      if (timedOut) {
        usageStats.total_errors += 1;
        ensureAccountStatsToday(acct);
        acct.stats.errors += 1;
        console.error(
          `[codex-gateway] account=${acct.label} model=${model} effort=${effort} timeout=${Math.ceil(CODEX_EXEC_TIMEOUT_MS / 1000)}s elapsed=${elapsed}s signal=${signal || "-"} force_kill=${forceKilled}`
        );
        settle(reject, createTimeoutError(CODEX_EXEC_TIMEOUT_MS, elapsed, acct.label, model));
        return;
      }

      if (turnUsage) {
        recordUsage(model, turnUsage);
        recordAccountUsage(acct, turnUsage);
        console.log(
          `[codex-gateway] account=${acct.label} model=${model} effort=${effort} code=${code} elapsed=${elapsed}s len=${content.length} tokens=${turnUsage.input_tokens}+${turnUsage.output_tokens} cached=${turnUsage.cached_input_tokens || 0} cost=$${calcCost(model, turnUsage).toFixed(6)}`
        );
      } else {
        console.log(
          `[codex-gateway] account=${acct.label} model=${model} effort=${effort} code=${code} elapsed=${elapsed}s len=${content.length} tokens=unknown`
        );
      }

      if (code === 0) {
        settle(resolve, { content, usage: turnUsage, rateLimited: false, authFailed: false });
        return;
      }

      if (workspaceFailed) {
        settle(resolve, { content, usage: turnUsage, rateLimited: false, authFailed: false, workspaceFailed: true });
        return;
      }

      if (billingFailed) {
        settle(resolve, { content, usage: turnUsage, rateLimited: false, authFailed: false, billingFailed: true });
        return;
      }

      if (authFailed) {
        settle(resolve, { content, usage: turnUsage, rateLimited: false, authFailed: true });
        return;
      }

      if (rateLimited) {
        settle(resolve, { content, usage: turnUsage, rateLimited: true, authFailed: false });
        return;
      }

      if (code !== 0) usageStats.total_errors += 1;
      settle(reject, new Error(content));
    });
  });
}

/**
 * Run codex with automatic account rotation.
 * Single account: direct passthrough, no rotation overhead.
 * Multiple accounts: round-robin with rate-limit failover.
 */
async function runCodex(model, prompt, opts = {}) {
  if (accountPool.length === 0) {
    throw new Error("No accounts configured. Place auth.json or auth-{label}.json files in " + CODEX_HOME);
  }

  // Single account — simple passthrough, no rotation
  if (!isMultiAccountMode()) {
    return runCodexWithAccount(model, prompt, opts, accountPool[0]);
  }

  // Multi-account rotation
  const available = accountPool.filter((a) => !a.disabled);
  const maxAttempts = available.length;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const acct = pickNextAccount();
    if (!acct) break;

    console.log(
      `[codex-gateway] attempt ${attempt + 1}/${maxAttempts} using account=${acct.label}`
    );

    try {
      const result = await runCodexWithAccount(model, prompt, opts, acct);

      if (result.workspaceFailed) {
        markAccountDisabled(acct, "workspace deactivated", "deactivated_workspace");
        lastError = new Error(`Account ${acct.label} workspace deactivated`);
        console.warn(`[codex-gateway] account ${acct.label} workspace deactivated, disabled, trying next...`);
        continue;
      }

      if (result.billingFailed) {
        markAccountDisabled(acct, "insufficient balance or billing error", "insufficient_balance");
        lastError = new Error(`Account ${acct.label} billing failed`);
        console.warn(`[codex-gateway] account ${acct.label} billing failed, disabled, trying next...`);
        continue;
      }

      if (result.authFailed) {
        markAccountDisabled(acct, "auth failed: token expired or refresh_token reused — re-login required", "auth_invalid");
        lastError = new Error(`Account ${acct.label} auth failed`);
        console.warn(`[codex-gateway] account ${acct.label} auth failed, disabled, trying next...`);
        continue;
      }

      if (result.rateLimited) {
        markAccountCooldown(acct, "rate_limit");
        lastError = new Error(`Account ${acct.label} rate-limited`);
        console.warn(`[codex-gateway] account ${acct.label} hit rate limit, trying next...`);
        continue;
      }

      return result;
    } catch (err) {
      if (isWorkspaceError(err.message)) {
        markAccountDisabled(acct, err.message, "deactivated_workspace");
        lastError = err;
        continue;
      }
      if (isBillingError(err.message)) {
        markAccountDisabled(acct, err.message, "insufficient_balance");
        lastError = err;
        continue;
      }
      if (isAuthError(err.message)) {
        markAccountDisabled(acct, err.message, "auth_invalid");
        lastError = err;
        continue;
      }
      if (isRateLimitError(err.message)) {
        markAccountCooldown(acct, "rate_limit");
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  // Distinguish all-cooldown (temporary) from all-disabled (permanent)
  const now2 = Date.now();
  const disabledCount = accountPool.filter(a => a.disabled).length;
  const cooldownCount = accountPool.filter(a => !a.disabled && a.cooldownUntil > now2).length;
  const totalCount = accountPool.length;
  if (disabledCount === totalCount) {
    const err = new Error("All accounts permanently unavailable (disabled). Re-login or add new accounts.");
    err.exhaustionType = "all_disabled";
    throw err;
  }
  if (cooldownCount + disabledCount >= totalCount) {
    const err = new Error("All accounts temporarily rate-limited. Try again in a few minutes.");
    err.exhaustionType = "all_cooldown";
    throw err;
  }
  throw lastError || new Error("All accounts exhausted (rate-limited or disabled)");
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

  // API key authentication (skip for health/models endpoints)
  const rawPath = (req.url?.split("?")[0] ?? "/").replace(/^\/v1/, "");
  if (!["/health", "/models", "/routing-status", "/accounts", "/stats"].includes(rawPath) && !verifyApiKey(req)) {
    return json(res, 401, { error: { message: "Invalid or missing API key", type: "authentication_error" } });
  }

  const url = req.url?.split("?")[0] ?? "/";
  const route = url.startsWith("/v1") ? url.slice(3) : url;

  // GET /health — provider-level health for upstream consumers
  if (req.method === "GET" && route === "/health") {
    const readiness = getProviderReadiness();
    const statusCode = readiness.status === "down" ? 503 : 200;
    return json(res, statusCode, {
      service: "codex-gateway",
      ...readiness,
      models_count: cachedModels.length,
      uptime_sec: Math.floor((Date.now() - server._startedAt) / 1000),
    });
  }

  // GET /routing-status — eligible models and routing info
  if (req.method === "GET" && route === "/routing-status") {
    const readiness = getProviderReadiness();
    return json(res, 200, {
      provider: readiness,
      eligible_models: readiness.status !== "down" ? cachedModels.map(m => m.id) : [],
      accounts: getAccountPoolStatus(),
    });
  }

  // GET / or /help
  if (req.method === "GET" && (route === "/" || route === "/help")) {
    return json(res, 200, {
      name: "codex-gateway",
      version: "2.0.0",
      description: "OpenAI-compatible HTTP gateway wrapping the Codex CLI with multi-account rotation",
      endpoints: {
        "GET /v1/models": "List available models with context_window, supported_reasoning_levels",
        "POST /v1/chat/completions": "Chat completion (OpenAI-compatible, auto-rotates accounts)",
        "GET /v1/stats": "Today's token usage, budget, per-model & per-account breakdown, USD cost",
        "GET /v1/stats/history": "Full daily history with grand totals (up to 90 days)",
        "GET /v1/accounts": "Account pool status (plan, email, cooldown, per-account usage)",
        "POST /v1/auth-sync": "Manually trigger auth file sync to remote (requires AUTH_SYNC_TARGET)",
        "GET /v1/health": "Provider-level health (healthy/degraded/down) for upstream routing",
        "GET /v1/routing-status": "Eligible models and account routing state",
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
        fast_mode: { type: "boolean", default: false, description: "Codex fast mode. Default off for higher quality." },
      },
      account_rotation: {
        strategy: "round-robin with automatic failover",
        cooldown_ms: ACCOUNT_COOLDOWN_MS,
        scan_interval_ms: ACCOUNT_SCAN_INTERVAL_MS,
        total_accounts: accountPool.length,
        accounts: accountPool.map((a) => a.label),
      },
      models_count: cachedModels.length,
      config: {
        port: PORT,
        work_dir: WORK_DIR,
        codex_path: CODEX_PATH,
        codex_exec_timeout_ms: CODEX_EXEC_TIMEOUT_MS,
      },
    });
  }

  // POST /auth-sync — manually trigger auth file sync to remote
  if (req.method === "POST" && route === "/auth-sync") {
    if (!AUTH_SYNC_TARGET) {
      return json(res, 400, { error: { message: "AUTH_SYNC_TARGET not configured", type: "config_error" } });
    }
    syncAuthToRemote().catch(() => {});
    return json(res, 200, { status: "sync triggered", target: AUTH_SYNC_TARGET });
  }

  // GET /stats
  if (req.method === "GET" && route === "/stats") {
    return json(res, 200, getStatsSnapshot());
  }

  // GET /stats/history
  if (req.method === "GET" && route === "/stats/history") {
    return json(res, 200, getFullHistory());
  }

  // GET /accounts — dedicated account pool status
  // POST /refresh — trigger OAuth2 token refresh for all accounts
  if (req.method === "POST" && route === "/refresh") {
    if (!verifyApiKey(req)) return json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
    const results = [];
    for (const acct of accountPool) {
      try {
        const r = await refreshAccountRateLimits(acct, { force: false });
        if (acct.disabled && r.refreshed) {
          acct.disabled = false;
          acct.disabledReason = null;
          acct.disabledAt = null;
          acct.errorCategory = null;
          acct._reprobeAttempted = false;
        }
        results.push({ label: acct.label, status: "refreshed", method: r.method, new_expiry: acct.info?.token_expires });
      } catch (e) {
        results.push({ label: acct.label, status: "failed", error: e.message });
      }
    }
    return json(res, 200, { results });
  }

    if (req.method === "GET" && route === "/accounts") {
    return json(res, 200, {
      total: accountPool.length,
      cooldown_ms: ACCOUNT_COOLDOWN_MS,
      budget_per_account: DAILY_TOKEN_BUDGET,
      accounts: getAccountPoolStatus(),
    });
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

    // Model alias mapping (for Droid which can't use real model names)
    const MODEL_ALIASES = {
      "cg-gpt54": "gpt-5.4",
      "cg-gpt53": "gpt-5.3-codex",
      "cg-gpt51": "gpt-5.1-codex",
    };
    const rawModel = payload.model || "gpt-5.4";
    const model = MODEL_ALIASES[rawModel] || rawModel;
    const prompt = messagesToPrompt(payload.messages);
    const stream = Boolean(payload.stream);
    const includeUsage = Boolean(payload.stream_options?.include_usage);
    const payloadKeys = Object.keys(payload || {}).sort().join(",");

    const runOpts = {};
    if (payload.reasoning_effort) runOpts.reasoning_effort = payload.reasoning_effort;
    if (payload.max_tokens) runOpts.max_tokens = payload.max_tokens;
    if (payload.max_completion_tokens) runOpts.max_tokens = payload.max_completion_tokens;
    if (typeof payload.fast_mode === "boolean") runOpts.fast_mode = payload.fast_mode;

    console.log(
      `[codex-gateway] -> model=${model} stream=${stream} messages=${payload.messages?.length ?? 0} accounts=${accountPool.length} keys=${payloadKeys}`
    );

    let result;
    try {
      result = await runCodex(model, prompt, runOpts);
    } catch (err) {
      console.error(`[codex-gateway] codex error: ${err.message}`);
      let statusCode, errorType;
      if (err.exhaustionType === "all_disabled") {
        statusCode = 503;
        errorType = "quota_exceeded";
      } else if (err.exhaustionType === "all_cooldown") {
        statusCode = 429;
        errorType = "rate_limit_error";
      } else if (err.code === "ETIMEDOUT") {
        statusCode = 504;
        errorType = "timeout_error";
      } else if (isRateLimitError(err.message)) {
        statusCode = 429;
        errorType = "rate_limit_error";
      } else {
        statusCode = 500;
        errorType = "server_error";
      }
      return json(res, statusCode, { error: { message: err.message, type: errorType } });
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

await discoverAndProvisionAccounts();
updateLegacyAccountInfo();
await refreshModels();
await loadStats();
watchModelCache();

// Watch for new auth files appearing in CODEX_HOME (best-effort, not all OS support this reliably)
try {
  fsWatch(CODEX_HOME, { persistent: false }, (event, filename) => {
    if (filename && (filename === "auth.json" || /^auth-.+\.json$/.test(filename))) {
      console.log(`[codex-gateway] auth file change detected: ${filename}, re-scanning accounts...`);
      discoverAndProvisionAccounts().then(updateLegacyAccountInfo).catch(() => {});
      triggerAuthSync();
    }
  });
} catch {}

// Periodic scan: discover new accounts + sync updated auth files (only active in multi-account mode or to detect new accounts)
setInterval(async () => {
  try {
    const prevCount = accountPool.length;
    await discoverAndProvisionAccounts();
    updateLegacyAccountInfo();
    if (isMultiAccountMode()) {
      await syncAccountAuthFiles();
    }
    if (accountPool.length !== prevCount) {
      console.log(`[codex-gateway] account pool changed: ${prevCount} -> ${accountPool.length} [${accountPool.map((a) => a.label).join(", ")}]`);
      if (isMultiAccountMode()) {
        console.log(`[codex-gateway] multi-account rotation activated`);
      }
    }
  } catch (err) {
    console.warn(`[codex-gateway] periodic account scan failed: ${err.message}`);
  }
}, ACCOUNT_SCAN_INTERVAL_MS);

// ── Self-heal periodic sweep ──────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  let healed = 0, warned = 0;

  for (const acct of accountPool) {
    // Token expiry: auto-disable if expired, warn if critical
    const expiry = getTokenExpiryWarning(acct);
    if (expiry.warning_level === "expired" && !acct.disabled) {
      markAccountDisabled(acct, "JWT token expired — re-login required", "auth_invalid");
      console.warn(`[codex-gateway] self-heal: disabled ${acct.label} — token expired`);
      warned++;
      continue;
    }
    if (expiry.warning_level === "critical_24h") {
      console.warn(`[codex-gateway] self-heal: ${acct.label} token expires in ${Math.ceil(expiry.expires_in_sec / 3600)}h — re-login soon!`);
      warned++;
    }

    // Proactive token refresh: refresh tokens expiring within 48h (OAuth2, zero cost)
    if (!acct.disabled && acct.authFile) {
      const expiry = getTokenExpiryWarning(acct);
      if (expiry.warning_level === "warning_3d" || expiry.warning_level === "critical_24h") {
        if (!acct._lastRefreshAttempt || (now - acct._lastRefreshAttempt) >= 60 * 60 * 1000) {
          acct._lastRefreshAttempt = now;
          try {
            await refreshAccountRateLimits(acct, { force: false });
            console.log(`[codex-gateway] self-heal: proactively refreshed ${acct.label} (was ${expiry.warning_level})`);
            healed++;
          } catch (e) {
            // Not critical — will retry next sweep
          }
        }
      }
    }

    // Try to re-enable disabled accounts with refreshable errors after cool-off
    if (acct.disabled) {
      const category = acct.errorCategory || "unknown";
      const recoverability = errorRecoverability(category);
      if (recoverability === "refreshable" && acct.disabledAt) {
        const disabledAge = now - new Date(acct.disabledAt).getTime();
        if (disabledAge >= DISABLED_RETRY_AFTER_MS) {
          try {
            await refreshAccountRateLimits(acct, { force: false }); // check token file only
            acct.disabled = false;
            acct.disabledReason = null;
            acct.disabledAt = null;
            acct.errorCategory = null;
            acct._reprobeAttempted = false;
            console.log(`[codex-gateway] self-heal: re-enabled ${acct.label} after token refresh`);
            healed++;
          } catch (e) {
            // Token not updated — try force probe every 2 hours
            if (disabledAge >= 30 * 60 * 1000 && (!acct._lastProbeAt || (now - (acct._lastProbeAt || 0)) >= 30 * 60 * 1000)) {
              acct._lastProbeAt = now;
              try {
                await refreshAccountRateLimits(acct, { force: true });
                acct.disabled = false;
                acct.disabledReason = null;
                acct.disabledAt = null;
                acct.errorCategory = null;
                acct._reprobeAttempted = false;
                console.log(`[codex-gateway] self-heal: re-enabled ${acct.label} after probe success`);
                healed++;
              } catch (probeErr) {
                console.log(`[codex-gateway] self-heal: ${acct.label} probe failed: ${probeErr.message}`);
              }
            }
          }
        }
      }
      continue;
    }

    // Clear stale cooldowns and log
    if (acct.cooldownUntil > 0 && acct.cooldownUntil <= now) {
      console.log(`[codex-gateway] self-heal: ${acct.label} cooldown expired, back in rotation`);
      acct.cooldownUntil = 0;
      healed++;
    }
  }

  if (healed > 0 || warned > 0) {
    const available = accountPool.filter(a => !a.disabled).length;
    console.log(`[codex-gateway] self-heal sweep: ${healed} healed, ${warned} warned, ${available}/${accountPool.length} accounts available`);
  }
}, SELF_HEAL_INTERVAL_MS);

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("[codex-gateway] unhandled:", err);
    json(res, 500, { error: { message: "Internal server error", type: "server_error" } });
  }
});

server._startedAt = Date.now();
server.listen(PORT, BIND_ADDR, () => {
  console.log(`[codex-gateway] listening on http://${BIND_ADDR}:${PORT}`);
  console.log(`[codex-gateway] codex binary: ${CODEX_PATH}`);
  console.log(`[codex-gateway] work dir:     ${WORK_DIR}`);
  console.log(`[codex-gateway] exec timeout: ${Math.ceil(CODEX_EXEC_TIMEOUT_MS / 1000)}s`);
  console.log(`[codex-gateway] accounts:     ${accountPool.length} [${accountPool.map((a) => a.label).join(", ")}]`);
  console.log(`[codex-gateway] mode:         ${isMultiAccountMode() ? "multi-account rotation" : "single account (direct)"}`);
  console.log(`[codex-gateway] scan interval: ${ACCOUNT_SCAN_INTERVAL_MS / 1000}s`);
  console.log(`[codex-gateway] api key:      ${API_KEY ? "enabled" : "disabled (local only)"}`);
  console.log(`[codex-gateway] auth-sync:    ${AUTH_SYNC_TARGET || "disabled"}`);
});

// Initial auth sync on startup (if configured)
if (AUTH_SYNC_TARGET) {
  syncAuthToRemote().catch(() => {});
}
