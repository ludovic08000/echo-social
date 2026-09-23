import { access, readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const outputRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".webmanifest"]);
const forbiddenPatterns = [
  new RegExp(["web", "authn"].join(""), "i"),
  new RegExp(["web", "_", "authn"].join(""), "i"),
  new RegExp(["windows", "[ _-]?", "hello"].join(""), "i"),
  new RegExp(`${["pass", "key"].join("")}\\b`, "i"),
  new RegExp(["public", "key", "credential"].join(""), "i"),
  new RegExp(["navigator", "\\.", "credentials"].join(""), "i"),
  new RegExp(["authenticator", "attachment"].join(""), "i"),
  new RegExp(["allow", "credentials"].join(""), "i"),
  new RegExp(["exclude", "credentials"].join(""), "i"),
  // L'auth Lovable Cloud doit rester sur la coordination sans verrou du SDK.
  // Ce message et cette clé identifient l'ancien chemin Navigator LockManager.
  new RegExp(["navigator", " lockmanager"].join(""), "i"),
  new RegExp(["lock:sb-", "[a-z0-9]+", "-auth-token"].join(""), "i"),
];

async function listTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTextFiles(absolutePath));
    } else if (textExtensions.has(extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

const outputFiles = await listTextFiles(outputRoot);
const outputContents = new Map();
const violations = [];
for (const file of outputFiles) {
  const contents = await readFile(file, "utf8");
  outputContents.set(file, contents);
  const matched = forbiddenPatterns.find((pattern) => pattern.test(contents));
  if (matched) violations.push(relative(outputRoot, file));
}

if (violations.length > 0) {
  throw new Error(
    `Retired browser-auth implementation found in production output: ${violations.join(", ")}`,
  );
}

const indexPath = join(outputRoot, "index.html");
const serviceWorkerPath = join(outputRoot, "sw.js");
const legacyRegisterPath = join(outputRoot, "registerSW.js");
const indexContents = outputContents.get(indexPath) ?? await readFile(indexPath, "utf8");
const serviceWorkerContents = outputContents.get(serviceWorkerPath) ?? await readFile(serviceWorkerPath, "utf8");
const combinedOutput = [...outputContents.values()].join("\n");
const pwaViolations = [];

try {
  await access(legacyRegisterPath);
  pwaViolations.push("legacy registerSW.js was generated");
} catch {
  // Expected: registration lives in the versioned application bundle.
}

if (indexContents.includes("registerSW.js")) {
  pwaViolations.push("index.html references the legacy passive registrar");
}
if (serviceWorkerContents.includes("index.html")) {
  pwaViolations.push("index.html is trapped in the service-worker precache");
}
if (!serviceWorkerContents.includes("documents-aegis-v1")) {
  pwaViolations.push("navigation NetworkFirst cache is missing");
}
if (!combinedOutput.includes("[PWA_UPDATE]")) {
  pwaViolations.push("active service-worker update checks are missing");
}

if (pwaViolations.length > 0) {
  throw new Error(`Unsafe PWA update boundary: ${pwaViolations.join(", ")}`);
}

console.log("[aegis-browser-boundary] supported device path and active PWA updates verified");
