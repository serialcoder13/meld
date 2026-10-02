import type { Database } from "bun:sqlite";
import { MeldRuntimeError } from "./interp";
import { typeToString, type Field, type TableDef } from "./ir";
import { isPlainObject, normalize, show, validate, type Records } from "./values";

// A module-owned table, stored in SQLite as one JSON document per row plus an
// automatic integer id. Only the owning module's steps get a handle to it.

type Row = Record<string, unknown> & { id: number };

export class TableStore {
  private readonly sql: string;
  private readonly fields: Map<string, Field>;

  constructor(private readonly db: Database, readonly def: TableDef, private readonly records: Records) {
    this.sql = `t_${def.module}__${def.name}`;
    this.fields = new Map(def.fields.map((f) => [f.name, f]));
    db.run(`CREATE TABLE IF NOT EXISTS ${this.sql} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)`);
    for (const f of def.fields) {
      if (f.unique) db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${this.sql}__${f.name} ON ${this.sql} (json_extract(data, '$.${f.name}'))`);
    }
  }

  private get label() {
    return `${this.def.module}.${this.def.name}`;
  }

  // ---- reads ----

  get(id: unknown): Row | null {
    if (typeof id !== "number") throw new MeldRuntimeError(undefined, `${this.label}.get needs a number id, got ${show(id)}.`);
    const r = this.db.query(`SELECT id, data FROM ${this.sql} WHERE id = ?`).get(id) as { id: number; data: string } | null;
    return r ? decode(r) : null;
  }

  find(where: unknown): Row | null {
    return this.list(where, { limit: 1 })[0] ?? null;
  }

  exists(where: unknown): boolean {
    return this.find(where) !== null;
  }

  count(where: unknown): number {
    const w = this.where(where);
    const r = this.db.query(`SELECT COUNT(*) AS n FROM ${this.sql}${w.sql}`).get(...w.params) as { n: number };
    return r.n;
  }

  list(where: unknown, options?: unknown): Row[] {
    const w = this.where(where);
    const opts = options === undefined || options === null ? {} : options;
    if (!isPlainObject(opts)) throw new MeldRuntimeError(undefined, `${this.label}.list options should be an object like { order: "createdAt desc", limit: 20, offset: 0 }.`);
    for (const k of Object.keys(opts)) {
      if (!["order", "limit", "offset"].includes(k)) throw new MeldRuntimeError(undefined, `${this.label}.list has no option '${k}'. Options: order, limit, offset.`);
    }
    let sql = `SELECT id, data FROM ${this.sql}${w.sql}`;
    if (opts.order !== undefined) sql += ` ORDER BY ${this.order(opts.order)}`;
    else sql += " ORDER BY id";
    const params = [...w.params];
    if (opts.limit !== undefined || opts.offset !== undefined) {
      sql += " LIMIT ? OFFSET ?";
      params.push(this.count_(opts.limit, "limit", -1), this.count_(opts.offset, "offset", 0));
    }
    return (this.db.query(sql).all(...params) as { id: number; data: string }[]).map(decode);
  }

  // ---- writes ----

  insert(row: unknown): Row {
    if (!isPlainObject(row)) throw new MeldRuntimeError(undefined, `${this.label}.insert needs an object, got ${show(row)}.`);
    if ("id" in row) throw new MeldRuntimeError(undefined, `${this.label}.insert: id is assigned automatically; leave it out.`);
    const data: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const [k, v] of Object.entries(row)) {
      const f = this.fields.get(k);
      if (!f) problems.push(`${k} is not a column of ${this.label}`);
      else problems.push(...validate(v, f.type, this.records, k));
    }
    for (const f of this.def.fields) {
      if (row[f.name] === undefined) {
        if (f.type.kind === "nullable") data[f.name] = null;
        else if (!f.optional) problems.push(`${f.name} is missing (expected ${typeToString(f.type)})`);
      } else data[f.name] = normalize(row[f.name], f.type, this.records);
    }
    if (problems.length) throw new MeldRuntimeError(undefined, `Can't insert into ${this.label}: ${problems.join("; ")}.`);
    this.checkUnique(data, null);
    const r = this.db.query(`INSERT INTO ${this.sql} (data) VALUES (?) RETURNING id`).get(JSON.stringify(data)) as { id: number };
    return { id: r.id, ...data };
  }

  update(where: unknown, changes: unknown): number {
    if (!isPlainObject(changes)) throw new MeldRuntimeError(undefined, `${this.label}.update needs the changes as an object, got ${show(changes)}.`);
    const problems: string[] = [];
    for (const [k, v] of Object.entries(changes)) {
      const f = this.fields.get(k);
      if (k === "id") problems.push("id can't be changed");
      else if (!f) problems.push(`${k} is not a column of ${this.label}`);
      else problems.push(...validate(v, f.type, this.records, k));
    }
    if (problems.length) throw new MeldRuntimeError(undefined, `Can't update ${this.label}: ${problems.join("; ")}.`);
    const rows = this.list(where);
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const { id, ...data } = row;
        for (const [k, v] of Object.entries(changes)) data[k] = normalize(v, this.fields.get(k)!.type, this.records);
        this.checkUnique(data, id);
        this.db.query(`UPDATE ${this.sql} SET data = ? WHERE id = ?`).run(JSON.stringify(data), id);
      }
    });
    tx();
    return rows.length;
  }

  delete(where: unknown): number {
    const w = this.where(where);
    return this.db.query(`DELETE FROM ${this.sql}${w.sql}`).run(...w.params).changes;
  }

  // ---- helpers ----

  private checkUnique(data: Record<string, unknown>, id: number | null) {
    for (const f of this.def.fields) {
      if (!f.unique || data[f.name] === null || data[f.name] === undefined) continue;
      const clash = this.db
        .query(`SELECT id FROM ${this.sql} WHERE json_extract(data, '$.${f.name}') = ? AND id IS NOT ?`)
        .get(data[f.name] as string | number, id) as { id: number } | null;
      if (clash) throw new MeldRuntimeError(undefined, `Another ${this.def.name} already has this ${f.name}. Check with ${this.def.name}.exists({ ${f.name}: ... }) first.`);
    }
  }

  private column(name: string, what: string): string {
    if (name === "id") return "id";
    if (!this.fields.has(name)) {
      throw new MeldRuntimeError(undefined, `${this.label} has no column '${name}' to ${what}. Columns: id, ${[...this.fields.keys()].join(", ")}.`);
    }
    return `json_extract(data, '$.${name}')`;
  }

  private where(where: unknown): { sql: string; params: (string | number)[] } {
    if (where === undefined || where === null) return { sql: "", params: [] };
    if (!isPlainObject(where)) throw new MeldRuntimeError(undefined, `A filter should be an object like { slug: "..." }, got ${show(where)}.`);
    const parts: string[] = [];
    const params: (string | number)[] = [];
    for (const [k, cond] of Object.entries(where)) {
      const col = this.column(k, "filter on");
      if (cond === null) parts.push(`${col} IS NULL`);
      else if (isPlainObject(cond)) {
        const ops = Object.entries(cond);
        if (ops.length !== 1) throw new MeldRuntimeError(undefined, `Filter on ${k} should have one operator: { in: [...] }, { has: value } or { not: value }.`);
        const [op, v] = ops[0]!;
        if (op === "in") {
          if (!Array.isArray(v)) throw new MeldRuntimeError(undefined, `{ in: ... } on ${k} needs a list.`);
          if (!v.length) parts.push("0");
          else {
            parts.push(`${col} IN (${v.map(() => "?").join(", ")})`);
            params.push(...v.map(sqlValue));
          }
        } else if (op === "has") {
          if (k === "id") throw new MeldRuntimeError(undefined, "{ has: ... } works on list columns, not id.");
          parts.push(`EXISTS (SELECT 1 FROM json_each(data, '$.${k}') WHERE value = ?)`);
          params.push(sqlValue(v));
        } else if (op === "not") {
          parts.push(v === null ? `${col} IS NOT NULL` : `${col} IS NOT ?`);
          if (v !== null) params.push(sqlValue(v));
        } else throw new MeldRuntimeError(undefined, `Unknown filter operator '${op}' on ${k}. Use in, has or not.`);
      } else {
        parts.push(`${col} = ?`);
        params.push(sqlValue(cond));
      }
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
  }

  private order(order: unknown): string {
    if (typeof order !== "string") throw new MeldRuntimeError(undefined, `order should be text like "createdAt desc", got ${show(order)}.`);
    return order
      .split(",")
      .map((part) => {
        const [name, dir = "asc", ...rest] = part.trim().split(/\s+/);
        if (!name || rest.length || !["asc", "desc"].includes(dir.toLowerCase())) {
          throw new MeldRuntimeError(undefined, `Can't read the order "${order}". Use e.g. "createdAt desc, id desc".`);
        }
        return `${this.column(name, "order by")} ${dir.toUpperCase()}`;
      })
      .join(", ");
  }

  private count_(v: unknown, what: string, fallback: number): number {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new MeldRuntimeError(undefined, `${what} should be a whole number of 0 or more, got ${show(v)}.`);
    return v;
  }
}

function decode(r: { id: number; data: string }): Row {
  return { id: r.id, ...(JSON.parse(r.data) as Record<string, unknown>) };
}

function sqlValue(v: unknown): string | number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number") return v;
  throw new MeldRuntimeError(undefined, `Can't filter by ${show(v)}; use text, a number or true/false.`);
}
