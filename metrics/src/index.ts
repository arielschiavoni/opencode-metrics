import { openDb, querySessions, queryMessages } from "./db.ts";
import type { Database } from "bun:sqlite";
import { openStateDb, getWatermark, setWatermark } from "./state.ts";
import { sessionToSeries, messageToSeries } from "./metrics.ts";
import type { TimeSeries } from "./metrics.ts";
import { writeBatch } from "./remote-write.ts";

// ─────────────────────────────────────────────────────────────
// Config from environment
// ─────────────────────────────────────────────────────────────

const OPENCODE_DB = process.env.OPENCODE_DB ?? "/data/opencode.db";
const STATE_DB = process.env.STATE_DB ?? "/state/metrics-state.db";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "60000", 10);

// ─────────────────────────────────────────────────────────────
// Core processing logic
// ─────────────────────────────────────────────────────────────

async function processSessions(db: Database): Promise<void> {
  const watermark = getWatermark("session");
  const rows = querySessions(db, watermark);
  if (rows.length === 0) return;

  console.log(`[sessions] ${rows.length} new/updated rows since watermark ${watermark}`);
  const series: TimeSeries[] = rows.flatMap(sessionToSeries);
  await writeBatch(series, PROMETHEUS_URL);

  const maxTs = Math.max(...rows.map((r) => r.time_updated));
  setWatermark("session", maxTs);
  console.log(`[sessions] watermark advanced to ${maxTs}`);
}

async function processMessages(db: Database): Promise<void> {
  const watermark = getWatermark("message");
  const rows = queryMessages(db, watermark);
  if (rows.length === 0) return;

  console.log(`[messages] ${rows.length} new/updated rows since watermark ${watermark}`);
  const series: TimeSeries[] = rows.flatMap(messageToSeries);
  await writeBatch(series, PROMETHEUS_URL);

  const maxTs = Math.max(...rows.map((r) => r.time_updated));
  setWatermark("message", maxTs);
  console.log(`[messages] watermark advanced to ${maxTs}`);
}

async function processBatch(): Promise<void> {
  const db = openDb(OPENCODE_DB);
  const start = Date.now();
  console.log(`\n[${new Date().toISOString()}] Starting export cycle...`);
  try {
    await processSessions(db);
    await processMessages(db);
  } catch (err) {
    // Log but don't crash — watermarks are not advanced on failure,
    // so the next cycle will retry from the same position.
    console.error("[error] Export cycle failed:", err);
  } finally {
    db.close();
  }
  console.log(`[${new Date().toISOString()}] Cycle complete in ${Date.now() - start}ms`);
}

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────

console.log("OpenCode metrics exporter starting...");
console.log(`  opencode.db : ${OPENCODE_DB}`);
console.log(`  state.db    : ${STATE_DB}`);
console.log(`  prometheus  : ${PROMETHEUS_URL}/api/v1/write`);
console.log(`  poll        : ${POLL_INTERVAL_MS}ms`);

openStateDb(STATE_DB);

// Run immediately on startup (handles full backfill on first run),
// then poll on a fixed interval.
// Note: DB connection is opened/closed per cycle to work around Podman virtiofs
// bind mount caching issues with SQLite WAL files.
await processBatch();
setInterval(processBatch, POLL_INTERVAL_MS);
