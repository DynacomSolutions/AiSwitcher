import { describe, expect, test } from "bun:test";
import { createWarmGate, MAX_TIMER_MS, positiveIntEnv, UNREADABLE_WARM_SET } from "../../src/shared/warm-gate.ts";

/** A manual timer: fire() runs the pending timeout callback at once. */
function manualTimer() {
  let pending: (() => void) | undefined;
  let cleared = false;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      cleared = true;
    },
    fire: () => pending?.(),
    wasCleared: () => cleared,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("warm gate", () => {
  test("goes from cold to warm when every key finishes", async () => {
    const t = manualTimer();
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const a = deferred();
    const b = deferred();
    const run = gate.run(["a", "b"], (k) => (k === "a" ? a.promise : b.promise));
    expect(gate.state()).toBe("cold");
    expect(gate.isReady()).toBe(false);
    a.resolve();
    await Bun.sleep(0);
    expect(gate.state()).toBe("cold");
    b.resolve();
    const result = await run;
    expect(result.outcome).toBe("warm");
    expect(result.cold).toEqual([]);
    expect(gate.state()).toBe("warm");
    expect(gate.isReady()).toBe(true);
    expect(t.wasCleared()).toBe(true);
  });

  test("a rejected key still counts as finished", async () => {
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: manualTimer().setTimer });
    const result = await gate.run(["a", "b"], (k) => (k === "a" ? Promise.reject(new Error("boom")) : Promise.resolve()));
    expect(result.outcome).toBe("warm");
    expect(gate.isReady()).toBe(true);
  });

  test("a warm function that throws at once counts as finished", async () => {
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: manualTimer().setTimer });
    const result = await gate.run(["a"], () => {
      throw new Error("sync boom");
    });
    expect(result.outcome).toBe("warm");
  });

  test("times out with the cold list and is ready afterwards", async () => {
    const t = manualTimer();
    let clock = 1000;
    const gate = createWarmGate({ timeoutMs: 50, now: () => clock, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const never = new Promise<void>(() => {});
    const run = gate.run(["claude/slow", "claude/fast"], (k) => (k === "claude/fast" ? Promise.resolve() : never));
    await Bun.sleep(0);
    clock = 1050;
    t.fire();
    const result = await run;
    expect(result).toEqual({ outcome: "timeout", durationMs: 50, cold: ["claude/slow"] });
    expect(gate.state()).toBe("timeout");
    expect(gate.isReady()).toBe(true);
  });

  test("an empty key list is warm at once", async () => {
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: manualTimer().setTimer });
    const result = await gate.run([], () => Promise.resolve());
    expect(result.outcome).toBe("warm");
    expect(gate.state()).toBe("warm");
  });

  test("draining from cold is not ready and stays so after the run ends", async () => {
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: manualTimer().setTimer });
    const a = deferred();
    const run = gate.run(["a"], () => a.promise);
    gate.drain();
    expect(gate.state()).toBe("draining");
    a.resolve();
    await run;
    expect(gate.state()).toBe("draining");
    expect(gate.isReady()).toBe(false);
  });

  test("draining from warm and from timeout is sticky", async () => {
    const warm = createWarmGate({ timeoutMs: 1000, setTimer: manualTimer().setTimer });
    await warm.run([], () => Promise.resolve());
    warm.drain();
    expect(warm.state()).toBe("draining");
    expect(warm.isReady()).toBe(false);

    const t = manualTimer();
    const slow = createWarmGate({ timeoutMs: 1, setTimer: t.setTimer });
    const run = slow.run(["a"], () => new Promise<void>(() => {}));
    t.fire();
    await run;
    expect(slow.state()).toBe("timeout");
    slow.drain();
    expect(slow.state()).toBe("draining");
    expect(slow.isReady()).toBe(false);
  });
});

describe("warm gate drain and keys", () => {
  /** Records every timer so a test can fire or inspect each one. */
  function timers() {
    const set: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    return {
      set,
      setTimer: (fn: () => void, ms: number) => (set.push({ fn, ms, cleared: false }), set.length - 1),
      clearTimer: (h: unknown) => {
        set[h as number]!.cleared = true;
      },
    };
  }

  test("drain clears the timer and settles a pending run as draining", async () => {
    const t = timers();
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const run = gate.run(["a"], () => new Promise<void>(() => {}));
    gate.drain();
    const result = await run;
    expect(result.outcome).toBe("draining");
    expect(result.cold).toEqual(["a"]);
    expect(t.set[0]!.cleared).toBe(true);
    expect(gate.state()).toBe("draining");
    expect(gate.isReady()).toBe(false);
  });

  test("a run started after drain ends at once", async () => {
    const gate = createWarmGate({ timeoutMs: 1000, setTimer: manualTimer().setTimer });
    gate.drain();
    expect((await gate.run(["a"], () => new Promise<void>(() => {}))).outcome).toBe("draining");
  });

  test("the timeout also bounds reading the keys", async () => {
    const t = timers();
    const gate = createWarmGate({ timeoutMs: 80, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const run = gate.run(() => new Promise<string[]>(() => {}), () => Promise.resolve());
    t.set[0]!.fn();
    expect(await run).toMatchObject({ outcome: "timeout", cold: [UNREADABLE_WARM_SET] });
    expect(gate.isReady()).toBe(true);
  });

  test("an unreadable key list is retried, then warms", async () => {
    const t = timers();
    const gate = createWarmGate({ timeoutMs: 10_000, retryMs: 5, setTimer: t.setTimer, clearTimer: t.clearTimer });
    let calls = 0;
    const run = gate.run(async () => {
      calls += 1;
      if (calls === 1) throw new Error("registry unreadable");
      return ["a"];
    }, () => Promise.resolve());
    await Bun.sleep(0);
    expect(gate.state()).toBe("cold");
    expect(t.set[1]!.ms).toBe(5);
    t.set[1]!.fn();
    expect((await run).outcome).toBe("warm");
    expect(calls).toBe(2);
  });

  test("a key list that stays unreadable ends as a timeout", async () => {
    const t = timers();
    const gate = createWarmGate({ timeoutMs: 100, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const run = gate.run(Promise.reject(new Error("no")), () => Promise.resolve());
    await Bun.sleep(0);
    t.set[0]!.fn();
    const result = await run;
    expect(result).toMatchObject({ outcome: "timeout", cold: [UNREADABLE_WARM_SET] });
  });

  test("timeouts above the timer limit are clamped", () => {
    const t = timers();
    const gate = createWarmGate({ timeoutMs: 10 ** 12, setTimer: t.setTimer, clearTimer: t.clearTimer });
    void gate.run(["a"], () => new Promise<void>(() => {}));
    expect(t.set[0]!.ms).toBe(MAX_TIMER_MS);
    gate.drain();
    expect(positiveIntEnv("X", 90, { X: "99999999999999" })).toBe(MAX_TIMER_MS);
  });

  test("the default timer is unref'd", async () => {
    const gate = createWarmGate({ timeoutMs: 60_000 });
    const run = gate.run(["a"], () => Promise.resolve());
    expect((await run).outcome).toBe("warm");
  });
});

describe("positiveIntEnv", () => {
  test("accepts a positive integer and falls back otherwise", () => {
    expect(positiveIntEnv("X", 90, { X: "250" })).toBe(250);
    for (const bad of ["0", "-5", "abc", "1.5", "", " "]) expect(positiveIntEnv("X", 90, { X: bad })).toBe(90);
    expect(positiveIntEnv("X", 90, {})).toBe(90);
  });
});
