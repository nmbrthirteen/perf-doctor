import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, parseCount, stringFlag } from "../src/args.js";

test("parseArgs splits a flag on the first equals sign only", () => {
  const args = parseArgs(["--base=https://x.dev/?a=b=c", "--json"]);
  assert.equal(args["base"], "https://x.dev/?a=b=c");
  assert.equal(args["json"], true);
});

test("parseArgs keeps positionals in order", () => {
  assert.deepEqual(parseArgs(["/a", "desktop", "3"])._, ["/a", "desktop", "3"]);
});

test("parseArgs keeps an empty value as an empty string", () => {
  assert.equal(parseArgs(["--base="])["base"], "");
});

test("parseCount returns the fallback when the flag is absent", () => {
  assert.equal(parseCount("runs", undefined, 1), 1);
});

test("parseCount accepts digits and numbers", () => {
  assert.equal(parseCount("runs", "3", 1), 3);
  assert.equal(parseCount("runs", 5, 1), 5);
});

test("parseCount rejects non-numeric, zero, and bare flags", () => {
  for (const bad of ["abc", "1.5", "0", "", true, -2]) {
    assert.throws(() => parseCount("runs", bad, 1), /--runs must be a whole number/);
  }
});

test("stringFlag returns string values and ignores bare flags", () => {
  const args = parseArgs(["--agent=codex", "--json"]);

  assert.equal(stringFlag(args, "agent"), "codex");
  assert.equal(stringFlag(args, "json"), undefined);
  assert.equal(stringFlag(args, "missing"), undefined);
});
