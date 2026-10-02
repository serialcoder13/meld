---
name: meld
description: Read, change and check apps written in Meld (.meld files) - modules, steps, flows, tables and their plain-language /// explanations. Use whenever a task touches .meld files, a Meld app's endpoints or business logic, or the Meld CLI (meld check / explain / who-uses / studio).
---

# Working on a Meld app

Meld is a language where the model of the app *is* the app: every endpoint (flow), unit of work (step), table and the calls between modules are declared in `.meld` files, and the Meld runtime runs exactly that. The full language reference is in `references/meld-language.md`; read it before writing Meld for the first time in a session.

People who don't read code work on the same app in Meld Studio. They see and change only the `///` explanations and titles; an AI turns their changes into code. So the explanations are part of the product, not comments.

## How to work

1. **Understand before changing.** Run these instead of reading every file:
   - `meld explain <app>`: the modules, their steps and endpoints, and who depends on whom.
   - `meld explain <app> <module.flow>`: one endpoint step by step, and what follows each outcome.
   - `meld who-uses <app> <module.step>`: every endpoint that uses a step and what depends on each of its outcomes. Check this before changing a step's inputs or outcomes.
2. **Change the model.** Edit the `.meld` files. Keep to the language reference: JavaScript-like step bodies, braces on every `if`, `==` not `===`, `null` not `undefined`, outcomes returned by name (`return found(row: row)`), named arguments when calling steps.
3. **Keep the explanation true.** Whenever you change what a step, flow, helper, table or module does, rewrite its `///` lines so a non-programmer reading only them knows what it does now: plain words, one sentence per line, 2 to 6 lines, no code or identifiers. Add `///` lines to anything new.
4. **Check the whole app.** Run `meld check <app>` after every change and fix every problem it reports. It catches outcomes that lead nowhere, two responses that could both happen, calls to another module's step without `uses`, type mismatches and undeclared ports. Don't stop until it says `ok`.
5. **Run it.** If the app has tests (`bun test`) or an API suite (for example `run-spec.sh`), run them. `meld run <app>` serves it; `meld studio <app>` adds the visual view.

## Rules that keep a Meld app healthy

- All behavior lives in the model. Don't add servers, routes or modules outside `.meld` files.
- A module touches only its own tables (`db`). To use another module's data, call one of its steps from a flow, and add `uses module.step`.
- A step reaches the world only through the ports in its `uses` (`db`, `crypto`, `clock`, `ids`, `log`, `store`). Prefer Meld step bodies; use a `js "./file.ts"` body only when Meld can't express it, and never import packages or use `fetch`, `process` or `Bun` there.
- Every outcome must lead somewhere in every flow that uses the step. When you add an outcome, update each flow `meld who-uses` lists.
- Give each new `respond` line a condition (an outcome it uses, or `when step.outcome`) so that two responses can never both happen.
- Don't rename steps, flows or outcomes casually: other modules and the studio refer to them by name. Titles (`"Sign up"`) are free to change.

## Commands

| Command | What it does |
|---|---|
| `meld check <app>` | Check the whole app (add `--json` for machine-readable problems) |
| `meld explain <app> [module.flow]` | The app, or one endpoint, in words |
| `meld who-uses <app> <module.step>` | Where a step is used and what depends on it |
| `meld run <app> [--port N]` | Serve the app |
| `meld studio <app> [--port N]` | Serve it with Meld Studio at `/_meld/studio` |
