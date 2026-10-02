import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis } from "../check";
import { contractChanges, declarationText, draftReplace, locate, targetLabel, type Draft, type Target } from "../edit";
import { whoUses } from "../explain";
import { stepKey, typeToString, type Field } from "../ir";
import type { LLM } from "./llm";

// The Meld agent: writes plain-language explanations, and turns a changed
// explanation (or a request) into new Meld code that the checker accepts.
// People see explanations and summaries, never the code.

const PRIMER = readFileSync(join(import.meta.dir, "..", "..", "docs", "meld-language.md"), "utf8");
const MAX_ATTEMPTS = 3;

export interface Proposal {
  id: string;
  target: Target;
  summary: string; // what will behave differently, in plain language
  doc: string; // the new explanation
  changes: string[]; // contract changes, worked out by Meld (not by the model)
  problems: string[]; // checker problems left after the last attempt; empty when it can be applied
  attempts: number;
  draft: Draft;
}

const EXPLAIN_RULES = `Write the explanation of one part of a Meld app for a person who doesn't read code.
- Say what it does and in what order, and what each possible ending (outcome) means.
- 2 to 6 short lines, one sentence per line. Plain words; no code, no variable names, no symbols.
- Name things the way a user would ("the article", "the signed-in person"), not by identifiers.
Reply with only the explanation lines.`;

const CHANGE_RULES = `You change one declaration in a Meld app. Follow the Meld language reference exactly.
- Keep the declaration's kind and name. Change as little as needed.
- Keep its inputs and outcomes unless the request needs different ones; callers elsewhere depend on them.
- The explanation is for people who don't read code: plain words, one sentence per line, 2 to 6 lines.
Reply in exactly this format and nothing else:
<summary>one or two plain sentences saying what will behave differently</summary>
<explanation>the full new explanation</explanation>
<meld>
the complete new declaration, starting with its keyword, without any /// lines
</meld>`;

export class MeldAgent {
  private nextId = 0;
  constructor(private llm: LLM) {}

  async explain(a: Analysis, t: Target): Promise<string> {
    const code = t.kind === "module" ? moduleOutline(a, t.module) : declarationText(a, t);
    if (!code) throw new Error(`Can't find ${targetLabel(t)}.`);
    const user = [`# Context\n${context(a, t)}`, `# The ${t.kind} to explain\n\`\`\`meld\n${code}\n\`\`\``].join("\n\n");
    const text = await this.llm.complete(`${EXPLAIN_RULES}\n\n# Meld language reference\n${PRIMER}`, user, "medium");
    return cleanExplanation(text);
  }

  async propose(a: Analysis, t: Target, request: { doc?: string; instruction?: string }): Promise<Proposal> {
    if (t.kind === "module") throw new Error("Change the module's parts one at a time.");
    const code = declarationText(a, t);
    const current = locate(a, t);
    if (!code || !current) throw new Error(`Can't find ${targetLabel(t)}.`);
    const ask = request.doc
      ? `The person rewrote the explanation. Make the ${t.kind} do exactly what the new explanation says.\n\nNew explanation:\n${request.doc}`
      : `The person asked for this change:\n${request.instruction}`;
    let user = [
      `# Context\n${context(a, t)}`,
      `# The ${t.kind} to change\n\`\`\`meld\n${code}\n\`\`\``,
      `# Its current explanation\n${current.doc ?? "(none yet)"}`,
      `# What to do\n${ask}`,
    ].join("\n\n");
    const system = `${CHANGE_RULES}\n\n# Meld language reference\n${PRIMER}`;

    let last: { summary: string; doc: string; draft: Draft } | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const reply = await this.llm.complete(system, user, "high");
      const parsed = parseChange(reply);
      if (!parsed) {
        user += `\n\n# Your last reply couldn't be read\nReply in the exact <summary>, <explanation>, <meld> format.`;
        continue;
      }
      const doc = request.doc ?? parsed.explanation;
      const draft = draftReplace(a, t, parsed.meld, doc);
      last = { summary: parsed.summary, doc, draft };
      if (!draft.problems.length) return this.finish(a, t, last, attempt);
      user += `\n\n# Attempt ${attempt} didn't pass the Meld checker\nYour declaration:\n\`\`\`meld\n${parsed.meld}\n\`\`\`\nProblems:\n${draft.problems.map((p) => `- ${p}`).join("\n")}\nFix them and reply again in the same format.`;
    }
    if (!last) throw new Error("The model didn't reply in the expected format.");
    return this.finish(a, t, last, MAX_ATTEMPTS);
  }

  private finish(a: Analysis, t: Target, r: { summary: string; doc: string; draft: Draft }, attempts: number): Proposal {
    const key = stepKey(t.module, t.name);
    const changes = t.kind === "step" ? contractChanges(a.steps.get(key), r.draft.analysis?.steps.get(key)) : [];
    return { id: `p${++this.nextId}`, target: t, summary: r.summary, doc: r.doc, changes, problems: r.draft.problems, attempts, draft: r.draft };
  }
}

