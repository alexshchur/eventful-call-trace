import { execSync } from "child_process";
import { assert } from "ts-essentials";

// Composable file cache wrapper for any sync function
export function fileCache<T extends (...args: any[]) => any>(
  fn: T,
  options?: { cacheDir?: string }
): T {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const cacheDir =
    options?.cacheDir || path.resolve(__dirname, "../../../.cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
  return ((...args: any[]) => {
    // Sanitize command: if first arg is a string, trim and collapse whitespace
    let sanitized = "";
    if (typeof args[0] === "string") {
      sanitized = args[0]
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[^a-zA-Z0-9_.-]+/g, "_")
        .slice(0, 64);
    } else {
      sanitized = JSON.stringify(args)
        .replace(/[^a-zA-Z0-9_.-]+/g, "_")
        .slice(0, 64);
    }
    const key = JSON.stringify(args);
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const cacheFile = path.join(cacheDir, sanitized + "_" + hash + ".json");
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    }
    const result = fn(...args);
    fs.writeFileSync(cacheFile, JSON.stringify(result), "utf-8");
    return result;
  }) as T;
}

// Utility to run shell commands and fetch JSON
export function fetchJson(command: string): any {
  const output = execSync(command, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 100,
  });
  assert(output, `No output from ${command}`);
  return JSON.parse(output);
}

// Example: cached version
export const cachedFetchJson = fileCache(fetchJson);
