// Shared feature extractor for AI Threat Shield ML model.
// 64 features, pure TS, deterministic.

export const FEATURE_DIM = 64;

const DANGER_TOKENS = [
  "union select", "drop table", "or 1=1", "select * from", "information_schema",
  "<script", "onerror=", "onload=", "javascript:", "<iframe", "document.cookie",
  "ignore previous", "system prompt", "developer mode", "jailbroken",
  "../", "..\\", "file://", "gopher://", "127.0.0.1", "169.254.169.254",
  "$where", "$ne", "{{7*7}}", "${", "|cat ", ";rm ", "`whoami`",
  "phantomjs", "headlesschrome", "selenium", "puppeteer",
];

function shannon(s: string): number {
  if (!s) return 0;
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of m.values()) {
    const p = v / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function hashBucket(s: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h % n;
}

export interface FeatureInput {
  payload: string;
  endpoint: string;
  ua: string;
  hourUtc?: number;
  ipFreq1m?: number;
  regexConf?: number;
}

export function extractFeatures(input: FeatureInput): number[] {
  const f = new Array<number>(FEATURE_DIM).fill(0);
  const p = (input.payload ?? "").slice(0, 8000);
  const lp = p.toLowerCase();
  const len = p.length || 1;

  // 0..7 char ratios
  f[0] = countChar(p, "<") / len;
  f[1] = countChar(p, ">") / len;
  f[2] = countChar(p, "'") / len;
  f[3] = countChar(p, '"') / len;
  f[4] = countChar(p, ";") / len;
  f[5] = countChar(p, "\\") / len;
  f[6] = countChar(p, "%") / len;
  f[7] = countChar(p, "$") / len;

  // 8..9 misc
  let nonAscii = 0;
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) > 127) nonAscii++;
  f[8] = nonAscii / len;
  f[9] = Math.min(1, p.length / 4000);

  // 10 entropy normalized (max ~6.5 for utf8 text)
  f[10] = Math.min(1, shannon(p) / 6.5);

  // 11..40 → 30 danger tokens (sigmoid count)
  for (let i = 0; i < DANGER_TOKENS.length && i < 30; i++) {
    const t = DANGER_TOKENS[i];
    let c = 0, idx = 0;
    while ((idx = lp.indexOf(t, idx)) !== -1) { c++; idx += t.length; }
    f[11 + i] = Math.min(1, c / 3);
  }

  // 41..56 → endpoint hashed buckets (16)
  const eb = hashBucket(input.endpoint || "unknown", 16);
  f[41 + eb] = 1;

  // 57..58 → ua bot/headless flags
  const ua = (input.ua || "").toLowerCase();
  f[57] = /(bot|crawl|spider|scrapy|httpclient)/.test(ua) ? 1 : 0;
  f[58] = /(headless|phantom|selenium|puppeteer|playwright)/.test(ua) ? 1 : 0;

  // 59..62 → time/freq
  f[59] = ((input.hourUtc ?? new Date().getUTCHours()) % 24) / 24;
  f[60] = Math.min(1, (input.ipFreq1m ?? 0) / 60);
  f[61] = Math.min(1, (input.regexConf ?? 0) / 100);

  // 62..63 → encoding signals
  f[62] = /(%[0-9a-f]{2}){4,}/i.test(p) ? 1 : 0;
  f[63] = /\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i.test(p) ? 1 : 0;

  return f;
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === c) n++;
  return n;
}

// Inférence logistic regression
export function predict(features: number[], weights: number[], bias: number): number {
  let z = bias;
  const n = Math.min(features.length, weights.length);
  for (let i = 0; i < n; i++) z += features[i] * weights[i];
  // sigmoid
  return 1 / (1 + Math.exp(-z));
}
