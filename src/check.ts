import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  PORTS,
  stepKey,
  typeToString,
  type Diagnostic,
  type Expr,
  type Field,
  type FlowDef,
  type FlowNode,
  type FnDef,
  type OutcomeDef,
  type Loc,
  type Model,
  type ModuleDef,
  type RecordDef,
  type StepDef,
  type Stmt,
  type TypeRef,
} from "./ir";
import { BUILTIN_NAMES } from "./interp";
import { assignable } from "./values";

// The one analyzer. The runtime, `meld explain` and `meld who-uses` all read
// its output, so what you see is exactly what runs.

export interface Dep {
  node: string;
  outcome: string;
}

export interface FlowPlan {
  flow: FlowDef;
  deps: Map<string, Dep[]>; // node name -> outcomes it waits for
  order: string[]; // a topological order of node names, for display
}

export interface Usage {
  module: string;
  flow: FlowDef;
  node: FlowNode;
}

export interface Analysis {
  model: Model;
  diagnostics: Diagnostic[];
  records: Map<string, RecordDef>;
  modules: Map<string, ModuleDef>;
  steps: Map<string, StepDef>;
  plans: FlowPlan[];
  usages: Map<string, Usage[]>; // step key -> flows that call it
}

export function analyze(model: Model): Analysis {
  const a: Analysis = {
    model,
    diagnostics: [],
    records: new Map(),
    modules: new Map(),
    steps: new Map(),
    plans: [],
    usages: new Map(),
  };
  const err = (loc: Loc, message: string) => a.diagnostics.push({ loc, message });

  if (!model.app) err({ file: model.root, line: 1, col: 1 }, "No app is declared. Add a line like: app shop \"My shop\"");

  for (const r of model.records) {
    if (a.records.has(r.name)) err(r.loc, `Record ${r.name} is declared twice.`);
    a.records.set(r.name, r);
  }
  for (const m of model.modules) {
    if (a.modules.has(m.name)) err(m.loc, `Module ${m.name} is declared twice.`);
    a.modules.set(m.name, m);
    // each table's rows have a type, row<table>, with an automatic id
    for (const t of m.tables) {
      a.records.set(`${m.name}.${t.name}`, {
        name: `${m.name}.${t.name}`,
        fields: [{ name: "id", type: { kind: "number" }, optional: false, loc: t.loc }, ...t.fields],
        loc: t.loc,
      });
    }
    for (const s of m.steps) {
      const key = stepKey(m.name, s.name);
      if (a.steps.has(key)) err(s.loc, `Step ${s.name} is declared twice in module ${m.name}.`);
      a.steps.set(key, s);
    }
  }

  const checkType = (t: TypeRef, loc: Loc) => {
    if (t.kind === "list" || t.kind === "map" || t.kind === "nullable") checkType(t.of, loc);
    if (t.kind === "nullable" && t.of.kind === "nullable") err(loc, "A type can only be '| null' once.");
    if (t.kind === "record" && !a.records.has(t.name)) err(loc, t.name.includes(".") ? `Unknown table in ${typeToString(t)}.` : `Unknown record ${t.name}.`);
  };
  const checkFields = (fields: Field[], what: string, allow: { unique?: boolean; header?: boolean } = {}) => {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name)) err(f.loc, `${what} has two fields named ${f.name}.`);
      seen.add(f.name);
      checkType(f.type, f.loc);
      if (f.unique && !allow.unique) err(f.loc, "'unique' only applies to table columns.");
      if (f.unique && !["text", "number"].includes(f.type.kind)) err(f.loc, "Only text and number columns can be unique.");
      if (f.source && !allow.header) err(f.loc, "Only flow inputs can come from a header.");
      if (f.source && !(f.type.kind === "text" && f.optional)) err(f.loc, `A header input is optional text: ${f.name}?: text from header "${f.source.name}".`);
    }
  };

  for (const r of model.records) checkFields(r.fields, `Record ${r.name}`);

  const routes = new Map<string, FlowDef>();
  for (const m of model.modules) {
    for (const u of m.uses) {
      if (u.module === m.name) err(u.loc, `Module ${m.name} doesn't need 'uses' for its own steps.`);
      else if (!a.modules.has(u.module)) err(u.loc, `Unknown module ${u.module}.`);
      else if (!a.steps.has(stepKey(u.module, u.step))) err(u.loc, `Module ${u.module} has no step ${u.step}.`);
    }
    const names = new Set<string>();
    for (const t of m.tables) {
      if (names.has(t.name)) err(t.loc, `Module ${m.name} already has a table called ${t.name}.`);
      names.add(t.name);
      checkFields(t.fields, `Table ${t.name}`, { unique: true });
      if (t.fields.some((f) => f.name === "id")) err(t.loc, `Table ${t.name} gets an automatic id: number; don't declare one.`);
    }
    const fnNames = new Set<string>();
    for (const fn of m.fns) {
      if (fnNames.has(fn.name)) err(fn.loc, `Module ${m.name} already has a function called ${fn.name}.`);
      if (BUILTIN_NAMES.has(fn.name)) err(fn.loc, `${fn.name} is a builtin; pick another name.`);
      fnNames.add(fn.name);
      checkFields(fn.params, `Function ${fn.name}`);
      checkType(fn.returns, fn.loc);
    }
    for (const fn of m.fns) checkFn(m, fn, err);
    for (const s of m.steps) checkStep(m, s, checkFields, err);
    for (const f of m.flows) {
      const route = `${f.trigger.method} ${f.trigger.path}`;
      const other = routes.get(route);
      if (other) err(f.trigger.loc, `${route} is already handled by flow ${other.module}.${other.name}.`);
      routes.set(route, f);
      checkFields(f.inputs, `Flow ${f.name}`, { header: true });
      const plan = checkFlow(a, m, f, err);
      if (plan) a.plans.push(plan);
    }
  }
  a.diagnostics.sort((x, y) => x.loc.file.localeCompare(y.loc.file) || x.loc.line - y.loc.line || x.loc.col - y.loc.col);
  return a;
}

