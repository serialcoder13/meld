import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyze } from "../src/check";
import { Engine } from "../src/engine";
import { formatDiagnostic } from "../src/ir";
import { loadModel } from "../src/load";
import { Storage } from "../src/ports";
import { TableStore } from "../src/tables";

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "meld-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  const { model, diagnostics } = loadModel(root);
  const analysis = analyze(model);
  const problems = (diagnostics.length ? diagnostics : analysis.diagnostics).map((d) => formatDiagnostic(d, root));
  return { analysis, problems };
}

async function engineFor(dir: string) {
  const { model, diagnostics } = loadModel(dir);
  const analysis = analyze(model);
  expect([...diagnostics, ...analysis.diagnostics]).toEqual([]);
  const engine = new Engine(analysis, { storage: new Storage(":memory:") });
  await engine.load();
  const run = (module: string, flow: string, input: Record<string, unknown>) => engine.run(engine.plan(module, flow)!, input);
  return { engine, run };
}

const APP = 'app t "Test"\n';

describe("syntax", () => {
  test("points at JavaScript habits with a fix", () => {
    const { problems } = app({
      "a.meld": `${APP}module m { step s (x: number) -> ok { if (x === 1) { return ok() } return ok() } }`,
    });
    expect(problems.join("\n")).toContain("a.meld:2:45: Use == instead of ===");
  });

  test("rejects unknown types with the Meld name", () => {
    const { problems } = app({ "a.meld": `${APP}record R { name: string }` });
    expect(problems.join("\n")).toContain("Use 'text' instead of 'string'");
  });
});

describe("the model is the only way things connect", () => {
  test("a module can't call another module's step unless it declares it", () => {
    const { problems } = app({
      "a.meld": `${APP}
module billing { step charge (amount: money) -> paid { return paid() } }
module orders {
  flow buy on POST "/buy" (amount: money) {
    c = billing.charge(amount: amount)
    respond 200 { ok: true }
  }
}`,
    });
    expect(problems.join("\n")).toContain("Module orders can't call billing.charge. Add 'uses billing.charge'");
  });

  test("every outcome must lead somewhere", () => {
    const { problems } = app({
      "a.meld": `${APP}
module m {
  step check (n: number) -> big | small { if (n > 10) { return big() } return small() }
  flow f on POST "/f" (n: number) {
    c = check(n: n)
    when c.big respond 200 { size: "big" }
  }
}`,
    });
    expect(problems.join("\n")).toContain("When c ends with 'small', nothing happens");
  });

  test("a step can only touch ports it declares", () => {
    const { problems } = app({
      "a.meld": `${APP}module m { step s (k: text) -> ok { store.set(k, 1)\n return ok() } }`,
    });
    expect(problems.join("\n")).toContain("uses 'store' but doesn't declare it. Add 'uses store'");
  });

  test("JavaScript steps can't reach around the model", () => {
    const { problems } = app({
      "app.meld": APP,
      "m/m.meld": 'module m { step s (url: text) -> ok js "./s.ts" }',
      "m/s.ts": 'import { readFileSync } from "node:fs";\nexport default async (i) => { await fetch(i.url); return { ok: {} } }',
    });
    const text = problems.join("\n");
    expect(text).toContain("imports 'node:fs' directly");
    expect(text).toContain("uses 'fetch' directly");
  });

  test("outcome fields and step inputs are checked against the contract", () => {
    const { problems } = app({
      "a.meld": `${APP}
module m {
  step s (n: number) -> done(total: money) { return done(sum: n) }
  flow f on POST "/f" (n: text) {
    r = s(n: n)
    respond 200 { total: r.done.total }
  }
}`,
    });
    const text = problems.join("\n");
    expect(text).toContain("Outcome done needs total (money)");
    expect(text).toContain("Outcome done has no field sum");
    expect(text).toContain("n should be number but this is text");
  });

  test("a step must always return an outcome", () => {
    const { problems } = app({
      "a.meld": `${APP}module m { step s (n: number) -> ok { if (n > 1) { return ok() } } }`,
    });
    expect(problems.join("\n")).toContain("can reach its end without returning an outcome");
  });
});

