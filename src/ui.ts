import { readFileSync } from "node:fs";
import { verdict, type Baseline } from "./report.js";
import { scoreBand, siteScore } from "./score.js";
import type { ReportMeta, RouteResult } from "./types.js";

export const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const color = (v: string) => (v === "good" ? C.green : v === "needs work" ? C.yellow : v === "?" ? C.dim : C.red);

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function elementLabel(r: RouteResult, max: number): string {
  if (r.error) return C.red(`error: ${r.error.slice(0, max)}`);
  if (!r.lcp) return C.dim("no LCP");
  const el = r.lcp.element;
  if (!el) return C.dim("unknown element");
  const name = el.tag + (el.cls ? `.${el.cls.trim().split(/\s+/)[0]}` : "");
  const detail = el.src
    ? safeDecode(el.src).split("/").pop()!.split("?")[0]!
    : el.text
      ? `"${el.text}"`
      : "";
  const room = Math.max(0, max - name.length - 1);
  return `${name} ${C.dim(detail.slice(0, room))}`;
}

interface Header {
  version: string;
  base: string;
  profileLabel: string;
  runs: number;
  parallel: number;
}

export class Renderer {
  private routes: string[];
  private w: number;
  private cols: number;
  private tty: boolean;
  private active = new Map<number, string>();
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private high = 0;
  private medium = 0;
  private measured = 0;

  constructor(routes: string[], header: Header) {
    this.routes = routes;
    this.w = Math.max(...routes.map((r) => r.length), 6);
    this.cols = process.stdout.columns || 100;
    this.tty = process.stdout.isTTY === true;

    console.log(`\n${C.bold("perf-doctor")} ${C.dim(`v${header.version}`)}`);
    console.log(
      C.dim(
        `${header.base} · ${header.profileLabel} · ${routes.length} route${routes.length > 1 ? "s" : ""} · ${header.runs} run${header.runs > 1 ? "s" : ""} each${header.parallel > 1 ? ` · ${header.parallel} at a time (noisier, verify sequentially)` : ""}`,
      ),
    );
    console.log("");
    console.log(
      `  ${"".padEnd(this.w)}  ${C.dim("LCP".padStart(7))}  ${C.dim("CLS".padStart(5))}  ${C.dim("TBT".padStart(6))}`,
    );
    if (this.tty) {
      for (const r of routes) console.log(this.pendingLine(r));
      console.log("");
      console.log(this.counterLine());
      this.timer = setInterval(() => this.tick(), 120);
      if (typeof this.timer.unref === "function") this.timer.unref();
    }
  }

  private pendingLine(route: string): string {
    return C.dim(`· ${route.padEnd(this.w)}`);
  }

  private counterLine(): string {
    const scanned = C.dim(`Measuring routes (${this.measured}/${this.routes.length})`);
    if (!this.high && !this.medium) return scanned;
    const high = this.high ? C.red(`${this.high} high`) : C.dim("0 high");
    const med = this.medium ? C.yellow(`${this.medium} medium`) : C.dim("0 medium");
    return `${scanned}   findings › ${high} · ${med}`;
  }

  private redraw(i: number, line: string): void {
    if (!this.tty) return;
    const up = this.routes.length - i + 2;
    process.stdout.write(`\x1b[${up}A\r\x1b[2K${line}\x1b[${up}B\r`);
  }

  private redrawCounter(): void {
    if (!this.tty) return;
    process.stdout.write(`\x1b[1A\r\x1b[2K${this.counterLine()}\x1b[1B\r`);
  }

  private tick(): void {
    if (!this.active.size) return;
    this.frame = (this.frame + 1) % SPINNER.length;
    for (const [i, note] of this.active) {
      this.redraw(i, `${C.cyan(SPINNER[this.frame]!)} ${this.routes[i]!.padEnd(this.w)}  ${C.dim(note)}`);
    }
  }

  start(i: number, runs: number): void {
    this.active.set(i, runs > 1 ? `run 1/${runs}` : "measuring");
    this.tick();
  }

  progress(i: number, run: number, runs: number): void {
    this.active.set(i, `run ${run}/${runs}`);
  }

  done(i: number, r: RouteResult): void {
    this.active.delete(i);
    this.measured++;
    this.high += r.findings.filter((f) => f.severity === "high").length;
    this.medium += r.findings.filter((f) => f.severity === "medium").length;
    this.redrawCounter();
    const lcp = r.lcp ? `${r.lcp.time}ms` : "-";
    const cls = r.cls != null ? r.cls.toFixed(2) : "-";
    const tbt = r.tbt != null ? `${r.tbt}ms` : "-";
    const icon = r.error ? C.red("✗") : color(verdict("lcp", r.lcp?.time))("✓");
    const fixed = 2 + this.w + 2 + 7 + 2 + 5 + 2 + 6 + 2;
    const line = `${icon} ${r.route.padEnd(this.w)}  ${color(verdict("lcp", r.lcp?.time))(lcp.padStart(7))}  ${color(
      verdict("cls", r.cls),
    )(cls.padStart(5))}  ${color(verdict("tbt", r.tbt))(tbt.padStart(6))}  ${elementLabel(r, this.cols - fixed)}`;
    if (this.tty) this.redraw(i, line);
    else console.log(line);
  }

