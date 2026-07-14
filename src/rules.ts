import type { Finding, RuleContext, Severity, SourceIndex } from "./types.js";

const VENDORS: [string, string][] = [
  ["termly", "Termly consent banner"],
  ["onetrust", "OneTrust consent banner"],
  ["cookiebot", "Cookiebot consent banner"],
  ["cookieyes", "CookieYes consent banner"],
  ["iubenda", "Iubenda consent banner"],
  ["usercentrics", "Usercentrics consent banner"],
  ["osano", "Osano consent banner"],
  ["intercom", "Intercom widget"],
  ["drift-widget", "Drift widget"],
  ["hubspot", "HubSpot widget"],
  ["zendesk", "Zendesk widget"],
  ["crisp-client", "Crisp widget"],
];

const kb = (bytes: number) => `${Math.round(bytes / 1024)}KB`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function underlyingSrc(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, "http://x");
    const inner = u.searchParams.get("url");
    return inner ? decodeURIComponent(inner) : url;
  } catch {
    return url;
  }
}

function srcFingerprint(url: string | null): string | null {
  const real = underlyingSrc(url);
  if (!real) return null;
  const name = real.split("?")[0]!.split("/").pop();
  return name && name.length > 6 ? name : real.slice(-40);
}

function hasToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(haystack);
}

