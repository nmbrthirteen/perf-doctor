import type { ElementInfo, LcpInfo, ProbeResult, ShiftInfo } from "./types.js";

export function probe(settleMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let lcp: LcpInfo | null = null;
    const shifts: ShiftInfo[] = [];
    const longTasks: { start: number; duration: number }[] = [];

    const describe = (el: Element | null): ElementInfo | null => {
      if (!el) return null;
      const img = el instanceof HTMLImageElement ? el : null;
      const chain: string[] = [];
      let node: Element | null = el;

      for (let i = 0; node && i < 5; i++) {
        const cls = node.getAttribute("class");
        chain.push(
          node.tagName.toLowerCase() +
            (node.id ? "#" + node.id : "") +
            (cls ? "." + cls.trim().split(/\s+/).slice(0, 3).join(".") : ""),
        );
        node = node.parentElement;
      }

      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: (el.getAttribute("class") || "").slice(0, 160) || null,
        text: (el.textContent || "").trim().slice(0, 80) || null,
        alt: img ? img.getAttribute("alt") : null,
        src: img ? img.currentSrc || img.src : null,
        srcAttr: img ? img.getAttribute("src") : null,
        fetchPriority: el.getAttribute("fetchpriority"),
        loading: el.getAttribute("loading"),
        sizes: img ? img.getAttribute("sizes") : null,
        naturalWidth: img ? img.naturalWidth : null,
        displayWidth: Math.round(el.getBoundingClientRect().width),
        ancestors: chain,
      };
    };

    let lastLcpAt = 0;
    let lastShiftAt = 0;

    const onLcp = (entry: PerformanceEntry) => {
      lastLcpAt = performance.now();

      // SAFETY: entries from the largest-contentful-paint observer are LargestContentfulPaint, which lib.dom omits.
      const e = entry as PerformanceEntry & {
        renderTime: number;
        loadTime: number;
        size: number;
        url?: string;
        element?: Element | null;
      };

      lcp = {
        time: Math.round(e.renderTime || e.loadTime || e.startTime),
        size: Math.round(e.size),
        url: e.url || null,
        element: describe(e.element ?? null),
      };
    };

    const onShift = (entry: PerformanceEntry) => {
      // SAFETY: entries from the layout-shift observer are LayoutShift, which lib.dom omits.
      const e = entry as PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: { node?: Element | null }[];
      };

      if (e.hadRecentInput) return;
      lastShiftAt = performance.now();
      shifts.push({
        value: e.value,
        time: Math.round(e.startTime),
        sources: (e.sources || []).slice(0, 2).map((s) => ({
          tag: s.node?.tagName ? s.node.tagName.toLowerCase() : null,
          cls: s.node?.getAttribute ? (s.node.getAttribute("class") || "").slice(0, 80) || null : null,
          text: s.node?.textContent ? s.node.textContent.trim().slice(0, 50) || null : null,
        })),
      });
    };

    const onLongTask = (e: PerformanceEntry) => {
      longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
    };

    const observers: { po: PerformanceObserver; cb: (e: PerformanceEntry) => void }[] = [];
    const failed = new Map<string, string>();

    const observe = (type: string, cb: (e: PerformanceEntry) => void) => {
      try {
        const po = new PerformanceObserver((list) => {
          list.getEntries().forEach(cb);

          if (type !== "longtask") reschedule();
        });

        po.observe({ type, buffered: true });
        observers.push({ po, cb });
      } catch (err) {
        failed.set(type, err instanceof Error ? err.message : String(err));
      }
    };

    const sessionCls = (): number | null => {
      if (!shifts.length) return 0;
      const sorted = shifts.slice().sort((a, b) => a.time - b.time);
      let max = 0;
      let sum = 0;
      let windowStart = -Infinity;
      let last = -Infinity;

      for (const s of sorted) {
        if (s.time - last > 1000 || s.time - windowStart > 5000) {
          sum = 0;
          windowStart = s.time;
        }

        sum += s.value;
        last = s.time;

        if (sum > max) max = sum;
      }

      return Number(max.toFixed(4));
    };

    let collected = false;
    let loadedAt: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const collect = () => {
      if (collected) return;
      collected = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);

      for (const { po, cb } of observers) {
        po.takeRecords().forEach(cb);
        po.disconnect();
      }

      // SAFETY: the "navigation" entry type only yields PerformanceNavigationTiming.
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;

      const resources = performance.getEntriesByType("resource").map((entry) => {
        // SAFETY: the "resource" entry type only yields PerformanceResourceTiming; renderBlockingStatus is missing from lib.dom.
        const r = entry as PerformanceResourceTiming & { renderBlockingStatus?: string };

        return {
          name: r.name,
          type: r.initiatorType,
          start: Math.round(r.startTime),
          requestStart: Math.round(r.requestStart || r.startTime),
          responseEnd: Math.round(r.responseEnd),
          transferSize: r.transferSize || 0,
          encodedSize: r.encodedBodySize || 0,
          renderBlocking: r.renderBlockingStatus ?? null,
        };
      });

      const preloads = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"]')).map((l) => ({
        rel: l.getAttribute("rel") || "",
        href: l.href || "",
        imagesrcset: l.getAttribute("imagesrcset"),
      }));

      const worstShift = shifts.slice().sort((a, b) => b.value - a.value)[0] || null;

      const tbt = failed.has("longtask")
        ? null
        : longTasks.reduce((a, t) => a + Math.max(0, t.duration - 50), 0);

      resolve({
        lcp,
        ttfb: Math.round(nav?.responseStart || 0),
        cls: failed.has("layout-shift") ? null : sessionCls(),
        worstShift,
        tbt,
        longTaskCount: longTasks.length,
        resources,
        preloads,
        observerErrors: [...failed].map(([type, msg]) => `${type}: ${msg}`),
      });
    };

    // Settled once past 2.5s with no LCP update for 2s and no shift for 1.5s, or at settleMs.
    function reschedule(): void {
      if (loadedAt == null || collected) return;
      const stableAt = Math.max(loadedAt + 2500, lastLcpAt + 2000, lastShiftAt + 1500);
      const deadline = Math.min(loadedAt + settleMs, stableAt);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(collect, Math.max(0, deadline - performance.now()));
    }

    const settle = () => {
      loadedAt = performance.now();
      reschedule();
    };

    observe("largest-contentful-paint", onLcp);
    observe("layout-shift", onShift);
    observe("longtask", onLongTask);

    if (document.readyState === "complete") settle();
    else addEventListener("load", settle);
    hardTimer = setTimeout(collect, 45000);
  });
}
