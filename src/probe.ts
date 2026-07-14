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
    const observe = (type: string, cb: (e: PerformanceEntry) => void) => {
      try {
        const po = new PerformanceObserver((list) => list.getEntries().forEach(cb));
        po.observe({ type, buffered: true } as PerformanceObserverInit);
        observers.push({ po, cb });
      } catch {}
    };

    observe("largest-contentful-paint", onLcp);
    observe("layout-shift", onShift);
    observe("longtask", onLongTask);

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
    const collect = () => {
      if (collected) return;
      collected = true;
      for (const { po, cb } of observers) {
        po.takeRecords().forEach(cb);
        po.disconnect();
      }

      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const resources = performance.getEntriesByType("resource").map((entry) => {
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

      const preloads = Array.from(document.querySelectorAll('link[rel="preload"]')).map((l) => ({
        rel: l.getAttribute("rel") || "",
        href: (l as HTMLLinkElement).href || "",
        imagesrcset: l.getAttribute("imagesrcset"),
      }));

      const worstShift = shifts.slice().sort((a, b) => b.value - a.value)[0] || null;
      const tbt = longTasks.reduce((a, t) => a + Math.max(0, t.duration - 50), 0);

      resolve({
        lcp,
        ttfb: Math.round(nav?.responseStart || 0),
        cls: sessionCls(),
        worstShift,
        tbt,
        longTaskCount: longTasks.length,
        resources,
        preloads,
      });
    };

    const settle = () => {
      const loadedAt = performance.now();
      const iv = setInterval(() => {
        const now = performance.now();
        const sinceLoad = now - loadedAt;
        const stable = now - lastLcpAt >= 2000 && now - lastShiftAt >= 1500;
        if (sinceLoad >= settleMs || (sinceLoad >= 2500 && stable)) {
          clearInterval(iv);
          collect();
        }
      }, 250);
    };

    if (document.readyState === "complete") settle();
    else addEventListener("load", settle);
    setTimeout(collect, 45000);
  });
}
