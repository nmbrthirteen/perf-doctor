import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, DiscoveredRoute, Project } from "./types.js";

const PAGE_FILE = /^page\.(tsx|ts|jsx|js)$/;
const PAGES_EXT = /\.(tsx|ts|jsx|js)$/;
const IGNORED = new Set(["node_modules", ".next", ".git", "dist", "build", "api"]);

export function detectProject(cwd: string): Project {
  const pkgPath = join(cwd, "package.json");
  let deps: Record<string, string> = {};
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {}
  }

  const appDir = ["app", "src/app"].map((d) => join(cwd, d)).find(existsSync);
  const pagesDir = ["pages", "src/pages"].map((d) => join(cwd, d)).find(existsSync);

  let framework = "unknown";
  if (deps["next"] && appDir) framework = "next-app";
  else if (deps["next"] && pagesDir) framework = "next-pages";
  else if (deps["next"]) framework = "next";
  else if (deps["astro"]) framework = "astro";
  else if (deps["react-router"] || deps["react-router-dom"]) framework = "react-router";
  else if (deps["vite"]) framework = "vite";

  return { framework, appDir, pagesDir };
}

function walkApp(dir: string, segments: string[], out: DiscoveredRoute[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  const pageFile = entries.find((e) => PAGE_FILE.test(e));
  if (pageFile) {
    const path = "/" + segments.filter(Boolean).join("/");
    out.push({ route: path === "/" ? "/" : path, file: join(dir, pageFile) });
  }

  for (const entry of entries) {
    if (IGNORED.has(entry) || entry.startsWith(".") || entry.startsWith("_")) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    if (entry.startsWith("(") && entry.endsWith(")")) {
      walkApp(full, segments, out);
      continue;
    }
    if (entry.startsWith("@")) continue;
    walkApp(full, [...segments, entry], out);
  }
}

function walkPages(dir: string, segments: string[], out: DiscoveredRoute[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry) || entry.startsWith("_") || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkPages(full, [...segments, entry], out);
      continue;
    }
    if (!PAGES_EXT.test(entry)) continue;
    const name = entry.replace(PAGES_EXT, "");
    const parts = name === "index" ? segments : [...segments, name];
    const path = "/" + parts.filter(Boolean).join("/");
    out.push({ route: path === "/" ? "/" : path, file: full });
  }
}

function expandParams(
  dynamic: DiscoveredRoute[],
  params: Record<string, string[]>,
): { expanded: DiscoveredRoute[]; skipped: DiscoveredRoute[] } {
  const expanded: DiscoveredRoute[] = [];
  const skipped: DiscoveredRoute[] = [];

  for (const r of dynamic) {
    if (/\[\.\.\./.test(r.route)) {
      skipped.push(r);
      continue;
    }
    let variants = [r.route];
    let resolvable = true;
    for (const [, name] of r.route.matchAll(/\[([^\]]+)\]/g)) {
      const values = params[name!];
      if (!values?.length) {
        resolvable = false;
        break;
      }
      variants = variants.flatMap((v) => values.map((val) => v.replace(`[${name}]`, val)));
    }
    if (resolvable) expanded.push(...variants.map((route) => ({ route, file: r.file })));
    else skipped.push(r);
  }
  return { expanded, skipped };
}

export function discoverRoutes(
  cwd: string,
  project: Project,
  params: Record<string, string[]> = {},
): { routes: DiscoveredRoute[]; skipped: DiscoveredRoute[] } {
  const found: DiscoveredRoute[] = [];
  if (project.appDir) walkApp(project.appDir, [], found);
  else if (project.pagesDir) walkPages(project.pagesDir, [], found);

  const dynamic = found.filter((r) => /\[.+\]/.test(r.route));
  const routes = found.filter((r) => !/\[.+\]/.test(r.route));
  const { expanded, skipped } = expandParams(dynamic, params);
  routes.push(...expanded);
  routes.sort((a, b) => a.route.localeCompare(b.route));
  return { routes, skipped };
}

export async function findBase(candidates: string[]): Promise<string | null> {
  for (const base of candidates) {
    try {
      const res = await fetch(base, { method: "HEAD", signal: AbortSignal.timeout(2500) });
      if (res.status < 400 || res.status === 405) return base;
    } catch {}
  }
  return null;
}

export function loadConfig(cwd: string): Config {
  for (const name of ["perf-doctor.json", ".perf-doctor.json"]) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Config;
    } catch {
      console.error(`Could not parse ${name}, ignoring it.`);
      return {};
    }
  }
  return {};
}
