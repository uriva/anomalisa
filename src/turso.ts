import { createClient } from "@libsql/client/web";

const formatTursoUrl = (url: string) =>
  url.replace(/^turso:\/\//, "https://").replace(/^libsql:\/\//, "https://");

const createTursoClient = () =>
  createClient({
    url: formatTursoUrl(Deno.env.get("TURSO_DATABASE_URL") ?? ""),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN") ?? "",
  });

let _turso: ReturnType<typeof createTursoClient> | null = null;
export const getTurso = () => _turso ??= createTursoClient();

export const initTursoSchema = () =>
  getTurso().batch([
    `CREATE TABLE IF NOT EXISTS counts (
      project_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, event_name, bucket)
    );`,
    `CREATE TABLE IF NOT EXISTS user_counts (
      project_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      user_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, event_name, bucket, user_id)
    );`,
    `CREATE TABLE IF NOT EXISTS max_user_counts (
      project_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, event_name, bucket)
    );`,
    `CREATE TABLE IF NOT EXISTS stats (
      project_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      type TEXT NOT NULL,
      mean REAL NOT NULL,
      m2 REAL NOT NULL,
      n REAL NOT NULL,
      last_bucket TEXT NOT NULL,
      PRIMARY KEY (project_id, event_name, type)
    );`,
    `CREATE TABLE IF NOT EXISTS anomalies (
      project_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      metric TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT "_",
      expected REAL NOT NULL,
      actual REAL NOT NULL,
      z_score REAL NOT NULL,
      detected_at TEXT NOT NULL,
      trend TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, event_name, bucket, metric, user_id)
    );`,
    `CREATE TABLE IF NOT EXISTS cooldowns (
      project_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      metric TEXT NOT NULL,
      direction TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT "_",
      actual REAL NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, event_name, metric, direction, user_id)
    );`,
    `CREATE TABLE IF NOT EXISTS outgoing_alerts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS email_rate_limits (
      to_email TEXT NOT NULL,
      project_name TEXT NOT NULL,
      event_name TEXT NOT NULL,
      day_bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (to_email, project_name, event_name, day_bucket)
    );`,
  ], "write");
