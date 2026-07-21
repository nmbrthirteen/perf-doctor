#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.js";
import { detectProject, discoverRoutes, findBase, loadConfig } from "./detect.js";
import { PROFILES, dominantPhase, looksLikeDevServer, measure } from "./measure.js";
import { install, uninstall } from "./install.js";
import { toMarkdown, type Baseline } from "./report.js";
import { runNetworkRules, runRules, runSourceRules } from "./rules.js";
import { attribute, buildIndex } from "./scan.js";
import { Renderer, pickAgent, printDelta, printFindings, printFooter, printScore } from "./ui.js";
import type { DiscoveredRoute, ReportMeta, RouteResult } from "./types.js";

const HELP = `
perf-doctor  measure every route, find the cause, verify the fix

Usage
  npx perf-doctor                          all routes of the app in this folder
  npx perf-doctor /stories                 one route
  npx perf-doctor https://site.com/page    one page anywhere
  npx perf-doctor install                  add the agent skill and AGENTS.md section
  npx perf-doctor uninstall                remove everything install added

Words you can add, no flags needed
  desktop     no throttling (default is throttled mobile)
  fix         hand the findings to your coding agent when done
  fast        measure 4 routes at once (quicker sweep, noisier numbers)
  3           any bare number sets runs per route, the median is reported

Examples
  npx perf-doctor /stories 3
  npx perf-doctor https://lifeat.upgaming.com fast
  npx perf-doctor desktop fix

Flags, same things for scripts
  --base=<url> --profile=<name> --routes=/a,/b --runs=<n> --parallel=<n>
  --limit=<n> --agent=<cmd> --fix --json --help
`;

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (const a of argv) {
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k) args[k] = v ?? true;
  }
  return args;
}

async function sitemapRoutes(base: string): Promise<DiscoveredRoute[]> {
  try {
    const res = await fetch(new URL("/sitemap.xml", base), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => {
        try {
          return new URL(m[1]!).pathname;
        } catch {
          return null;
        }
      })
      .filter((p): p is string => p != null);
    return [...new Set(paths)].slice(0, 25).map((route) => ({ route, file: null }));
  } catch {
    return [];
  }
}

