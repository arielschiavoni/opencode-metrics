import type { SessionRow, MessageRow } from "./db.ts";

export interface Sample {
  value: number;
  timestamp: number; // unix ms — used for historical backfill
}

export interface TimeSeries {
  labels: Record<string, string>; // must include __name__
  samples: Sample[];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function safe(v: string | null | undefined): string {
  return v ?? "unknown";
}

function series(
  name: string,
  labels: Record<string, string>,
  value: number,
  timestamp: number
): TimeSeries {
  return {
    labels: { __name__: name, ...labels },
    samples: [{ value, timestamp }],
  };
}

/**
 * Normalise a raw model ID to a canonical name.
 *
 * Observed raw values and expected output:
 *   eu.anthropic.claude-sonnet-4-6            → claude-sonnet-4-6
 *   anthropic.claude-haiku-4-5-20251001-v1:0  → claude-haiku-4-5
 *   eu.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5
 *   claude-haiku-4-5-20251001                 → claude-haiku-4-5
 *   claude-sonnet-4.6  (typo dot)             → claude-sonnet-4-6
 *   nvidia.nemotron-super-3-120b              → nemotron-super-3-120b
 *   minimax.minimax-m2.5                      → minimax-m2.5
 */
export function normalizeModel(raw: string | null | undefined): string {
  if (!raw) return "unknown";

  let id = raw.toLowerCase();

  // Replace digit.digit version separators (e.g. "4.6" → "4-6", "2.5" → "2-5")
  // but NOT dots that are part of prefixes like "eu.anthropic."
  id = id.replace(/(\d)\.(\d)/g, "$1-$2");

  // Strip known vendor/region prefix segments (anything before the first
  // component that starts with a known model family name).
  // Handles: eu., us., anthropic., nvidia., minimax., amazon., google.
  id = id.replace(/^(eu\.|us\.|anthropic\.|nvidia\.|minimax\.|amazon\.|google\.)+/, "");

  // Strip Bedrock version suffix: -v1:0, -v2:1, etc.
  id = id.replace(/-v\d+:\d+$/, "");

  // Strip trailing 8-digit date stamps: -20251001
  id = id.replace(/-\d{8}$/, "");

  return id;
}

// ─────────────────────────────────────────────────────────────
// Session metrics
// One set of series per completed session (timestamp = time_updated)
// Emits: opencode_session_total, opencode_session_cost_usd
// ─────────────────────────────────────────────────────────────

export function sessionToSeries(row: SessionRow): TimeSeries[] {
  const ts = row.time_updated;
  const base = {
    provider: safe(row.provider_id),
    model: normalizeModel(row.model_id),
  };

  return [
    series("opencode_session_total", base, 1, ts),
    series("opencode_session_cost_usd", base, row.cost, ts),
  ];
}

// ─────────────────────────────────────────────────────────────
// LLM call metrics
// One set of series per completed assistant message (timestamp = t_completed)
// Emits: opencode_llm_call_cost_usd, opencode_llm_call_tokens
// ─────────────────────────────────────────────────────────────

export function messageToSeries(row: MessageRow): TimeSeries[] {
  const ts = row.t_completed ?? row.time_updated;
  const base = {
    provider: safe(row.provider_id),
    model: normalizeModel(row.model_id),
  };

  return [
    series("opencode_llm_call_cost_usd", base, row.cost, ts),
    series("opencode_llm_call_tokens", { ...base, type: "input" }, row.tokens_input, ts),
    series("opencode_llm_call_tokens", { ...base, type: "output" }, row.tokens_output, ts),
    series("opencode_llm_call_tokens", { ...base, type: "cache_read" }, row.tokens_cache_read, ts),
    series("opencode_llm_call_tokens", { ...base, type: "cache_write" }, row.tokens_cache_write, ts),
  ];
}