  finish(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export function printScore(results: RouteResult[]): void {
  const s = siteScore(results);
  if (s == null) return;
  const band = scoreBand(s);
  const col = band === "good" ? C.green : band === "needs work" ? C.yellow : C.red;
  const filled = Math.round(s / 5);
  const bar = col("█".repeat(filled)) + C.dim("░".repeat(20 - filled));
  console.log(`\n${C.bold("Score")}  ${bar}  ${col(`${s}/100`)} ${col(band)}`);
}

function codeFrame(file: string, line: number): string | null {
  try {
    const text = readFileSync(file, "utf8").split("\n")[line - 1];
    if (!text?.trim()) return null;
    return `      ${C.dim(`${line} |`)} ${C.dim(text.trim().slice(0, 90))}`;
  } catch {
    return null;
  }
}

export async function pickAgent(options: string[]): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  console.log(`${C.bold("Hand these findings to an agent?")}\n`);
  return new Promise((resolve) => {
    let sel = 0;
    const render = (first = false) => {
      if (!first) process.stdout.write(`\x1b[${options.length}A`);
      for (const [i, o] of options.entries()) {
        process.stdout.write(`\r\x1b[2K${i === sel ? C.bold(`› ${o}`) : C.dim(`  ${o}`)}\n`);
      }
    };
    render(true);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (v: number | null) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log("");
      resolve(v);
    };
    const onData = (b: Buffer) => {
      const s = b.toString();
      if (s === "\x1b[A" || s === "k") sel = (sel + options.length - 1) % options.length;
      else if (s === "\x1b[B" || s === "j") sel = (sel + 1) % options.length;
      else if (s === "\r" || s === "\n") return finish(sel);
      else if (s === "\x03" || s === "\x1b" || s === "q") return finish(null);
      render();
    };
    process.stdin.on("data", onData);
  });
}

export function printFindings(results: RouteResult[], meta: ReportMeta): void {
  const w = Math.max(...results.map((r) => r.route.length), 6);
  const all = results.flatMap((r) => r.findings);
  const high = all.filter((f) => f.severity === "high");
  const med = all.filter((f) => f.severity === "medium").length;

  console.log(
    `\n${C.bold("Findings")}  ${high.length ? C.red(`${high.length} high`) : C.dim("0 high")} · ${med ? C.yellow(`${med} medium`) : C.dim("0 medium")}`,
  );
  for (const f of high.slice(0, 6)) {
    console.log(
      `  ${C.red("!")} ${(f.route ?? "").padEnd(w)}  ${f.title}${f.file ? C.dim(`  ${f.file}:${f.line}`) : ""}`,
    );
    if (f.file && f.line) {
      const frame = codeFrame(f.file, f.line);
      if (frame) console.log(frame);
    }
  }
  if (high.length > 6) console.log(C.dim(`  and ${high.length - 6} more in the report`));

  if (meta.devServer) {
    console.log(
      `\n${C.yellow("Warning:")} this looks like a dev server, so these numbers don't describe production. Run next build && next start and measure that.`,
    );
  }
}

export function printDelta(results: RouteResult[], baseline: Baseline): void {
  const prev = new Map(baseline.results.map((r) => [r.route, r]));
  const rows = results.filter((r) => r.lcp && prev.get(r.route)?.lcp);
  if (!rows.length) return;

  console.log(`\n${C.bold("Change since last run")} ${C.dim(`(${baseline.meta.at})`)}`);
  const w = Math.max(...rows.map((r) => r.route.length), 6);
  let moved = 0;
  for (const r of rows) {
    const before = prev.get(r.route)!.lcp!.time;
    const after = r.lcp!.time;
    const d = after - before;
    if (Math.abs(d) < 150) continue;
    moved++;
    const sign = d < 0 ? C.green(`${d}ms`) : C.red(`+${d}ms`);
    console.log(`  ${r.route.padEnd(w)}  ${before}ms -> ${after}ms  ${sign}`);
  }
  if (!moved) console.log(C.dim("  no route moved by more than 150ms"));
}

export function printFooter(interactive: boolean): void {
  console.log(`\n${C.bold("Report")}  .perf/report.md`);
  if (!interactive) console.log(C.dim(`Hand it to your agent: claude "work through .perf/report.md"`));
  console.log("");
}
