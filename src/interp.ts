import type { Expr, FnDef, Loc, NamedArg, Stmt } from "./ir";
import { show } from "./values";

// The Meld interpreter: a small tree-walking evaluator for the JavaScript-like
// language used in step bodies and flow arguments. It runs next to Bun's JS
// engine in the same process, but Meld code can only reach what it is given:
// its inputs, the ports its step declares, and the builtins below.

export class MeldRuntimeError extends Error {
  constructor(public loc: Loc | undefined, message: string) {
    super(message);
  }
}

// A callable value: builtins, list/text methods, port methods, outcome
// constructors and lambdas all look the same to Meld code.
export class Fn {
  constructor(
    public name: string,
    public call: (args: unknown[], loc: Loc) => unknown | Promise<unknown>,
    public callNamed?: (args: Record<string, unknown>, loc: Loc) => unknown | Promise<unknown>,
  ) {}
}

export class OutcomeValue {
  constructor(public outcome: string, public data: Record<string, unknown>) {}
}

export class Scope {
  private vars = new Map<string, unknown>();
  constructor(private parent?: Scope) {}
  define(name: string, value: unknown) {
    this.vars.set(name, value);
  }
  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }
  get(name: string, loc: Loc): unknown {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name, loc);
    throw new MeldRuntimeError(loc, `'${name}' is not defined.`);
  }
  set(name: string, value: unknown, loc: Loc) {
    if (this.vars.has(name)) this.vars.set(name, value);
    else if (this.parent) this.parent.set(name, value, loc);
    else throw new MeldRuntimeError(loc, `'${name}' is not defined. Declare it first with let ${name} = ...`);
  }
}

export interface Budget {
  fuel: number;
}

type Signal = undefined | { type: "return"; value: unknown } | { type: "break" } | { type: "continue" };

export class Interpreter {
  constructor(private budget: Budget) {}

  private burn(loc: Loc) {
    if (--this.budget.fuel < 0) {
      throw new MeldRuntimeError(loc, "This step did too much work and was stopped (it may be looping forever).");
    }
  }

  // Calls a module's pure `fn` helper. `scope` holds the builtins and the
  // module's other helpers, never ports.
  async callFunction(def: FnDef, args: unknown[], scope: Scope, loc: Loc): Promise<unknown> {
    if (args.length !== def.params.length) {
      throw new MeldRuntimeError(loc, `${def.name}(...) takes ${def.params.length} argument(s): ${def.params.map((p) => p.name).join(", ")}.`);
    }
    const inner = new Scope(scope);
    def.params.forEach((p, i) => inner.define(p.name, args[i]));
    const sig = await this.block(def.body, inner);
    if (sig?.type !== "return") throw new MeldRuntimeError(def.loc, `${def.name}(...) finished without returning a value.`);
    return sig.value;
  }

  async runBody(stmts: Stmt[], scope: Scope): Promise<unknown> {
    const sig = await this.block(stmts, new Scope(scope));
    if (sig?.type === "return") return sig.value;
    if (sig) throw new MeldRuntimeError(undefined, `'${sig.type}' used outside of a loop.`);
    return undefined;
  }

  private async block(stmts: Stmt[], scope: Scope): Promise<Signal> {
    for (const s of stmts) {
      const sig = await this.stmt(s, scope);
      if (sig) return sig;
    }
    return undefined;
  }

  private async stmt(s: Stmt, scope: Scope): Promise<Signal> {
    this.burn(s.loc);
    switch (s.kind) {
      case "let":
        scope.define(s.name, await this.eval(s.value, scope));
        return;
      case "assign": {
        let value = await this.eval(s.value, scope);
        if (s.op !== "=") {
          const current = await this.eval(s.target, scope);
          value = arith(s.op === "+=" ? "+" : "-", current, value, s.loc);
        }
        await this.assign(s.target, value, scope);
        return;
      }
      case "expr":
        await this.eval(s.expr, scope);
        return;
      case "if": {
        const test = truth(await this.eval(s.test, scope), s.loc, "if");
        if (test) return this.block(s.then, new Scope(scope));
        if (s.else) return this.block(s.else, new Scope(scope));
        return;
      }
      case "for": {
        const list = await this.eval(s.iterable, scope);
        if (!Array.isArray(list)) throw new MeldRuntimeError(s.loc, `for ... of needs a list, got ${show(list)}.`);
        for (const item of [...list]) {
          const inner = new Scope(scope);
          inner.define(s.name, item);
          const sig = await this.block(s.body, inner);
          if (sig?.type === "break") break;
          if (sig?.type === "return") return sig;
        }
        return;
      }
      case "while": {
        while (truth(await this.eval(s.test, scope), s.loc, "while")) {
          this.burn(s.loc);
          const sig = await this.block(s.body, new Scope(scope));
          if (sig?.type === "break") break;
          if (sig?.type === "return") return sig;
        }
        return;
      }
      case "return":
        return { type: "return", value: await this.eval(s.value, scope) };
      case "break":
        return { type: "break" };
      case "continue":
        return { type: "continue" };
    }
  }

