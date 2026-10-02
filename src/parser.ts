import { lex, type Token } from "./lexer";
import {
  MeldSyntaxError,
  type AppDef,
  type BinaryOp,
  type Expr,
  type Field,
  type FlowDef,
  type FnDef,
  type TableDef,
  type FlowNode,
  type Loc,
  type ModuleDef,
  type NamedArg,
  type OutcomeDef,
  type PortName,
  PORTS,
  type RecordDef,
  type StepDef,
  type Stmt,
  type TypeRef,
} from "./ir";

export interface ParsedFile {
  app?: AppDef;
  records: RecordDef[];
  modules: ModuleDef[];
}

const KEYWORDS = new Set(["let", "const", "if", "else", "for", "of", "while", "return", "break", "continue", "true", "false", "null"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function parseFile(source: string, file: string, dir: string): ParsedFile {
  return new Parser(lex(source, file), dir).file();
}

class Parser {
  private i = 0;
  private currentModule: string | undefined; // set while parsing a module, for row<table> types
  constructor(private tokens: Token[], private dir: string) {}

  // ---- token helpers ----

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)]!;
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.i++;
    return t;
  }
  private is(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.kind === "punct" || t.kind === "ident") && t.value === value;
  }
  private accept(value: string): boolean {
    if (this.is(value)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(value: string, what?: string): Token {
    const t = this.peek();
    if (!this.is(value)) this.fail(t, `Expected ${what ?? `'${value}'`} but found ${describe(t)}.`);
    return this.next();
  }
  private ident(what: string): Token {
    const t = this.peek();
    if (t.kind !== "ident") this.fail(t, `Expected ${what} but found ${describe(t)}.`);
    return this.next();
  }
  private name(what: string): Token {
    const t = this.ident(what);
    if (!/^[a-z][a-z0-9_]*$/.test(t.value)) {
      this.fail(t, `'${t.value}' is not a valid ${what}. Use lower_snake_case, e.g. ${toSnake(t.value)}.`);
    }
    if (KEYWORDS.has(t.value)) this.fail(t, `'${t.value}' is a reserved word and can't be used as a ${what}.`);
    return t;
  }
  // Data-level names (fields, parameters, variables) may be lowerCamelCase so
  // they can match JSON on the wire; model-level names stay lower_snake_case.
  private fieldName(what: string): Token {
    const t = this.ident(what);
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(t.value)) {
      this.fail(t, `'${t.value}' is not a valid ${what}. Start with a lowercase letter, e.g. ${t.value[0]!.toLowerCase()}${t.value.slice(1)}.`);
    }
    if (KEYWORDS.has(t.value)) this.fail(t, `'${t.value}' is a reserved word and can't be used as a ${what}.`);
    return t;
  }
  private optionalTitle(): string | undefined {
    return this.peek().kind === "str" ? this.next().value : undefined;
  }
  private lastLine(): number {
    return this.tokens[Math.max(0, this.i - 1)]!.loc.line;
  }
  private fail(t: Token, message: string): never {
    throw new MeldSyntaxError(t.loc, message);
  }

  // ---- top level ----

  file(): ParsedFile {
    const out: ParsedFile = { records: [], modules: [] };
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (this.is("app")) {
        if (out.app) this.fail(t, "A file can declare the app only once.");
        out.app = this.app();
      } else if (this.is("record")) out.records.push(this.record());
      else if (this.is("module")) out.modules.push(this.module());
      else this.fail(t, `Expected 'app', 'record' or 'module' at the top level but found ${describe(t)}.`);
    }
    return out;
  }

  private app(): AppDef {
    const kw = this.next();
    const name = this.name("app name");
    return { name: name.value, title: this.optionalTitle(), loc: kw.loc };
  }

  private record(): RecordDef {
    const kw = this.next();
    const name = this.ident("record name");
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name.value)) {
      this.fail(name, `Record names use PascalCase, e.g. ${name.value[0]!.toUpperCase()}${name.value.slice(1)}.`);
    }
    const title = this.optionalTitle();
    this.expect("{");
    const fields: Field[] = [];
    while (!this.accept("}")) {
      fields.push(this.field("field name"));
      this.accept(",") || this.accept(";");
    }
    return { name: name.value, title, fields, loc: kw.loc };
  }

  private module(): ModuleDef {
    const kw = this.next();
    const name = this.name("module name");
    this.currentModule = name.value;
    const mod: ModuleDef = {
      name: name.value,
      title: this.optionalTitle(),
      dir: this.dir,
      uses: [],
      tables: [],
      fns: [],
      steps: [],
      flows: [],
      loc: kw.loc,
    };
    this.expect("{");
    while (!this.accept("}")) {
      const t = this.peek();
      if (this.is("uses")) {
        this.next();
        do {
          const m = this.name("module name");
          this.expect(".", "'.' followed by a step name (uses module.step)");
          const s = this.name("step name");
          mod.uses.push({ module: m.value, step: s.value, loc: m.loc });
        } while (this.accept(","));
      } else if (this.is("step")) mod.steps.push(this.step(mod.name));
      else if (this.is("flow")) mod.flows.push(this.flow(mod.name));
      else if (this.is("table")) mod.tables.push(this.table(mod.name));
      else if (this.is("fn")) mod.fns.push(this.fn(mod.name));
      else this.fail(t, `Expected 'uses', 'table', 'fn', 'step' or 'flow' inside a module but found ${describe(t)}.`);
    }
    this.currentModule = undefined;
    return mod;
  }

  private table(module: string): TableDef {
    const kw = this.next();
    const name = this.name("table name");
    this.expect("{");
    const fields: Field[] = [];
    while (!this.accept("}")) {
      fields.push(this.field("column name"));
      this.accept(",") || this.accept(";");
    }
    return { module, name: name.value, fields, loc: kw.loc, endLine: this.lastLine() };
  }

  private fn(module: string): FnDef {
    const kw = this.next();
    const name = this.name("function name");
    const params = this.params();
    this.expect("->", "'->' followed by the type the function returns");
    const returns = this.type();
    const body = this.block();
    return { module, name: name.value, params, returns, body, loc: kw.loc, endLine: this.lastLine() };
  }

  private step(module: string): StepDef {
    const kw = this.next();
    const name = this.name("step name");
    const title = this.optionalTitle();
    const inputs = this.params();
    this.expect("->", "'->' followed by the step's outcomes, e.g. -> done(total: money) | failed(reason: text)");
    const outcomes: OutcomeDef[] = [];
    do {
      const o = this.name("outcome name");
      outcomes.push({ name: o.value, fields: this.is("(") ? this.params() : [], loc: o.loc });
    } while (this.accept("|"));
    const ports: StepDef["ports"] = [];
    if (this.accept("uses")) {
      do {
        const p = this.ident("port name");
        if (!PORTS.includes(p.value as PortName)) {
          this.fail(p, `Unknown port '${p.value}'. Steps can use: ${PORTS.join(", ")}.`);
        }
        ports.push({ name: p.value as PortName, loc: p.loc });
      } while (this.accept(","));
    }
    let body: StepDef["body"];
    if (this.is("js")) {
      const js = this.next();
      const path = this.peek();
      if (path.kind !== "str") this.fail(path, 'Expected the path of a JavaScript/TypeScript file, e.g. js "./charge.ts".');
      this.next();
      body = { kind: "js", path: path.value, loc: js.loc };
    } else if (this.is("{")) {
      body = { kind: "meld", stmts: this.block() };
    } else {
      this.fail(this.peek(), "Expected the step's body in { } or js \"./file.ts\".");
    }
    return { module, name: name.value, title, inputs, outcomes, ports, body, loc: kw.loc, endLine: this.lastLine() };
  }

  private flow(module: string): FlowDef {
    const kw = this.next();
    const name = this.name("flow name");
    const title = this.optionalTitle();
    this.expect("on", "'on' followed by an HTTP method and path, e.g. on POST \"/orders\"");
    const m = this.ident("HTTP method");
    if (!METHODS.has(m.value)) this.fail(m, `Expected an HTTP method (${[...METHODS].join(", ")}) but found '${m.value}'.`);
    const p = this.peek();
    if (p.kind !== "str" || !p.value.startsWith("/")) this.fail(p, 'Expected a path in quotes starting with /, e.g. "/orders".');
    this.next();
    const inputs = this.params();
    this.expect("{");
    const nodes: FlowNode[] = [];
    while (!this.accept("}")) {
      nodes.push(this.flowNode());
      this.accept(";");
    }
    return {
      module,
      name: name.value,
      title,
      trigger: { method: m.value, path: p.value, loc: m.loc },
      inputs,
      nodes,
      loc: kw.loc,
      endLine: this.lastLine(),
    };
  }

  private flowNode(): FlowNode {
    const start = this.peek();
    const when: FlowNode["when"] = [];
    if (this.accept("when")) {
      do {
        const n = this.name("step name");
        this.expect(".", "'.' followed by an outcome name (when step.outcome)");
        const o = this.name("outcome name");
        when.push({ node: n.value, outcome: o.value, loc: n.loc });
      } while (this.accept(","));
    }
    if (this.is("respond")) {
      const kw = this.next();
      const status = this.peek();
      if (status.kind !== "num" || !/^[1-5][0-9][0-9]$/.test(status.value)) {
        this.fail(status, "Expected an HTTP status code after 'respond', e.g. respond 201 { ... }.");
      }
      this.next();
      const sameLine = this.peek().loc.line === status.loc.line && this.peek().kind !== "eof" && !this.is("}");
      const body = sameLine ? this.expr() : undefined;
      return { kind: "respond", name: `respond@${kw.loc.line}`, when, args: [], status: Number(status.value), body, loc: kw.loc };
    }
    const name = this.name("name for this step's result");
    if (!this.accept("=")) {
      this.fail(this.peek(), `Inside a flow, each line is either 'name = step(...)' or 'respond <status> { ... }'.`);
    }
    const first = this.name("step name");
    let target = { module: "", step: first.value, loc: first.loc };
    if (this.accept(".")) target = { module: first.value, step: this.name("step name").value, loc: first.loc };
    this.expect("(");
    const args = this.namedArgs("step");
    return { kind: "do", name: name.value, when, target, args, loc: start.loc };
  }

  private params(): Field[] {
    this.expect("(");
    const fields: Field[] = [];
    while (!this.accept(")")) {
      fields.push(this.field("parameter name"));
      if (!this.is(")")) this.expect(",", "',' or ')'");
    }
    return fields;
  }

  private field(what: string): Field {
    const n = this.fieldName(what);
    const optional = this.accept("?");
    this.expect(":", `':' followed by a type (text, number, money, bool, list<...> or a record name)`);
    const field: Field = { name: n.value, type: this.type(), optional, loc: n.loc };
    if (this.accept("unique")) field.unique = true;
    if (this.accept("from")) {
      this.expect("header", "'header' (inputs can come from a request header: from header \"Authorization\")");
      const h = this.peek();
      if (h.kind !== "str") this.fail(h, 'Expected the header name in quotes, e.g. from header "Authorization".');
      this.next();
      field.source = { kind: "header", name: h.value };
    }
    return field;
  }

  private type(): TypeRef {
    const base = this.baseType();
    if (this.is("|") && this.is("null", 1)) {
      this.next();
      this.next();
      return { kind: "nullable", of: base };
    }
    return base;
  }

  private baseType(): TypeRef {
    const t = this.ident("a type");
    switch (t.value) {
      case "text":
      case "number":
      case "money":
      case "bool":
        return { kind: t.value };
      case "list": {
        this.expect("<", "'<' after list, e.g. list<text>");
        const of = this.type();
        this.expect(">");
        return { kind: "list", of };
      }
      case "row": {
        // a row of one of the module's tables: row<article> or row<module.table>
        this.expect("<", "'<' after row, e.g. row<article>");
        const first = this.name("table name");
        let full = `${this.currentModule ?? ""}.${first.value}`;
        if (this.accept(".")) full = `${first.value}.${this.name("table name").value}`;
        else if (!this.currentModule) this.fail(first, "Outside a module, name the table with its module: row<module.table>.");
        this.expect(">");
        return { kind: "record", name: full };
      }
      case "map": {
        this.expect("<", "'<' after map, e.g. map<text>");
        const of = this.type();
        this.expect(">");
        return { kind: "map", of };
      }
      case "string":
        this.fail(t, "Use 'text' instead of 'string'.");
      case "boolean":
        this.fail(t, "Use 'bool' instead of 'boolean'.");
      case "int":
      case "float":
        this.fail(t, "Use 'number' (or 'money' for amounts of money).");
      default:
        if (/^[A-Z]/.test(t.value)) return { kind: "record", name: t.value };
        this.fail(t, `Unknown type '${t.value}'. Use text, number, money, bool, list<...> or a record name.`);
    }
  }

  // ---- statements ----

  private block(): Stmt[] {
    this.expect("{");
    const stmts: Stmt[] = [];
    while (!this.accept("}")) {
      if (this.peek().kind === "eof") this.fail(this.peek(), "This block is never closed with }.");
      stmts.push(this.stmt());
      this.accept(";");
    }
    return stmts;
  }

  private stmt(): Stmt {
    const t = this.peek();
    if (this.is("let") || this.is("const")) {
      this.next();
      const n = this.fieldName("variable name");
      this.expect("=", "'=' and a value");
      return { kind: "let", name: n.value, value: this.expr(), loc: t.loc };
    }
    if (this.is("var")) this.fail(t, "Use 'let' instead of 'var'.");
    if (this.is("if")) return this.ifStmt();
    if (this.is("for")) {
      this.next();
      this.expect("(");
      this.accept("let") || this.accept("const");
      const n = this.fieldName("loop variable");
      if (this.is("in")) this.fail(this.peek(), "Use 'of' to loop over a list: for (let item of items) { ... }.");
      this.expect("of", "'of', e.g. for (let item of items)");
      const iterable = this.expr();
      this.expect(")");
      return { kind: "for", name: n.value, iterable, body: this.block(), loc: t.loc };
    }
    if (this.is("while")) {
      this.next();
      this.expect("(");
      const test = this.expr();
      this.expect(")");
      return { kind: "while", test, body: this.block(), loc: t.loc };
    }
    if (this.is("return")) {
      this.next();
      return { kind: "return", value: this.expr(), loc: t.loc };
    }
    if (this.is("break")) {
      this.next();
      return { kind: "break", loc: t.loc };
    }
    if (this.is("continue")) {
      this.next();
      return { kind: "continue", loc: t.loc };
    }
    if (this.is("try") || this.is("throw")) {
      this.fail(t, `'${t.value}' is not part of Meld. A step reports problems by returning one of its outcomes.`);
    }
    const expr = this.expr();
    for (const op of ["=", "+=", "-="] as const) {
      if (this.accept(op)) {
        if (expr.kind !== "name" && expr.kind !== "member" && expr.kind !== "index") {
          this.fail(t, "You can only assign to a variable, a field or a list item.");
        }
        return { kind: "assign", target: expr, op, value: this.expr(), loc: t.loc };
      }
    }
    return { kind: "expr", expr, loc: t.loc };
  }

  private ifStmt(): Stmt {
    const t = this.next();
    this.expect("(", "'(' after if");
    const test = this.expr();
    this.expect(")");
    const then = this.block();
    let otherwise: Stmt[] | null = null;
    if (this.accept("else")) otherwise = this.is("if") ? [this.ifStmt()] : this.block();
    return { kind: "if", test, then, else: otherwise, loc: t.loc };
  }

  // ---- expressions ----

  expr(): Expr {
    if (this.isLambda()) return this.lambda();
    const test = this.or();
    if (this.accept("?")) {
      const then = this.expr();
      this.expect(":", "':' in a ? : expression");
      return { kind: "cond", test, then, else: this.expr(), loc: test.loc };
    }
    return test;
  }

  private isLambda(): boolean {
    if (this.peek().kind === "ident" && this.is("=>", 1)) return true;
    if (!this.is("(")) return false;
    let depth = 0;
    for (let k = this.i; k < this.tokens.length; k++) {
      const t = this.tokens[k]!;
      if (t.kind === "punct" && t.value === "(") depth++;
      if (t.kind === "punct" && t.value === ")" && --depth === 0) {
        const after = this.tokens[k + 1];
        return after?.kind === "punct" && after.value === "=>";
      }
    }
    return false;
  }

  private lambda(): Expr {
    const start = this.peek();
    const params: string[] = [];
    if (this.accept("(")) {
      while (!this.accept(")")) {
        params.push(this.fieldName("parameter name").value);
        if (!this.is(")")) this.expect(",");
      }
    } else params.push(this.fieldName("parameter name").value);
    this.expect("=>");
    if (this.is("{")) this.fail(this.peek(), "Lambdas take a single expression, e.g. item => item.qty * item.price. To return an object, wrap it in parentheses: item => ({ ... }).");
    return { kind: "lambda", params, body: this.expr(), loc: start.loc };
  }

  private binary(ops: BinaryOp[], operand: () => Expr): Expr {
    let left = operand();
    while (true) {
      const op = ops.find((o) => this.peek().kind === "punct" && this.peek().value === o);
      if (!op) return left;
      this.next();
      left = { kind: "binary", op, left, right: operand(), loc: left.loc };
    }
  }
  private or = (): Expr => this.binary(["||"], this.and);
  private and = (): Expr => this.binary(["&&"], this.equality);
  private equality = (): Expr => this.binary(["==", "!="], this.comparison);
  private comparison = (): Expr => this.binary(["<", "<=", ">", ">="], this.additive);
  private additive = (): Expr => this.binary(["+", "-"], this.multiplicative);
  private multiplicative = (): Expr => this.binary(["*", "/", "%"], this.unary);

  private unary = (): Expr => {
    const t = this.peek();
    if (this.accept("!")) return { kind: "unary", op: "!", operand: this.unary(), loc: t.loc };
    if (this.accept("-")) return { kind: "unary", op: "-", operand: this.unary(), loc: t.loc };
    return this.postfix();
  };

  private postfix(): Expr {
    let e = this.primary();
    while (true) {
      const t = this.peek();
      if (this.accept(".")) {
        const n = this.ident("a field or method name");
        e = { kind: "member", object: e, name: n.value, loc: t.loc };
      } else if (this.accept("[")) {
        const index = this.expr();
        this.expect("]");
        e = { kind: "index", object: e, index, loc: t.loc };
      } else if (this.accept("(")) {
        if (this.peek().kind === "ident" && this.is(":", 1)) {
          e = { kind: "call", callee: e, args: [], named: this.namedArgs("call"), loc: t.loc };
        } else {
          const args: Expr[] = [];
          while (!this.accept(")")) {
            args.push(this.expr());
            if (!this.is(")")) this.expect(",", "',' or ')'");
          }
          e = { kind: "call", callee: e, args, named: null, loc: t.loc };
        }
      } else return e;
    }
  }

  // after '(' has been consumed
  private namedArgs(what: string): NamedArg[] {
    const args: NamedArg[] = [];
    while (!this.accept(")")) {
      const n = this.fieldName("argument name");
      this.expect(":", `':' after the argument name. ${what === "step" ? "Steps" : "This call"} take named arguments, e.g. charge(amount: total)`);
      args.push({ name: n.value, value: this.expr(), loc: n.loc });
      if (!this.is(")")) this.expect(",", "',' or ')'");
    }
    return args;
  }

  private primary(): Expr {
    const t = this.next();
    const loc: Loc = t.loc;
    if (t.kind === "num") return { kind: "num", value: Number(t.value), loc };
    if (t.kind === "str") return { kind: "str", value: t.value, loc };
    if (t.kind === "ident") {
      if (t.value === "true" || t.value === "false") return { kind: "bool", value: t.value === "true", loc };
      if (t.value === "null") return { kind: "null", loc };
      if (t.value === "undefined") this.fail(t, "Meld has no 'undefined'. Use null, or leave an optional field out.");
      if (KEYWORDS.has(t.value)) this.fail(t, `Unexpected '${t.value}' here.`);
      return { kind: "name", name: t.value, loc };
    }
    if (t.kind === "punct") {
      if (t.value === "(") {
        const e = this.expr();
        this.expect(")");
        return e;
      }
      if (t.value === "[") {
        const items: Expr[] = [];
        while (!this.accept("]")) {
          items.push(this.expr());
          if (!this.is("]")) this.expect(",", "',' or ']'");
        }
        return { kind: "list", items, loc };
      }
      if (t.value === "{") {
        const entries: { key: string; value: Expr }[] = [];
        while (!this.accept("}")) {
          const k = this.next();
          if (k.kind !== "ident" && k.kind !== "str") this.fail(k, `Expected a field name but found ${describe(k)}.`);
          if (this.accept(":")) entries.push({ key: k.value, value: this.expr() });
          else entries.push({ key: k.value, value: { kind: "name", name: k.value, loc: k.loc } });
          if (!this.is("}")) this.expect(",", "',' or '}'");
        }
        return { kind: "object", entries, loc };
      }
    }
    this.fail(t, `Expected a value but found ${describe(t)}.`);
  }
}

function describe(t: Token): string {
  if (t.kind === "eof") return "the end of the file";
  if (t.kind === "str") return `text "${t.value}"`;
  return `'${t.value}'`;
}

function toSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}
