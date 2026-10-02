import ELK from "elkjs/lib/elk.bundled.js";
import type { AppView, FieldView, FlowView, ModuleView, StepView } from "./view";

// ---- colors: the same name always gets the same color (as in kirun-ui) ----

const SIDE_COLORS = [
  "#3B82F6", "#6366F1", "#10B981", "#22C55E", "#8B5CF6", "#A855F7", "#EC4899", "#F43F5E",
  "#F97316", "#EAB308", "#14B8A6", "#06B6D4", "#0EA5E9", "#D946EF", "#84CC16", "#0891B2",
];

export function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return SIDE_COLORS[(Math.abs(hash) + 12) % SIDE_COLORS.length]!;
}

export function statusColor(status: number): string {
  if (status < 300) return "#10B981";
  if (status === 401 || status === 403) return "#F97316";
  if (status < 500) return "#EAB308";
  return "#F43F5E";
}

export const METHOD_COLORS: Record<string, string> = {
  GET: "bg-sky-100 text-sky-700",
  POST: "bg-emerald-100 text-emerald-700",
  PUT: "bg-amber-100 text-amber-700",
  PATCH: "bg-amber-100 text-amber-700",
  DELETE: "bg-rose-100 text-rose-700",
};

export const PORT_HELP: Record<string, string> = {
  db: "reads and writes its module's tables",
  store: "keeps small values for its module",
  crypto: "hashes passwords and signs tokens",
  clock: "reads the current time",
  ids: "hands out new numbers",
  log: "writes to the run log",
};

// ---- finding things in the view ----

export function findFlow(view: AppView, key: string): FlowView | undefined {
  for (const m of view.modules) for (const f of m.flows) if (f.key === key) return f;
}

export function findStep(view: AppView, key: string): StepView | undefined {
  for (const m of view.modules) for (const s of m.steps) if (s.key === key) return s;
}

export function findModule(view: AppView, name: string): ModuleView | undefined {
  return view.modules.find((m) => m.name === name);
}

export function fieldLabel(f: FieldView): string {
  return `${f.name}${f.optional ? "?" : ""}: ${f.type}`;
}

// A starting request body for a flow, built from its input types.
export function sampleBody(view: AppView, flow: FlowView): unknown {
  const body: Record<string, unknown> = {};
  const pathParams = new Set([...flow.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  for (const f of flow.inputs) {
    if (f.header || pathParams.has(f.name) || f.optional) continue;
    body[f.name] = sample(view, f.type, 0);
  }
  return body;
}

function sample(view: AppView, type: string, depth: number): unknown {
  if (type.endsWith(" | null")) return sample(view, type.slice(0, -7), depth);
  if (type.startsWith("list<")) return [sample(view, type.slice(5, -1), depth + 1)];
  if (type.startsWith("map<")) return {};
  if (type === "text") return "";
  if (type === "number" || type === "money") return 0;
  if (type === "bool") return false;
  const rec = view.records.find((r) => r.name === type);
  if (!rec || depth > 3) return {};
  const out: Record<string, unknown> = {};
  for (const f of rec.fields) if (!f.optional) out[f.name] = sample(view, f.type, depth + 1);
  return out;
}

// ---- automatic layout (ELK, left to right) ----

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  outPorts: string[];
}

export interface LayoutEdge {
  id: string;
  source: string;
  sourcePort?: string;
  target: string;
}

const elk = new ELK();

export async function layout(nodes: LayoutNode[], edges: LayoutEdge[], opts: { spacing?: number } = {}) {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(opts.spacing ?? 110),
      "elk.spacing.nodeNode": "48",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.semiInteractive": "true",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
      ports: [
        { id: `${n.id}::in`, layoutOptions: { "elk.port.side": "WEST" } },
        ...n.outPorts.map((p, i) => ({ id: `${n.id}::${p}`, layoutOptions: { "elk.port.side": "EAST", "elk.port.index": String(i) } })),
      ],
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.sourcePort ? `${e.source}::${e.sourcePort}` : e.source],
      targets: [`${e.target}::in`],
    })),
  };
  const out = await elk.layout(graph);
  return new Map((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
