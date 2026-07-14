import type { Browser } from "playwright-core";
import { probe } from "./probe.js";
import type {
  DominantPhase,
  Measurement,
  Phases,
  ProbeResult,
  Profile,
  ResourceInfo,
} from "./types.js";

export const PROFILES: Record<string, Profile> = {
  mobile: {
    label: "Slow 4G, 4x CPU, 412x915",
    cpu: 4,
    network: {
      offline: false,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      latency: 150,
    },
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  },
  desktop: {
    label: "no throttling, 1440x900",
    cpu: 1,
    network: null,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    userAgent: null,
  },
};

function computePhases(raw: ProbeResult, lcpResource: ResourceInfo | null): Phases | null {
  if (!raw.lcp) return null;
  const ttfb = raw.ttfb || 0;
  const total = raw.lcp.time;
  if (!lcpResource) {
    return { ttfb, loadDelay: 0, loadTime: 0, renderDelay: Math.max(0, total - ttfb), total, kind: "text" };
  }
  const loadDelay = Math.max(0, lcpResource.requestStart - ttfb);
  const loadTime = Math.max(0, lcpResource.responseEnd - lcpResource.requestStart);
  const renderDelay = Math.max(0, total - lcpResource.responseEnd);
  return { ttfb, loadDelay, loadTime, renderDelay, total, kind: "image" };
}

export function dominantPhase(p: Phases | null): DominantPhase | null {
  if (!p) return null;
  const parts: [DominantPhase["name"], number][] = [
    ["ttfb", p.ttfb],
    ["loadDelay", p.loadDelay],
    ["loadTime", p.loadTime],
    ["renderDelay", p.renderDelay],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  const [name, value] = parts[0]!;
  return { name, value, share: p.total ? value / p.total : 0 };
}

function aggregate(raw: ProbeResult, cdpSizes: Map<string, number>, origin: string) {
  const lcpTime = raw.lcp?.time ?? null;
  const bytesByType: Record<string, number> = {};
  const thirdPartyBytes: Record<string, number> = {};
  let bytesBeforeLcp = 0;

  for (const r of raw.resources) {
    const size = cdpSizes.get(r.name) ?? r.transferSize ?? r.encodedSize;
    if (lcpTime == null || r.responseEnd > lcpTime) continue;
    bytesBeforeLcp += size;
    bytesByType[r.type] = (bytesByType[r.type] || 0) + size;
    try {
      const host = new URL(r.name).origin;
      if (host !== origin) thirdPartyBytes[host] = (thirdPartyBytes[host] || 0) + size;
    } catch {}
  }
  return { bytesBeforeLcp, bytesByType, thirdPartyBytes };
}

async function fetchHtml(url: string, userAgent: string | null): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: userAgent ? { "user-agent": userAgent } : {},
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    return await res.text();
  } catch {
    return "";
  }
}

interface MeasureOpts {
  runs?: number;
  settleMs?: number;
  timeout?: number;
  onRun?: (run: number, runs: number) => void;
}

async function measureOnce(
  browser: Browser,
  url: string,
  profile: Profile,
  { settleMs = 5000, timeout = 45000 }: MeasureOpts,
): Promise<Measurement> {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.isMobile,
    userAgent: profile.userAgent ?? undefined,
  });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  const cdpSizes = new Map<string, number>();
  const urlByRequest = new Map<string, string>();
  client.on("Network.responseReceived", (e: { requestId: string; response: { url: string } }) => {
    urlByRequest.set(e.requestId, e.response.url);
  });
  client.on("Network.loadingFinished", (e: { requestId: string; encodedDataLength: number }) => {
    const u = urlByRequest.get(e.requestId);
    if (u) cdpSizes.set(u, (cdpSizes.get(u) || 0) + e.encodedDataLength);
  });

  const empty: ProbeResult = {
    lcp: null,
    ttfb: 0,
    cls: null,
    worstShift: null,
    tbt: 0,
    longTaskCount: 0,
    resources: [],
    preloads: [],
  };

  try {
    await client.send("Network.enable");
    if (profile.network) await client.send("Network.emulateNetworkConditions", profile.network);
    await client.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });

    await page.goto(url, { waitUntil: "commit", timeout });

    let raw: ProbeResult;
    try {
      raw = await page.evaluate(probe, settleMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/context was destroyed|navigation/i.test(msg)) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      raw = await page.evaluate(probe, settleMs);
    }

    const origin = new URL(url).origin;
    const found = raw.lcp?.url ? raw.resources.find((r) => r.name === raw.lcp!.url) ?? null : null;
    const lcpResource = found
      ? { ...found, transferSize: cdpSizes.get(found.name) ?? found.transferSize }
      : null;
    return {
      ...raw,
      ...aggregate(raw, cdpSizes, origin),
      lcpResource,
      phases: computePhases(raw, lcpResource),
      error: null,
      html: "",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return {
      ...empty,
      error: msg,
      phases: null,
      lcpResource: null,
      bytesBeforeLcp: 0,
      bytesByType: {},
      thirdPartyBytes: {},
      html: "",
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function measure(
  browser: Browser,
  url: string,
  profile: Profile,
  opts: MeasureOpts = {},
): Promise<Measurement> {
  const runs = Math.max(1, opts.runs ?? 1);
  const samples: Measurement[] = [];
  for (let i = 0; i < runs; i++) {
    opts.onRun?.(i + 1, runs);
    samples.push(await measureOnce(browser, url, profile, opts));
  }
  const ok = samples.filter((s) => s.lcp);
  if (!ok.length) return samples[0]!;

  ok.sort((a, b) => a.lcp!.time - b.lcp!.time);
  const median = ok[Math.floor(ok.length / 2)]!;
  median.html = await fetchHtml(url, profile.userAgent);
  return median;
}

export function looksLikeDevServer(html: string): boolean {
  return /\/_next\/static\/development\/|\/@vite\/client|webpack-hmr|__NEXT_DEV/.test(html);
}
