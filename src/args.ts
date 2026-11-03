export interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };

  for (const a of argv) {
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }

    const body = a.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);

    if (key) args[key] = eq === -1 ? true : body.slice(eq + 1);
  }

  return args;
}

export function stringFlag(args: Args, key: string): string | undefined {
  const value = args[key];

  return value === true || value === false || Array.isArray(value) ? undefined : value;
}

export function parseCount(name: string, raw: string | number | boolean | string[] | undefined, fallback: number): number {
  if (raw === undefined) return fallback;

  const text = String(raw);
  const n = /^\d+$/.test(text) ? Number(text) : NaN;

  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a whole number of 1 or more, got "${String(raw)}". Try --${name}=3.`);
  }

  return n;
}
