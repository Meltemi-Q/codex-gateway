#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";

const DISPLAY_SUFFIX = "[Codex Gateway]";
const DEFAULT_BASE_URL = "http://127.0.0.1:8319/v1";
const DEFAULT_API_KEY = "sk-codex-gateway";
const DEFAULT_PROVIDER = "generic-chat-completion-api";
const FALLBACK_MODELS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5-codex",
  "gpt-5",
  "gpt-5.1-codex-mini",
  "gpt-5-codex-mini",
];
const PREFERRED_ORDER = new Map(FALLBACK_MODELS.map((model, index) => [model, index]));

function usage() {
  console.log(`codex-gateway Droid importer

Usage:
  node scripts/install-droid-models.mjs [--base-url URL] [--api-key KEY] [--provider NAME] [--set-default] [--no-backup]

Options:
  --base-url URL   Droid baseUrl to write (default: ${DEFAULT_BASE_URL})
  --api-key KEY    Droid apiKey to write (default: ${DEFAULT_API_KEY})
  --provider NAME  Droid provider to write (default: ${DEFAULT_PROVIDER})
  --set-default    Set Droid's default session model to the imported GPT-5.4 entry
  --no-backup      Skip writing .bak files before updating config
  --help           Show this help
`);
}

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_KEY,
    provider: DEFAULT_PROVIDER,
    backup: true,
    setDefault: false,
    factoryHome: path.join(os.homedir(), ".factory"),
    codexHome: path.join(os.homedir(), ".codex"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      options.baseUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--api-key") {
      options.apiKey = argv[index + 1];
      index += 1;
    } else if (arg === "--provider") {
      options.provider = argv[index + 1];
      index += 1;
    } else if (arg === "--set-default") {
      options.setDefault = true;
    } else if (arg === "--no-backup") {
      options.backup = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.baseUrl || !options.apiKey || !options.provider) {
    throw new Error("baseUrl, apiKey, and provider must be non-empty");
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function sortModels(models) {
  return [...models].sort((left, right) => {
    const leftOrder = PREFERRED_ORDER.has(left) ? PREFERRED_ORDER.get(left) : Number.MAX_SAFE_INTEGER;
    const rightOrder = PREFERRED_ORDER.has(right) ? PREFERRED_ORDER.get(right) : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.localeCompare(right);
  });
}

function prettyToken(token) {
  const lower = token.toLowerCase();
  if (lower === "gpt") return "GPT";
  if (lower === "claude") return "Claude";
  if (lower === "codex") return "Codex";
  if (lower === "mini") return "Mini";
  if (lower === "max") return "Max";
  if (lower === "opus") return "Opus";
  if (lower === "sonnet") return "Sonnet";
  if (/^[a-z]\d+$/i.test(token)) return token.toUpperCase();
  if (/^\d+(\.\d+)?$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function displayLabelForModel(model) {
  const parts = String(model || "").split("-").filter(Boolean);
  if (parts[0]?.toLowerCase() === "gpt" && parts[1]) {
    const head = `GPT-${parts[1]}`;
    const tail = parts.slice(2).map(prettyToken).join(" ");
    return [head, tail].filter(Boolean).join(" ");
  }
  return parts.map(prettyToken).join(" ");
}

function displayNameForModel(model) {
  return `${displayLabelForModel(model)} ${DISPLAY_SUFFIX}`;
}

function idForDisplayName(displayName, index) {
  return `custom:${displayName.replace(/\s+/g, "-")}-${index}`;
}

async function readJson(file, fallbackValue) {
  if (!existsSync(file)) return fallbackValue;
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw);
}

async function backupFile(file, enabled) {
  if (!enabled || !existsSync(file)) return null;
  const backupPath = `${file}.bak`;
  await fs.copyFile(file, backupPath);
  return backupPath;
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function resolveModels(baseUrl, codexHome) {
  const gatewayEndpoint = `${baseUrl}/models`;
  try {
    const response = await fetch(gatewayEndpoint);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const models = uniq(Array.isArray(data?.data) ? data.data.map((entry) => entry?.id) : []);
    if (models.length > 0) {
      return { source: gatewayEndpoint, models: sortModels(models) };
    }
  } catch {}

  const cacheFile = path.join(codexHome, "models_cache.json");
  try {
    const raw = await fs.readFile(cacheFile, "utf-8");
    const data = JSON.parse(raw);
    const models = uniq(
      Array.isArray(data?.models)
        ? data.models
            .filter((entry) => entry?.visibility !== "hidden" && entry?.slug)
            .map((entry) => entry.slug)
        : []
    );
    if (models.length > 0) {
      return { source: cacheFile, models: sortModels(models) };
    }
  } catch {}

  return { source: "built-in fallback", models: [...FALLBACK_MODELS] };
}

function isGatewayConfigEntry(entry, baseUrl, provider) {
  const displayName = String(entry?.model_display_name || "");
  const modelBaseUrl = normalizeBaseUrl(entry?.base_url);
  return (
    displayName.includes("Codex Gateway") ||
    (modelBaseUrl === baseUrl && String(entry?.provider || "") === provider)
  );
}

function isGatewaySettingsEntry(entry, baseUrl, provider) {
  const displayName = String(entry?.displayName || "");
  const entryId = String(entry?.id || "");
  const modelBaseUrl = normalizeBaseUrl(entry?.baseUrl);
  return (
    displayName.includes("Codex Gateway") ||
    entryId.includes("Codex-Gateway") ||
    (modelBaseUrl === baseUrl && String(entry?.provider || "") === provider)
  );
}

function buildConfigEntry(model, baseUrl, apiKey, provider) {
  return {
    model_display_name: displayNameForModel(model),
    model,
    base_url: baseUrl,
    api_key: apiKey,
    provider,
  };
}

function buildSettingsEntry(model, index, baseUrl, apiKey, provider) {
  const displayName = displayNameForModel(model);
  return {
    model,
    id: idForDisplayName(displayName, index),
    index,
    baseUrl: baseUrl,
    apiKey: apiKey,
    displayName,
    noImageSupport: false,
    provider,
  };
}

function allocateIndexes(entries, count) {
  const used = new Set(
    entries
      .map((entry) => entry?.index)
      .filter((index) => Number.isInteger(index) && index >= 0)
  );
  const indexes = [];
  let candidate = 0;
  while (indexes.length < count) {
    if (!used.has(candidate)) {
      indexes.push(candidate);
    }
    candidate += 1;
  }
  return indexes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configFile = path.join(options.factoryHome, "config.json");
  const settingsFile = path.join(options.factoryHome, "settings.json");

  const resolved = await resolveModels(options.baseUrl, options.codexHome);
  if (resolved.models.length === 0) {
    throw new Error("No models available to import");
  }

  const config = await readJson(configFile, {});
  const settings = await readJson(settingsFile, {});

  const configModels = Array.isArray(config.custom_models) ? config.custom_models : [];
  const preservedConfigModels = configModels.filter((entry) => !isGatewayConfigEntry(entry, options.baseUrl, options.provider));
  const importedConfigModels = resolved.models.map((model) =>
    buildConfigEntry(model, options.baseUrl, options.apiKey, options.provider)
  );
  config.custom_models = [...importedConfigModels, ...preservedConfigModels];

  const settingsModels = Array.isArray(settings.customModels) ? settings.customModels : [];
  const preservedSettingsModels = settingsModels.filter((entry) => !isGatewaySettingsEntry(entry, options.baseUrl, options.provider));
  const allocatedIndexes = allocateIndexes(preservedSettingsModels, resolved.models.length);
  const importedSettingsModels = resolved.models.map((model, offset) =>
    buildSettingsEntry(model, allocatedIndexes[offset], options.baseUrl, options.apiKey, options.provider)
  );
  settings.customModels = [...importedSettingsModels, ...preservedSettingsModels];

  const preferredDefault = importedSettingsModels.find((entry) => entry.model === "gpt-5.4") || importedSettingsModels[0];
  const currentDefaultModel = settings?.sessionDefaultSettings?.model;
  const currentDefaultIsGateway = typeof currentDefaultModel === "string" && currentDefaultModel.includes("Codex-Gateway");
  const currentDefaultStillExists = settings.customModels.some((entry) => entry?.id === currentDefaultModel);
  if (options.setDefault || !currentDefaultModel || currentDefaultIsGateway || !currentDefaultStillExists) {
    settings.sessionDefaultSettings = {
      ...(settings.sessionDefaultSettings || {}),
      model: preferredDefault.id,
    };
  }

  const configBackup = await backupFile(configFile, options.backup);
  const settingsBackup = await backupFile(settingsFile, options.backup);
  await writeJson(configFile, config);
  await writeJson(settingsFile, settings);

  console.log(`[droid-sync] models: ${resolved.models.length} (${resolved.models.join(", ")})`);
  console.log(`[droid-sync] source: ${resolved.source}`);
  if (configBackup) console.log(`[droid-sync] backup: ${configBackup}`);
  if (settingsBackup) console.log(`[droid-sync] backup: ${settingsBackup}`);
  console.log(`[droid-sync] updated: ${configFile}`);
  console.log(`[droid-sync] updated: ${settingsFile}`);
  console.log(`[droid-sync] default: ${settings.sessionDefaultSettings?.model || "(unchanged)"}`);
}

main().catch((error) => {
  console.error(`[droid-sync] error: ${error.message}`);
  process.exitCode = 1;
});
