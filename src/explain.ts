import type { Analysis, FlowPlan } from "./check";
import { stepKey, typeToString, type Expr, type Field, type FlowNode, type StepDef } from "./ir";

// Views over the analysis. These are what a person working on one piece reads
// to see how it fits the whole; they come from the same analysis the runtime uses.

const fields = (fs: Field[]) => fs.map((f) => `${f.name}${f.optional ? "?" : ""}: ${typeToString(f.type)}`).join(", ");
const quoted = (t?: string) => (t ? `"${t}"` : "");

export function explainApp(a: Analysis): string {
  const out: string[] = [];
  const app = a.model.app;
  out.push(`${app?.title ?? app?.name ?? "(no app)"}${app?.title ? ` (${app.name})` : ""}`, "");
  for (const m of a.modules.values()) {
    out.push(`module ${m.name} ${quoted(m.title)}`.trimEnd());
    if (m.uses.length) out.push(`  uses      ${m.uses.map((u) => `${u.module}.${u.step}`).join(", ")}`);
    for (const s of m.steps) {
      const callers = (a.usages.get(stepKey(m.name, s.name)) ?? []).map((u) => `${u.module}.${u.flow.name}`);
      const ports = s.ports.length ? `  [${s.ports.map((p) => p.name).join(", ")}]` : "";
      const lang = s.body.kind === "js" ? "  (JavaScript)" : "";
      out.push(`  step      ${s.name} ${quoted(s.title)}${ports}${lang}${callers.length ? `  ← ${[...new Set(callers)].join(", ")}` : "  (not used by any flow)"}`);
    }
    for (const f of m.flows) out.push(`  flow      ${f.trigger.method} ${f.trigger.path}  ${f.name} ${quoted(f.title)}`.trimEnd());
    out.push("");
  }
  const edges = new Map<string, Set<string>>();
  for (const m of a.modules.values()) for (const u of m.uses) {
    const set = edges.get(`${m.name} → ${u.module}`) ?? new Set();
    set.add(u.step);
    edges.set(`${m.name} → ${u.module}`, set);
  }
  if (edges.size) {
    out.push("Who depends on whom");
    for (const [e, steps] of edges) out.push(`  ${e}  (${[...steps].join(", ")})`);
  }
  return out.join("\n").trimEnd();
}

export function explainFlow(a: Analysis, plan: FlowPlan): string {
  const f = plan.flow;
  const out: string[] = [];
  out.push(`${f.title ?? f.name}   ${f.module}.${f.name}   ${f.trigger.method} ${f.trigger.path}`);
  out.push(`needs: ${fields(f.inputs) || "(nothing)"}`, "");
  const byName = new Map(f.nodes.map((n) => [n.name, n]));
  const label = (n: FlowNode) => (n.kind === "respond" ? `respond ${n.status}` : n.name);
  const width = Math.max(...f.nodes.filter((n) => n.kind === "do").map((n) => n.name.length), 4);
  for (const name of plan.order) {
    const n = byName.get(name)!;
    if (n.kind !== "do") continue;
    const step = a.steps.get(stepKey(n.target!.module || f.module, n.target!.step));
    const waits = plan.deps.get(name)!.map((d) => `${d.node}.${d.outcome}`);
    out.push(`  ${n.name.padEnd(width)}  ${(step?.title ?? "").padEnd(24)}  ${step ? `${step.module}.${step.name}` : "?"}${waits.length ? `   (after ${waits.join(", ")})` : "   (starts right away)"}`);
    for (const o of step?.outcomes ?? []) {
      const next = f.nodes.filter((m) => plan.deps.get(m.name)!.some((d) => d.node === name && d.outcome === o.name)).map(label);
      out.push(`  ${"".padEnd(width)}    ${o.name} → ${next.join(", ") || "(nothing!)"}`);
    }
  }
  return out.join("\n");
}

