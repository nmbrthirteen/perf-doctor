<p align="center">
  <img src="assets/icon.svg" alt="perf-doctor" width="96" height="96">
</p>

<h1 align="center">perf-doctor</h1>

<p align="center">Find out why your pages load slow, then fix it.</p>

```bash
npx perf-doctor@latest
```

It measures every route of your app on a throttled connection, shows which element won LCP and why it was late, points at the file, and scores the site 0-100. At the end, pick your coding agent: it fixes the findings and perf-doctor re-measures, so you see the before and after.

```
✓ /        6032ms   0.00   939ms  img cover_88b2f2d54a.jpg
✓ /about  14616ms   0.00   704ms  div "We use essential cookies"

Score  ████████░░░░░░░░░░░░  41/100 poor

Findings  3 high · 2 medium
  ! /about  LCP image is marked loading="lazy"  components/BounceCards.tsx:145

Hand these findings to an agent?
  › Claude Code
```

Other ways to run it:

```bash
npx perf-doctor /stories 3              # one route, median of 3 runs
npx perf-doctor https://site.com/page   # any page anywhere
npx perf-doctor desktop                 # no throttling
npx perf-doctor fix                     # measure, fix, re-measure, no questions
npx perf-doctor install                 # teach your agent the loop (uninstall undoes it)
```

Needs Node 18+ and a Chrome installed, nothing else. The full report lands in `.perf/report.md`. Run `--help` for flags.

MIT
