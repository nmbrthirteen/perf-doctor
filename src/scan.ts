import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Attribution, ElementInfo, SearchHit, SearchOpts, SourceFile, SourceIndex } from "./types.js";

const SOURCE_EXT = /\.(tsx|jsx|ts|js|mjs|astro|vue|svelte)$/;
const JSON_EXT = /\.json$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".vercel",
  "public",
]);
const MAX_FILES = 4000;

function walk(dir: string, out: Map<string, "source" | "locale">): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (out.size >= MAX_FILES) return;
    if (SOURCE_EXT.test(entry)) out.set(full, "source");
    else if (JSON_EXT.test(entry) && /locale|messages|translation|i18n/i.test(full)) out.set(full, "locale");
  }
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function findKeyByValue(obj: unknown, value: string, prefix = ""): string | null {
  if (!obj || typeof obj !== "object") return null;
  const target = value.trim();
  if (target.length < 8) return null;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      if (v.trim() === target) return path;
    } else if (v && typeof v === "object") {
      const nested = findKeyByValue(v, value, path);
      if (nested) return nested;
    }
  }
  return null;
}

export function buildIndex(cwd: string): SourceIndex {
  const files = new Map<string, "source" | "locale">();
  walk(cwd, files);

  const sources: SourceFile[] = [];
  const locales: SourceFile[] = [];
  for (const [path, kind] of files) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const rec = { rel: relative(cwd, path), content };
    if (kind === "source") sources.push(rec);
    else locales.push(rec);
  }

  const parsedLocales = locales.map((f) => {
    try {
      return { file: f, json: JSON.parse(f.content) as unknown };
    } catch {
      return { file: f, json: null };
    }
  });

  const search = (needle: string, opts: SearchOpts = {}): SearchHit[] => {
    const { limit = 3, files: pool = sources } = opts;
    if (!needle || needle.length < 4) return [];
    const hits: SearchHit[] = [];
    for (const f of pool) {
      const idx = f.content.indexOf(needle);
      if (idx === -1) continue;
      hits.push({ file: f.rel, line: lineOf(f.content, idx), content: f.content });
      if (hits.length >= limit) break;
    }
    return hits;
  };

  const searchRegex = (re: RegExp, opts: SearchOpts = {}): SearchHit[] => {
    const { limit = 3, files: pool = sources } = opts;
    const hits: SearchHit[] = [];
    for (const f of pool) {
      const m = re.exec(f.content);
      re.lastIndex = 0;
      if (!m) continue;
      hits.push({ file: f.rel, line: lineOf(f.content, m.index), content: f.content });
      if (hits.length >= limit) break;
    }
    return hits;
  };

  const resolveI18n = (text: string) => {
    for (const { file, json } of parsedLocales) {
      if (!json) continue;
      const key = findKeyByValue(json, text);
      if (key) return { key, locale: file.rel };
    }
    return null;
  };

  return { sources, locales, search, searchRegex, resolveI18n, cwd };
}

export function attribute(
  index: SourceIndex,
  element: ElementInfo | null,
  routeFile: string | null,
): Attribution | null {
  if (!element) return null;
  const tries: { how: string; hits: SearchHit[] }[] = [];

  if (element.alt) tries.push({ how: "alt text", hits: index.search(element.alt) });

  if (element.srcAttr && !/^https?:/.test(element.srcAttr)) {
    const name = element.srcAttr.split("/").pop();
    if (name) tries.push({ how: "image path", hits: index.search(name) });
  }

  if (element.src) {
    let decoded = element.src;
    try {
      decoded = decodeURIComponent(element.src);
    } catch {}
    const name = decoded.split("/").pop()?.split("?")[0];
    if (name && name.length > 6) tries.push({ how: "image filename", hits: index.search(name) });
  }

  if (element.cls) {
    const classes = element.cls.trim().split(/\s+/);
    for (const n of [classes.length, 4, 3]) {
      const slice = classes.slice(0, n).join(" ");
      if (slice.length < 8) continue;
      const hits = index.search(slice, { limit: 4 });
      if (hits.length && hits.length < 3) {
        tries.push({ how: "className", hits });
        break;
      }
      if (hits.length >= 3) break;
    }
  }

  if (element.text) {
    const text = element.text.slice(0, 50);
    const direct = index.search(text);
    if (direct.length) tries.push({ how: "text", hits: direct });
    else {
      const i18n = index.resolveI18n(element.text);
      if (i18n) {
        const keyLeaf = i18n.key.split(".").slice(-2).join(".");
        const hits = index.search(keyLeaf);
        tries.push({
          how: `i18n key ${i18n.key} (${i18n.locale})`,
          hits: hits.length ? hits : [{ file: i18n.locale, line: 1 }],
        });
      }
    }
  }

  const best = tries.find((t) => t.hits.length);
  if (!best) {
    return routeFile ? { how: "route file", file: relative(index.cwd, routeFile), line: 1 } : null;
  }
  const hit = best.hits[0]!;
  return { how: best.how, file: hit.file, line: hit.line, source: hit.content };
}
