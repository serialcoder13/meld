#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyze, type Analysis } from "./check";
import { Engine } from "./engine";
import { explainApp, explainFlow, whoUses } from "./explain";
import { formatDiagnostic } from "./ir";
import { loadModel } from "./load";
import { Storage } from "./ports";
import { createServer } from "./server";

const USAGE = `meld — run a Meld app on one Bun server

  meld check    [dir]                 check the model
  meld run      [dir] [--port 3000]   check, then serve every flow
  meld studio   [dir] [--port 3000]   run, and open Meld Studio to see and try the app
  meld explain  [dir] [module.flow]   show the app, or one flow step by step
  meld who-uses [dir] module.step     show where a step is used and what depends on it`;

function load(dir: string): Analysis | null {
  const { model, diagnostics } = loadModel(dir);
  const analysis = analyze(model);
  // A file that didn't parse makes the rest of the model incomplete, so show only syntax errors first.
  const all = diagnostics.length ? diagnostics : analysis.diagnostics;
  if (all.length) {
    for (const d of all) console.error(formatDiagnostic(d, model.root));
    console.error(`\n${all.length} problem${all.length > 1 ? "s" : ""} found.`);
    return null;
  }
  return analysis;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string>();
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]!.startsWith("--")) flags.set(rest[i]!.slice(2), rest[++i] ?? "");
    else args.push(rest[i]!);
  }
  const takeDir = () => (args.length && !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(args[0]!) ? args.shift()! : ".");

  switch (cmd) {
    case "check": {
      const a = load(takeDir());
      if (!a) return 1;
      console.log(`ok: ${a.modules.size} modules, ${a.steps.size} steps, ${a.plans.length} flows`);
      return 0;
    }
    case "explain": {
      const a = load(takeDir());
      if (!a) return 1;
      const target = args[0];
      if (!target) {
        console.log(explainApp(a));
        return 0;
      }
      const [m, f] = target.split(".");
      const plan = a.plans.find((p) => p.flow.module === m && p.flow.name === f);
      if (!plan) {
        console.error(`No flow ${target}. Flows: ${a.plans.map((p) => `${p.flow.module}.${p.flow.name}`).join(", ")}`);
        return 1;
      }
      console.log(explainFlow(a, plan));
      return 0;
    }
    case "who-uses": {
      const a = load(takeDir());
      if (!a) return 1;
      if (!args[0]) {
        console.error("Say which step, e.g. meld who-uses inventory.reserve");
        return 1;
      }
      console.log(whoUses(a, args[0]));
      return 0;
    }
    case "run":
    case "studio": {
      const dir = resolve(takeDir());
      const a = load(dir);
      if (!a) return 1;
      mkdirSync(join(dir, ".meld"), { recursive: true });
      const engine = new Engine(a, { storage: new Storage(flags.get("db") ?? join(dir, ".meld", "data.sqlite")) });
      await engine.load();
      const server = createServer(engine, Number(flags.get("port") ?? 3000), { studio: cmd === "studio" });
      console.log(`${a.model.app?.title ?? a.model.app?.name} is running on ${server.url}`);
      for (const p of a.plans) console.log(`  ${p.flow.trigger.method.padEnd(6)} ${p.flow.trigger.path.padEnd(24)} ${p.flow.module}.${p.flow.name}`);
      console.log(`  traces: ${server.url}_meld/traces`);
      if (cmd === "studio") console.log(`\nMeld Studio: ${server.url}_meld/studio`);
      return -1; // keep running
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);
