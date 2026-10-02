import { readFileSync } from "node:fs";
import type { Analysis } from "../check";
import { printExpr } from "../explain";
import { stepKey, typeToString, type Expr, type Field } from "../ir";

// The studio's picture of the app, built from the same analysis the runtime
// uses, so what you see is what runs.

export interface FieldView {
  name: string;
  type: string;
  optional: boolean;
  unique?: boolean;
  header?: string;
}

export interface Source {
  file: string; // relative to the app folder
  line: number;
  code: string;
}

export interface StepView {
  key: string;
  module: string;
  name: string;
  title?: string;
  inputs: FieldView[];
  outcomes: { name: string; fields: FieldView[] }[];
  ports: string[];
  lang: "meld" | "js";
  source: Source;
  usedBy: {
    flow: string; // module.flow
    node: string;
    args: { name: string; value: string }[];
    after: string[];
    next: { outcome: string; targets: string[] }[];
  }[];
  callers: string[]; // modules allowed to call it
}

export interface NodeView {
  id: string;
  kind: "do" | "respond";
  name: string;
  step?: string; // step key
  args: { name: string; value: string }[];
  status?: number;
  body?: string;
  deps: { node: string; outcome: string }[];
  inputsUsed: string[]; // flow inputs this line reads
}

export interface FlowView {
  key: string;
  module: string;
  name: string;
  title?: string;
  method: string;
  path: string;
  inputs: FieldView[];
  nodes: NodeView[];
  source: Source;
}

export interface ModuleView {
  name: string;
  title?: string;
  uses: string[];
  tables: { name: string; fields: FieldView[]; source: Source }[];
  fns: { name: string; params: FieldView[]; returns: string; source: Source }[];
  steps: StepView[];
  flows: FlowView[];
}

export interface AppView {
  app: { name: string; title?: string };
  records: { name: string; title?: string; fields: FieldView[] }[];
  modules: ModuleView[];
  links: { from: string; to: string; steps: string[] }[];
}

