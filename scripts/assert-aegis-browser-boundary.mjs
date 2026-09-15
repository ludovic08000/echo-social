import { readdir, readFile } from "node:fs/promises";
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

const violations = [];
for (const file of await listTextFiles(outputRoot)) {
  const contents = await readFile(file, "utf8");
  const matched = forbiddenPatterns.find((pattern) => pattern.test(contents));
  if (matched) violations.push(relative(outputRoot, file));
}

if (violations.length > 0) {
  throw new Error(
    `Retired browser-auth implementation found in production output: ${violations.join(", ")}`,
  );
}

console.log("[aegis-browser-boundary] production output contains only the supported device path");
