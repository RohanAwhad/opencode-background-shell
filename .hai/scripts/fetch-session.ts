import { pathToFileURL } from "node:url";
import { locateDatabase, runSqlite, sqlQuote, writeJsonFile } from "./state-file";

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  project_id: string | null;
  created_ms: number | null;
  updated_ms: number | null;
}

interface PartRow {
  message_id: string;
  role: string | null;
  created_ms: number | null;
  part_id: string;
  part_type: string | null;
  part_text: string | null;
}

interface FetchedMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  created_ms: number | null;
  text: string;
}

interface SessionTranscript {
  session: SessionRow;
  messages: FetchedMessage[];
}

const SESSION_COLUMNS = "id, title, directory, project_id, time_created AS created_ms, time_updated AS updated_ms";

export function findSession(dbPath: string, sessionId: string): SessionRow | null {
  const rows = asRows(
    runSqlite(dbPath, `SELECT ${SESSION_COLUMNS} FROM session WHERE id = ${sqlQuote(sessionId)} LIMIT 1`),
  );
  return rows[0] === undefined ? null : (rows[0] as unknown as SessionRow);
}

export function findLatestSessionForProject(dbPath: string, directory: string): SessionRow | null {
  const rows = asRows(
    runSqlite(
      dbPath,
      `SELECT ${SESSION_COLUMNS} FROM session WHERE directory = ${sqlQuote(directory)} ORDER BY time_updated DESC LIMIT 1`,
    ),
  );
  return rows[0] === undefined ? null : (rows[0] as unknown as SessionRow);
}

export function recentSessionDirectories(dbPath: string, limit = 5): string[] {
  const rows = asRows(
    runSqlite(
      dbPath,
      `SELECT directory, MAX(time_updated) AS latest
       FROM session
       WHERE directory IS NOT NULL AND directory != ''
       GROUP BY directory
       ORDER BY latest DESC
       LIMIT ${limit}`,
    ),
  );
  return rows.flatMap((row) => (typeof row === "object" && row !== null && "directory" in row ? [String(row.directory)] : []));
}

function fetchPartRows(dbPath: string, sessionId: string): PartRow[] {
  const rows = asRows(
    runSqlite(
      dbPath,
      `SELECT m.id AS message_id,
              json_extract(m.data, '$.role') AS role,
              m.time_created AS created_ms,
              p.id AS part_id,
              json_extract(p.data, '$.type') AS part_type,
              json_extract(p.data, '$.text') AS part_text
       FROM message m
       JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
       WHERE m.session_id = ${sqlQuote(sessionId)}
       ORDER BY m.time_created, m.id, p.time_created, p.id`,
    ),
  );
  return rows as unknown as PartRow[];
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`sqlite3 returned unexpected JSON: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return value;
}
export function transcriptForSession(dbPath: string, session: SessionRow): SessionTranscript {
  const partsByMessage = new Map<string, PartRow[]>();

  for (const part of fetchPartRows(dbPath, session.id)) {
    const parts = partsByMessage.get(part.message_id) ?? [];
    parts.push(part);
    partsByMessage.set(part.message_id, parts);
  }

  const messages: FetchedMessage[] = [];
  for (const [messageId, parts] of partsByMessage) {
    if (parts[0] === undefined) {
      continue;
    }
    const role = parts[0].role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = parts
      .filter((part) => part.part_type === "text")
      .map((part) => part.part_text ?? "")
      .join("\n\n");
    if (text === "") {
      continue;
    }
    messages.push({
      id: messageId,
      role,
      created_ms: parts[0].created_ms,
      text,
      seq: 0,
    });
  }

  messages.sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0) || a.id.localeCompare(b.id));
  messages.forEach((message, position) => {
    message.seq = position + 1;
  });

  return { session, messages };
}

function usage(): void {
  console.error("usage: fetch-session.ts <session-id> | --project <dir> [--out <path>]");
}

function runCli(): void {
  const argv = process.argv.slice(2);
  let sessionId: string | undefined;
  let projectDir: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      projectDir = argv[i + 1];
      i += 1;
    } else if (arg === "--out") {
      outPath = argv[i + 1];
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      sessionId = arg;
    }
  }

  if (sessionId === undefined && projectDir === undefined) {
    usage();
    process.exitCode = 1;
    return;
  }

  const dbPath = locateDatabase();
  const session =
    sessionId !== undefined
      ? findSession(dbPath, sessionId)
      : findLatestSessionForProject(dbPath, projectDir ?? "");

  if (session === null) {
    console.error(`no session found for ${sessionId !== undefined ? `id ${sessionId}` : `project ${projectDir}`}`);
    if (projectDir !== undefined) {
      console.error("most recent session directories:");
      for (const directory of recentSessionDirectories(dbPath)) {
        console.error(`- ${directory}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  const transcript = transcriptForSession(dbPath, session);
  if (outPath !== undefined) {
    writeJsonFile(outPath, transcript);
  } else {
    console.log(JSON.stringify(transcript, null, 2));
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli();
}
