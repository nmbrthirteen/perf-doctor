import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

const CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export function findBrowser(): string | null {
  if (process.env["PERF_DOCTOR_CHROME"]) return process.env["PERF_DOCTOR_CHROME"];
  for (const path of CANDIDATES[process.platform] ?? []) {
    if (existsSync(path)) return path;
  }
  return null;
}

export async function launch(): Promise<Browser> {
  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error(
      "No Chrome, Chromium, Edge, or Brave found. Install Chrome, or set PERF_DOCTOR_CHROME to a browser binary.",
    );
  }
  return chromium.launch({
    executablePath,
    args: ["--disable-features=Translate,AcceptCHFrame", "--no-first-run"],
  });
}