// ---- steps and functions ------------------------------------------------------

function checkStep(m: ModuleDef, s: StepDef, checkFields: (f: Field[], what: string) => void, err: (loc: Loc, msg: string) => void) {
  checkFields(s.inputs, `Step ${s.name}`);
  const outcomeNames = new Set<string>();
  for (const o of s.outcomes) {
    if (outcomeNames.has(o.name)) err(o.loc, `Step ${s.name} has two outcomes named ${o.name}.`);
    outcomeNames.add(o.name);
    checkFields(o.fields, `Outcome ${o.name}`);
  }
  const ports = new Set<string>(s.ports.map((p) => p.name));
  if (ports.has("db") && !m.tables.length) err(s.ports.find((p) => p.name === "db")!.loc, `Step ${s.name} uses db, but module ${m.name} has no tables.`);

  if (s.body.kind === "js") {
    checkJsStep(m, s, s.body.path, s.body.loc, ports, err);
    return;
  }
  checkBody(m, s.body.stmts, { what: `step ${s.name}`, params: s.inputs, outcomes: s.outcomes, ports }, err);
  if (!alwaysReturns(s.body.stmts)) err(s.loc, `Step ${s.name} can reach its end without returning an outcome.`);
}

function checkFn(m: ModuleDef, fn: FnDef, err: (loc: Loc, msg: string) => void) {
  checkBody(m, fn.body, { what: `function ${fn.name}`, params: fn.params, outcomes: [], ports: new Set() }, err);
  if (!alwaysReturns(fn.body)) err(fn.loc, `Function ${fn.name} can reach its end without returning a value.`);
}

interface BodyCtx {
  what: string;
  params: Field[];
  outcomes: OutcomeDef[];
  ports: Set<string>;
}

