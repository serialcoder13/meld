import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MeldSyntaxError, type Diagnostic, type Model } from "./ir";
import { parseFile } from "./parser";

// Loads every .meld file under a folder into one model. Each module's folder
// is the folder of the .meld file that declares it.
// `overrides` replaces file contents in memory, so a proposed edit can be
// checked before anything is written.
export function loadModel(root: string, overrides?: Map<string, string>): { model: Model; diagnostics: Diagnostic[] } {
  const absRoot = resolve(root);
  const model: Model = { root: absRoot, records: [], modules: [] };
  const diagnostics: Diagnostic[] = [];
  for (const file of findMeldFiles(absRoot)) {
    const dir = file.slice(0, file.lastIndexOf("/"));
    try {
      const parsed = parseFile(overrides?.get(file) ?? readFileSync(file, "utf8"), file, dir);
      if (parsed.app) {
        if (model.app) diagnostics.push({ loc: parsed.app.loc, message: `The app is already declared in ${model.app.loc.file}.` });
        else model.app = parsed.app;
      }
      model.records.push(...parsed.records);
      for (const m of parsed.modules) {
        for (const s of m.steps) if (s.body.kind === "js") s.body.path = resolve(dir, s.body.path);
        model.modules.push(m);
      }
    } catch (e) {
      if (e instanceof MeldSyntaxError) diagnostics.push({ loc: e.loc, message: e.message });
      else throw e;
    }
  }
  return { model, diagnostics };
}

function findMeldFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findMeldFiles(p));
    else if (name.endsWith(".meld")) out.push(p);
  }
  return out;
}
