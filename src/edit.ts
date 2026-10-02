import { readFileSync, writeFileSync } from "node:fs";
import { analyze, type Analysis } from "./check";
import { formatDiagnostic, typeToString, type Loc, type StepDef } from "./ir";
import { loadModel } from "./load";

// Editing the model safely: every change is made in memory first and the
// whole app is checked before anything is written.

export type TargetKind = "module" | "step" | "flow" | "fn" | "table";

export interface Target {
  kind: TargetKind;
  module: string;
  name: string; // for a module, its own name
}

interface Located {
  file: string;
  line: number; // the declaration's first line (1-based)
  endLine: number;
  docStart: number; // first /// line above it, or `line` when there is none
  indent: string;
  title?: string;
  doc?: string;
}

export function targetLabel(t: Target): string {
  return t.kind === "module" ? `module ${t.module}` : `${t.kind} ${t.module}.${t.name}`;
}

export function locate(a: Analysis, t: Target): Located | undefined {
  const m = a.modules.get(t.module);
  if (!m) return;
  let decl: { loc: Loc; endLine?: number; title?: string; doc?: string } | undefined;
  if (t.kind === "module") decl = m;
  else if (t.kind === "step") decl = m.steps.find((s) => s.name === t.name);
  else if (t.kind === "flow") decl = m.flows.find((f) => f.name === t.name);
  else if (t.kind === "fn") decl = m.fns.find((f) => f.name === t.name);
  else if (t.kind === "table") decl = m.tables.find((x) => x.name === t.name);
  if (!decl) return;
  const lines = readFileSync(decl.loc.file, "utf8").split("\n");
  let docStart = decl.loc.line;
  while (docStart > 1 && /^\s*\/\/\/(?!\/)/.test(lines[docStart - 2]!)) docStart--;
  const indent = lines[decl.loc.line - 1]!.match(/^\s*/)![0];
  const endLine = t.kind === "module" ? decl.loc.line : (decl.endLine ?? decl.loc.line);
  return { file: decl.loc.file, line: decl.loc.line, endLine, docStart, indent, title: decl.title, doc: decl.doc };
}

/** The declaration's text, without its /// explanation. */
export function declarationText(a: Analysis, t: Target): string | undefined {
  const at = locate(a, t);
  if (!at || t.kind === "module") return;
  const lines = readFileSync(at.file, "utf8").split("\n");
  return dedent(lines.slice(at.line - 1, at.endLine).join("\n"));
}

export function docLines(doc: string, indent: string): string[] {
  return doc
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l !== "" || (i > 0 && i < all.length - 1))
    .map((l) => (l ? `${indent}/// ${l}` : `${indent}///`));
}

export interface Draft {
  files: Map<string, string>; // file -> new contents
  analysis?: Analysis;
  problems: string[]; // plain checker messages; empty means the whole app checks clean
}

function check(root: string, files: Map<string, string>): Draft {
  const { model, diagnostics } = loadModel(root, files);
  const analysis = analyze(model);
  const all = diagnostics.length ? diagnostics : analysis.diagnostics;
  return { files, analysis: all.length ? undefined : analysis, problems: all.map((d) => formatDiagnostic(d, root)) };
}

/** Replace a declaration (and its explanation) with new text, then check the whole app. */
export function draftReplace(a: Analysis, t: Target, newText: string, doc: string | undefined): Draft {
  const at = locate(a, t);
  if (!at) return { files: new Map(), problems: [`Can't find ${targetLabel(t)}.`] };
  const lines = readFileSync(at.file, "utf8").split("\n");
  const body = newText
    .replace(/^\s*\/\/\/.*\n/gm, "") // explanations are managed separately
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? at.indent + l : ""));
  const replacement = [...(doc ? docLines(doc, at.indent) : []), ...body];
  const next = [...lines.slice(0, at.docStart - 1), ...replacement, ...lines.slice(at.endLine)];
  return check(a.model.root, new Map([[at.file, next.join("\n")]]));
}

/** Change only the explanation (/// lines) of a declaration. */
export function draftDoc(a: Analysis, t: Target, doc: string): Draft {
  const at = locate(a, t);
  if (!at) return { files: new Map(), problems: [`Can't find ${targetLabel(t)}.`] };
  const lines = readFileSync(at.file, "utf8").split("\n");
  const next = [...lines.slice(0, at.docStart - 1), ...docLines(doc, at.indent), ...lines.slice(at.line - 1)];
  return check(a.model.root, new Map([[at.file, next.join("\n")]]));
}

/** Change the human title ("Sign up") of a module, step or flow. */
export function draftTitle(a: Analysis, t: Target, title: string): Draft {
  const at = locate(a, t);
  if (!at) return { files: new Map(), problems: [`Can't find ${targetLabel(t)}.`] };
  if (t.kind === "fn" || t.kind === "table") return { files: new Map(), problems: [`A ${t.kind} has no title.`] };
  const lines = readFileSync(at.file, "utf8").split("\n");
  const line = lines[at.line - 1]!;
  const quoted = JSON.stringify(title.trim());
  const head = new RegExp(`^(\\s*${t.kind}\\s+${t.kind === "module" ? t.module : t.name})(\\s+"(?:[^"\\\\]|\\\\.)*")?`);
  if (!head.test(line)) return { files: new Map(), problems: [`Can't find the title of ${targetLabel(t)}.`] };
  lines[at.line - 1] = line.replace(head, (_, start: string) => `${start} ${quoted}`);
  return check(a.model.root, new Map([[at.file, lines.join("\n")]]));
}

export function writeDraft(d: Draft) {
  for (const [file, contents] of d.files) writeFileSync(file, contents);
}

// ---- describing a change in plain language (never by showing code) ----

export function contractChanges(before: StepDef | undefined, after: StepDef | undefined): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  const fields = (fs: { name: string; type: { kind: string } }[]) => new Map(fs.map((f) => [f.name, typeToString(f.type as never)]));
  const bi = fields(before.inputs);
  const ai = fields(after.inputs);
  for (const [n, ty] of ai) if (!bi.has(n)) out.push(`Now also needs ${n} (${ty}).`);
  for (const n of bi.keys()) if (!ai.has(n)) out.push(`No longer needs ${n}.`);
  for (const [n, ty] of ai) if (bi.has(n) && bi.get(n) !== ty) out.push(`${n} changes from ${bi.get(n)} to ${ty}.`);
  const bo = new Set(before.outcomes.map((o) => o.name));
  const ao = new Set(after.outcomes.map((o) => o.name));
  for (const o of ao) if (!bo.has(o)) out.push(`Can now also end with "${o}".`);
  for (const o of bo) if (!ao.has(o)) out.push(`Can no longer end with "${o}".`);
  const bp = new Set(before.ports.map((p) => p.name));
  const ap = new Set(after.ports.map((p) => p.name));
  for (const p of ap) if (!bp.has(p)) out.push(`Now also touches ${p}.`);
  for (const p of bp) if (!ap.has(p)) out.push(`No longer touches ${p}.`);
  return out;
}

function dedent(code: string): string {
  const lines = code.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}