  private async assign(target: Expr, value: unknown, scope: Scope) {
    if (target.kind === "name") return scope.set(target.name, value, target.loc);
    if (target.kind === "member") {
      const obj = await this.eval(target.object, scope);
      if (!isObject(obj)) throw new MeldRuntimeError(target.loc, `Can't set '${target.name}' on ${show(obj)}.`);
      obj[target.name] = value;
      return;
    }
    if (target.kind === "index") {
      const obj = await this.eval(target.object, scope);
      const idx = await this.eval(target.index, scope);
      if (Array.isArray(obj)) {
        obj[listIndex(obj, idx, target.loc)] = value;
        return;
      }
      if (isObject(obj) && typeof idx === "string") {
        obj[idx] = value;
        return;
      }
      throw new MeldRuntimeError(target.loc, `Can't set an item on ${show(obj)}.`);
    }
  }

  async eval(e: Expr, scope: Scope): Promise<unknown> {
    this.burn(e.loc);
    switch (e.kind) {
      case "num":
      case "str":
      case "bool":
        return e.value;
      case "null":
        return null;
      case "name":
        return scope.get(e.name, e.loc);
      case "list": {
        const out: unknown[] = [];
        for (const item of e.items) out.push(await this.eval(item, scope));
        return out;
      }
      case "object": {
        const out: Record<string, unknown> = {};
        for (const { key, value } of e.entries) out[key] = await this.eval(value, scope);
        return out;
      }
      case "member":
        return member(await this.eval(e.object, scope), e.name, e.loc, this);
      case "index": {
        const obj = await this.eval(e.object, scope);
        const idx = await this.eval(e.index, scope);
        if (Array.isArray(obj)) return obj[listIndex(obj, idx, e.loc)];
        if (isObject(obj) && typeof idx === "string") return member(obj, idx, e.loc, this);
        throw new MeldRuntimeError(e.loc, `Can't look up ${show(idx)} in ${show(obj)}.`);
      }
      case "call": {
        const callee = await this.eval(e.callee, scope);
        if (!(callee instanceof Fn)) throw new MeldRuntimeError(e.loc, `${describeCallee(e.callee)} is not something you can call.`);
        if (e.named) {
          if (!callee.callNamed) {
            throw new MeldRuntimeError(e.loc, `${callee.name}(...) takes its arguments in order, not by name.`);
          }
          return callee.callNamed(await this.namedArgs(e.named, scope), e.loc);
        }
        const args: unknown[] = [];
        for (const a of e.args) args.push(await this.eval(a, scope));
        return callee.call(args, e.loc);
      }
      case "unary": {
        const v = await this.eval(e.operand, scope);
        if (e.op === "!") return !truth(v, e.loc, "!");
        if (typeof v !== "number") throw new MeldRuntimeError(e.loc, `Can't negate ${show(v)}.`);
        return -v;
      }
      case "binary": {
        if (e.op === "&&" || e.op === "||") {
          const l = truth(await this.eval(e.left, scope), e.loc, e.op);
          if (e.op === "&&" ? !l : l) return l;
          return truth(await this.eval(e.right, scope), e.loc, e.op);
        }
        const l = await this.eval(e.left, scope);
        const r = await this.eval(e.right, scope);
        return binary(e.op, l, r, e.loc);
      }
      case "cond":
        return truth(await this.eval(e.test, scope), e.loc, "?:") ? this.eval(e.then, scope) : this.eval(e.else, scope);
      case "lambda":
        return new Fn("function", async (args, loc) => {
          if (args.length < e.params.length) {
            throw new MeldRuntimeError(loc, `This function needs ${e.params.length} argument(s).`);
          }
          const inner = new Scope(scope);
          e.params.forEach((p, i) => inner.define(p, args[i]));
          return this.eval(e.body, inner);
        });
    }
  }

  async namedArgs(args: NamedArg[], scope: Scope): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const a of args) out[a.name] = await this.eval(a.value, scope);
    return out;
  }
}

// ---- operators ----

