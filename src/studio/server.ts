import type { Server } from "bun";
import { MeldAgent, type Proposal } from "../agent/agent";
import { loadConfig, publicConfig, saveConfig, type AgentConfig } from "../agent/config";
import { AgentError, makeLLM } from "../agent/llm";
import { analyze } from "../check";
import { draftDoc, draftTitle, writeDraft, type Draft, type Target } from "../edit";
import { Engine } from "../engine";
import { formatDiagnostic } from "../ir";
import { loadModel } from "../load";
import type { Storage } from "../ports";
import { appRoutes, notFound } from "../server";
import studioPage from "./index.html";
import { buildView } from "./view";

// Meld Studio: the running app plus a visual view of it, and the place where
// people change it. Every change is checked against the whole app before it's
// written, and the app reloads without a restart.

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

export class Studio {
  engine: Engine;
  private server!: Server<unknown>;
  private proposals = new Map<string, Proposal>();
  private agentInstance: { config: string; agent: MeldAgent } | undefined;

  constructor(private root: string, private storage: Storage, engine: Engine) {
    this.engine = engine;
  }

  start(port: number) {
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1", // the studio can change files: only this machine may reach it
      development: { hmr: false, console: false },
      routes: this.routes() as never,
      fetch: notFound,
    });
    return this.server;
  }

  /** Re-read the model from disk and swap in the new app. */
  async reload(): Promise<string[]> {
    const { model, diagnostics } = loadModel(this.root);
    const analysis = analyze(model);
    const problems = (diagnostics.length ? diagnostics : analysis.diagnostics).map((d) => formatDiagnostic(d, this.root));
    if (problems.length) return problems;
    const engine = new Engine(analysis, { storage: this.storage, previous: this.engine });
    await engine.load();
    this.engine = engine;
    this.server.reload({ routes: this.routes() as never, fetch: notFound });
    return [];
  }

  private agent(): MeldAgent {
    const config = loadConfig();
    if (!config) throw new AgentError("Set up the AI agent first: open Settings and choose a provider, model and key.");
    const key = JSON.stringify(config);
    if (this.agentInstance?.config !== key) this.agentInstance = { config: key, agent: new MeldAgent(makeLLM(config)) };
    return this.agentInstance.agent;
  }

  private async save(draft: Draft): Promise<Response> {
    if (draft.problems.length) return json({ ok: false, problems: draft.problems }, 422);
    writeDraft(draft);
    const problems = await this.reload();
    return json({ ok: problems.length === 0, problems });
  }

  private routes() {
    // Changes need a custom header, so a web page in the browser can't post them cross-site.
    const guarded =
      (handler: (body: Record<string, unknown>, req: Request & { params: Record<string, string> }) => Promise<Response>) =>
      async (req: Request & { params: Record<string, string> }) => {
        if (req.headers.get("x-meld-studio") !== "1") return fail("Missing the x-meld-studio header.", 403);
        let body: Record<string, unknown> = {};
        try {
          const text = await req.text();
          if (text) body = JSON.parse(text);
        } catch {
          return fail("The request body is not valid JSON.");
        }
        try {
          return await handler(body, req);
        } catch (e) {
          if (e instanceof AgentError) return fail(e.message, 502);
          return fail((e as Error).message, 500);
        }
      };
    const target = (body: Record<string, unknown>): Target => body.target as Target;

    return {
      ...appRoutes(this.engine),
      "/_meld/studio": studioPage,
      "/_meld/view": { GET: async () => json(buildView(this.engine.analysis)) },
      "/_meld/agent": {
        GET: async () => json(publicConfig(loadConfig())),
        PUT: guarded(async (body) => {
          const config = body as unknown as AgentConfig;
          if (!["anthropic", "openai", "openai-compatible"].includes(config.provider)) return fail("Unknown provider.");
          if (!config.model?.trim()) return fail("Choose a model.");
          if (config.provider === "openai-compatible" && !config.baseUrl?.trim()) return fail("An OpenAI-compatible provider needs its base URL.");
          saveConfig({ ...config, model: config.model.trim(), apiKey: config.apiKey?.trim() || undefined }, true);
          return json(publicConfig(loadConfig()));
        }),
      },
      "/_meld/agent/test": {
        POST: guarded(async () => {
          const config = loadConfig();
          if (!config) return fail("The agent isn't set up yet.");
          const reply = await makeLLM(config).complete("Reply with the single word OK.", "Are you there?", "low");
          return json({ ok: true, reply: reply.trim().slice(0, 200) });
        }),
      },
      "/_meld/explain": {
        POST: guarded(async (body) => json({ doc: await this.agent().explain(this.engine.analysis, target(body)) })),
      },
      "/_meld/doc": {
        POST: guarded(async (body) => this.save(draftDoc(this.engine.analysis, target(body), String(body.doc ?? "")))),
      },
      "/_meld/title": {
        POST: guarded(async (body) => this.save(draftTitle(this.engine.analysis, target(body), String(body.title ?? "")))),
      },
      "/_meld/propose": {
        POST: guarded(async (body) => {
          const doc = typeof body.doc === "string" && body.doc.trim() ? body.doc.trim() : undefined;
          const instruction = typeof body.instruction === "string" && body.instruction.trim() ? body.instruction.trim() : undefined;
          if (!doc && !instruction) return fail("Say what should change.");
          const p = await this.agent().propose(this.engine.analysis, target(body), { doc, instruction });
          this.proposals.set(p.id, p);
          const { draft: _draft, ...shown } = p;
          return json(shown);
        }),
      },
      "/_meld/proposals/:id/apply": {
        POST: guarded(async (_body, req) => {
          const p = this.proposals.get(req.params.id!);
          if (!p) return fail("That proposal has expired. Ask again.", 404);
          this.proposals.delete(p.id);
          return this.save(p.draft);
        }),
      },
    };
  }
}
