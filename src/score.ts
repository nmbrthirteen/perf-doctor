import type { RouteResult } from "./types.js";

const CURVES: Record<"lcp" | "cls" | "tbt", [number, number]> = {
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  tbt: [200, 600],
};

function metricScore(v: number | null | undefined, good: number, ok: number): number | null {
  if (v == null) return null;
  if (v <= good) return 100;
  if (v <= ok) return Math.round(90 - (40 * (v - good)) / (ok - good));
  const floor = ok * 3;
  if (v >= floor) return 0;
  return Math.round(50 - (50 * (v - ok)) / (floor - ok));
}

function routeScore(r: RouteResult): number | null {
  if (!r.lcp) return null;
  const parts: [number | null, number][] = [
    [metricScore(r.lcp.time, ...CURVES.lcp), 0.5],
    [metricScore(r.cls, ...CURVES.cls), 0.25],
    [metricScore(r.tbt, ...CURVES.tbt), 0.25],
  ];
  let sum = 0;
  let weight = 0;
  for (const [s, w] of parts) {
    if (s == null) continue;
    sum += s * w;
    weight += w;
  }
  return weight ? Math.round(sum / weight) : null;
}

export function siteScore(results: RouteResult[]): number | null {
  const scores = results.map(routeScore).filter((s): s is number => s != null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function scoreBand(s: number): "good" | "needs work" | "poor" {
  return s >= 90 ? "good" : s >= 50 ? "needs work" : "poor";
}
