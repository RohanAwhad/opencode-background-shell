import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export function locateDatabase(): string {
  return process.env.OPENCODE_DB ?? `${homedir()}/.local/share/opencode/opencode.db`;
}

export function runSqlite(dbPath: string, sql: string): unknown {
  const stdout = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (stdout.trim() === "") {
    return null;
  }
  return JSON.parse(stdout);
}

export function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}
