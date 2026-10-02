import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AgentConfig } from "./config";

// One small interface over the providers: send a system prompt and a user
// message, get text back.

export type Effort = "low" | "medium" | "high";

export interface LLM {
  complete(system: string, user: string, effort: Effort): Promise<string>;
}

export class AgentError extends Error {}

// Models that take output_config.effort and the server-side refusal fallback.
const CURRENT_CLAUDE = /^claude-(fable-5|opus-5|opus-4-[678]|sonnet-5)/;
const FALLBACK_CLAUDE = /^claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

export function makeLLM(config: AgentConfig): LLM {
  if (config.provider === "anthropic") return new ClaudeLLM(config);
  return new OpenAILLM(config);
}

class ClaudeLLM implements LLM {
  private client: Anthropic;
  constructor(private config: AgentConfig) {
    // No key saved: the SDK reads ANTHROPIC_API_KEY (or an `ant auth login` profile).
    this.client = new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
  }

  async complete(system: string, user: string, effort: Effort): Promise<string> {
    const model = this.config.model;
    const useFallback = this.config.fallbacks !== false && FALLBACK_CLAUDE.test(model);
    try {
      const stream = this.client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system,
        messages: [{ role: "user", content: user }],
        ...(CURRENT_CLAUDE.test(model) ? { output_config: { effort } } : {}),
        ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        throw new AgentError(`The model declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
      }
      if (message.stop_reason === "max_tokens") throw new AgentError("The model's answer was cut off before it finished.");
      return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    } catch (e) {
      if (e instanceof AgentError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new AgentError("The Anthropic API key was rejected. Check it in Studio settings.");
      if (e instanceof Anthropic.NotFoundError) throw new AgentError(`Anthropic doesn't know the model "${model}".`);
      if (e instanceof Anthropic.RateLimitError) throw new AgentError("Anthropic is rate limiting requests. Try again in a moment.");
      if (e instanceof Anthropic.APIError) throw new AgentError(`Anthropic API error ${e.status}: ${e.message}`);
      throw new AgentError(`Couldn't reach Anthropic: ${(e as Error).message}`);
    }
  }
}

class OpenAILLM implements LLM {
  private client: OpenAI;
  constructor(private config: AgentConfig) {
    this.client = new OpenAI({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async complete(system: string, user: string): Promise<string> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const choice = res.choices[0];
      if (!choice?.message.content) throw new AgentError("The model sent an empty answer.");
      if (choice.finish_reason === "length") throw new AgentError("The model's answer was cut off before it finished.");
      return choice.message.content;
    } catch (e) {
      if (e instanceof AgentError) throw e;
      if (e instanceof OpenAI.AuthenticationError) throw new AgentError("The API key was rejected. Check it in Studio settings.");
      if (e instanceof OpenAI.NotFoundError) throw new AgentError(`The provider doesn't know the model "${this.config.model}".`);
      if (e instanceof OpenAI.APIError) throw new AgentError(`API error ${e.status}: ${e.message}`);
      throw new AgentError(`Couldn't reach the provider: ${(e as Error).message}`);
    }
  }
}
