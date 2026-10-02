import { typeToString, type Field, type RecordDef, type TypeRef } from "./ir";

// Values that cross a boundary (HTTP input, step input/outcome, tables, JS
// steps) are plain JSON-like data and are checked against the declared types.

export type Records = Map<string, RecordDef>;

export function validateFields(value: unknown, fields: Field[], records: Records, path: string): string[] {
  if (!isPlainObject(value)) return [`${path || "input"} should be an object with fields ${fields.map((f) => f.name).join(", ")}`];
  const problems: string[] = [];
  const known = new Set(fields.map((f) => f.name));
  for (const f of fields) {
    const p = path ? `${path}.${f.name}` : f.name;
    if (!(f.name in value) || value[f.name] === undefined) {
      if (!f.optional) problems.push(`${p} is missing (expected ${typeToString(f.type)})`);
      continue;
    }
    problems.push(...validate(value[f.name], f.type, records, p));
  }
  for (const k of Object.keys(value)) {
    if (!known.has(k)) problems.push(`${path ? `${path}.${k}` : k} is not an expected field`);
  }
  return problems;
}

export function validate(value: unknown, type: TypeRef, records: Records, path: string): string[] {
  if (type.kind === "nullable") return value === null ? [] : validate(value, type.of, records, path);
  if (value === null) return [`${path} can't be null (expected ${typeToString(type)})`];
  switch (type.kind) {
    case "text":
      return typeof value === "string" ? [] : [`${path} should be text, got ${show(value)}`];
    case "bool":
      return typeof value === "boolean" ? [] : [`${path} should be true or false, got ${show(value)}`];
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${path} should be a number, got ${show(value)}`];
    case "money":
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} should be an amount of money, got ${show(value)}`];
      return isCents(value) ? [] : [`${path} should have at most 2 decimals, got ${value}`];
    case "list":
      if (!Array.isArray(value)) return [`${path} should be a list, got ${show(value)}`];
      return value.flatMap((item, i) => validate(item, type.of, records, `${path}[${i}]`));
    case "map":
      if (!isPlainObject(value)) return [`${path} should be an object, got ${show(value)}`];
      return Object.entries(value).flatMap(([k, v]) => validate(v, type.of, records, `${path}.${k}`));
    case "record": {
      const rec = records.get(type.name);
      if (!rec) return [`${path}: unknown record ${type.name}`];
      return validateFields(value, rec.fields, records, path);
    }
  }
}

// Money arithmetic in v0 uses numbers; round away float noise at boundaries.
export function normalize(value: unknown, type: TypeRef, records: Records): unknown {
  if (value === null || value === undefined) return value;
  switch (type.kind) {
    case "nullable":
      return normalize(value, type.of, records);
    case "money":
      if (typeof value === "number") {
        const r = Math.round(value * 100) / 100;
        return Math.abs(r - value) < 1e-9 ? r : value;
      }
      return value;
    case "list":
      return Array.isArray(value) ? value.map((v) => normalize(v, type.of, records)) : value;
    case "map":
      return isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, type.of, records)])) : value;
    case "record": {
      const rec = records.get(type.name);
      return rec && isPlainObject(value) ? normalizeFields(value, rec.fields, records) : value;
    }
    default:
      return value;
  }
}

export function normalizeFields(value: Record<string, unknown>, fields: Field[], records: Records): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const f of fields) if (out[f.name] !== undefined) out[f.name] = normalize(out[f.name], f.type, records);
  return out;
}

function isCents(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function show(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string") return `text "${v}"`;
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "an object";
  return `${typeof v} ${String(v)}`;
}

// Can a value of type `actual` be used where `expected` is wanted?
export function assignable(actual: TypeRef, expected: TypeRef): boolean {
  if (expected.kind === "nullable") return actual.kind === "nullable" ? assignable(actual.of, expected.of) : assignable(actual, expected.of);
  if (actual.kind === "nullable") return false;
  if (actual.kind !== expected.kind) return actual.kind === "number" && expected.kind === "money";
  if ((actual.kind === "list" || actual.kind === "map") && actual.kind === expected.kind) return assignable(actual.of, expected.of);
  if (actual.kind === "record" && expected.kind === "record") return actual.name === expected.name;
  return true;
}