function truth(v: unknown, loc: Loc, where: string): boolean {
  if (typeof v !== "boolean") throw new MeldRuntimeError(loc, `${where} needs true or false, got ${show(v)}.`);
  return v;
}

function arith(op: "+" | "-" | "*" | "/" | "%", l: unknown, r: unknown, loc: Loc): unknown {
  if (op === "+" && typeof l === "string" && typeof r === "string") return l + r;
  if (op === "+" && Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
  if (typeof l !== "number" || typeof r !== "number") {
    if (op === "+" && (typeof l === "string" || typeof r === "string")) {
      throw new MeldRuntimeError(loc, `Can't add ${show(l)} and ${show(r)}. Convert with text(...) first.`);
    }
    throw new MeldRuntimeError(loc, `'${op}' needs two numbers, got ${show(l)} and ${show(r)}.`);
  }
  if ((op === "/" || op === "%") && r === 0) throw new MeldRuntimeError(loc, "Can't divide by zero.");
  switch (op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/": return l / r;
    case "%": return l % r;
  }
}

function binary(op: string, l: unknown, r: unknown, loc: Loc): unknown {
  switch (op) {
    case "+": case "-": case "*": case "/": case "%":
      return arith(op, l, r, loc);
    case "==": return deepEqual(l, r);
    case "!=": return !deepEqual(l, r);
    case "<": case "<=": case ">": case ">=": {
      if (!((typeof l === "number" && typeof r === "number") || (typeof l === "string" && typeof r === "string"))) {
        throw new MeldRuntimeError(loc, `Can't compare ${show(l)} with ${show(r)}.`);
      }
      if (op === "<") return l < r;
      if (op === "<=") return l <= r;
      if (op === ">") return l > r;
      return l >= r;
    }
  }
  throw new MeldRuntimeError(loc, `Unknown operator ${op}.`);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Fn) && !(v instanceof OutcomeValue);
}

function listIndex(list: unknown[], idx: unknown, loc: Loc): number {
  if (typeof idx !== "number" || !Number.isInteger(idx)) throw new MeldRuntimeError(loc, `A list position must be a whole number, got ${show(idx)}.`);
  if (idx < 0 || idx >= list.length) throw new MeldRuntimeError(loc, `Position ${idx} is outside the list (it has ${list.length} items).`);
  return idx;
}

function describeCallee(e: Expr): string {
  if (e.kind === "name") return `'${e.name}'`;
  if (e.kind === "member") return `'${e.name}'`;
  return "This";
}

// ---- members: fields, list methods, text methods ----

async function callFn(f: unknown, args: unknown[], loc: Loc): Promise<unknown> {
  if (!(f instanceof Fn)) throw new MeldRuntimeError(loc, `Expected a function (e.g. item => item.qty), got ${show(f)}.`);
  return f.call(args, loc);
}

function method(name: string, impl: (args: unknown[], loc: Loc) => unknown | Promise<unknown>): Fn {
  return new Fn(name, impl);
}

