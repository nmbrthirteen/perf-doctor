import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARK_START = "<!-- perf-doctor -->";
const MARK_END = "<!-- /perf-doctor -->";

const AGENTS_SECTION = `
${MARK_START}
## Performance

Run \`npx perf-doctor\` to measure Core Web Vitals on every route, then read .perf/report.md for ranked findings with file:line pointers. Fix one finding at a time and re-run the same command after each; it prints the LCP delta per route. Never make a visual change to hit a number without asking first.
${MARK_END}
`;

export function install(cwd: string): void {
  const skillSource = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
  if (!existsSync(skillSource)) {
    console.error("Bundled skill file not found. Reinstall perf-doctor.");
    process.exit(1);
  }

  const dir = join(cwd, ".claude", "skills", "perf-doctor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), readFileSync(skillSource, "utf8"));
  console.log("Installed skill: .claude/skills/perf-doctor/SKILL.md");

  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf8");
    if (!content.includes(MARK_START)) {
      writeFileSync(agentsPath, content.replace(/\n?$/, "\n") + AGENTS_SECTION);
      console.log("Added a perf-doctor section to AGENTS.md (read by codex, cursor, gemini)");
    }
  }

  const gitignore = join(cwd, ".gitignore");
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, "utf8");
    if (!content.split("\n").some((l) => l.trim() === ".perf" || l.trim() === ".perf/")) {
      writeFileSync(gitignore, content.replace(/\n?$/, "\n.perf/\n"));
      console.log("Added .perf/ to .gitignore");
    }
  }

  console.log(
    '\nDone. Ask your agent to "run perf-doctor and fix the findings", or run `npx perf-doctor fix` yourself.',
  );
}

export function uninstall(cwd: string): void {
  const dir = join(cwd, ".claude", "skills", "perf-doctor");
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log("Removed .claude/skills/perf-doctor/");
  }

  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf8");
    const start = content.indexOf(MARK_START);
    const end = content.indexOf(MARK_END);
    if (start !== -1 && end !== -1) {
      writeFileSync(
        agentsPath,
        (content.slice(0, start) + content.slice(end + MARK_END.length)).replace(/\n{3,}/g, "\n\n"),
      );
      console.log("Removed the perf-doctor section from AGENTS.md");
    }
  }

  const gitignore = join(cwd, ".gitignore");
  if (existsSync(gitignore)) {
    const lines = readFileSync(gitignore, "utf8").split("\n");
    const kept = lines.filter((l) => l.trim() !== ".perf/" && l.trim() !== ".perf");
    if (kept.length !== lines.length) {
      writeFileSync(gitignore, kept.join("\n"));
      console.log("Removed .perf/ from .gitignore");
    }
  }

  if (existsSync(join(cwd, ".perf"))) {
    console.log("Left .perf/ reports in place. Delete them with: rm -rf .perf");
  }
  console.log("Done.");
}