describe("running the shop example", () => {
  const dir = join(import.meta.dir, "..", "examples", "shop");

  test("places an order, then finds it", async () => {
    const { run } = await engineFor(dir);
    expect((await run("inventory", "restock", { sku: "mug", qty: 5, price: 12.5 })).status).toBe(200);
    const placed = await run("orders", "place_order", { customer: "ana@example.com", items: [{ sku: "mug", qty: 2 }] });
    expect(placed.status).toBe(201);
    expect(placed.body).toEqual({ order_id: "ord_1", total: 25 });
    const found = await run("orders", "get_order", { order_id: "ord_1" });
    expect(found.status).toBe(200);
    expect((found.body as { payment_id: string }).payment_id).toBe("pay_1");
  });

  test("a declined payment puts the stock back before responding", async () => {
    const { run } = await engineFor(dir);
    await run("inventory", "restock", { sku: "mug", qty: 1, price: 12.5 });
    const declined = await run("orders", "place_order", { customer: "blocked@example.com", items: [{ sku: "mug", qty: 1 }] });
    expect(declined.status).toBe(402);
    expect(declined.trace.nodes.map((n) => `${n.node}:${n.status}`)).toContain("release:done");
    // the one mug is available again
    const again = await run("orders", "place_order", { customer: "ana@example.com", items: [{ sku: "mug", qty: 1 }] });
    expect(again.status).toBe(201);
  });

  test("out of stock skips billing entirely", async () => {
    const { run } = await engineFor(dir);
    const r = await run("orders", "place_order", { customer: "ana@example.com", items: [{ sku: "tee", qty: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "out_of_stock", missing: ["tee"] });
    expect(r.trace.nodes.find((n) => n.node === "charge")?.status).toBe("skipped");
  });

  test("bad input is rejected against the contract", async () => {
    const { run } = await engineFor(dir);
    const r = await run("orders", "place_order", { customer: "x", items: [{ sku: "mug", qty: "two" }] });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ errors: { "items[0].qty": ['should be a number, got text "two"'] } });
  });
});

describe("tables", () => {
  const def = (fields: string) => {
    const { analysis } = app({ "a.meld": `${APP}module m { table thing { ${fields} } }` });
    const t = analysis.modules.get("m")!.tables[0]!;
    return new TableStore(new Storage(":memory:").db, t, analysis.records);
  };

  test("insert, unique columns, filters, order and paging", () => {
    const t = def("name: text unique\n tags: list<text>\n score: number\n note: text | null");
    t.insert({ name: "a", tags: ["x"], score: 1 });
    t.insert({ name: "b", tags: ["x", "y"], score: 3 });
    t.insert({ name: "c", tags: [], score: 2 });
    expect(() => t.insert({ name: "a", tags: [], score: 9 })).toThrow("Another thing already has this name");
    expect(t.find({ name: "b" })).toEqual({ id: 2, name: "b", tags: ["x", "y"], score: 3, note: null });
    expect(t.list({ tags: { has: "x" } }, { order: "score desc" }).map((r) => r.name)).toEqual(["b", "a"]);
    expect(t.list({ id: { in: [1, 3] } }).map((r) => r.name)).toEqual(["a", "c"]);
    expect(t.list({ name: { not: "a" } }, { order: "score asc", limit: 1, offset: 1 }).map((r) => r.name)).toEqual(["b"]);
    expect(t.count({ note: null })).toBe(3);
    expect(t.update({ name: "c" }, { note: "hi" })).toBe(1);
    expect(() => t.update({ name: "c" }, { name: "a" })).toThrow("already has this name");
    expect(() => t.insert({ name: "d", tags: "x", score: 1 })).toThrow("tags should be a list");
    expect(t.delete({ score: { in: [1, 2] } })).toBe(2);
  });
});

