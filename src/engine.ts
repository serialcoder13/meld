import type { Analysis, FlowPlan } from "./check";
import { isNullable, stepKey, typeToString, type Field, type FlowNode, type Loc, type StepDef } from "./ir";
import { BUILTINS, Fn, Interpreter, MeldRuntimeError, OutcomeValue, Scope } from "./interp";
import { jsPorts, meldPorts, type PortEnv, type Storage } from "./ports";
import { TableStore } from "./tables";
import { isPlainObject, normalize, normalizeFields, validate, validateFields } from "./values";

// Runs flows the KIRun way, one level up: a line in a flow fires as soon as the
// step outcomes it waits for have happened; lines that are ready run in
// parallel; lines waiting for an outcome that didn't happen are skipped.

export interface TraceNode {
  id: string; // the flow node this entry is for
  node: string;
  step?: string;
  status: "done" | "skipped" | "failed";
  outcome?: string;
  ms: number;
  logs: string[];
  error?: string;
}

export interface Trace {
  id: number;
  flow: string;
  startedAt: string;
  ms: number;
  status: number;
  nodes: TraceNode[];
  error?: string;
}

export interface RunResult {
  status: number;
  body: unknown;
  trace: Trace;
}

export type JsStepFn = (input: Record<string, unknown>, ports: unknown) => unknown;

export interface EngineOptions {
  storage: Storage;
  fuel?: number;
  now?: () => Date;
}

class StepFailure extends Error {
  constructor(public node: string, message: string, public loc?: Loc) {
    super(message);
  }
}

export class Engine {
  private jsSteps = new Map<string, JsStepFn>();
  private tables = new Map<string, Map<string, TableStore>>(); // module -> table name -> store
  private traceId = 0;
  readonly traces: Trace[] = [];

  constructor(readonly analysis: Analysis, private opts: EngineOptions) {
    for (const m of analysis.modules.values()) {
      const own = new Map<string, TableStore>();
      for (const t of m.tables) own.set(t.name, new TableStore(opts.storage.db, t, analysis.records));
      this.tables.set(m.name, own);
    }
  }

  // Builtins plus the module's own `fn` helpers, bound to one interpreter's budget.
  private moduleScope(module: string, interp: Interpreter): Scope {
    const scope = new Scope();
    for (const [k, v] of Object.entries(BUILTINS)) scope.define(k, v);
    const records = this.analysis.records;
    for (const def of this.analysis.modules.get(module)?.fns ?? []) {
      scope.define(
        def.name,
        new Fn(def.name, async (args, loc) => {
          def.params.forEach((p, i) => {
            const bad = validate(args[i], p.type, records, p.name);
            if (args[i] !== undefined && bad.length) throw new MeldRuntimeError(loc, `${def.name}(...): ${bad.join("; ")}.`);
          });
          const result = await interp.callFunction(def, args, scope, loc);
          const bad = validate(result, def.returns, records, "the result");
          if (bad.length) throw new MeldRuntimeError(def.loc, `${def.name}(...) should return ${typeToString(def.returns)}: ${bad.join("; ")}.`);
          return normalize(result, def.returns, records);
        }),
      );
    }
    return scope;
  }

  async load() {
    for (const [key, step] of this.analysis.steps) {
      if (step.body.kind !== "js") continue;
      const mod = await import(step.body.path);
      if (typeof mod.default !== "function") {
        throw new Error(`${step.body.path} must export a default function for step ${key}.`);
      }
      this.jsSteps.set(key, mod.default);
    }
  }

  plan(module: string, flow: string): FlowPlan | undefined {
    return this.analysis.plans.find((p) => p.flow.module === module && p.flow.name === flow);
  }