// ---- prompt context ----

const sig = (fs: Field[]) => fs.map((f) => `${f.name}${f.optional ? "?" : ""}: ${typeToString(f.type)}`).join(", ");

function moduleOutline(a: Analysis, name: string): string {
  const m = a.modules.get(name)!;
  const out = [`module ${m.name}${m.title ? ` "${m.title}"` : ""}`];
  if (m.uses.length) out.push(`  uses ${m.uses.map((u) => `${u.module}.${u.step}`).join(", ")}`);
  for (const t of m.tables) out.push(`  table ${t.name} { ${sig(t.fields)} }`);
  for (const f of m.fns) out.push(`  fn ${f.name} (${sig(f.params)}) -> ${typeToString(f.returns)}`);
  for (const s of m.steps) {
    out.push(`  step ${s.name}${s.title ? ` "${s.title}"` : ""} (${sig(s.inputs)}) -> ${s.outcomes.map((o) => `${o.name}(${sig(o.fields)})`).join(" | ")}${s.ports.length ? ` uses ${s.ports.map((p) => p.name).join(", ")}` : ""}`);
  }
  for (const f of m.flows) out.push(`  flow ${f.name}${f.title ? ` "${f.title}"` : ""} on ${f.trigger.method} "${f.trigger.path}" (${sig(f.inputs)})`);
  return out.join("\n");
}

function context(a: Analysis, t: Target): string {
  const records = [...a.records.values()].filter((r) => !r.name.includes(".")).map((r) => `record ${r.name} { ${sig(r.fields)} }`);
  const parts = [`## Records\n${records.join("\n")}`, `## Its module (outline)\n${moduleOutline(a, t.module)}`];
  const m = a.modules.get(t.module)!;
  for (const u of m.uses) {
    const s = a.steps.get(stepKey(u.module, u.step));
    if (s) parts.push(`## Used from module ${u.module}\nstep ${s.name} (${sig(s.inputs)}) -> ${s.outcomes.map((o) => `${o.name}(${sig(o.fields)})`).join(" | ")}`);
  }
  if (t.kind === "step") parts.push(`## Where this step is used\n${whoUses(a, stepKey(t.module, t.name))}`);
  return parts.join("\n\n");
}

// ---- reading replies ----

export function parseChange(reply: string): { summary: string; explanation: string; meld: string } | undefined {
  const tag = (name: string) => reply.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  const summary = tag("summary");
  const explanation = tag("explanation");
  let meld = tag("meld");
  if (!summary || !explanation || !meld) return;
  meld = meld.replace(/^```(?:meld)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  return { summary, explanation: cleanExplanation(explanation), meld };
}

function cleanExplanation(text: string): string {
  return text
    .replace(/^```\w*\n?|```$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/\/|[-*•])\s?/, "").trim())
    .filter(Boolean)
    .join("\n");
}
