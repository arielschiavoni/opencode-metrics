import { Database } from "bun:sqlite";

export interface SessionRow {
  id: string;
  time_updated: number;
  time_created: number;
  cost: number;
  model_id: string | null;
  provider_id: string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  time_updated: number;
  model_id: string | null;
  provider_id: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  t_created: number | null;
  t_completed: number | null;
}

export function openDb(path: string): Database {
  return new Database(path, { readonly: true });
}

// Jan 1 2026 00:00:00 UTC in milliseconds
const CUTOFF_MS = 1735689600000;

export function querySessions(db: Database, watermark: number): SessionRow[] {
  return db
    .query<SessionRow, [number]>(
      `SELECT
        s.id,
        s.time_updated,
        s.time_created,
        s.cost,
        COALESCE(json_extract(s.model, '$.id'),         first_msg.model_id)    AS model_id,
        COALESCE(json_extract(s.model, '$.providerID'), first_msg.provider_id) AS provider_id
      FROM session s
      -- Fallback: derive provider/model from the first assistant message when
      -- the session row's model column is NULL (pre-migration sessions).
      LEFT JOIN (
        SELECT
          session_id,
          json_extract(data, '$.providerID') AS provider_id,
          json_extract(data, '$.modelID')    AS model_id
        FROM message
        WHERE json_extract(data, '$.role') = 'assistant'
          AND json_extract(data, '$.cost') > 0
        GROUP BY session_id
      ) first_msg ON first_msg.session_id = s.id
      WHERE s.time_updated > ?
        AND s.time_updated >= ${CUTOFF_MS}
        AND s.cost > 0
      ORDER BY s.time_updated ASC`
    )
    .all(watermark);
}

export function queryMessages(db: Database, watermark: number): MessageRow[] {
  return db
    .query<MessageRow, [number]>(
      `SELECT
        m.id,
        m.session_id,
        m.time_updated,
        json_extract(m.data, '$.modelID')               AS model_id,
        json_extract(m.data, '$.providerID')            AS provider_id,
        json_extract(m.data, '$.cost')                  AS cost,
        COALESCE(json_extract(m.data, '$.tokens.input'), 0)          AS tokens_input,
        COALESCE(json_extract(m.data, '$.tokens.output'), 0)         AS tokens_output,
        COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)     AS tokens_cache_read,
        COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)    AS tokens_cache_write,
        json_extract(m.data, '$.time.created')          AS t_created,
        json_extract(m.data, '$.time.completed')        AS t_completed
      FROM message m
      WHERE m.time_updated > ?
        AND m.time_updated >= ${CUTOFF_MS}
        AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.cost') > 0
      ORDER BY m.time_updated ASC`
    )
    .all(watermark);
}