function member(obj: unknown, name: string, loc: Loc, _interp: Interpreter): unknown {
  if (Array.isArray(obj)) {
    const list = obj;
    switch (name) {
      case "length": return list.length;
      case "push": return method("push", (args) => { list.push(...args); return list.length; });
      case "includes": return method("includes", ([x]) => list.some((y) => deepEqual(x, y)));
      case "indexOf": return method("indexOf", ([x]) => list.findIndex((y) => deepEqual(x, y)));
      case "join": return method("join", ([sep], l) => {
        if (!list.every((x) => typeof x === "string")) throw new MeldRuntimeError(l, "join needs a list of text.");
        return list.join(typeof sep === "string" ? sep : ",");
      });
      case "slice": return method("slice", ([a, b]) => list.slice(a as number, b as number | undefined));
      case "concat": return method("concat", ([other], l) => {
        if (!Array.isArray(other)) throw new MeldRuntimeError(l, "concat needs a list.");
        return [...list, ...other];
      });
      case "reverse": return method("reverse", () => [...list].reverse());
      case "map": return method("map", async ([f], l) => {
        const out: unknown[] = [];
        for (let i = 0; i < list.length; i++) out.push(await callFn(f, [list[i], i], l));
        return out;
      });
      case "filter": return method("filter", async ([f], l) => {
        const out: unknown[] = [];
        for (let i = 0; i < list.length; i++) if (truth(await callFn(f, [list[i], i], l), l, "filter")) out.push(list[i]);
        return out;
      });
      case "some": return method("some", async ([f], l) => {
        for (let i = 0; i < list.length; i++) if (truth(await callFn(f, [list[i], i], l), l, "some")) return true;
        return false;
      });
      case "every": return method("every", async ([f], l) => {
        for (let i = 0; i < list.length; i++) if (!truth(await callFn(f, [list[i], i], l), l, "every")) return false;
        return true;
      });
    }
    throw new MeldRuntimeError(loc, `Lists have no '${name}'. Available: length, push, includes, indexOf, join, slice, concat, reverse, map, filter, some, every.`);
  }
  if (typeof obj === "string") {
    const s = obj;
    switch (name) {
      case "length": return s.length;
      case "toUpperCase": return method(name, () => s.toUpperCase());
      case "toLowerCase": return method(name, () => s.toLowerCase());
      case "trim": return method(name, () => s.trim());
      case "split": return method(name, ([sep]) => s.split(String(sep)));
      case "includes": return method(name, ([x]) => s.includes(String(x)));
      case "startsWith": return method(name, ([x]) => s.startsWith(String(x)));
      case "endsWith": return method(name, ([x]) => s.endsWith(String(x)));
      case "slice": return method(name, ([a, b]) => s.slice(a as number, b as number | undefined));
      case "replaceAll": return method(name, ([a, b]) => s.replaceAll(String(a), String(b)));
    }
    throw new MeldRuntimeError(loc, `Text has no '${name}'. Available: length, toUpperCase, toLowerCase, trim, split, includes, startsWith, endsWith, slice, replaceAll.`);
  }
  if (isObject(obj)) {
    if (!(name in obj)) {
      const fields = Object.keys(obj);
      throw new MeldRuntimeError(loc, `There is no '${name}' here${fields.length ? ` (fields: ${fields.join(", ")})` : ""}. Use has(value, "${name}") to check optional fields.`);
    }
    return obj[name];
  }
  throw new MeldRuntimeError(loc, `Can't read '${name}' from ${show(obj)}.`);
}

// ---- builtins ----

function num(v: unknown, loc: Loc, fn: string): number {
  if (typeof v !== "number") throw new MeldRuntimeError(loc, `${fn} needs a number, got ${show(v)}.`);
  return v;
}

function numbers(args: unknown[], loc: Loc, fn: string): number[] {
  const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return list.map((v) => num(v, loc, fn));
}

export const BUILTINS: Record<string, Fn> = {
  text: new Fn("text", ([v]) => (typeof v === "string" ? v : JSON.stringify(v))),
  number: new Fn("number", ([v], loc) => {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isFinite(n) || String(v).trim() === "") throw new MeldRuntimeError(loc, `${show(v)} is not a number.`);
    return n;
  }),
  round: new Fn("round", ([v, digits], loc) => {
    const d = digits === undefined ? 0 : num(digits, loc, "round");
    const f = 10 ** d;
    return Math.round(num(v, loc, "round") * f) / f;
  }),
  floor: new Fn("floor", ([v], loc) => Math.floor(num(v, loc, "floor"))),
  ceil: new Fn("ceil", ([v], loc) => Math.ceil(num(v, loc, "ceil"))),
  abs: new Fn("abs", ([v], loc) => Math.abs(num(v, loc, "abs"))),
  min: new Fn("min", (args, loc) => Math.min(...numbers(args, loc, "min"))),
  max: new Fn("max", (args, loc) => Math.max(...numbers(args, loc, "max"))),
  sum: new Fn("sum", (args, loc) => numbers(args, loc, "sum").reduce((a, b) => a + b, 0)),
  keys: new Fn("keys", ([o], loc) => {
    if (!isObject(o)) throw new MeldRuntimeError(loc, `keys needs an object, got ${show(o)}.`);
    return Object.keys(o);
  }),
  values: new Fn("values", ([o], loc) => {
    if (!isObject(o)) throw new MeldRuntimeError(loc, `values needs an object, got ${show(o)}.`);
    return Object.values(o);
  }),
  has: new Fn("has", ([o, k]) => isObject(o) && typeof k === "string" && k in o && o[k] !== undefined),
  range: new Fn("range", ([n], loc) => Array.from({ length: num(n, loc, "range") }, (_, i) => i)),
  unique: new Fn("unique", ([list], loc) => {
    if (!Array.isArray(list)) throw new MeldRuntimeError(loc, `unique needs a list, got ${show(list)}.`);
    const out: unknown[] = [];
    for (const x of list) if (!out.some((y) => deepEqual(x, y))) out.push(x);
    return out;
  }),
};

export const BUILTIN_NAMES = new Set(Object.keys(BUILTINS));