// Name resolution and the rules for step and function bodies.
function checkBody(m: ModuleDef, stmts: Stmt[], ctx: BodyCtx, err: (loc: Loc, msg: string) => void) {
  const isStep = ctx.outcomes.length > 0;
  const outcomeNames = new Set(ctx.outcomes.map((o) => o.name));
  const fns = new Map(m.fns.map((f) => [f.name, f]));
  const tables = new Set(m.tables.map((t) => t.name));
  const top = new Set<string>([...BUILTIN_NAMES, ...fns.keys(), ...ctx.params.map((f) => f.name), ...ctx.ports, ...outcomeNames]);
  const scopes: Set<string>[] = [top];
  const defined = (n: string) => scopes.some((sc) => sc.has(n));

  const checkName = (name: string, loc: Loc) => {
    if (defined(name)) return;
    if ((PORTS as readonly string[]).includes(name)) {
      if (isStep) err(loc, `The ${ctx.what} uses '${name}' but doesn't declare it. Add 'uses ${name}' after its outcomes.`);
      else err(loc, `Functions can't use ports like '${name}'. Do this in a step instead.`);
    } else err(loc, `'${name}' is not defined in ${ctx.what}.`);
  };

  const expr = (e: Expr, locals: Set<string>, inReturn = false): void => {
    switch (e.kind) {
      case "name":
        if (!locals.has(e.name)) checkName(e.name, e.loc);
        if (!locals.has(e.name) && outcomeNames.has(e.name) && !inReturn) {
          err(e.loc, `Outcome ${e.name}(...) can only be used in a return.`);
        }
        return;
      case "call": {
        const callee = e.callee.kind === "name" && !locals.has(e.callee.name) ? e.callee.name : undefined;
        if (callee && outcomeNames.has(callee)) {
          if (!inReturn) err(e.loc, `Outcome ${callee}(...) can only be used in a return.`);
          const outcome = ctx.outcomes.find((o) => o.name === callee)!;
          if (e.args.length) err(e.loc, `Give outcome fields by name, e.g. ${outcome.name}(${outcome.fields.map((f) => `${f.name}: ...`).join(", ")}).`);
          const given = new Set((e.named ?? []).map((n) => n.name));
          for (const f of outcome.fields) if (!f.optional && !given.has(f.name)) err(e.loc, `Outcome ${outcome.name} needs ${f.name} (${typeToString(f.type)}).`);
          for (const n of e.named ?? []) {
            if (!outcome.fields.some((f) => f.name === n.name)) err(n.loc, `Outcome ${outcome.name} has no field ${n.name}.`);
            expr(n.value, locals);
          }
          return;
        }
        const fn = callee ? fns.get(callee) : undefined;
        if (fn && !scopes.slice(1).some((sc) => sc.has(fn.name))) {
          if (e.named) err(e.loc, `${fn.name}(...) takes its arguments in order: ${fn.name}(${fn.params.map((p) => p.name).join(", ")}).`);
          else if (e.args.length !== fn.params.length) err(e.loc, `${fn.name}(...) takes ${fn.params.length} argument(s): ${fn.params.map((p) => p.name).join(", ")}.`);
        }
        expr(e.callee, locals);
        for (const x of e.args) expr(x, locals);
        for (const n of e.named ?? []) expr(n.value, locals);
        return;
      }
      case "member":
        if (e.object.kind === "name" && e.object.name === "db" && !locals.has("db") && ctx.ports.has("db") && !tables.has(e.name)) {
          err(e.loc, `Module ${m.name} has no table ${e.name}. Its tables: ${[...tables].join(", ") || "(none)"}.`);
        }
        return expr(e.object, locals);
      case "index":
        expr(e.object, locals);
        return expr(e.index, locals);
      case "list":
        return e.items.forEach((x) => expr(x, locals));
      case "object":
        return e.entries.forEach((x) => expr(x.value, locals));
      case "unary":
        return expr(e.operand, locals);
      case "binary":
        expr(e.left, locals);
        return expr(e.right, locals);
      case "cond":
        expr(e.test, locals);
        expr(e.then, locals, inReturn);
        return expr(e.else, locals, inReturn);
      case "lambda":
        return expr(e.body, new Set([...locals, ...e.params]));
      default:
        return;
    }
  };

  const none = new Set<string>();
  const block = (body: Stmt[], inLoop: boolean) => {
    scopes.push(new Set());
    for (const st of body) stmt(st, inLoop);
    scopes.pop();
  };
  const stmt = (st: Stmt, inLoop: boolean): void => {
    switch (st.kind) {
      case "let":
        expr(st.value, none);
        if (outcomeNames.has(st.name) || ctx.ports.has(st.name)) err(st.loc, `'${st.name}' is already the name of an outcome or port.`);
        scopes.at(-1)!.add(st.name);
        return;
      case "assign":
        if (st.target.kind === "name" && !defined(st.target.name)) {
          err(st.loc, `'${st.target.name}' is not defined. Declare it first with let ${st.target.name} = ...`);
        } else expr(st.target, none);
        return expr(st.value, none);
      case "expr":
        return expr(st.expr, none);
      case "if":
        expr(st.test, none);
        block(st.then, inLoop);
        if (st.else) block(st.else, inLoop);
        return;
      case "for":
        expr(st.iterable, none);
        scopes.push(new Set([st.name]));
        for (const b of st.body) stmt(b, true);
        scopes.pop();
        return;
      case "while":
        expr(st.test, none);
        return block(st.body, true);
      case "return": {
        const v = st.value;
        if (isStep) {
          const returnsOutcome = (x: Expr): boolean =>
            (x.kind === "call" && x.callee.kind === "name" && outcomeNames.has(x.callee.name)) ||
            (x.kind === "cond" && returnsOutcome(x.then) && returnsOutcome(x.else));
          if (!returnsOutcome(v)) err(st.loc, `A step returns one of its outcomes: ${ctx.outcomes.map((o) => `${o.name}(...)`).join(", ")}.`);
        }
        return expr(v, none, true);
      }
      case "break":
      case "continue":
        if (!inLoop) err(st.loc, `'${st.kind}' can only be used inside a loop.`);
        return;
    }
  };

  block(stmts, false);
}

