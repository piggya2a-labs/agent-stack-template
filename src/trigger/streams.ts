/**
 * src/trigger/streams.ts — Realtime Stream schemas (shared across all tasks)
 *
 * Named streams:
 *   events      — global event bus
 *   langgraph   — raw LangGraph SSE events
 *   dispatches  — A2A dispatch lifecycle events (for frontend tree rendering)
 *   waitpoints  — suspension / external event state
 *
 * IMPORTANT: SDK v4.4.x streams.append() stringifies objects as "[object Object]".
 * Always use the typed helper functions (appendEvent, appendLg, etc.) which
 * JSON.stringify the record. Never call stream.append({...}) directly.
 */
import { streams } from "@trigger.dev/sdk";

export type EventRecord = {
  type: "lg_chunk" | "turn_start" | "turn_end" | "error" | "system";
  event?: string;
  data?: unknown;
  turn_id?: string;
  correlation_id?: string;
  assistant_id?: string;
  thread_id?: string;
  error?: string;
  ts: string;
};
export const eventsStream = streams.define<string>({ id: "events" });
export async function appendEvent(record: EventRecord): Promise<void> {
  try {
    await eventsStream.append(JSON.stringify(record));
  } catch (e) {
    console.warn("eventsStream.append failed (non-fatal):", e);
  }
}

export type LgRecord = { event: string; data: unknown };
export const lgStream = streams.define<string>({ id: "langgraph" });
export async function appendLg(record: LgRecord): Promise<void> {
  try {
    await lgStream.append(JSON.stringify(record));
  } catch (e) {
    console.warn("lgStream.append failed (non-fatal):", e);
  }
}

export type DispatchRecord = {
  event: "triggered" | "completed" | "failed";
  child_run_id: string;
  target_agent: string;
  caller_agent: string;
  caller_thread_id: string | null;
  target_thread_id?: string | null;
  correlation_id: string;
  transport: "trigger_sync" | "trigger_async";
  timestamp: string;
  output_excerpt?: string;
  error?: string;
};
export const dispatchesStream = streams.define<string>({ id: "dispatches" });
export async function appendDispatch(record: DispatchRecord): Promise<void> {
  try {
    await dispatchesStream.append(JSON.stringify(record));
  } catch (e) {
    console.warn("dispatchesStream.append failed (non-fatal):", e);
  }
}

export type WaitpointRecord = {
  event: "created" | "resumed" | "timeout";
  token_id: string;
  reason: string;
  timeout?: string;
  timestamp: string;
};
export const waitpointsStream = streams.define<string>({ id: "waitpoints" });
export async function appendWaitpoint(record: WaitpointRecord): Promise<void> {
  try {
    await waitpointsStream.append(JSON.stringify(record));
  } catch (e) {
    console.warn("waitpointsStream.append failed (non-fatal):", e);
  }
}

export type LgStreamPart = LgRecord;
export type DispatchStreamPart = DispatchRecord;
export type WaitpointStreamPart = WaitpointRecord;