export function buildView(a: Analysis): AppView {
  const root = a.model.root;
  const files = new Map<string, string[]>();
  const source = (loc: { file: string; line: number }, endLine?: number): Source => {
    let lines = files.get(loc.file);
    if (!lines) {
      lines = readFileSync(loc.file, "utf8").split("\n");
      files.set(loc.file, lines);
    }
    const code = lines.slice(loc.line - 1, endLine ?? loc.line).join("\n");
    return { file: loc.file.startsWith(root + "/") ? loc.file.slice(root.length + 1) : loc.file, line: loc.line, code: dedent(code) };
  };
  const field = (f: Field): FieldView => ({
    name: f.name,
    type: typeToString(f.type),
    optional: f.optional,
    ...(f.unique ? { unique: true } : {}),
    ...(f.source ? { header: f.source.name } : {}),
  });

  const modules: ModuleView[] = [...a.modules.values()].map((m) => ({
    name: m.name,
    title: m.title,
    uses: m.uses.map((u) => stepKey(u.module, u.step)),
    tables: m.tables.map((t) => ({ name: t.name, fields: t.fields.map(field), source: source(t.loc, t.endLine) })),
    fns: m.fns.map((fn) => ({ name: fn.name, params: fn.params.map(field), returns: typeToString(fn.returns), source: source(fn.loc, fn.endLine) })),
    steps: m.steps.map((s) => {
      const key = stepKey(m.name, s.name);
      const usedBy = (a.usages.get(key) ?? []).map((u) => {
        const plan = a.plans.find((p) => p.flow === u.flow)!;
        return {
          flow: stepKey(u.module, u.flow.name),
          node: u.node.name,
          args: u.node.args.map((x) => ({ name: x.name, value: printExpr(x.value) })),
          after: plan.deps.get(u.node.name)!.map((d) => `${d.node}.${d.outcome}`),
          next: s.outcomes.map((o) => ({
            outcome: o.name,
            targets: u.flow.nodes
              .filter((n) => plan.deps.get(n.name)!.some((d) => d.node === u.node.name && d.outcome === o.name))
              .map((n) => (n.kind === "respond" ? `respond ${n.status}` : n.name)),
          })),
        };
      });
      const callers = [m.name, ...[...a.modules.values()].filter((x) => x.uses.some((u) => stepKey(u.module, u.step) === key)).map((x) => x.name)];
      return {
        key,
        module: m.name,
        name: s.name,
        title: s.title,
        inputs: s.inputs.map(field),
        outcomes: s.outcomes.map((o) => ({ name: o.name, fields: o.fields.map(field) })),
        ports: s.ports.map((p) => p.name),
        lang: s.body.kind,
        source: s.body.kind === "js" ? jsSource(s.body.path, root) : source(s.loc, s.endLine),
        usedBy,
        callers,
      };
    }),
    flows: m.flows.map((f) => {
      const plan = a.plans.find((p) => p.flow === f);
      const inputNames = new Set(f.inputs.map((i) => i.name));
      return {
        key: stepKey(m.name, f.name),
        module: m.name,
        name: f.name,
        title: f.title,
        method: f.trigger.method,
        path: f.trigger.path,
        inputs: f.inputs.map(field),
        source: source(f.loc, f.endLine),
        nodes: f.nodes.map((n) => {
          const used = new Set<string>();
          const exprs: Expr[] = n.kind === "do" ? n.args.map((x) => x.value) : n.body ? [n.body] : [];
          for (const e of exprs) collectNames(e, (name) => inputNames.has(name) && used.add(name));
          return {
            id: n.name,
            kind: n.kind,
            name: n.kind === "respond" ? `respond ${n.status}` : n.name,
            ...(n.target ? { step: stepKey(n.target.module || m.name, n.target.step) } : {}),
            args: n.args.map((x) => ({ name: x.name, value: printExpr(x.value) })),
            ...(n.status ? { status: n.status } : {}),
            ...(n.body ? { body: printExpr(n.body) } : {}),
            deps: plan?.deps.get(n.name) ?? [],
            inputsUsed: [...used],
          };
        }),
      };
    }),
  }));

  const links = new Map<string, { from: string; to: string; steps: string[] }>();
  for (const m of a.modules.values()) {
    for (const u of m.uses) {
      const k = `${m.name}->${u.module}`;
      const link = links.get(k) ?? { from: m.name, to: u.module, steps: [] };
      link.steps.push(u.step);
      links.set(k, link);
    }
  }

  return {
    app: { name: a.model.app?.name ?? "app", title: a.model.app?.title },
    records: [...a.records.values()].filter((r) => !r.name.includes(".")).map((r) => ({ name: r.name, title: r.title, fields: r.fields.map(field) })),
    modules,
    links: [...links.values()],
  };
}

function jsSource(path: string, root: string): Source {
  return { file: path.startsWith(root + "/") ? path.slice(root.length + 1) : path, line: 1, code: readFileSync(path, "utf8") };
}

function dedent(code: string): string {
  const lines = code.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

function collectNames(e: Expr, cb: (name: string) => void, locals = new Set<string>()) {
  switch (e.kind) {
    case "name":
      if (!locals.has(e.name)) cb(e.name);
      return;
    case "member":
      return collectNames(e.object, cb, locals);
    case "index":
      collectNames(e.object, cb, locals);
      return collectNames(e.index, cb, locals);
    case "call":
      collectNames(e.callee, cb, locals);
      e.args.forEach((x) => collectNames(x, cb, locals));
      return (e.named ?? []).forEach((x) => collectNames(x.value, cb, locals));
    case "list":
      return e.items.forEach((x) => collectNames(x, cb, locals));
    case "object":
      return e.entries.forEach((x) => collectNames(x.value, cb, locals));
    case "unary":
      return collectNames(e.operand, cb, locals);
    case "binary":
      collectNames(e.left, cb, locals);
      return collectNames(e.right, cb, locals);
    case "cond":
      collectNames(e.test, cb, locals);
      collectNames(e.then, cb, locals);
      return collectNames(e.else, cb, locals);
    case "lambda":
      return collectNames(e.body, cb, new Set([...locals, ...e.params]));
    default:
      return;
  }
}