function alwaysReturns(stmts: Stmt[]): boolean {
  const last = stmts.at(-1);
  if (!last) return false;
  if (last.kind === "return") return true;
  if (last.kind === "if") return !!last.else && alwaysReturns(last.then) && alwaysReturns(last.else);
  return false;
}

const BANNED_GLOBALS = ["fetch", "Bun", "process", "Deno", "require", "eval", "globalThis", "XMLHttpRequest", "WebSocket", "setInterval"];

// A lint, not a sandbox: JS steps must stay inside their module and reach the
// outside world only through the ports the model gives them.
function checkJsStep(m: ModuleDef, s: StepDef, path: string, loc: Loc, ports: Set<string>, err: (loc: Loc, msg: string) => void) {
  if (!path.startsWith(m.dir + "/")) {
    err(loc, `The code for step ${s.name} must live in module ${m.name}'s folder.`);
    return;
  }
  if (!existsSync(path)) {
    err(loc, `Can't find ${path.slice(m.dir.length + 1)} for step ${s.name}.`);
    return;
  }
  const source = readFileSync(path, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
  const at = (i: number): Loc => ({ file: path, line: code.slice(0, i).split("\n").length, col: 1 });
  const importRe = /(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(importRe)) {
    const spec = match[1] ?? match[2]!;
    const l = at(match.index!);
    if (spec.startsWith(".")) {
      const target = resolve(dirname(path), spec);
      if (!target.startsWith(m.dir + "/")) {
        err(l, `Step ${s.name} imports code from outside module ${m.name}. Modules reach each other only through the model ('uses module.step').`);
      }
    } else {
      err(l, `Step ${s.name} imports '${spec}' directly. Packages can't be used in steps yet; they will come in through integrations.`);
    }
  }
  const stripped = code.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  for (const g of BANNED_GLOBALS) {
    const re = new RegExp(`(?<![.\\w$])${g}\\b`);
    const idx = stripped.search(re);
    if (idx >= 0) {
      const declared = ports.size ? `It declares: ${[...ports].join(", ")}.` : "It declares none.";
      err(at(idx), `Step ${s.name} uses '${g}' directly. Steps may only use the ports the model gives them. ${declared}`);
    }
  }
}

// ---- flows ------------------------------------------------------------------

interface Chain {
  root: string;
  path: string[];
  loc: Loc;
}

function chainOf(e: Expr): Chain | null {
  if (e.kind === "name") return { root: e.name, path: [], loc: e.loc };
  if (e.kind === "member") {
    const c = chainOf(e.object);
    return c && { ...c, path: [...c.path, e.name] };
  }
  return null;
}

function walkChains(e: Expr, locals: Set<string>, cb: (c: Chain) => void) {
  const c = chainOf(e);
  if (c) {
    if (!locals.has(c.root)) cb(c);
    return;
  }
  switch (e.kind) {
    case "member":
      return walkChains(e.object, locals, cb);
    case "index":
      walkChains(e.object, locals, cb);
      return walkChains(e.index, locals, cb);
    case "call":
      walkChains(e.callee, locals, cb);
      e.args.forEach((x) => walkChains(x, locals, cb));
      return (e.named ?? []).forEach((n) => walkChains(n.value, locals, cb));
    case "list":
      return e.items.forEach((x) => walkChains(x, locals, cb));
    case "object":
      return e.entries.forEach((x) => walkChains(x.value, locals, cb));
    case "unary":
      return walkChains(e.operand, locals, cb);
    case "binary":
      walkChains(e.left, locals, cb);
      return walkChains(e.right, locals, cb);
    case "cond":
      walkChains(e.test, locals, cb);
      walkChains(e.then, locals, cb);
      return walkChains(e.else, locals, cb);
    case "lambda":
      return walkChains(e.body, new Set([...locals, ...e.params]), cb);
  }
}

function resolveTarget(a: Analysis, m: ModuleDef, node: FlowNode): StepDef | undefined {
  const t = node.target!;
  const module = t.module || m.name;
  return a.steps.get(stepKey(module, t.step));
}

function checkFlow(a: Analysis, m: ModuleDef, f: FlowDef, err: (loc: Loc, msg: string) => void): FlowPlan | null {
  const inputs = new Map(f.inputs.map((x) => [x.name, x]));
  const nodes = new Map<string, FlowNode>();
  const targets = new Map<string, StepDef>();

  // path parameters must be declared text inputs
  for (const p of f.trigger.path.matchAll(/:([a-z][a-z0-9_]*)/g)) {
    const inp = inputs.get(p[1]!);
    if (!inp) err(f.trigger.loc, `The path has :${p[1]}, so flow ${f.name} needs an input ${p[1]}: text.`);
    else if (inp.type.kind !== "text" && inp.type.kind !== "number") err(inp.loc, `${p[1]} comes from the path, so it must be text or number.`);
  }
  if (f.trigger.method === "GET") {
    for (const i of f.inputs) {
      const base = i.type.kind === "nullable" ? i.type.of : i.type;
      if (base.kind === "list" || base.kind === "record" || base.kind === "map") err(i.loc, `GET flows take simple inputs (from the path or query), not ${typeToString(i.type)}.`);
    }
  }

  for (const n of f.nodes) {
    if (n.kind !== "do") continue;
    if (nodes.has(n.name)) err(n.loc, `Flow ${f.name} already has a step result called ${n.name}.`);
    if (inputs.has(n.name)) err(n.loc, `${n.name} is already an input of flow ${f.name}.`);
    nodes.set(n.name, n);
    const t = n.target!;
    const module = t.module || m.name;
    const step = resolveTarget(a, m, n);
    if (!a.modules.has(module)) {
      err(t.loc, `Unknown module ${module}.`);
      continue;
    }
    if (!step) {
      err(t.loc, `Module ${module} has no step ${t.step}.`);
      continue;
    }
    if (module !== m.name && !m.uses.some((u) => u.module === module && u.step === t.step)) {
      err(t.loc, `Module ${m.name} can't call ${module}.${t.step}. Add 'uses ${module}.${t.step}' to module ${m.name} so the dependency is part of the model.`);
    }
    targets.set(n.name, step);
    const key = stepKey(module, t.step);
    const list = a.usages.get(key) ?? [];
    list.push({ module: m.name, flow: f, node: n });
    a.usages.set(key, list);
  }

  const deps = new Map<string, Dep[]>();
  const responds = f.nodes.filter((n) => n.kind === "respond");
  if (!responds.length) err(f.loc, `Flow ${f.name} never responds. Add a line like: respond 200 { ... }`);

  const typeOfChain = (c: Chain): TypeRef | undefined => {
    let type: TypeRef | undefined;
    let rest: string[];
    if (inputs.has(c.root)) {
      const inp = inputs.get(c.root)!;
      // an optional input that wasn't given is null
      type = inp.optional && inp.type.kind !== "nullable" ? { kind: "nullable", of: inp.type } : inp.type;
      rest = c.path;
    } else {
      const step = targets.get(c.root);
      const outcome = step?.outcomes.find((o) => o.name === c.path[0]);
      const field = outcome?.fields.find((x) => x.name === c.path[1]);
      if (!field) return undefined;
      type = field.type;
      rest = c.path.slice(2);
    }
    for (const p of rest) {
      if (type?.kind !== "record") return undefined;
      type = a.records.get(type.name)?.fields.find((x) => x.name === p)?.type;
    }
    return type;
  };

  for (const n of f.nodes) {
    const nd: Dep[] = [];
    const add = (d: Dep) => {
      if (!nd.some((x) => x.node === d.node && x.outcome === d.outcome)) nd.push(d);
    };
    for (const w of n.when) {
      const step = targets.get(w.node);
      if (!nodes.has(w.node)) err(w.loc, `Flow ${f.name} has no step result called ${w.node}.`);
      else if (step && !step.outcomes.some((o) => o.name === w.outcome)) {
        err(w.loc, `${w.node} (${step.module}.${step.name}) has no outcome ${w.outcome}. Its outcomes are: ${step.outcomes.map((o) => o.name).join(", ")}.`);
      } else add({ node: w.node, outcome: w.outcome });
    }
    const onChain = (c: Chain) => {
      if (inputs.has(c.root)) {
        const t = inputs.get(c.root)!;
        let type: TypeRef = t.type;
        for (const p of c.path) {
          if (type.kind !== "record") break;
          const fld = a.records.get(type.name)?.fields.find((x) => x.name === p);
          if (!fld) {
            err(c.loc, `${type.name} has no field ${p}.`);
            return;
          }
          type = fld.type;
        }
        return;
      }
      if (BUILTIN_NAMES.has(c.root) || m.fns.some((x) => x.name === c.root)) return;
      if (!nodes.has(c.root)) {
        err(c.loc, `'${c.root}' is not an input or a step result in flow ${f.name}.`);
        return;
      }
      if (c.root === n.name) {
        err(c.loc, `${n.name} can't use its own result.`);
        return;
      }
      const step = targets.get(c.root);
      if (!step) return;
      const outcomeName = c.path[0];
      const outcome = step.outcomes.find((o) => o.name === outcomeName);
      if (!outcome) {
        err(c.loc, `Say which outcome of ${c.root} you mean, e.g. ${c.root}.${step.outcomes[0]?.name ?? "done"}.${step.outcomes[0]?.fields[0]?.name ?? "field"}. Its outcomes are: ${step.outcomes.map((o) => o.name).join(", ")}.`);
        return;
      }
      const fieldName = c.path[1];
      if (fieldName && !outcome.fields.some((x) => x.name === fieldName)) {
        err(c.loc, `Outcome ${c.root}.${outcome.name} has no field ${fieldName}. Its fields are: ${outcome.fields.map((x) => x.name).join(", ") || "(none)"}.`);
      }
      add({ node: c.root, outcome: outcome.name });
    };
    if (n.kind === "do") {
      const step = targets.get(n.name);
      for (const arg of n.args) {
        walkChains(arg.value, new Set(), onChain);
        const param = step?.inputs.find((x) => x.name === arg.name);
        if (step && !param) err(arg.loc, `${step.module}.${step.name} has no input ${arg.name}. Its inputs are: ${step.inputs.map((x) => x.name).join(", ") || "(none)"}.`);
        const c = chainOf(arg.value);
        const actual = c ? typeOfChain(c) : literalType(arg.value);
        const expected: TypeRef | undefined = param && (param.optional && param.type.kind !== "nullable" ? { kind: "nullable", of: param.type } : param.type);
        if (param && expected && arg.value.kind === "null") {
          if (expected.kind !== "nullable") err(arg.loc, `${arg.name} can't be null (it is ${typeToString(param.type)}).`);
        } else if (param && expected && actual && !assignable(actual, expected)) {
          err(arg.loc, `${arg.name} should be ${typeToString(param.type)} but this is ${typeToString(actual)}.`);
        }
      }
      if (step) {
        for (const p of step.inputs) {
          if (!p.optional && !n.args.some((x) => x.name === p.name)) err(n.loc, `${step.module}.${step.name} needs ${p.name} (${typeToString(p.type)}).`);
        }
      }
    } else if (n.body) walkChains(n.body, new Set(), onChain);

    const byNode = new Map<string, string>();
    for (const d of nd) {
      const prev = byNode.get(d.node);
      if (prev && prev !== d.outcome) {
        err(n.loc, `This line waits for ${d.node}.${prev} and ${d.node}.${d.outcome}, but a step ends with only one outcome, so it can never run.`);
      }
      byNode.set(d.node, d.outcome);
    }
    deps.set(n.name, nd);
  }

  // Two responses must never both be able to happen: some step has to end
  // differently on the way to each of them.
  const needs = (name: string, seen = new Set<string>()): Dep[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const own = deps.get(name) ?? [];
    return [...own, ...own.flatMap((d) => needs(d.node, seen))];
  };
  const label = (n: FlowNode) => `respond ${n.status} (line ${n.loc.line})`;
  for (let i = 0; i < responds.length; i++) {
    for (let j = i + 1; j < responds.length; j++) {
      const a1 = needs(responds[i]!.name);
      const b1 = needs(responds[j]!.name);
      const exclusive = a1.some((x) => b1.some((y) => x.node === y.node && x.outcome !== y.outcome));
      if (!exclusive) {
        const why = [...new Set([...a1, ...b1].map((d) => `${d.node}.${d.outcome}`))].join(", ") || "nothing";
        err(responds[j]!.loc, `${label(responds[i]!)} and ${label(responds[j]!)} could both happen (they only wait for ${why}). Make one of them wait for an outcome that rules out the other, e.g. with 'when'.`);
      }
    }
  }

  // every outcome must lead somewhere
  for (const [name, step] of targets) {
    for (const o of step.outcomes) {
      const handled = [...deps.values()].some((ds) => ds.some((d) => d.node === name && d.outcome === o.name));
      if (!handled) {
        err(nodes.get(name)!.loc, `When ${name} ends with '${o.name}', nothing happens. Use ${name}.${o.name} in a later step, or add: when ${name}.${o.name} respond ... { ... }`);
      }
    }
  }

  // cycles and order
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  let cyclic = false;
  const visit = (name: string) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      cyclic = true;
      return;
    }
    state.set(name, "visiting");
    for (const d of deps.get(name) ?? []) visit(d.node);
    state.set(name, "done");
    order.push(name);
  };
  for (const n of f.nodes) visit(n.name);
  if (cyclic) err(f.loc, `The steps in flow ${f.name} wait for each other in a circle, so none of them can start.`);

  return { flow: f, deps, order };
}

function literalType(e: Expr): TypeRef | undefined {
  if (e.kind === "str") return { kind: "text" };
  if (e.kind === "bool") return { kind: "bool" };
  if (e.kind === "num") return { kind: "number" };
  return undefined;
}
