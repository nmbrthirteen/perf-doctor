import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { attribute, buildIndex } from "../src/scan.js";
import type { ElementInfo } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "perf-doctor-"));

after(() => rmSync(root, { recursive: true, force: true }));

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(root, "p-"));

  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }

  return buildIndex(dir);
}

const img = (over: Partial<ElementInfo>): ElementInfo => ({
  tag: "img",
  id: null,
  cls: null,
  text: null,
  alt: null,
  src: null,
  srcAttr: null,
  fetchPriority: null,
  loading: null,
  sizes: null,
  naturalWidth: null,
  displayWidth: 100,
  ancestors: [],
  ...over,
});

test("attribute matches a next/image URL by the underlying filename", () => {
  const index = project({ "components/hero.tsx": '<Image src="/img/hero-banner.jpg" />\n' });
  const hit = attribute(index, img({ src: "/_next/image?url=%2Fimg%2Fhero-banner.jpg&w=640&q=75" }), null);
  assert.equal(hit?.how, "image filename");
  assert.equal(hit?.file, "components/hero.tsx");
  assert.equal(hit?.line, 1);
});

test("attribute prefers a usage over an import of the same name", () => {
  const index = project({
    "a-barrel.ts": 'import hero from "./hero-banner.jpg";\n',
    "z-page.tsx": 'export const Page = () => <img src="/hero-banner.jpg" />;\n',
  });

  const hit = attribute(index, img({ src: "http://x/hero-banner.jpg" }), null);
  assert.equal(hit?.file, "z-page.tsx");
});

test("attribute falls back to an import when nothing else matches", () => {
  const index = project({ "a.ts": 'import hero from "./hero-banner.jpg";\n' });
  const hit = attribute(index, img({ src: "http://x/hero-banner.jpg" }), null);
  assert.equal(hit?.file, "a.ts");
});

test("attribute ignores filenames shorter than the minimum needle", () => {
  const index = project({ "a.tsx": '<img src="/a.png" />\n' });
  assert.equal(attribute(index, img({ src: "http://x/a.png" }), null), null);
});

test("attribute falls back to the route file", () => {
  const index = project({ "a.tsx": "export {};\n" });
  const hit = attribute(index, img({ src: "http://x/missing-file.png" }), join(index.cwd, "app/page.tsx"));
  assert.deepEqual(hit, { how: "route file", file: join("app", "page.tsx"), line: 1 });
});

test("attribute returns null without an element", () => {
  assert.equal(attribute(project({ "a.tsx": "" }), null, null), null);
});
