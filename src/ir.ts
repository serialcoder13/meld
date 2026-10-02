// The Meld model after parsing. The runtime is driven entirely by this: routes,
// flows, which step may call which, and what each step is allowed to touch.

export interface Loc {
  file: string;
  line: number;
  col: number;
}

// ---- types -----------------------------------------------------------------

export type TypeRef =
  | { kind: "text" | "number" | "money" | "bool" }
  | { kind: "list"; of: TypeRef }
  | { kind: "map"; of: TypeRef } // an object with any text keys, e.g. map<list<text>>
  | { kind: "nullable"; of: TypeRef } // T | null
  | { kind: "record"; name: string };

export interface Field {
  name: string;
  type: TypeRef;
  optional: boolean; // may be left out (name?: T)
  unique?: boolean; // table columns only
  source?: { kind: "header"; name: string }; // flow inputs only
  loc: Loc;
}

export function typeToString(t: TypeRef): string {
  if (t.kind === "list") return `list<${typeToString(t.of)}>`;
  if (t.kind === "map") return `map<${typeToString(t.of)}>`;
  if (t.kind === "nullable") return `${typeToString(t.of)} | null`;
  if (t.kind === "record") return t.name.includes(".") ? `row<${t.name}>` : t.name;
  return t.kind;
}

export function isNullable(t: TypeRef): boolean {
  return t.kind === "nullable";
}

// ---- expressions and statements (shared by step bodies and flows) -------------

export type Expr =
  | { kind: "num"; value: number; loc: Loc }
  | { kind: "str"; value: string; loc: Loc }
  | { kind: "bool"; value: boolean; loc: Loc }
  | { kind: "null"; loc: Loc }
  | { kind: "name"; name: string; loc: Loc }
  | { kind: "list"; items: Expr[]; loc: Loc }
  | { kind: "object"; entries: { key: string; value: Expr }[]; loc: Loc }
  | { kind: "member"; object: Expr; name: string; loc: Loc }
  | { kind: "index"; object: Expr; index: Expr; loc: Loc }
  | { kind: "call"; callee: Expr; args: Expr[]; named: NamedArg[] | null; loc: Loc }
  | { kind: "unary"; op: "!" | "-"; operand: Expr; loc: Loc }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; loc: Loc }
  | { kind: "cond"; test: Expr; then: Expr; else: Expr; loc: Loc }
  | { kind: "lambda"; params: string[]; body: Expr; loc: Loc };

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

export interface NamedArg {
  name: string;
  value: Expr;
  loc: Loc;
}

export type Stmt =
  | { kind: "let"; name: string; value: Expr; loc: Loc }
  | { kind: "assign"; target: Expr; op: "=" | "+=" | "-="; value: Expr; loc: Loc }
  | { kind: "expr"; expr: Expr; loc: Loc }
  | { kind: "if"; test: Expr; then: Stmt[]; else: Stmt[] | null; loc: Loc }
  | { kind: "for"; name: string; iterable: Expr; body: Stmt[]; loc: Loc }
  | { kind: "while"; test: Expr; body: Stmt[]; loc: Loc }
  | { kind: "return"; value: Expr; loc: Loc }
  | { kind: "break"; loc: Loc }
  | { kind: "continue"; loc: Loc };

// ---- model -------------------------------------------------------------------

export interface RecordDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  name: string;
  title?: string;
  fields: Field[];
  loc: Loc;
}

export interface OutcomeDef {
  name: string;
  fields: Field[];
  loc: Loc;
}

export type PortName = "store" | "db" | "clock" | "log" | "ids" | "crypto";
export const PORTS: readonly PortName[] = ["store", "db", "clock", "log", "ids", "crypto"];

// A table owned by one module. Every row also has an automatic `id: number`.
export interface TableDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  module: string;
  name: string;
  fields: Field[];
  loc: Loc;
  endLine?: number; // last line of the declaration, for showing its source
}

// A pure helper function: no ports, callable from the module's steps and flows.
export interface FnDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  module: string;
  name: string;
  params: Field[];
  returns: TypeRef;
  body: Stmt[];
  loc: Loc;
  endLine?: number; // last line of the declaration, for showing its source
}

export interface StepDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  module: string;
  name: string;
  title?: string;
  inputs: Field[];
  outcomes: OutcomeDef[];
  ports: { name: PortName; loc: Loc }[];
  body: { kind: "meld"; stmts: Stmt[] } | { kind: "js"; path: string; loc: Loc };
  loc: Loc;
  endLine?: number; // last line of the declaration, for showing its source
}

export interface FlowNode {
  kind: "do" | "respond";
  name: string; // for respond nodes: "respond@<line>"
  when: { node: string; outcome: string; loc: Loc }[];
  // do: the step to call, with named arguments
  target?: { module: string; step: string; loc: Loc };
  args: NamedArg[];
  // respond: HTTP status and body
  status?: number;
  body?: Expr;
  loc: Loc;
}

export interface HttpTrigger {
  method: string;
  path: string;
  loc: Loc;
}

export interface FlowDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  module: string;
  name: string;
  title?: string;
  trigger: HttpTrigger;
  inputs: Field[];
  nodes: FlowNode[];
  loc: Loc;
  endLine?: number; // last line of the declaration, for showing its source
}

export interface UseDef {
  module: string;
  step: string;
  loc: Loc;
}

export interface ModuleDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  name: string;
  title?: string;
  dir: string; // folder holding the module's .meld file; its JS code must live here
  uses: UseDef[];
  tables: TableDef[];
  fns: FnDef[];
  steps: StepDef[];
  flows: FlowDef[];
  loc: Loc;
}

export interface AppDef {
  doc?: string; // plain-language explanation, from /// lines above the declaration
  name: string;
  title?: string;
  loc: Loc;
}

export interface Model {
  root: string;
  app?: AppDef;
  records: RecordDef[];
  modules: ModuleDef[];
}

// ---- diagnostics ---------------------------------------------------------------

export interface Diagnostic {
  loc: Loc;
  message: string;
}

export class MeldSyntaxError extends Error {
  constructor(public loc: Loc, message: string) {
    super(message);
  }
}

export function formatDiagnostic(d: Diagnostic, root?: string): string {
  const f = d.loc.file;
  const file = root && f.startsWith(root + "/") ? f.slice(root.length + 1) : f;
  return `${file}:${d.loc.line}:${d.loc.col}: ${d.message}`;
}

export function stepKey(module: string, step: string): string {
  return `${module}.${step}`;
}
