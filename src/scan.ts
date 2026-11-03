import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { underlyingSrc } from "./rules.js";
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
const MIN_NEEDLE = 8;
const IMPORT_LINE = /^\s*(import\b|export\b[^=]*\bfrom\b|.*\brequire\()/;

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

// An import line only proves a file knows the asset, a later hit is where it renders.
interface Usage {
  at: number;
  inImport: boolean;
}

function firstUsage(content: string, needle: string): Usage {
  let first = -1;

  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
    if (first === -1) first = at;
    const start = content.lastIndexOf("\n", at) + 1;
    const end = content.indexOf("\n", at);

    if (!IMPORT_LINE.test(content.slice(start, end === -1 ? undefined : end))) return { at, inImport: false };
  }

  return { at: first, inImport: first !== -1 };
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function findKeyByValue(root: Json, value: string): string | null {
  const target = value.trim();

  if (target.length < 8) return null;

  const visit = (node: Json, prefix: string): string | null => {
    if (!(node instanceof Object)) return null;

    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;

      if (v instanceof Object) {
        const nested = visit(v, path);

        if (nested) return nested;
      } else if (String(v).trim() === target) {
        return path;
      }
    }

    return null;
  };

  return visit(root, "");
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
      const json: Json = JSON.parse(f.content);

      return { file: f, json };
    } catch {
      return { file: f, json: null };
    }
  });

  const search = (needle: string, opts: SearchOpts = {}): SearchHit[] => {
    const { limit = 3, files: pool = sources } = opts;

    if (!needle || needle.length < MIN_NEEDLE) return [];
    const usage: SearchHit[] = [];
    const imports: SearchHit[] = [];

    for (const f of pool) {
      const idx = firstUsage(f.content, needle);

      if (idx.at === -1) continue;
      (idx.inImport ? imports : usage).push({
        file: f.rel,
        line: lineOf(f.content, idx.at),
        content: f.content,
      });

      if (usage.length >= limit) break;
    }

    return [...usage, ...imports].slice(0, limit);
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

// A substring search, so the result is a best guess at where the element lives, not proof.
export function attribute(
  index: SourceIndex,
  element: ElementInfo | null,
  routeFile: string | null,
): Attribution | null {
  if (!element) return null;
  const tries: { how: string; hits: SearchHit[] }[] = [];

  if (element.alt) tries.push({ how: "alt text", hits: index.search(element.alt) });

  if (element.srcAttr && !/^https?:/.test(element.srcAttr)) {
    const name = element.srcAttr.split("?")[0]!.split("/").pop();

    if (name) tries.push({ how: "image path", hits: index.search(name) });
  }

  if (element.src) {
    let decoded = underlyingSrc(element.src) ?? element.src;

    try {
      decoded = decodeURIComponent(decoded);
    } catch {}

    const name = decoded.split("?")[0]!.split("/").pop();

    if (name && name.length >= MIN_NEEDLE) tries.push({ how: "image filename", hits: index.search(name) });
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
