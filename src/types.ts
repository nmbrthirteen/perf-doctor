export interface ElementInfo {
  tag: string;
  id: string | null;
  cls: string | null;
  text: string | null;
  alt: string | null;
  src: string | null;
  srcAttr: string | null;
  fetchPriority: string | null;
  loading: string | null;
  sizes: string | null;
  naturalWidth: number | null;
  displayWidth: number;
  ancestors: string[];
}

export interface LcpInfo {
  time: number;
  size: number;
  url: string | null;
  element: ElementInfo | null;
}

export interface ResourceInfo {
  name: string;
  type: string;
  start: number;
  requestStart: number;
  responseEnd: number;
  transferSize: number;
  encodedSize: number;
  renderBlocking: string | null;
}

export interface ShiftSource {
  tag: string | null;
  cls: string | null;
  text: string | null;
}

export interface ShiftInfo {
  value: number;
  time: number;
  sources: ShiftSource[];
}

export interface PreloadInfo {
  rel: string;
  href: string;
  imagesrcset: string | null;
}

export interface ProbeResult {
  lcp: LcpInfo | null;
  ttfb: number;
  cls: number | null;
  worstShift: ShiftInfo | null;
  tbt: number;
  longTaskCount: number;
  resources: ResourceInfo[];
  preloads: PreloadInfo[];
}

export interface Phases {
  ttfb: number;
  loadDelay: number;
  loadTime: number;
  renderDelay: number;
  total: number;
  kind: "image" | "text";
}

export interface DominantPhase {
  name: "ttfb" | "loadDelay" | "loadTime" | "renderDelay";
  value: number;
  share: number;
}

export interface Profile {
  label: string;
  cpu: number;
  network: {
    offline: boolean;
    downloadThroughput: number;
    uploadThroughput: number;
    latency: number;
  } | null;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  userAgent: string | null;
}

export interface Measurement extends ProbeResult {
  error: string | null;
  phases: Phases | null;
  lcpResource: ResourceInfo | null;
  bytesBeforeLcp: number;
  bytesByType: Record<string, number>;
  thirdPartyBytes: Record<string, number>;
  cacheByUrl: Record<string, string | null>;
  html: string;
}

export interface NetworkAsset {
  url: string;
  type: string;
  cacheControl: string | null;
  bytes: number;
}

export type Severity = "high" | "medium" | "low";

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  evidence: string;
  fix: string;
  route?: string;
  file?: string;
  line?: number;
  foundBy?: string;
}

export interface Attribution {
  how: string;
  file: string;
  line: number;
  source?: string;
}

export interface SourceIndex {
  sources: SourceFile[];
  locales: SourceFile[];
  cwd: string;
  search: (needle: string, opts?: SearchOpts) => SearchHit[];
  searchRegex: (re: RegExp, opts?: SearchOpts) => SearchHit[];
  resolveI18n: (text: string) => { key: string; locale: string } | null;
}

export interface SourceFile {
  rel: string;
  content: string;
}

export interface SearchOpts {
  limit?: number;
  files?: SourceFile[];
}

export interface SearchHit {
  file: string;
  line: number;
  content?: string;
}

export interface RuleContext {
  route: string;
  m: Measurement;
  lcp: LcpInfo | null;
  element: ElementInfo | null;
  phases: Phases | null;
  dominant: DominantPhase | null;
  html: string;
  profile: Profile;
  index: SourceIndex | null;
  attribution: Attribution | null;
}

export interface RouteResult {
  route: string;
  url: string;
  lcp: LcpInfo | null;
  phases: Phases | null;
  dominant: DominantPhase | null;
  cls: number | null;
  tbt: number | null;
  ttfb: number | null;
  bytesBeforeLcp: number;
  bytesByType: Record<string, number>;
  error: string | null;
  attribution: { file: string; line: number; how: string } | null;
  findings: Finding[];
}

export interface ReportMeta {
  base: string;
  profileName: string;
  profileLabel: string;
  runs: number;
  at: string;
  devServer: boolean;
}

export interface Config {
  base?: string;
  profile?: string;
  routes?: string[];
  runs?: number;
  parallel?: number;
  params?: Record<string, string[]>;
}

export interface DiscoveredRoute {
  route: string;
  file: string | null;
}

export interface Project {
  framework: string;
  appDir: string | undefined;
  pagesDir: string | undefined;
}
