// Native Prometheus remote write implementation for Bun.
// Uses protobufjs for encoding and snappy for compression.
// Does NOT use the `prometheus-remote-write` npm package which relies on
// Node.js stream internals (PassThrough) that Bun doesn't fully support.
import protobuf from "protobufjs";
import { compress } from "snappy";
import type { TimeSeries } from "./metrics.ts";

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "500", 10);

// ─────────────────────────────────────────────────────────────
// Protobuf schema (Prometheus remote write v1)
// https://github.com/prometheus/prometheus/blob/main/prompb/types.proto
// ─────────────────────────────────────────────────────────────
const root = protobuf.parse(`
  syntax = "proto3";
  message Label {
    string name  = 1;
    string value = 2;
  }
  message Sample {
    double value     = 1;
    int64  timestamp = 2;
  }
  message TimeSeries {
    repeated Label  labels  = 1;
    repeated Sample samples = 2;
  }
  message WriteRequest {
    repeated TimeSeries timeseries = 1;
  }
`).root;

const WriteRequest = root.lookupType("WriteRequest");

function encodeWriteRequest(series: TimeSeries[]): Uint8Array {
  const payload = WriteRequest.create({
    timeseries: series.map((s) => ({
      labels: Object.entries(s.labels).map(([name, value]) => ({ name, value })),
      samples: s.samples,
    })),
  });
  return WriteRequest.encode(payload).finish() as Uint8Array;
}

// ─────────────────────────────────────────────────────────────
// HTTP transport
// ─────────────────────────────────────────────────────────────

async function postToPrometheus(url: string, body: Buffer): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-protobuf",
      "Content-Encoding": "snappy",
      "X-Prometheus-Remote-Write-Version": "0.1.0",
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    throw new Error(`Prometheus remote write failed: ${resp.status} ${resp.statusText} — ${text}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function writeBatch(series: TimeSeries[], url: string): Promise<void> {
  if (series.length === 0) return;

  const remoteWriteUrl = `${url}/api/v1/write`;
  const batches = chunk(series, BATCH_SIZE);
  console.log(
    `  → writing ${series.length} series in ${batches.length} batch(es) to ${remoteWriteUrl}`
  );

  for (let i = 0; i < batches.length; i++) {
    const encoded = encodeWriteRequest(batches[i]!);
    const compressed = await compress(Buffer.from(encoded));
    await postToPrometheus(remoteWriteUrl, compressed);
    if (batches.length > 1) {
      console.log(`    batch ${i + 1}/${batches.length} done`);
    }
  }
}
