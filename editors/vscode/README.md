# Meld for VS Code

Work on Meld apps in VS Code.

- **Highlighting** for `.meld` files, with `///` explanations shown as documentation.
- **Live checks:** every save runs `meld check` on the app and shows problems in the Problems panel. This includes changes made outside the editor, by Meld Studio or by Claude Code.
- **Meld: Who Uses This Step** (right-click inside a step): every endpoint that uses it and what depends on each outcome.
- **Meld: Open Studio** (right-click): Meld Studio in an editor tab, opened at the step or endpoint under the cursor. Changes made in the studio are written to the `.meld` files and checked like any other edit.
- **Meld: Explain the App**: the modules, steps, endpoints and who depends on whom.
- **Meld: Add the Claude Code Skill to This Project**: lets Claude Code work on the app the Meld way.

## Setup

The extension runs the Meld command line. If `meld` isn't on your PATH, set **Meld: Command** to how you run it, for example:

```
bun /path/to/meld/src/cli.ts
```

## Try it from a checkout

Open `editors/vscode` in VS Code and press F5 to start an Extension Development Host. Or package it with `npx @vscode/vsce package --no-dependencies --skip-license` and install the `.vsix` (Extensions view → … → Install from VSIX).
