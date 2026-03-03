import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const TRACE_HEADER = "X-Request-Trace-Id";

/**
 * Create a streamFn wrapper that injects X-Request-Trace-Id header
 * for transparent proxy telemetry correlation.
 */
export function createTraceHeaderStreamFn(
  baseStreamFn: StreamFn | undefined,
  sessionKey: string,
  runId: string,
): StreamFn {
  const traceId = `${sessionKey}/${runId}`;
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: { [TRACE_HEADER]: traceId, ...options?.headers },
    });
}
