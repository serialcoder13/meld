import type { Engine } from "./engine";
import type { Field, TypeRef } from "./ir";
import studioPage from "./studio/index.html";
import { buildView } from "./studio/view";

// One Bun server. Every route comes from a flow in the model; there is no
// other way to add one.

type RouteRequest = Request & { params: Record<string, string> };

export function createServer(engine: Engine, port: number, opts: { studio?: boolean } = {}) {
  const routes: Record<string, Record<string, (req: RouteRequest) => Promise<Response>>> = {};
  for (const plan of engine.analysis.plans) {
    const { method, path } = plan.flow.trigger;
    routes[path] ??= {};
    routes[path][method] = async (req) => {
      const input = await readInput(req, plan.flow.inputs, method);
      if (input instanceof Response) return input;
      const result = await engine.run(plan, input);
      if (result.body === undefined) return new Response(null, { status: result.status });
      return Response.json(result.body, { status: result.status });
    };
  }
  routes["/_meld/model"] = {
    GET: async () =>
      Response.json({
        app: engine.analysis.model.app?.name,
        modules: [...engine.analysis.modules.values()].map((m) => ({
          name: m.name,
          title: m.title,
          uses: m.uses.map((u) => `${u.module}.${u.step}`),
          tables: m.tables.map((t) => t.name),
          steps: m.steps.map((s) => ({ name: s.name, title: s.title, body: s.body.kind, ports: s.ports.map((p) => p.name) })),
          flows: m.flows.map((f) => ({ name: f.name, title: f.title, route: `${f.trigger.method} ${f.trigger.path}` })),
        })),
      }),
  };
  routes["/_meld/traces"] = { GET: async () => Response.json([...engine.traces].reverse()) };

  const studio = opts.studio ? { "/_meld/studio": studioPage, "/_meld/view": { GET: async () => Response.json(buildView(engine.analysis)) } } : {};

  return Bun.serve({
    port,
    development: opts.studio ? { hmr: false, console: false } : false,
    routes: { ...routes, ...studio } as never,
    fetch: (req) => {
      const url = new URL(req.url);
      return Response.json({ errors: { route: [`No flow handles ${req.method} ${url.pathname}.`] } }, { status: 404 });
    },
  });
}

const bad = (message: string) => Response.json({ errors: { body: [message] } }, { status: 400 });

async function readInput(req: RouteRequest, fields: Field[], method: string): Promise<Record<string, unknown> | Response> {
  const input: Record<string, unknown> = {};
  const fromHeader = fields.filter((f) => f.source?.kind === "header");
  if (method === "GET" || method === "DELETE") {
    const url = new URL(req.url);
    for (const [k, v] of url.searchParams) {
      const field = fields.find((f) => f.name === k);
      if (field?.source) continue;
      input[k] = coerce(v, field?.type);
    }
  } else {
    const text = await req.text();
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return bad("is not valid JSON");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("must be a JSON object");
      for (const f of fromHeader) delete (body as Record<string, unknown>)[f.name];
      Object.assign(input, body);
    }
  }
  for (const [k, v] of Object.entries(req.params ?? {})) {
    input[k] = coerce(decodeURIComponent(v), fields.find((f) => f.name === k)?.type);
  }
  for (const f of fromHeader) {
    const v = req.headers.get(f.source!.name);
    if (v !== null) input[f.name] = v;
  }
  return input;
}

function coerce(v: string, type: TypeRef | undefined): unknown {
  const t = type?.kind === "nullable" ? type.of : type;
  if (!t) return v;
  if (t.kind === "number" || t.kind === "money") return v.trim() === "" || Number.isNaN(Number(v)) ? v : Number(v);
  if (t.kind === "bool") return v === "true" ? true : v === "false" ? false : v;
  return v;
}