export function whoUses(a: Analysis, key: string): string {
  const step = a.steps.get(key);
  if (!step) return `No step called ${key}. Steps: ${[...a.steps.keys()].join(", ")}`;
  const out: string[] = [];
  out.push(`${key} ${quoted(step.title)}`.trimEnd());
  out.push(`  owned by module ${step.module}, written in ${step.body.kind === "js" ? "JavaScript" : "Meld"}`);
  out.push(`  takes    ${fields(step.inputs) || "(nothing)"}`);
  out.push(`  results  ${step.outcomes.map((o) => `${o.name}(${fields(o.fields)})`).join(" | ")}`);
  const tables = a.modules.get(step.module)?.tables.map((t) => t.name).join(", ") ?? "";
  const port = (name: string) =>
    name === "store" ? `store (module ${step.module}'s data)` : name === "db" ? `db (module ${step.module}'s tables: ${tables})` : name;
  out.push(`  touches  ${step.ports.map((p) => port(p.name)).join(", ") || "nothing outside itself"}`);
  const uses = a.usages.get(key) ?? [];
  out.push("", uses.length ? `Used in ${uses.length} place${uses.length > 1 ? "s" : ""}:` : "Not used by any flow yet.");
  for (const u of uses) {
    const plan = a.plans.find((p) => p.flow === u.flow)!;
    out.push(`  ${u.module}.${u.flow.name} ${quoted(u.flow.title)}  ${u.flow.trigger.method} ${u.flow.trigger.path}  (as '${u.node.name}')`);
    const waits = plan.deps.get(u.node.name)!.map((d) => `${d.node}.${d.outcome}`);
    if (waits.length) out.push(`    runs after  ${waits.join(", ")}`);
    for (const arg of u.node.args) out.push(`    ${arg.name.padEnd(10)} ← ${printExpr(arg.value)}`);
    for (const o of step.outcomes) {
      const next = u.flow.nodes.filter((m) => plan.deps.get(m.name)!.some((d) => d.node === u.node.name && d.outcome === o.name));
      out.push(`    on ${o.name} → ${next.map((m) => (m.kind === "respond" ? `respond ${m.status}` : describeNode(a, u.flow.module, m))).join(", ")}`);
    }
  }
  const allowed = [...a.modules.values()].filter((m) => m.uses.some((x) => stepKey(x.module, x.step) === key)).map((m) => m.name);
  out.push("", `Modules allowed to call it: ${[step.module, ...allowed].join(", ")}`);
  return out.join("\n");
}

function describeNode(a: Analysis, module: string, n: FlowNode): string {
  const s: StepDef | undefined = a.steps.get(stepKey(n.target!.module || module, n.target!.step));
  return `${n.name} (${s ? `${s.module}.${s.name}` : "?"})`;
}

export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "num": return String(e.value);
    case "str": return JSON.stringify(e.value);
    case "bool": return String(e.value);
    case "null": return "null";
    case "name": return e.name;
    case "list": return `[${e.items.map(printExpr).join(", ")}]`;
    case "object": return `{ ${e.entries.map((x) => `${x.key}: ${printExpr(x.value)}`).join(", ")} }`;
    case "member": return `${printExpr(e.object)}.${e.name}`;
    case "index": return `${printExpr(e.object)}[${printExpr(e.index)}]`;
    case "call": return `${printExpr(e.callee)}(${e.named ? e.named.map((n) => `${n.name}: ${printExpr(n.value)}`).join(", ") : e.args.map(printExpr).join(", ")})`;
    case "unary": return `${e.op}${printExpr(e.operand)}`;
    case "binary": return `${printExpr(e.left)} ${e.op} ${printExpr(e.right)}`;
    case "cond": return `${printExpr(e.test)} ? ${printExpr(e.then)} : ${printExpr(e.else)}`;
    case "lambda": return `${e.params.length === 1 ? e.params[0] : `(${e.params.join(", ")})`} => ${printExpr(e.body)}`;
  }
}
