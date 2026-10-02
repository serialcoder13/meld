const { describe, expect, test } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("../src/lib");

describe("meld vscode helpers", () => {
  test("splits the configured command", () => {
    expect(lib.splitCommand('bun "/My Code/meld/src/cli.ts"')).toEqual(["bun", "/My Code/meld/src/cli.ts"]);
    expect(lib.cliCwd(["bun", "/x/meld/src/cli.ts"])).toBe("/x/meld");
    expect(lib.cliCwd(["meld"])).toBeUndefined();
  });

  test("finds the app folder from any file in it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "meld-vsc-"));
    fs.mkdirSync(path.join(root, "app", "users"), { recursive: true });
    fs.writeFileSync(path.join(root, "app", "app.meld"), 'app shop "Shop"\n');
    fs.writeFileSync(path.join(root, "app", "users", "users.meld"), "module users {}\n");
    expect(lib.findAppRoot(path.join(root, "app", "users", "users.meld"), root)).toBe(path.join(root, "app"));
  });

  test("knows which declaration the cursor is in", () => {
    const text = 'module users {\n  step register (u: NewUser) -> ok {\n    return ok()\n  }\n  flow sign_up on POST "/x" () {\n  }\n}';
    expect(lib.declarationAt(text, text.indexOf("return"))).toEqual({ module: "users", kind: "step", name: "register" });
    expect(lib.studioHash(lib.declarationAt(text, text.indexOf("POST")))).toBe("/f/users.sign_up");
    expect(lib.declarationAt(text, text.indexOf("{") + 1)).toEqual({ module: "users", kind: "module", name: "users" });
  });

  test("reads meld check --json", () => {
    expect(lib.parseCheck('[{"file":"/a.meld","line":2,"col":3,"message":"m"}]')).toHaveLength(1);
    expect(lib.parseCheck("error: not json")).toEqual([]);
  });
});
