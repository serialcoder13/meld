# The Meld language (reference for people and AI agents)

Meld describes a whole backend as a model that runs. Every route, every call between modules, every piece of data a step touches and every outcome is declared in `.meld` files; the Meld runtime executes exactly that. Code that isn't wired into the model can't run.

## Files and layout

- An app is a folder of `.meld` files. One file declares the app: `app conduit "Conduit"`.
- Each module usually lives in its own folder: `users/users.meld`. A JavaScript step body (`js "./file.ts"`) must live in its module's folder.
- `///` lines right above a declaration are its **explanation**: plain language for people who don't read code. Keep them accurate. When you change what something does, update its `///` lines too.
- `//` is an ordinary comment.

## Records (shapes of data on the wire)

```meld
/// A person signing up.
record NewUser {
  username: text
  email: text
  password: text
  bio?: text | null      // `?` = may be left out; `| null` = may be null
}
```

Types: `text`, `number`, `money`, `bool`, `list<T>`, `map<T>` (object with any text keys), a record name (PascalCase), `row<table>` (a row of one of the module's tables, with an automatic `id: number`), and `T | null`.
Field and variable names may be camelCase (to match JSON). Module, table, step, flow, outcome and helper names are lower_snake_case.

## Modules

```meld
/// Everything about articles: writing, listing, favorites and tags.
module articles "Articles" {
  uses users.require_user, users.profiles   // the only other modules' steps it may call

  table article { ... }
  fn slugify (title: text) -> text { ... }
  step create "Write an article" (...) -> ... { ... }
  flow create_article "Write an article" on POST "/api/articles" (...) { ... }
}
```

A module owns its tables. Nothing outside the module can read or change them.

## Tables

```meld
table account {
  username: text unique
  email: text unique
  bio: text | null
  tagList: list<text>
}
```

Every row also gets `id: number` automatically. Columns can be `unique`.

## Steps (the units of work)

```meld
/// Looks up the article by its slug.
/// Says "missing" when there is no such article.
step find "Find an article" (slug: text)
  -> found(row: row<article>)
   | missing(errors: map<list<text>>)
  uses db
{
  let row = db.article.find({ slug: slug })
  if (row == null) {
    return missing(errors: { article: ["not found"] })
  }
  return found(row: row)
}
```

- A step has typed inputs and one or more named **outcomes**; it must end by returning exactly one outcome: `return found(row: row)` (outcome fields are given by name).
- `uses` lists the **ports** the step may touch. Nothing else is reachable:
  - `db`: the module's tables. `db.<table>.insert(row)`, `.get(id)`, `.find(where)`, `.exists(where)`, `.count(where)`, `.list(where, { order: "createdAt desc, id desc", limit: 20, offset: 0 })`, `.update(where, changes)`, `.delete(where)`. A `where` is an object: `{ slug: s }` (equals), `{ id: { in: [1, 2] } }`, `{ tagList: { has: "x" } }`, `{ id: { not: 3 } }`, `{ bio: null }`. Inserting a duplicate of a `unique` column fails, so check with `exists` first.
  - `crypto`: `hashPassword(pw)`, `checkPassword(pw, hash)`, `sign(object)` → token, `verify(token)` → object or null.
  - `clock`: `now()` (ISO text), `today()`. `ids`: `next("ord")` → "ord_1", `number("article")` → 1. `log`: `info(text)`, `warn(text)`. `store`: small key-value storage for the module.
- A step body can instead be JavaScript/TypeScript: `js "./charge.ts"` (default export `async (input, ports) => ({ outcomeName: { ...fields } })`). It may not import packages or use `fetch`, `process`, `Bun`.

## The step language (JavaScript-like, stricter)

- `let x = ...` (or `const`), `x = ...`, `x += ...`, `if (...) { } else if (...) { } else { }` (braces required), `for (let item of list) { }`, `while (...) { }`, `break`, `continue`, `return outcome(...)`.
- Values: numbers, `"text"`, `true`/`false`, `null`, lists `[1, 2]`, objects `{ a: 1, b }`, lambdas `x => x * 2` (one expression; return an object with `x => ({ ... })`).
- Operators: `+ - * / %`, `== !=` (deep equality, never converts types), `< <= > >=`, `&& || !`, `cond ? a : b`. Conditions must be true/false. No `===`, `??`, `undefined`, template strings, `try/throw`, `var`.
- `+` joins text only with text: `"#" + text(n)`.
- Builtins: `text(v)`, `number(t)`, `round(n, digits)`, `floor`, `ceil`, `abs`, `min`, `max`, `sum(list)`, `keys(obj)`, `values(obj)`, `has(obj, "field")`, `unique(list)`, `range(n)`.
- Lists: `.length .push(x) .includes(x) .indexOf(x) .join(sep) .slice(a, b) .concat(list) .reverse() .map(f) .filter(f) .some(f) .every(f)`.
- Text: `.length .toUpperCase() .toLowerCase() .trim() .split(sep) .includes(t) .startsWith(t) .endsWith(t) .slice(a, b) .replaceAll(a, b)`.
- An optional input that wasn't given is `null`. An optional record field that was left out is absent: check it with `has(record, "field")`.

## Helpers

```meld
fn page_size (limit: number | null) -> number {
  return limit == null ? 20 : limit
}
```

Pure functions shared by the module's steps and flows. They can't use ports. Arguments are given in order.

## Flows (endpoints)

```meld
/// Writes a new article for the signed-in user.
flow create_article "Write an article" on POST "/api/articles" (article: NewArticle, auth?: text from header "Authorization") {
  me = users.require_user(header: auth)
  c = create(article: article, authorId: me.user.id)
  people = users.profiles(ids: [me.user.id], viewer: me.user.id)
  out = present(rows: [c.created.row], viewer: me.user.id, profiles: people.found.profiles, withBody: true)
  respond 201 { article: out.ready.articles[0] }
  respond 422 { errors: c.invalid.errors }
  respond 401 { errors: me.missing.errors }
  respond 401 { errors: me.invalid.errors }
}
```

- A flow body is **dataflow**, not a sequence: each line runs as soon as the outcomes it uses have happened; lines that are ready run in parallel; a line that waits for an outcome that didn't happen is skipped. Order in the file doesn't matter.
- `name = step(arg: value, ...)` calls a step (`module.step` for another module's step, which needs `uses`). Using `c.created.row` makes the line wait for step `c` to end with `created`.
- `respond <status> <body>` answers the request. `when x.outcome` in front of a line makes it wait for that outcome even if it doesn't use its data: `when d.removed respond 204`.
- Inputs: path parameters (`:slug`), query parameters (GET/DELETE), JSON body fields (other methods), and headers (`auth?: text from header "Authorization"`).

## Rules the checker enforces (run `meld check`)

- Every outcome of every step must lead somewhere in each flow that calls the step.
- Two `respond` lines must never both be able to happen (some step must end differently on the way to each).
- A module calls another module's step only if it declares `uses module.step`.
- Inputs, outcomes and arguments must match their declared types; a step must always return an outcome.
- A step touches only the ports in its `uses`; `db.x` must be one of the module's own tables.

## Commands

- `meld check <app>`: check the whole model; fix every problem it reports.
- `meld explain <app> [module.flow]`: the whole app, or one flow step by step.
- `meld who-uses <app> module.step`: every place a step is used and what depends on each outcome.
- `meld run <app>` / `meld studio <app>`: run it (studio adds the visual view at `/_meld/studio`).
