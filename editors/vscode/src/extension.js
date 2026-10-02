// Meld for VS Code: live checks on every save, "who uses this step", and
// Meld Studio in an editor tab. All the knowledge lives in the Meld command
// line; this extension only connects it to the editor.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

let studio; // { proc, root, port }

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection("meld");
  const output = vscode.window.createOutputChannel("Meld");
  context.subscriptions.push(diagnostics, output);

  const config = () => vscode.workspace.getConfiguration("meld");
  const command = () => lib.splitCommand(config().get("command") || "meld");

  function run(args, root) {
    const [exe, ...pre] = command();
    return new Promise((resolve) => {
      cp.execFile(exe, [...pre, ...args], { cwd: lib.cliCwd([exe, ...pre]) || root, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          vscode.window.showErrorMessage(`Meld: can't run "${exe}". Set "meld.command" in your settings (e.g. "bun /path/to/meld/src/cli.ts").`);
        }
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      });
    });
  }

  function rootFor(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return lib.findAppRoot(uri.fsPath, folder ? folder.uri.fsPath : path.dirname(uri.fsPath));
  }

  function activeRoot() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "meld") return rootFor(editor.document.uri);
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : undefined;
  }

  // ---- live checks ----

  const known = new Map(); // app root -> files that have problems
  async function check(root) {
    const result = await run(["check", "--json", root], root);
    const problems = lib.parseCheck(result.stdout);
    for (const file of known.get(root) || []) diagnostics.delete(vscode.Uri.file(file));
    const byFile = new Map();
    for (const p of problems) {
      const line = Math.max(0, p.line - 1);
      const col = Math.max(0, p.col - 1);
      const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), p.message, vscode.DiagnosticSeverity.Error);
      d.source = "meld";
      if (!byFile.has(p.file)) byFile.set(p.file, []);
      byFile.get(p.file).push(d);
    }
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
    known.set(root, [...byFile.keys()]);
    return problems;
  }

  const timers = new Map();
  const checkSoon = (doc) => {
    if (doc.languageId !== "meld") return;
    const root = rootFor(doc.uri);
    clearTimeout(timers.get(root));
    timers.set(root, setTimeout(() => check(root), 150));
  };
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(checkSoon), vscode.workspace.onDidOpenTextDocument(checkSoon));
  vscode.workspace.textDocuments.forEach(checkSoon);
  // files changed by Meld Studio (or Claude Code) outside the editor
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.meld");
  watcher.onDidChange((uri) => check(rootFor(uri)));
  watcher.onDidCreate((uri) => check(rootFor(uri)));
  watcher.onDidDelete((uri) => check(rootFor(uri)));
  context.subscriptions.push(watcher);

  // ---- commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand("meld.check", async () => {
      const root = activeRoot();
      if (!root) return;
      const problems = await check(root);
      vscode.window.showInformationMessage(problems.length ? `Meld found ${problems.length} problem(s). See the Problems panel.` : "Meld: the app checks clean.");
    }),

    vscode.commands.registerCommand("meld.explain", async () => {
      const root = activeRoot();
      if (!root) return;
      const result = await run(["explain", root], root);
      output.clear();
      output.append(result.stdout || result.stderr);
      output.show(true);
    }),

    vscode.commands.registerCommand("meld.whoUses", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const decl = lib.declarationAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
      if (!decl || decl.kind !== "step") {
        vscode.window.showInformationMessage("Meld: put the cursor inside a step first.");
        return;
      }
      const root = rootFor(editor.document.uri);
      const result = await run(["who-uses", root, `${decl.module}.${decl.name}`], root);
      output.clear();
      output.append(result.stdout || result.stderr);
      output.show(true);
    }),

    vscode.commands.registerCommand("meld.installSkill", async () => {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) return;
      const result = await run(["skill", "install", folder.uri.fsPath], folder.uri.fsPath);
      vscode.window.showInformationMessage(result.code === 0 ? "Meld: added the skill in .claude/skills/meld. Claude Code will use it in this project." : `Meld: ${result.stderr || "couldn't add the skill."}`);
    }),

    vscode.commands.registerCommand("meld.openStudio", async () => {
      const root = activeRoot();
      if (!root) return;
      const editor = vscode.window.activeTextEditor;
      const decl = editor && editor.document.languageId === "meld" ? lib.declarationAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active)) : undefined;
      const port = await ensureStudio(root, output);
      if (!port) return;
      const local = vscode.Uri.parse(`http://127.0.0.1:${port}/_meld/studio#${lib.studioHash(decl)}`);
      const url = (await vscode.env.asExternalUri(local)).toString(true);
      const panel = vscode.window.createWebviewPanel("meldStudio", "Meld Studio", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
      panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;overflow:hidden}</style></head>
<body><iframe src="${url}"></iframe></body></html>`;
    }),
  );

  async function ensureStudio(root, out) {
    if (studio && studio.root === root && studio.proc.exitCode === null) return studio.port;
    if (studio) studio.proc.kill();
    const port = config().get("studioPort") || 4310;
    const [exe, ...pre] = command();
    const proc = cp.spawn(exe, [...pre, "studio", root, "--port", String(port)], { cwd: lib.cliCwd([exe, ...pre]) || root });
    proc.stdout.on("data", (d) => out.append(String(d)));
    proc.stderr.on("data", (d) => out.append(String(d)));
    studio = { proc, root, port };
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/_meld/view`);
        if (res.ok) return port;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    out.show(true);
    vscode.window.showErrorMessage("Meld Studio didn't start. See the Meld output for why (often: the app has problems; run Meld: Check the App).");
    return undefined;
  }
}

function deactivate() {
  if (studio) studio.proc.kill();
}

module.exports = { activate, deactivate };
