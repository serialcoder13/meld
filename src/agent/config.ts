import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Which model the Meld agent talks to. Saved in the user's home folder (never
// in the project, so a key can't end up in git), readable only by the user.

export type Provider = "anthropic" | "openai" | "openai-compatible";

export interface AgentConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string; // for openai-compatible providers (Ollama, OpenRouter, Groq, Gemini, ...)
  fallbacks?: boolean; // Anthropic only: retry a declined request on a fallback model (default on)
}

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5",
  "openai-compatible": "",
};

export function configPath(): string {
  return process.env.MELD_AGENT_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "meld", "agent.json");
}

/** The saved config, falling back to provider keys in the environment. */
export function loadConfig(): AgentConfig | undefined {
  const path = configPath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as AgentConfig;
    } catch {
      return undefined;
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", model: DEFAULT_MODELS.anthropic };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", model: DEFAULT_MODELS.openai };
  return undefined;
}

export function saveConfig(next: AgentConfig, keepKey: boolean) {
  const path = configPath();
  const previous = loadConfig();
  const config: AgentConfig = { ...next };
  if (keepKey && !config.apiKey && previous?.apiKey && previous.provider === config.provider) config.apiKey = previous.apiKey;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** What the studio may show: never the key itself. */
export function publicConfig(c: AgentConfig | undefined) {
  if (!c) return { configured: false as const };
  const envKey = c.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  return {
    configured: true as const,
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    fallbacks: c.fallbacks !== false,
    key: c.apiKey ? `saved (…${c.apiKey.slice(-4)})` : envKey ? "from environment" : "missing",
  };
}
