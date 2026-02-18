import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(),
}));

import { streamSimple } from "@mariozechner/pi-ai";
import { createTraceHeaderStreamFn } from "./trace-header.js";

describe("createTraceHeaderStreamFn", () => {
  it("injects X-Request-Trace-Id with sessionKey/runId format", () => {
    const base = vi.fn();
    const wrapped = createTraceHeaderStreamFn(base, "main:dm:+1234567890", "abc-123");

    wrapped("model", {}, undefined);

    expect(base).toHaveBeenCalledOnce();
    const [model, context, options] = base.mock.calls[0];
    expect(model).toBe("model");
    expect(options.headers["X-Request-Trace-Id"]).toBe("main:dm:+1234567890/abc-123");
  });

  it("preserves existing headers from options", () => {
    const base = vi.fn();
    const wrapped = createTraceHeaderStreamFn(base, "sess", "run1");

    wrapped("model", {}, { headers: { Authorization: "Bearer tok" } });

    const [, , options] = base.mock.calls[0];
    expect(options.headers["X-Request-Trace-Id"]).toBe("sess/run1");
    expect(options.headers.Authorization).toBe("Bearer tok");
  });

  it("existing headers take precedence over trace header", () => {
    const base = vi.fn();
    const wrapped = createTraceHeaderStreamFn(base, "sess", "run1");

    wrapped("model", {}, { headers: { "X-Request-Trace-Id": "custom" } });

    const [, , options] = base.mock.calls[0];
    expect(options.headers["X-Request-Trace-Id"]).toBe("custom");
  });

  it("falls back to streamSimple when baseStreamFn is undefined", () => {
    const wrapped = createTraceHeaderStreamFn(undefined, "sess", "run1");

    wrapped("model", {}, undefined);

    expect(streamSimple).toHaveBeenCalledOnce();
    const [, , options] = (streamSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers["X-Request-Trace-Id"]).toBe("sess/run1");
  });

  it("passes through other options like temperature", () => {
    const base = vi.fn();
    const wrapped = createTraceHeaderStreamFn(base, "s", "r");

    wrapped("model", {}, { temperature: 0.5 });

    const [, , options] = base.mock.calls[0];
    expect(options.temperature).toBe(0.5);
    expect(options.headers["X-Request-Trace-Id"]).toBe("s/r");
  });
});
