// Helpers for the Meld VS Code extension that don't need VS Code itself,
// so they can be tested on their own.

const fs = require("fs");
const path = require("path");

/** "bun /x/meld/src/cli.ts" -> ["bun", "/x/meld/src/cli.ts"] (double quotes group words). */
function splitCommand(command) {
  const parts = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command))) parts.push(m[1] ?? m[2]);
  return parts;
}

/** When the command runs Meld from a checkout (…/src/cli.ts), run it from the checkout so Bun finds its config. */
function cliCwd(parts) {
  const script = parts.find((p) => /[\\/]src[\\/]cli\.ts$/.test(p));
  return script ? path.dirname(path.dirname(script)) : undefined;
}

/** The folder of the Meld app a file belongs to: the nearest folder (up to `stopDir`) holding the `app` declaration. */
function findAppRoot(file, stopDir) {
  let dir = path.dirname(file);
  const stop = path.resolve(stopDir);
  while (true) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name.endsWith(".meld")) continue;
      try {
        if (/^\s*app\s+[a-z]/m.test(fs.readFileSync(path.join(dir, name), "utf8"))) return dir;
      } catch {
        // unreadable: skip
      }
    }
    const parent = path.dirname(dir);
    if (path.resolve(dir) === stop || parent === dir) return stop;
    dir = parent;
  }
}

/** The output of `meld check --json`, or [] when it isn't JSON (e.g. the command failed). */
function parseCheck(stdout) {
  try {
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list.filter((d) => d && typeof d.file === "string" && typeof d.message === "string") : [];
  } catch {
    return [];
  }
}

/** Which module, and which step/flow/fn/table, the cursor is inside. */
function declarationAt(text, offset) {
  const before = text.slice(0, offset);
  const moduleMatch = [...before.matchAll(/^\s*module\s+([a-z][a-z0-9_]*)/gm)].pop();
  if (!moduleMatch) return undefined;
  const decl = [...before.matchAll(/^\s*(step|flow|fn|table)\s+([a-z][a-z0-9_]*)/gm)].filter((m) => m.index > moduleMatch.index).pop();
  return decl ? { module: moduleMatch[1], kind: decl[1], name: decl[2] } : { module: moduleMatch[1], kind: "module", name: moduleMatch[1] };
}

/** Where Meld Studio should open for a declaration. */
function studioHash(decl) {
  if (!decl) return "/";
  if (decl.kind === "step") return `/p/${decl.module}.${decl.name}`;
  if (decl.kind === "flow") return `/f/${decl.module}.${decl.name}`;
  return `/m/${decl.module}`;
}

module.exports = { splitCommand, cliCwd, findAppRoot, parseCheck, declarationAt, studioHash };
