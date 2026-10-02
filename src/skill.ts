import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The Meld skill for Claude Code (and other agents that read SKILL.md files):
// how to work on a Meld app, plus the same language reference the studio's
// AI agent uses, so the two never disagree.

const REPO = join(import.meta.dir, "..");

export function installSkill(target: string) {
  mkdirSync(join(target, "references"), { recursive: true });
  copyFileSync(join(REPO, "skills", "meld", "SKILL.md"), join(target, "SKILL.md"));
  copyFileSync(join(REPO, "docs", "meld-language.md"), join(target, "references", "meld-language.md"));
}
