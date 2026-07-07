import { describe, expect, it } from "vitest";
import { ShutdownCoordinator } from "../src/core/shutdown/ShutdownCoordinator.js";
import { ShutdownStatusLine } from "../src/core/shutdown/ShutdownStatusLine.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";

describe("ShutdownCoordinator", () => {
  it("starts graceful shutdown once and routes a repeated interrupt through force exit", async () => {
    const exits: number[] = [];
    const forceReasons: string[] = [];
    const logs: string[] = [];
    const graceful = deferred<void>();
    let shutdownCalls = 0;
    const coordinator = new ShutdownCoordinator({
      logger: new StructuredLogger((line) => logs.push(line)),
      graceMs: 10_000,
      shutdown: async () => {
        shutdownCalls += 1;
        await graceful.promise;
      },
      forceDispose: (reason) => forceReasons.push(reason),
      exit: (code) => exits.push(code),
      setTimeout: () => fakeTimeout(),
      clearTimeout: () => undefined,
    });

    coordinator.request("sigint");
    coordinator.request("sigint");
    graceful.resolve();
    await flushPromises();

    expect(shutdownCalls).toBe(1);
    expect(forceReasons).toEqual(["repeated_interrupt"]);
    expect(exits).toEqual([130]);
    expect(logs.some((line) => line.includes("symphony forcing shutdown") && line.includes("repeated_interrupt"))).toBe(true);
  });

  it("force-exits when the grace timeout fires", async () => {
    const exits: number[] = [];
    const forceReasons: string[] = [];
    let timeoutCallback: () => void = () => undefined;
    const coordinator = new ShutdownCoordinator({
      logger: new StructuredLogger(() => undefined),
      graceMs: 25,
      shutdown: async () => {
        await new Promise<void>(() => undefined);
      },
      forceDispose: (reason) => forceReasons.push(reason),
      exit: (code) => exits.push(code),
      setTimeout: (callback: () => void) => {
        timeoutCallback = callback;
        return fakeTimeout();
      },
      clearTimeout: () => undefined,
    });

    coordinator.request("sigint");
    timeoutCallback();

    expect(forceReasons).toEqual(["grace_timeout"]);
    expect(exits).toEqual([130]);
  });

  it("exits cleanly after graceful shutdown completes before timeout", async () => {
    const exits: number[] = [];
    let cleared = false;
    const coordinator = new ShutdownCoordinator({
      logger: new StructuredLogger(() => undefined),
      graceMs: 25,
      shutdown: async () => undefined,
      exit: (code) => exits.push(code),
      setTimeout: () => fakeTimeout(),
      clearTimeout: () => {
        cleared = true;
      },
    });

    coordinator.request("sigint");
    await flushPromises();

    expect(cleared).toBe(true);
    expect(exits).toEqual([0]);
  });
});

describe("ShutdownStatusLine", () => {
  it("keeps a fixed TTY status line below log output and clears it on finish", () => {
    let now = 1_000;
    const writes: string[] = [];
    let intervalCallback: () => void = () => undefined;
    let clearedInterval = false;
    const status = new ShutdownStatusLine({
      stream: {
        isTTY: true,
        columns: 200,
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
      graceMs: 2_000,
      now: () => now,
      setInterval: (callback) => {
        intervalCallback = callback;
        return 1;
      },
      clearInterval: () => {
        clearedInterval = true;
      },
    });

    status.started({ id: "a", label: "stopping orchestrator" });
    status.writeLogLine("level=info message=\"test\"");
    status.completed({ id: "a", label: "stopping orchestrator" });
    now = 2_000;
    intervalCallback();
    status.finished({ status: "graceful" });

    const output = writes.join("");
    expect(output).toContain("\r\x1b[2Klevel=info message=\"test\"\n");
    expect(output).toContain("actions=1/1 pending=0 failed=0");
    expect(output).toContain("current=stopping orchestrator");
    expect(clearedInterval).toBe(true);
    expect(output.endsWith("\r\x1b[2K")).toBe(true);
  });

  it("writes plain log lines without status control sequences for non-TTY streams", () => {
    const writes: string[] = [];
    const status = new ShutdownStatusLine({
      stream: {
        isTTY: false,
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
      graceMs: 2_000,
    });

    status.started({ id: "a", label: "stopping orchestrator" });
    status.writeLogLine("level=info message=\"test\"");
    status.finished({ status: "graceful" });

    expect(writes).toEqual(["level=info message=\"test\"\n"]);
  });
});

function fakeTimeout(): NodeJS.Timeout {
  return { unref: () => undefined } as unknown as NodeJS.Timeout;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
