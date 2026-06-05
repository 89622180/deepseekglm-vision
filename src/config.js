import fs from "node:fs";
import path from "node:path";

const DEFAULT_MULTIMODAL_MODELS = [
  "GLM-5.1",
  "GLM-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash"
];
const DEFAULT_MULTIMODAL_TARGET_MODEL = "gpt-5.4";

function loadDotEnv() {
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
      return;
    }

    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      if (index === -1) {
        continue;
      }
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // The middleware still works with process env when .env is unavailable.
  }
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

function parseModelList(raw) {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig() {
  loadDotEnv();
  const multimodalModels = parseModelList(
    env("MULTIMODAL_MODELS", DEFAULT_MULTIMODAL_MODELS.join(","))
  );

  return {
    host: env("HOST", "0.0.0.0"),
    port: Number(env("PORT", "8080")),
    routeMode: env("ROUTE_MODE", "default").toLowerCase(),
    defaultBackendBaseUrl: normalizeBaseUrl(
      env("DEFAULT_BACKEND_BASE_URL", "http://127.0.0.1:8090/v1")
    ),
    multimodalModels,
    multimodalModelSet: new Set(multimodalModels.map((name) => name.toLowerCase())),
    visionBackendBaseUrl: env("VISION_BACKEND_BASE_URL"),
    visionBackendApiKey: env("VISION_BACKEND_API_KEY"),
    visionBackendModel: env("VISION_BACKEND_MODEL", DEFAULT_MULTIMODAL_TARGET_MODEL),
    customBackendBaseUrl: env("CUSTOM_BACKEND_BASE_URL"),
    customBackendApiKey: env("CUSTOM_BACKEND_API_KEY"),
    customBackendModel: env("CUSTOM_BACKEND_MODEL"),
    upstreamTimeoutMs: Number(env("UPSTREAM_TIMEOUT_MS", "600000"))
  };
}

export function isSupportedRouteMode(routeMode) {
  return ["default", "custom-vision", "custom-all"].includes(routeMode);
}