function baselinePath(outDir: string, base: string, profileName: string): string {
  const slug = `${base}-${profileName}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return join(outDir, `baseline-${slug}.json`);
}

const KNOWN_AGENTS: [string, string][] = [
  ["Claude Code", "claude"],
  ["Codex", "codex"],
  ["Cursor", "cursor-agent"],
  ["Gemini", "gemini"],
];

function commandExists(bin: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [bin], { stdio: "ignore" }).status === 0;
}

function runAgent(agent: string, prompt: string): boolean {
  console.log(`Handing the report to ${agent} ...\n`);
  const parts = agent.split(" ");
  const res = spawnSync(parts[0]!, [...parts.slice(1), prompt], { stdio: "inherit" });
  if (res.error) {
    console.error(`Could not start ${agent}: ${res.error.message}`);
    return false;
  }
  return true;
}

function copyToClipboard(text: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["pbcopy"]
      : process.platform === "win32"
        ? ["clip"]
        : ["xclip", "-selection", "clipboard"];
  const res = spawnSync(cmd[0]!, cmd.slice(1), { input: text });
  if (res.error || res.status !== 0) {
    console.log(`Could not reach the clipboard, here is the prompt:\n\n${text}`);
    return;
  }
  console.log("Prompt copied. Paste it into any agent.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"]) {
    console.log(HELP);
    return;
  }

  const cwd = process.cwd();
  if (args._[0] === "install") {
    install(cwd);
    return;
  }
  if (args._[0] === "uninstall") {
    uninstall(cwd);
    return;
  }

  const config = loadConfig(cwd);
  const project = detectProject(cwd);

  let posBase: string | null = null;
  let posProfile: string | null = null;
  let posRuns: number | null = null;
  let posParallel: number | null = null;
  let fixMode = Boolean(args["fix"]);
  const posRoutes: string[] = [];
  for (const p of args._) {
    if (/^https?:\/\//.test(p)) {
      const u = new URL(p);
      posBase ??= u.origin;
      if (u.pathname !== "/" || u.search) posRoutes.push(u.pathname + u.search);
    } else if (p.startsWith("/")) {
      posRoutes.push(p);
    } else if (p === "desktop" || p === "mobile") {
      posProfile = p;
    } else if (p === "fix") {
      fixMode = true;
    } else if (p === "fast") {
      posParallel = 4;
    } else if (/^\d+$/.test(p)) {
      posRuns = Number(p);
    } else {
      console.error(`Unknown argument: ${p}. Try --help.`);
      process.exit(1);
    }
  }

  const profileName = String(args["profile"] || posProfile || config.profile || "mobile");
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile: ${profileName}. Use mobile or desktop.`);

  const base =
    (typeof args["base"] === "string" && args["base"]) ||
    posBase ||
    config.base ||
    (await findBase(["http://localhost:3000", "http://localhost:3001", "http://localhost:4000"]));

  if (!base) {
    console.error(
      "No server found on localhost:3000, 3001, or 4000. Start your app, or pass --base=<url>.\nMeasure a production build (next build && next start), a dev server gives numbers nobody ships.",
    );
    process.exit(1);
  }

  let routes: DiscoveredRoute[] = [];
  if (posRoutes.length) {
    routes = posRoutes.map((route) => ({ route, file: null }));
  } else if (typeof args["routes"] === "string") {
    routes = args["routes"].split(",").map((route) => ({ route, file: null }));
  } else if (config.routes) {
    routes = config.routes.map((route) => ({ route, file: null }));
  } else {
    const discovered = discoverRoutes(cwd, project, config.params ?? {});
    routes = discovered.routes;
    if (discovered.skipped.length) {
      console.log(
        `\nSkipping ${discovered.skipped.length} dynamic route(s): ${discovered.skipped
          .map((d) => d.route)
          .join(", ")}.\nFill them via "params" in perf-doctor.json, or pass --routes.`,
      );
    }
  }
  if (!routes.length) routes = await sitemapRoutes(base);
  if (!routes.length) {
    console.error("No routes found. Pass --routes=/,/about or add a routes array to perf-doctor.json.");
    process.exit(1);
  }
  if (args["limit"]) routes = routes.slice(0, Number(args["limit"]));

  const runs = Number(args["runs"] || posRuns || config.runs || 1);
  const parallel = Math.max(1, Number(args["parallel"] || posParallel || config.parallel || 1));
  const jsonMode = Boolean(args["json"]);
  const index = project.framework === "unknown" ? null : buildIndex(cwd);

  const version = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ).version as string;

  const outDir = resolve(cwd, ".perf");
  mkdirSync(outDir, { recursive: true });
  const blPath = baselinePath(outDir, base, profileName);

  const sweep = async (opts: { offerAgent: boolean; compareTo?: string }): Promise<boolean> => {
    const browser = await launch();
    const slots: (RouteResult | null)[] = routes.map(() => null);
    const assetCache = new Map<string, { type: string; cacheControl: string | null; bytes: number }>();
    let devServer = false;
    let cursor = 0;
    const ui = jsonMode
      ? null
      : new Renderer(
          routes.map((r) => r.route),
          { version, base, profileLabel: profile.label, runs, parallel },
        );

    const worker = async () => {
      while (cursor < routes.length) {
        const i = cursor++;
        const { route, file } = routes[i]!;
        const url = new URL(route, base).toString();
        ui?.start(i, runs);
        const m = await measure(browser, url, profile, {
          runs,
          onRun: (run, total) => ui?.progress(i, run, total),
        });
        if (m.html && looksLikeDevServer(m.html)) devServer = true;

        for (const r of m.resources) {
          if (!(r.name in m.cacheByUrl) || assetCache.has(r.name)) continue;
          assetCache.set(r.name, {
            type: r.type,
            cacheControl: m.cacheByUrl[r.name] ?? null,
            bytes: r.transferSize || r.encodedSize || 0,
          });
        }

        const element = m.lcp?.element ?? null;
        const attribution = index && element ? attribute(index, element, file) : null;
        const phases = m.phases;
        const dominant = dominantPhase(phases);
        const findings = runRules({
          route,
          m,
          lcp: m.lcp,
          element,
          phases,
          dominant,
          html: m.html,
          profile,
          index,
          attribution,
        });

        slots[i] = {
          route,
          url,
          lcp: m.lcp,
          phases,
          dominant,
          cls: m.cls,
          tbt: m.lcp ? m.tbt : null,
          ttfb: m.lcp ? m.ttfb : null,
          bytesBeforeLcp: m.bytesBeforeLcp,
          bytesByType: m.bytesByType,
          error: m.error,
          attribution: attribution
            ? { file: attribution.file, line: attribution.line, how: attribution.how }
            : null,
          findings,
        };
        ui?.done(i, slots[i]!);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(parallel, routes.length) }, worker));
    } finally {
      ui?.finish();
      await browser.close().catch(() => {});
    }

    const results = slots.filter((r): r is RouteResult => r !== null);
    const sourceFindings = index ? runSourceRules(index) : [];
    const networkFindings = runNetworkRules(
      [...assetCache].map(([url, a]) => ({ url, ...a })),
      new URL(base).origin,
    );
    const meta: ReportMeta = {
      base,
      profileName,
      profileLabel: profile.label,
      runs,
      at: new Date().toISOString(),
      devServer,
    };
    const hasFindings =
      results.some((r) => r.findings.length) || sourceFindings.length > 0 || networkFindings.length > 0;

    if (jsonMode) {
      console.log(JSON.stringify({ meta, results, sourceFindings, networkFindings }, null, 2));
    } else {
      printScore(results);
      printFindings(results, meta, [...sourceFindings, ...networkFindings]);
      const deltaSource = opts.compareTo && existsSync(opts.compareTo) ? opts.compareTo : blPath;
      if (existsSync(deltaSource)) {
        try {
          printDelta(results, JSON.parse(readFileSync(deltaSource, "utf8")) as Baseline);
        } catch {}
      }
    }

    writeFileSync(join(outDir, "report.md"), toMarkdown(results, meta, sourceFindings, networkFindings));
    writeFileSync(
      join(outDir, "report.json"),
      JSON.stringify({ meta, results, sourceFindings, networkFindings }, null, 2),
    );
    if (parallel === 1) {
      const baseline: Baseline = {
        meta: { base, profileName, at: meta.at },
        results: results.map(({ route, lcp, cls, tbt }) => ({
          route,
          lcp: lcp ? { time: lcp.time } : null,
          cls,
          tbt,
        })),
      };
      writeFileSync(blPath, JSON.stringify(baseline, null, 2));
    }

    if (!jsonMode) printFooter(opts.offerAgent && hasFindings);
    return hasFindings;
  };

  const canPick = !jsonMode && !fixMode && process.stdin.isTTY === true;
  const hasFindings = await sweep({ offerAgent: canPick });

  const rerun = process.argv
    .slice(2)
    .filter((a) => a !== "--fix" && a !== "fix" && !a.startsWith("--agent"))
    .join(" ");
  const prompt = `Read .perf/report.md. Fix the high severity findings one at a time, worst route first. After each fix, verify it: re-run "npx perf-doctor ${rerun}" and confirm the route's LCP delta improved before moving on. Never make a visual change without asking first.`;

  const beforeFix = join(outDir, "before-fix.json");
  const verify = async () => {
    console.log(`\n${"-".repeat(40)}\nAgent session ended. Verifying the result ...\n`);
    await sweep({ offerAgent: false, compareTo: beforeFix });
    rmSync(beforeFix, { force: true });
  };

  if (fixMode) {
    if (!hasFindings) {
      console.log("Nothing to fix, skipping the agent handoff.");
      return;
    }
    if (existsSync(blPath)) copyFileSync(blPath, beforeFix);
    const started = runAgent(typeof args["agent"] === "string" ? args["agent"] : "claude", prompt);
    if (started) await verify();
    return;
  }

  if (canPick && hasFindings) {
    const available = KNOWN_AGENTS.filter(([, bin]) => commandExists(bin));
    const options = available.length
      ? [...available.map(([label]) => label), "Skip"]
      : ["Copy prompt", "Skip"];
    const choice = await pickAgent(options);
    if (choice == null || choice === options.length - 1) return;
    if (!available.length) {
      copyToClipboard(prompt);
      return;
    }
    if (existsSync(blPath)) copyFileSync(blPath, beforeFix);
    const started = runAgent(available[choice]![1], prompt);
    if (started) await verify();
  }
}

main().catch((e: Error) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