  async run(plan: FlowPlan, input: Record<string, unknown>): Promise<RunResult> {
    const started = performance.now();
    const f = plan.flow;
    const trace: Trace = {
      id: ++this.traceId,
      flow: `${f.module}.${f.name}`,
      startedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      ms: 0,
      status: 0,
      nodes: [],
    };
    const finish = (status: number, body: unknown, error?: string): RunResult => {
      trace.status = status;
      trace.ms = round(performance.now() - started);
      if (error) trace.error = error;
      this.traces.push(trace);
      if (this.traces.length > 200) this.traces.shift();
      return { status, body, trace };
    };

    const problems = validateFields(input, f.inputs, this.analysis.records, "");
    if (problems.length) return finish(422, { errors: errorMap(problems) });
    input = normalizeFields(input, f.inputs, this.analysis.records);

    const flowInterp = new Interpreter({ fuel: 100_000 });
    const scope = new Scope(this.moduleScope(f.module, flowInterp));
    defineInputs(scope, f.inputs, input);

    const outcomes = new Map<string, string>(); // node -> outcome
    const state = new Map<string, "pending" | "running" | "done" | "skipped">();
    for (const n of f.nodes) state.set(n.name, "pending");
    let response: { status: number; body: unknown } | undefined;

    const skip = (n: FlowNode) => {
      state.set(n.name, "skipped");
      const node = n.kind === "respond" ? `respond ${n.status}` : n.name;
      trace.nodes.push({ id: n.name, node, ...(n.target ? { step: this.key(n) } : {}), status: "skipped", ms: 0, logs: [] });
    };

    try {
      while (true) {
        // settle skips until nothing changes
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of f.nodes) {
            if (state.get(n.name) !== "pending") continue;
            const blocked = plan.deps.get(n.name)!.some((d) => {
              const s = state.get(d.node);
              return s === "skipped" || (s === "done" && outcomes.get(d.node) !== d.outcome);
            });
            if (blocked) {
              skip(n);
              changed = true;
            }
          }
        }
        const ready = f.nodes.filter(
          (n) => state.get(n.name) === "pending" && plan.deps.get(n.name)!.every((d) => state.get(d.node) === "done" && outcomes.get(d.node) === d.outcome),
        );
        if (!ready.length) break;
        await Promise.all(
          ready.map(async (n) => {
            state.set(n.name, "running");
            if (n.kind === "respond") {
              let body: unknown;
              try {
                body = n.body ? await flowInterp.eval(n.body, scope) : undefined;
              } catch (e) {
                if (e instanceof MeldRuntimeError) throw new StepFailure(`respond ${n.status}`, e.message, e.loc);
                throw e;
              }
              if (response) throw new StepFailure(n.name, `Flow ${f.name} tried to respond twice (${response.status} and ${n.status}).`, n.loc);
              response = { status: n.status!, body };
              trace.nodes.push({ id: n.name, node: `respond ${n.status}`, status: "done", ms: 0, logs: [] });
              state.set(n.name, "done");
              return;
            }
            const result = await this.runStep(n, scope, flowInterp, trace);
            outcomes.set(n.name, result.outcome);
            scope.define(n.name, { [result.outcome]: result.data });
            state.set(n.name, "done");
          }),
        );
      }
    } catch (e) {
      if (e instanceof StepFailure) {
        const where = e.loc ? ` (${short(e.loc, this.analysis.model.root)})` : "";
        return finish(500, { error: "step_failed", step: e.node, message: e.message + where }, e.message);
      }
      throw e;
    }

    if (!response) {
      const happened = [...outcomes].map(([n, o]) => `${n} → ${o}`).join(", ") || "nothing ran";
      const msg = `Flow ${f.name} finished without responding (${happened}).`;
      return finish(500, { error: "no_response", message: msg }, msg);
    }
    return finish(response.status, response.body);
  }

  private key(n: FlowNode): string {
    return stepKey(n.target!.module || this.moduleOf(n), n.target!.step);
  }

  private moduleOf(n: FlowNode): string {
    return this.analysis.plans.find((p) => p.flow.nodes.includes(n))!.flow.module;
  }

  private async runStep(n: FlowNode, scope: Scope, flowInterp: Interpreter, trace: Trace): Promise<{ outcome: string; data: Record<string, unknown> }> {
    const key = this.key(n);
    const step = this.analysis.steps.get(key)!;
    const logs: string[] = [];
    const t0 = performance.now();
    const record = (status: TraceNode["status"], outcome?: string, error?: string) =>
      trace.nodes.push({ id: n.name, node: n.name, step: key, status, outcome, ms: round(performance.now() - t0), logs, ...(error ? { error } : {}) });
    const env: PortEnv = {
      storage: this.opts.storage,
      tables: this.tables.get(step.module)!,
      now: this.opts.now,
      log: (level, m) => logs.push(`${level}: ${m}`),
    };
    const records = this.analysis.records;

    try {
      const raw = await flowInterp.namedArgs(n.args, scope);
      // An optional input that wasn't given is null in a flow; for a step
      // parameter that can't be null, that means "left out".
      for (const p of step.inputs) if (p.optional && raw[p.name] === null && !isNullable(p.type)) delete raw[p.name];
      const problems = validateFields(raw, step.inputs, records, "");
      if (problems.length) throw new StepFailure(n.name, `${key} was given bad input: ${problems.join("; ")}.`, n.loc);
      const input = structuredClone(normalizeFields(raw, step.inputs, records));

      let outcome: string;
      let data: Record<string, unknown>;
      if (step.body.kind === "meld") {
        ({ outcome, data } = await this.runMeld(step, input, env));
      } else {
        ({ outcome, data } = await this.runJs(step, key, input, env));
      }
      const def = step.outcomes.find((o) => o.name === outcome);
      if (!def) throw new StepFailure(n.name, `${key} returned '${outcome}', which is not one of its outcomes (${step.outcomes.map((o) => o.name).join(", ")}).`);
      const bad = validateFields(data, def.fields, records, outcome);
      if (bad.length) throw new StepFailure(n.name, `${key} returned a bad ${outcome}: ${bad.join("; ")}.`);
      data = structuredClone(normalizeFields(data, def.fields, records));
      record("done", outcome);
      return { outcome, data };
    } catch (e) {
      const message = e instanceof StepFailure ? e.message : e instanceof MeldRuntimeError ? `${key}: ${e.message}` : `${key} crashed: ${(e as Error)?.message ?? e}`;
      record("failed", undefined, message);
      if (e instanceof StepFailure) throw e;
      throw new StepFailure(n.name, message, e instanceof MeldRuntimeError ? e.loc : undefined);
    }
  }

  private async runMeld(step: StepDef, input: Record<string, unknown>, env: PortEnv) {
    if (step.body.kind !== "meld") throw new Error("unreachable");
    const interp = new Interpreter({ fuel: this.opts.fuel ?? 200_000 });
    const scope = new Scope(this.moduleScope(step.module, interp));
    for (const [k, v] of Object.entries(meldPorts(step, env))) scope.define(k, v);
    for (const o of step.outcomes) {
      scope.define(o.name, new Fn(o.name, () => new OutcomeValue(o.name, {}), (args) => new OutcomeValue(o.name, args)));
    }
    defineInputs(scope, step.inputs, input);
    const result = await interp.runBody(step.body.stmts, scope);
    if (!(result instanceof OutcomeValue)) throw new MeldRuntimeError(step.loc, `Step ${step.name} finished without returning an outcome.`);
    return { outcome: result.outcome, data: result.data };
  }

  private async runJs(step: StepDef, key: string, input: Record<string, unknown>, env: PortEnv) {
    const fn = this.jsSteps.get(key)!;
    const result = await fn(input, jsPorts(step, env));
    if (!isPlainObject(result) || Object.keys(result).length !== 1) {
      throw new MeldRuntimeError(undefined, `must return exactly one outcome, like { ${step.outcomes[0]?.name ?? "done"}: { ... } }.`);
    }
    const [outcome, data] = Object.entries(result)[0]!;
    return { outcome, data: (data ?? {}) as Record<string, unknown> };
  }
}

// Optional inputs that weren't given are null, so code never meets "undefined".
function defineInputs(scope: Scope, fields: Field[], input: Record<string, unknown>) {
  for (const i of fields) scope.define(i.name, input[i.name] === undefined ? null : input[i.name]);
}

// ["user.email can't be null (...)"] -> { "user.email": ["can't be null (...)"] }
export function errorMap(problems: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of problems) {
    const i = p.indexOf(" ");
    const key = i > 0 ? p.slice(0, i) : "body";
    (out[key] ??= []).push(i > 0 ? p.slice(i + 1) : p);
  }
  return out;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function short(loc: Loc, root: string): string {
  const f = loc.file.startsWith(root + "/") ? loc.file.slice(root.length + 1) : loc.file;
  return `${f}:${loc.line}`;
}
