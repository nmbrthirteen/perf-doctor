---
name: perf-doctor
description: Measure Core Web Vitals on every route, find the cause in the code, fix it, and verify the fix moved the number. Use when the user asks why a page is slow, wants faster loading, mentions LCP, CLS, Core Web Vitals, page speed, or a performance regression.
---

# perf-doctor

Make pages load fast, and prove it with a measurement.

## The loop

1. `npx perf-doctor`
2. Read `.perf/report.md`
3. Fix the high severity findings, worst route first
4. `npx perf-doctor` again
5. Report the LCP delta per route. If the number didn't move, revert.

Measure production builds. A dev server ships unminified code and unoptimized images, so its numbers describe a page nobody will ever load.

These are throttled lab numbers, not field data. The score is a lab estimate, not Google's field score, and the two can disagree. Real INP is a field metric because it depends on real interactions, so it is not measured here; blocking time is the load-phase proxy. Confirm any real-user regression against field data (RUM or CrUX), not this alone.

## Reading the report

LCP splits into four phases. The dominant one tells you which class of fix applies, so start there instead of guessing.

| Dominant phase | Meaning | Where to look |
| --- | --- | --- |
| ttfb | slow server response | caching, server-side data fetching |
| load delay | image discovered late | preload, priority, client-side rendering |
| load time | image too heavy | sizes, format, quality |
| render delay | image arrived, then waited to paint | hydration, JS-gated opacity, fonts, render-blocking CSS |

## Fixes by rule

- `lcp-third-party-element`: a consent banner or chat widget outranks the hero, so hero tweaks won't help. Load its script earlier or shrink its painted area.
- `lcp-not-in-ssr-html`: the LCP element is client-rendered, so the preload scanner never sees it. Render it during SSR; seed client queries with server data (react-query `initialData` or props).
- `lcp-image-deprioritized`: remove `fetchpriority="low"` / `loading="lazy"` and set `priority`. If it's hardcoded in a shared component, make priority a prop.
- `lcp-image-not-preloaded`: set `priority` (next/image emits the preload), or add `<link rel="preload" as="image">` with matching src, srcset, and sizes.
- `lcp-image-oversized`: `sizes` resolves to a candidate far larger than the rendered box. If it comes from a JS hook it's wrong on first render; write it as a CSS media query.
- `lcp-render-delay-dominant`: the image downloaded early and painted late, usually an opacity animation starting at 0. Paint it visible on the server, let the animation enhance.
- `lcp-js-starvation`: the bundle eats the hero's bandwidth. Defer below-fold client components and third-party scripts.
- `lcp-render-blocking`: a stylesheet or synchronous script in the head gates the paint, so nothing shows until it lands. Inline the critical CSS, load the rest without blocking, and serve fonts through next/font so their CSS doesn't hold up the first paint.
- `cls-poor`: reserve space before content lands (width and height, or aspect-ratio).
- `blocking-time-high`: lab proxy for INP. Hydrate fewer client components.
- `assets-weak-cache`: first-party static assets are served without a durable cache, so returning visitors re-download them. Cache content-hashed assets for a year (`max-age=31536000, immutable`); for a stable URL that can change, use a shorter max-age or version the name. This is a repeat-visit win and does not move the first-load numbers.

## Rules

- One change at a time, then measure. Two at once means you can't attribute the result.
- Never make a visual change to hit a number without asking first. Deferring below-fold content, cutting image quality, and removing animations are all visible.
- Quote real numbers from the report. No before and after, no claim.