describe("null and left out are different", () => {
  const src = `${APP}
record Changes { bio?: text | null
  tags?: list<text> }
module m {
  step s (c: Changes) -> done(bio: text | null, hasBio: bool) { return done(bio: has(c, "bio") ? c.bio : "unchanged", hasBio: has(c, "bio")) }
  flow f on PUT "/f" (c: Changes, auth?: text from header "Authorization") {
    r = s(c: c)
    respond 200 { bio: r.done.bio, hasBio: r.done.hasBio, auth: auth }
  }
}`;

  test("a nullable field accepts null, a left-out field is not there, a non-nullable one rejects null", async () => {
    const root = mkdtempSync(join(tmpdir(), "meld-"));
    writeFileSync(join(root, "a.meld"), src);
    const { run } = await engineFor(root);
    expect((await run("m", "f", { c: { bio: null } })).body).toEqual({ bio: null, hasBio: true, auth: null });
    expect((await run("m", "f", { c: {}, auth: "Token x" })).body).toEqual({ bio: "unchanged", hasBio: false, auth: "Token x" });
    const bad = await run("m", "f", { c: { tags: null } });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ errors: { "c.tags": ["can't be null (expected list<text>)"] } });
  });
});

describe("conduit", () => {
  const dir = join(import.meta.dir, "..", "examples", "conduit");

  test("the model checks clean", () => {
    const { model, diagnostics } = loadModel(dir);
    expect([...diagnostics, ...analyze(model).diagnostics].map((d) => d.message)).toEqual([]);
  });

  test("the checker catches two responses that could both happen", () => {
    const { model } = loadModel(dir);
    const comments = model.modules.find((m) => m.name === "comments")!;
    const del = comments.flows.find((f) => f.name === "delete_comment")!;
    // remove the guard that makes "article not found" wait for a signed-in user
    del.nodes.find((n) => n.name === "a")!.when = [];
    const messages = analyze(model).diagnostics.map((d) => d.message).join("\n");
    expect(messages).toContain("respond 404");
    expect(messages).toContain("could both happen");
  });
});

describe("the interpreter", () => {
  test("stops a step that runs forever", async () => {
    const root = mkdtempSync(join(tmpdir(), "meld-"));
    writeFileSync(
      join(root, "a.meld"),
      `${APP}module m {
  step spin () -> done { let i = 0\n while (true) { i += 1 }\n return done() }
  flow f on POST "/f" () { s = spin()\n when s.done respond 200 { ok: true } }
}`,
    );
    const { run } = await engineFor(root);
    const r = await run("m", "f", {});
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).toContain("did too much work and was stopped");
  });

  test("runs independent steps in parallel and joins them", async () => {
    const root = mkdtempSync(join(tmpdir(), "meld-"));
    writeFileSync(
      join(root, "a.meld"),
      `${APP}module m {
  step double (n: number) -> done(v: number) { return done(v: n * 2) }
  step add (a: number, b: number) -> done(v: number) { return done(v: a + b) }
  flow f on POST "/f" (x: number, y: number) {
    a = double(n: x)
    b = double(n: y)
    c = add(a: a.done.v, b: b.done.v)
    respond 200 { result: c.done.v }
  }
}`,
    );
    const { run } = await engineFor(root);
    const r = await run("m", "f", { x: 2, y: 5 });
    expect(r.body).toEqual({ result: 14 });
    expect(r.trace.nodes.slice(0, 2).map((n) => n.node).sort()).toEqual(["a", "b"]);
  });

  test("never converts types silently", async () => {
    const root = mkdtempSync(join(tmpdir(), "meld-"));
    writeFileSync(
      join(root, "a.meld"),
      `${APP}module m {
  step s (n: number) -> done(t: text) { return done(t: "n = " + n) }
  flow f on POST "/f" (n: number) { r = s(n: n)\n respond 200 { t: r.done.t } }
}`,
    );
    const { run } = await engineFor(root);
    const r = await run("m", "f", { n: 3 });
    expect(JSON.stringify(r.body)).toContain("Convert with text(...) first");
  });
});
