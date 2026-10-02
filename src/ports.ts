import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Loc, PortName, StepDef } from "./ir";
import { Fn, MeldRuntimeError } from "./interp";
import type { TableStore } from "./tables";

// Ports are the only way a step touches the world. A step gets exactly the
// ports it declares with `uses`, and the store is scoped to the step's module,
// so a module can never read another module's data.

export class Storage {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS kv (module TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (module, key))");
  }
  get(module: string, key: string): unknown {
    const row = this.db.query("SELECT value FROM kv WHERE module = ? AND key = ?").get(module, key) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  set(module: string, key: string, value: unknown) {
    this.db.query("INSERT INTO kv (module, key, value) VALUES (?, ?, ?) ON CONFLICT (module, key) DO UPDATE SET value = excluded.value").run(module, key, JSON.stringify(value));
  }
  delete(module: string, key: string) {
    this.db.query("DELETE FROM kv WHERE module = ? AND key = ?").run(module, key);
  }
  keys(module: string, prefix: string): string[] {
    const rows = this.db.query("SELECT key FROM kv WHERE module = ? AND key >= ? AND key < ? ORDER BY key").all(module, prefix, prefix + "￿") as { key: string }[];
    return rows.map((r) => r.key);
  }
  // Secret for signing tokens: MELD_SECRET if set, otherwise generated once per database.
  secret(): string {
    const env = process.env.MELD_SECRET;
    if (env) return env;
    let v = this.get("__meld", "secret") as string | undefined;
    if (!v) {
      v = randomBytes(32).toString("hex");
      this.set("__meld", "secret", v);
    }
    return v;
  }
  close() {
    this.db.close();
  }
}

export interface PortEnv {
  storage: Storage;
  tables: Map<string, TableStore>; // the step's own module's tables
  log: (level: "info" | "warn", message: string) => void;
  now?: () => Date;
}

type PortFn = (...args: any[]) => unknown;
type PortImpl = { [k: string]: PortFn | PortImpl };

function portImpls(name: PortName, module: string, env: PortEnv): PortImpl {
  const s = env.storage;
  switch (name) {
    case "store":
      return {
        get(key: unknown, fallback?: unknown) {
          const k = textArg(key, "store.get");
          const v = s.get(module, k);
          if (v !== undefined) return v;
          if (fallback !== undefined) return fallback;
          throw new MeldRuntimeError(undefined, `The store has nothing saved under "${k}". Pass a default: store.get("${k}", ...), or check with store.has("${k}").`);
        },
        has: (key: unknown) => s.get(module, textArg(key, "store.has")) !== undefined,
        set(key: unknown, value: unknown) {
          if (value === undefined) throw new MeldRuntimeError(undefined, "store.set needs a value.");
          s.set(module, textArg(key, "store.set"), value);
          return true;
        },
        delete(key: unknown) {
          s.delete(module, textArg(key, "store.delete"));
          return true;
        },
        keys: (prefix?: unknown) => s.keys(module, prefix === undefined ? "" : textArg(prefix, "store.keys")),
      };
    case "db": {
      const out: PortImpl = {};
      for (const [tname, t] of env.tables) {
        out[tname] = {
          insert: (row: unknown) => t.insert(row),
          get: (id: unknown) => t.get(id),
          find: (where: unknown) => t.find(where),
          exists: (where: unknown) => t.exists(where),
          count: (where?: unknown) => t.count(where),
          list: (where?: unknown, options?: unknown) => t.list(where, options),
          update: (where: unknown, changes: unknown) => t.update(where, changes),
          delete: (where: unknown) => t.delete(where),
        };
      }
      return out;
    }
    case "clock": {
      const now = env.now ?? (() => new Date());
      return {
        now: () => now().toISOString(),
        today: () => now().toISOString().slice(0, 10),
      };
    }
    case "ids": {
      const counter = (p: string) =>
        s.db.transaction(() => {
          const key = `__ids.${p}`;
          const n = ((s.get(module, key) as number | undefined) ?? 0) + 1;
          s.set(module, key, n);
          return n;
        })();
      return {
        next: (prefix: unknown) => `${textArg(prefix, "ids.next")}_${counter(textArg(prefix, "ids.next"))}`,
        number: (name: unknown) => counter(textArg(name, "ids.number")),
      };
    }
    case "log":
      return {
        info: (m: unknown) => env.log("info", typeof m === "string" ? m : JSON.stringify(m)),
        warn: (m: unknown) => env.log("warn", typeof m === "string" ? m : JSON.stringify(m)),
      };
    case "crypto":
      return {
        hashPassword: (pw: unknown) => Bun.password.hash(textArg(pw, "crypto.hashPassword"), { algorithm: "bcrypt", cost: 8 }),
        checkPassword: async (pw: unknown, hash: unknown) => {
          if (typeof pw !== "string" || typeof hash !== "string") return false;
          return Bun.password.verify(pw, hash).catch(() => false);
        },
        sign: (payload: unknown) => sign(payload, s.secret()),
        verify: (token: unknown) => verify(token, s.secret()),
      };
  }
}

// Tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
function sign(payload: unknown, secret: string): string {
  if (typeof payload !== "object" || payload === null) throw new MeldRuntimeError(undefined, "crypto.sign needs an object to sign.");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

function verify(token: unknown, secret: string): unknown {
  if (typeof token !== "string") return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

function mac(body: string, secret: string): string {
  return new Bun.CryptoHasher("sha256", secret).update(body).digest("base64url");
}

function textArg(v: unknown, fn: string): string {
  if (typeof v !== "string") throw new MeldRuntimeError(undefined, `${fn} needs text, got ${v === null ? "null" : typeof v}.`);
  return v;
}

function toMeld(prefix: string, impl: PortImpl): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(impl)) {
    if (typeof f !== "function") {
      out[k] = toMeld(`${prefix}.${k}`, f);
      continue;
    }
    out[k] = new Fn(`${prefix}.${k}`, async (args: unknown[], loc: Loc) => {
      try {
        return await f(...args);
      } catch (e) {
        if (e instanceof MeldRuntimeError && !e.loc) throw new MeldRuntimeError(loc, e.message);
        throw e;
      }
    });
  }
  return out;
}

// Ports as Meld values (for steps written in Meld).
export function meldPorts(step: StepDef, env: PortEnv): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of step.ports) out[p.name] = toMeld(p.name, portImpls(p.name, step.module, env));
  return out;
}

function freeze(impl: PortImpl): PortImpl {
  for (const v of Object.values(impl)) if (typeof v !== "function") freeze(v);
  return Object.freeze(impl);
}

// Ports as plain JavaScript objects (for steps written in JS/TS).
export function jsPorts(step: StepDef, env: PortEnv): Record<string, PortImpl> {
  const out: Record<string, PortImpl> = {};
  for (const p of step.ports) out[p.name] = freeze(portImpls(p.name, step.module, env));
  return Object.freeze(out);
}
