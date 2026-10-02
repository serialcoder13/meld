# meld
Meld Programming Language for Humans and LLMs to build

Meld is the core of the app, not a diagram of it. The model *is* what runs: every route, every call between modules, every piece of data a step touches, and every outcome is declared in `.meld` files, and the Meld runtime executes exactly that. Delete the model and nothing runs.

This is v0: one Bun server.

## Examples

- [`examples/shop`](examples/shop): a tiny shop (inventory, billing, orders), with one step written in JavaScript.
- [`examples/conduit`](examples/conduit): the [RealWorld](https://github.com/realworld-apps/realworld) "Medium clone" backend (users, profiles, articles, favorites, tags, feed, comments) in 3 modules, 25 steps and 19 flows. It **passes the official RealWorld API suite: 154 of 154 requests** (`examples/conduit/run-spec.sh`; needs [hurl](https://hurl.dev)).

## The idea in one example

```meld
module orders "Orders" {
  uses inventory.reserve, inventory.release, billing.charge

  flow place_order "Place an order" on POST "/orders" (customer: text, items: list<Item>) {
    reserve = inventory.reserve(items: items)
    charge = billing.charge(customer: customer, amount: reserve.reserved.total)
    save = save_order(customer: customer, items: items, total: reserve.reserved.total, payment_id: charge.paid.payment_id)
    when charge.declined release = inventory.release(items: items)

    respond 201 { order_id: save.saved.order_id, total: reserve.reserved.total }
    respond 409 { error: "out_of_stock", missing: reserve.out_of_stock.missing }
    when release.released respond 402 { error: "payment_declined", reason: charge.declined.reason }
  }
}
```

- **Flows are dataflow** (KIRun's idea, one level up). A line runs as soon as the outcomes it waits for have happened. Lines that are ready run in parallel. A line waiting for an outcome that didn't happen is skipped. Order in the file doesn't matter.
- **Steps have contracts:** typed inputs and named outcomes, e.g. `-> reserved(total: money) | out_of_stock(missing: list<text>)`.
- **Step bodies are written in Meld,** a small JavaScript-like language run by Meld's own interpreter. The interpreter enforces a work budget and never converts types silently. Alternatively, a step body can be JavaScript/TypeScript on Bun's engine (`js "./charge.ts"`). Both kinds get only their inputs and the ports they declare (`uses store, ids, clock, log`).
- **Modules own their data.** A module declares `table`s, and only its own steps can reach them through the `db` port (`db.article.list({ tagList: { has: tag } }, { order: "createdAt desc", limit: 20 })`). A module can use another module's step only if it declares it (`uses billing.charge`).
- **Requests are explicit inputs,** including headers (`auth?: text from header "Authorization"`). Checking who is calling is an ordinary step whose outcomes the flow handles, so the 401s are visible in the model.
- **Null and "left out" are different.** `bio?: text | null` may be left out or null; `tagList?: list<text>` may be left out but not null. Inside a flow or step, an optional input that wasn't given is `null`.
- **Pure helpers** (`fn slugify (title: text) -> text { ... }`) are shared by a module's steps and flows; they can't touch ports. Rows have types too: `row<article>`.
- **Ports:** `db`, `store`, `crypto` (password hashing, signed tokens), `ids`, `clock`, `log`. A step gets only the ones it declares.

## Meld Studio

`bun src/cli.ts studio examples/conduit` runs the app and opens a visual view of it at `/_meld/studio` (design hints from kirun-ui). People see explanations, never code:

- **App map:** every module with its endpoints, and arrows for which module uses which.
- **Tree (left):** modules → endpoints → the steps, tables and responses inside each endpoint. Search filters the tree and highlights matches.
- **Module page:** what a module owns (endpoints, steps, tables, helpers), what it depends on and who depends on it.
- **Flow canvas:** the endpoint, each step as a card (inputs on the left, outcomes as connectors on the right) and every possible response.
- **Piece view:** one step with everything around it: every endpoint that uses it, what each of its outcomes leads to there, and the tables it touches.
- **Detail panel:** a step's explanation, contract, what it touches, every place it's used, and its title, all editable.
- **Try it:** send a real request and watch the path it took light up.

### Changing the app

Explanations are `///` lines above each declaration in the `.meld` files. In the studio, a person can:

- **Change an explanation and press "Make it do this".** The AI agent rewrites the step or endpoint to match, Meld checks the whole app (the AI retries up to three times with the problems Meld found), and the person sees a plain-language summary to **Apply** or **Discard**. Applied changes are written to the `.meld` files and the running app reloads without a restart.
- **Ask for a change** in plain words, with the same check-and-approve loop.
- **Write missing explanations** with the AI, or fix only the wording.
- **Rename** titles.

Set up the agent under **Set up AI** (provider, model and key): Anthropic (default `claude-opus-5-5`), OpenAI, or any OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, ...). The key is stored in `~/.config/meld/agent.json` (readable only by you), never in the project; `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` work too. With Anthropic, a declined request is retried on a fallback model (server-side fallback; can be turned off). The studio only listens on 127.0.0.1 and refuses changes that don't come from its own page.

The language reference the agent follows is [docs/meld-language.md](docs/meld-language.md).

Run the studio from the repo root so Bun picks up the Tailwind plugin in `bunfig.toml`.

## VS Code and Claude Code

- [`editors/vscode`](editors/vscode): a VS Code extension with highlighting, live `meld check` problems on save (including changes made by the studio or an agent), **Who Uses This Step**, and **Meld Studio in an editor tab** opened at the step under the cursor.
- **Claude Code:** `meld skill install <project>` adds a Meld skill in `.claude/skills/meld/` (how to work on a Meld app, plus the same language reference the studio's agent uses). This repo has it installed. With it, Claude Code edits `.meld` files the Meld way: understand with `meld explain` / `who-uses`, keep `///` explanations true, and run `meld check` until it's clean.

## What the checker guarantees

`meld check` rejects a model when:
- a module calls a step it didn't declare with `uses`
- a step outcome leads nowhere ("When c ends with 'small', nothing happens")
- an argument or outcome field doesn't match the contract
- a step touches a port it didn't declare
- a step can end without returning an outcome
- two `respond` lines could both happen (some step has to end differently on the way to each)
- a step uses `db.x` for a table its module doesn't have
- JavaScript steps import packages, use `fetch`/`process`/`Bun`, or reach into another module's folder. This is a lint, not a sandbox.

## Commands

```sh
bun src/cli.ts check    examples/shop
bun src/cli.ts explain  examples/shop                     # the whole app, and who depends on whom
bun src/cli.ts explain  examples/shop orders.place_order  # one flow, step by step
bun src/cli.ts who-uses examples/shop inventory.reserve   # where a piece is used and what depends on it
bun src/cli.ts run      examples/shop --port 3000         # serve every flow; traces at /_meld/traces
bun src/cli.ts who-uses examples/conduit articles.find    # used by 4 flows in 2 modules
examples/conduit/run-spec.sh                              # the RealWorld API suite against Conduit
bun test
```

## Not yet

- Module boundaries in deployment (splitting a module into its own service)
- Integrations for npm packages
- Real sandboxing of JS steps
- Stable IDs for semantic diffs
- Changes that span several declarations at once (the agent edits one step, endpoint or helper at a time)
- Type checking inside step bodies (types are checked at every boundary, but a mistake inside a body shows up only when it runs)
- Decimal money