function vendorOf(ctx: RuleContext): string | null {
  const el = ctx.element;
  if (!el) return null;
  const haystack = [el.cls, el.id, el.src, ...(el.ancestors || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const [token, label] of VENDORS) {
    if (hasToken(haystack, token)) return label;
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x?27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function htmlHasText(html: string, text: string): boolean {
  const collapse = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();
  return collapse(html).includes(collapse(text));
}

function htmlHasSrc(html: string, fingerprint: string): boolean {
  if (html.includes(fingerprint)) return true;
  if (html.includes(encodeURIComponent(fingerprint))) return true;
  try {
    if (html.includes(decodeURIComponent(fingerprint))) return true;
  } catch {}
  return false;
}

type Rule = { id: string; run: (ctx: RuleContext) => Omit<Finding, "rule" | "route"> | null };

const RULES: Rule[] = [
  {
    id: "lcp-third-party-element",
    run(ctx) {
      const vendor = vendorOf(ctx);
      if (!vendor || !ctx.lcp) return null;
      return {
        severity: "high",
        title: `${vendor} is the LCP element`,
        evidence: `${vendor} (${ctx.lcp.size}px, painted at ${ctx.lcp.time}ms) outranks your hero, so hero tweaks won't move LCP on this route.`,
        fix: `Load its script earlier so it finishes before the hero paints, or shrink its painted area so the hero wins. Check the script strategy for ${vendor} in your layout.`,
      };
    },
  },
  {
    id: "lcp-not-in-ssr-html",
    run(ctx) {
      if (!ctx.lcp || !ctx.html || vendorOf(ctx)) return null;
      const el = ctx.element;
      if (!el) return null;
      if (el.src) {
        const fp = srcFingerprint(el.src);
        if (!fp || htmlHasSrc(ctx.html, fp)) return null;
        return {
          severity: "high",
          title: "LCP image was not found in the server HTML",
          evidence: `${fp} isn't in the HTML the server sent, so it's likely client-rendered and the browser can't preload it. Load delay: ${ctx.phases?.loadDelay ?? "?"}ms. Confirm in the page source.`,
          fix: "Render it during SSR. If a client hook fetches its data, seed it with server data (react-query initialData, or props).",
        };
      }
      if (el.text && el.text.length >= 12) {
        if (htmlHasText(ctx.html, el.text.slice(0, 40))) return null;
        return {
          severity: "medium",
          title: "LCP text was not found in the server HTML",
          evidence: `The LCP text ("${el.text.slice(0, 40)}") isn't in the server response, so it likely renders after hydration. Text split across nested elements can also cause this, so confirm in the page source.`,
          fix: "Render this text during SSR so it paints from the first response.",
        };
      }
      return null;
    },
  },
  {
    id: "lcp-image-deprioritized",
    run(ctx) {
      const el = ctx.element;
      if (!el || el.tag !== "img" || !ctx.phases) return null;
      const low = el.fetchPriority === "low";
      const lazy = el.loading === "lazy";
      if (!low && !lazy) return null;
      return {
        severity: "high",
        title: `LCP image is marked ${low ? 'fetchpriority="low"' : 'loading="lazy"'}`,
        evidence: `The image that wins LCP is explicitly deprioritized, so it downloads after everything else. Load delay: ${ctx.phases.loadDelay}ms.`,
        fix: low
          ? 'Remove fetchpriority="low" and set priority. If it comes from a shared component, make priority a prop instead of removing it everywhere.'
          : 'Remove loading="lazy" and set priority (next/image).',
      };
    },
  },
  {
    id: "lcp-image-not-preloaded",
    run(ctx) {
      const el = ctx.element;
      if (!el || !ctx.lcp?.url || !ctx.phases) return null;
      if (ctx.phases.loadDelay < 400) return null;
      if (el.fetchPriority === "low" || el.loading === "lazy") return null;
      const fp = srcFingerprint(ctx.lcp.url);
      if (!fp) return null;
      const preloaded = ctx.m.preloads.some(
        (p) => p.rel === "preload" && (p.href.includes(fp) || (p.imagesrcset ?? "").includes(fp)),
      );
      if (preloaded) return null;
      return {
        severity: "high",
        title: "LCP image is not preloaded",
        evidence: `The browser waited ${ctx.phases.loadDelay}ms before requesting the LCP image, and there's no preload link for it in the head.`,
        fix: "Set priority on the image (next/image emits the preload for you), or add <link rel=preload as=image> with the same src, srcset, and sizes.",
      };
    },
  },
  {
    id: "lcp-image-oversized",
    run(ctx) {
      const el = ctx.element;
      if (!el || el.tag !== "img" || !el.naturalWidth || !el.displayWidth || !ctx.phases) return null;
      const dpr = ctx.profile.deviceScaleFactor || 1;
      const target = el.displayWidth * dpr;
      if (!target) return null;
      const ratio = el.naturalWidth / target;
      if (ratio < 1.6) return null;
      const bytes = ctx.m.lcpResource?.transferSize || 0;
      return {
        severity: bytes > 150 * 1024 ? "high" : "medium",
        title: `LCP image is ${ratio.toFixed(1)}x larger than it renders`,
        evidence: `${el.naturalWidth}px wide but renders at ${el.displayWidth}px on a ${dpr}x screen, so ${target}px would do.${bytes ? ` Cost: ${kb(bytes)}, ${ctx.phases.loadTime}ms.` : ""} sizes is ${el.sizes ? `"${el.sizes}"` : "not set"}.`,
        fix: el.sizes
          ? "sizes picks the wrong candidate on this viewport. Write it as a CSS media query so it resolves before JS runs; a value from a JS hook is wrong on first render, exactly when the preload fires."
          : "Add a sizes attribute so the browser picks a smaller srcset candidate.",
      };
    },
  },
  {
    id: "lcp-render-delay-dominant",
    run(ctx) {
      const p = ctx.phases;
      if (!p || p.kind !== "image") return null;
      if (p.renderDelay < 1000 || p.renderDelay / p.total < 0.35) return null;
      const gated = ctx.attribution?.source
        ? /opacity-0|opacity:\s*0|initial=\{\{[^}]*opacity/.test(ctx.attribution.source)
        : false;
      return {
        severity: "high",
        title: "LCP image downloads early, then paints late",
        evidence: `Downloaded by ${p.ttfb + p.loadDelay + p.loadTime}ms, painted at ${p.total}ms. Render delay is ${p.renderDelay}ms, ${pct(p.renderDelay / p.total)} of LCP.${gated ? ` ${ctx.attribution?.file} contains an opacity-0 pattern, so the paint may be gated on hydration; verify it applies here.` : ""}`,
        fix: "Something blocks the paint, usually hydration, a JS-gated opacity animation, or a font. Make the hero paint without JS and let the animation enhance from there.",
      };
    },
  },
  {
    id: "lcp-js-starvation",
    run(ctx) {
      const scriptBytes = ctx.m.bytesByType["script"] || 0;
      if (scriptBytes < 300 * 1024) return null;
      const third = Object.entries(ctx.m.thirdPartyBytes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([host, b]) => {
          try {
            return `${new URL(host).hostname} ${kb(b)}`;
          } catch {
            return `${host} ${kb(b)}`;
          }
        })
        .join(", ");
      return {
        severity: scriptBytes > 700 * 1024 ? "high" : "medium",
        title: `${kb(scriptBytes)} of JavaScript downloads before LCP`,
        evidence: `${kb(scriptBytes)} of JS (of ${kb(ctx.m.bytesBeforeLcp)} total) downloads before LCP and competes with the hero for bandwidth.${third ? ` Biggest third parties: ${third}.` : ""}`,
        fix: "Defer below-fold client components, drop unused libraries, and load third-party scripts after the page is interactive.",
      };
    },
  },
  {
    id: "lcp-ttfb-slow",
    run(ctx) {
      if (!ctx.m.ttfb || ctx.m.ttfb < 800) return null;
      return {
        severity: ctx.m.ttfb > 1800 ? "high" : "medium",
        title: `Server takes ${ctx.m.ttfb}ms to first byte`,
        evidence: `Everything else waits on this. It's ${pct(ctx.m.ttfb / (ctx.phases?.total || ctx.m.ttfb))} of LCP on this route.`,
        fix: "Cache the response or move the slow fetch off the render path. A static or revalidated page removes this cost entirely.",
      };
    },
  },
  {
    id: "lcp-image-heavy",
    run(ctx) {
      const p = ctx.phases;
      if (!p || p.kind !== "image" || p.loadTime < 1500) return null;
      if (p.loadTime / p.total < 0.3) return null;
      const bytes = ctx.m.lcpResource?.transferSize || 0;
      return {
        severity: "medium",
        title: `LCP image takes ${p.loadTime}ms to download`,
        evidence: `${bytes ? `${kb(bytes)} ` : ""}on the wire, ${pct(p.loadTime / p.total)} of LCP. The request started on time; the bytes are the problem.`,
        fix: "Serve a smaller image: correct sizes, a modern format, lower quality. Most heroes survive quality 75 without visible change.",
      };
    },
  },
  {
    id: "cls-poor",
    run(ctx) {
      if (ctx.m.cls == null || ctx.m.cls <= 0.1) return null;
      const s = ctx.m.worstShift?.sources?.[0];
      return {
        severity: ctx.m.cls > 0.25 ? "high" : "medium",
        title: `Layout shifts by ${ctx.m.cls}`,
        evidence: s
          ? `Largest shift moves <${s.tag}${s.cls ? ` class="${s.cls}"` : ""}>${s.text ? ` "${s.text}"` : ""} at ${ctx.m.worstShift?.time}ms.`
          : `Cumulative layout shift is ${ctx.m.cls}, above the 0.1 threshold.`,
        fix: "Reserve the space before content lands: width and height or aspect-ratio on images and embeds, and size anything that appears after hydration.",
      };
    },
  },
  {
    id: "blocking-time-high",
    run(ctx) {
      if (!ctx.m.tbt || ctx.m.tbt < 300) return null;
      return {
        severity: ctx.m.tbt > 800 ? "high" : "medium",
        title: `${ctx.m.tbt}ms of main thread blocking`,
        evidence: `${ctx.m.longTaskCount} long tasks froze the main thread. INP needs a real interaction, so this is the lab proxy: a page that blocks this long feels slow to tap.`,
        fix: "Break up or defer the work that runs on load. Hydrating fewer client components is usually the biggest win.",
      };
    },
  },
];

type SourceRule = { id: string; run: (index: SourceIndex) => Omit<Finding, "rule"> | null };

const SOURCE_RULES: SourceRule[] = [
  {
    id: "src-fetchpriority-low",
    run(index) {
      const hits = index.searchRegex(/fetchPriority=["']low["']/g, { limit: 3 });
      if (!hits.length) return null;
      const first = hits[0]!;
      return {
        severity: "medium",
        title: 'A component hardcodes fetchPriority="low"',
        evidence: `Found in ${hits.map((h) => `${h.file}:${h.line}`).join(", ")}. If any of these render above the fold, they suppress the real LCP image there.`,
        fix: "Make priority a prop instead of hardcoding low, and pass it for the first card or the hero.",
        file: first.file,
        line: first.line,
      };
    },
  },
  {
    id: "src-sizes-from-js",
    run(index) {
      const hits = index.searchRegex(
        /sizes=\{[^}]*(useMobile|isMobile|useMediaQuery|useWindow|window\.)/g,
        { limit: 3 },
      );
      if (!hits.length) return null;
      const first = hits[0]!;
      return {
        severity: "high",
        title: "An image sizes attribute is computed from JavaScript",
        evidence: `Found in ${hits.map((h) => `${h.file}:${h.line}`).join(", ")}. These hooks return their desktop default on first render, so mobile preloads a desktop sized image.`,
        fix: 'Write sizes as a CSS media query, like sizes="(max-width: 1023px) 640px, 1280px", so it resolves without JS.',
        file: first.file,
        line: first.line,
      };
    },
  },
];

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const bySeverity = (a: Finding, b: Finding) => ORDER[a.severity] - ORDER[b.severity];

export function runRules(ctx: RuleContext): Finding[] {
  if (ctx.m.error) return [];
  const findings: Finding[] = [];
  for (const rule of RULES) {
    let f: Omit<Finding, "rule" | "route"> | null;
    try {
      f = rule.run(ctx);
    } catch {
      f = null;
    }
    if (!f) continue;
    const located =
      f.file || !ctx.attribution
        ? {}
        : { file: ctx.attribution.file, line: ctx.attribution.line, foundBy: ctx.attribution.how };
    findings.push({ ...f, ...located, rule: rule.id, route: ctx.route });
  }
  return findings.sort(bySeverity);
}

export function runSourceRules(index: SourceIndex): Finding[] {
  const findings: Finding[] = [];
  for (const rule of SOURCE_RULES) {
    let f: Omit<Finding, "rule"> | null;
    try {
      f = rule.run(index);
    } catch {
      f = null;
    }
    if (f) findings.push({ ...f, rule: rule.id });
  }
  return findings.sort(bySeverity);
}
