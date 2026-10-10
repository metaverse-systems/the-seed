import { ProjectType } from "../src/types";
import type { BuildableProject } from "../src/types";
import {
  runSchedule,
  InstallLock,
  InstallCancelled,
  effectiveTiers,
  tierJobs,
  processorCount,
  ScheduleContext,
  ProjectOutcome,
  ScheduleResult,
} from "../src/BuildScheduler";

// ── Helpers ─────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending promise callback run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Waits for `work`; resolves true instead if `signal` aborts first. */
function stopsFirst(work: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return work.then(() => false);
  if (signal.aborted) return Promise.resolve(true);
  return Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(true), { once: true })),
  ]);
}

const C = ProjectType.Component;
const S = ProjectType.System;
const P = ProjectType.Program;

interface Graph {
  order: BuildableProject[];
  edges: Map<string, string[]>;
  byName: Map<string, BuildableProject>;
}

/** Builds a graph from [name, type, deps] triples given in build order. */
function graph(spec: Array<[string, ProjectType, string[]]>): Graph {
  const order = spec.map(([name, type, deps]) => ({
    name,
    path: `/fake/${name}`,
    type,
    dependencies: deps,
  }));
  const byName = new Map(order.map((p) => [p.name, p]));
  const edges = new Map(order.map((p) => [p.path, p.dependencies.map((d) => `/fake/${d}`)]));
  return { order, edges, byName };
}

type EventKind = "start" | "install-begin" | "install-end" | "settle";

interface RecordedEvent {
  time: number;
  kind: EventKind;
  name: string;
  jobs?: number;
}

/**
 * A fake runProject: each project's build phase and install phase wait on
 * deferreds the test resolves or rejects. Events are recorded with a
 * logical clock.
 */
class FakeBuilds {
  events: RecordedEvent[] = [];
  contexts = new Map<string, ScheduleContext>();
  running = new Set<string>();
  maxRunning = 0;
  private clock = 0;
  private buildGates = new Map<string, Deferred<void>>();
  private installGates = new Map<string, Deferred<void>>();

  private gate(map: Map<string, Deferred<void>>, name: string): Deferred<void> {
    let gate = map.get(name);
    if (!gate) {
      gate = deferred<void>();
      map.set(name, gate);
    }
    return gate;
  }

  private record(kind: EventKind, name: string, jobs?: number): void {
    this.events.push({ time: this.clock++, kind, name, jobs });
  }

  /** Projects whose build phase does not stop when their signal aborts */
  ignoreSignal = new Set<string>();
  /** The install signal each project was given */
  installSignals = new Map<string, AbortSignal>();

  runProject = async (project: BuildableProject, context: ScheduleContext): Promise<ProjectOutcome<string>> => {
    this.contexts.set(project.name, context);
    this.running.add(project.name);
    this.maxRunning = Math.max(this.maxRunning, this.running.size);
    this.record("start", project.name, context.jobs);
    try {
      const buildSignal = this.ignoreSignal.has(project.name) ? undefined : context.signal;
      try {
        if (await stopsFirst(this.gate(this.buildGates, project.name).promise, buildSignal)) {
          return { status: "interrupted" };
        }
      } catch (reason) {
        return { status: "failed", failure: String(reason) };
      }
      return await context.withInstallLock(async (installSignal) => {
        this.installSignals.set(project.name, installSignal);
        this.record("install-begin", project.name);
        try {
          if (await stopsFirst(this.gate(this.installGates, project.name).promise, installSignal)) {
            return { status: "interrupted" } as ProjectOutcome<string>;
          }
        } finally {
          this.record("install-end", project.name);
        }
        return { status: "completed" } as ProjectOutcome<string>;
      });
    } finally {
      this.running.delete(project.name);
      this.record("settle", project.name);
    }
  };

  started(): string[] {
    return this.events.filter((e) => e.kind === "start").map((e) => e.name);
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  firstTime(kind: EventKind, name: string): number {
    const event = this.events.find((e) => e.kind === kind && e.name === name);
    if (!event) throw new Error(`No ${kind} event for ${name}`);
    return event.time;
  }

  finishBuild(name: string): void {
    this.gate(this.buildGates, name).resolve();
  }

  failBuild(name: string, reason = `${name} broke`): void {
    this.gate(this.buildGates, name).reject(reason);
  }

  finishInstall(name: string): void {
    this.gate(this.installGates, name).resolve();
  }

  failInstall(name: string, reason = `${name} install broke`): void {
    this.gate(this.installGates, name).reject(new Error(reason));
  }

  /** Finish a project's build and install, letting everything settle. */
  async finish(name: string): Promise<void> {
    this.finishBuild(name);
    await flush();
    this.finishInstall(name);
    await flush();
  }
}

/** Finish running projects, earliest started first, until the schedule resolves. */
async function drive<F>(fake: FakeBuilds, schedule: Promise<ScheduleResult<F>>): Promise<ScheduleResult<F>> {
  let done = false;
  const result = schedule.then((r) => {
    done = true;
    return r;
  });
  await flush();
  while (!done) {
    const next = fake.started().find((name) => fake.isRunning(name));
    if (!next) {
      await flush();
      if (!done) throw new Error("Schedule stalled with nothing running");
      break;
    }
    await fake.finish(next);
  }
  return result;
}

function start(g: Graph, fake: FakeBuilds, concurrency: number, processors = 4, signal?: AbortSignal, forceSignal?: AbortSignal) {
  return runSchedule({
    order: g.order,
    edges: g.edges,
    concurrency,
    processorCount: processors,
    signal,
    forceSignal,
    runProject: fake.runProject,
  });
}

function stateOf<F>(result: ScheduleResult<F>, g: Graph, name: string): string {
  return result.states.get(g.byName.get(name)!.path)!.state;
}

/** Start/end intervals of each project's install phase. */
function installIntervals(fake: FakeBuilds): Array<{ name: string; begin: number; end: number }> {
  return fake.events
    .filter((e) => e.kind === "install-begin")
    .map((e) => {
      const end = fake.events.find((other) => other.kind === "install-end" && other.name === e.name);
      return { name: e.name, begin: e.time, end: end ? end.time : Infinity };
    });
}

function expectNoInstallOverlap(fake: FakeBuilds): void {
  const intervals = installIntervals(fake).sort((a, b) => a.begin - b.begin);
  for (let i = 1; i < intervals.length; i++) {
    expect(intervals[i].begin).toBeGreaterThan(intervals[i - 1].end);
  }
}

// ── Graphs ──────────────────────────────────────────────────────────

const diamond = () => graph([
  ["A", C, []],
  ["B", C, ["A"]],
  ["C", C, ["A"]],
  ["D", P, ["B", "C"]],
]);

const tierBarrier = () => graph([
  ["A", C, []],
  ["B", C, []],
  ["S", S, ["A"]],
  ["Prog", P, ["S", "B"]],
]);

const withinTier = () => graph([
  ["A", C, []],
  ["B", C, []],
  ["C", C, []],
  ["D", C, ["A"]],
  ["Prog", P, ["B", "C", "D"]],
]);

const chain = () => graph([
  ["A", C, []],
  ["S", S, ["A"]],
  ["Prog", P, ["S"]],
]);

// A component that depends on a system: its effective tier is raised.
const inversion = () => graph([
  ["A", C, []],
  ["B", C, []],
  ["S", S, ["A"]],
  ["X", C, ["S"]],
  ["Prog", P, ["X", "B"]],
]);

const wide = () => graph([
  ["A", C, []],
  ["B", C, []],
  ["C", C, []],
  ["D", C, []],
  ["E", C, []],
  ["S1", S, ["A"]],
  ["S2", S, ["B"]],
  ["Prog", P, ["S1", "S2", "C", "D", "E"]],
]);

// ── Pure helpers ────────────────────────────────────────────────────

describe("effectiveTiers", () => {
  it("equals the declared tier in a well-formed graph", () => {
    const g = tierBarrier();
    const tiers = effectiveTiers(g.order, g.edges);
    expect(g.order.map((p) => tiers.get(p.path))).toEqual([0, 0, 1, 2]);
  });

  it("raises a project above the tiers of its dependencies", () => {
    const g = inversion();
    const tiers = effectiveTiers(g.order, g.edges);
    expect(tiers.get("/fake/X")).toBe(1);
    expect(tiers.get("/fake/Prog")).toBe(2);
  });
});

describe("tierJobs", () => {
  it("is undefined at concurrency 1", () => {
    expect(tierJobs(1, 4, 3)).toBeUndefined();
    expect(tierJobs(1, 16, 1)).toBeUndefined();
  });

  it("shares the processors among the projects of a tier that can run at once", () => {
    expect(tierJobs(3, 4, 3)).toBe(1);
    expect(tierJobs(2, 4, 3)).toBe(2);
    expect(tierJobs(3, 4, 1)).toBe(4);
    expect(tierJobs(4, 4, 8)).toBe(1);
    expect(tierJobs(2, 8, 5)).toBe(4);
  });

  it("is never below 1", () => {
    expect(tierJobs(4, 4, 100)).toBe(1);
  });
});

describe("processorCount", () => {
  it("is a positive integer", () => {
    const count = processorCount();
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ── InstallLock ─────────────────────────────────────────────────────

describe("InstallLock", () => {
  it("grants the lock in FIFO order", async () => {
    const lock = new InstallLock();
    const order: string[] = [];
    await lock.acquire();
    const waiters = ["one", "two", "three"].map((name) =>
      lock.acquire().then(() => {
        order.push(name);
      })
    );
    await flush();
    expect(order).toEqual([]);
    lock.release();
    await flush();
    expect(order).toEqual(["one"]);
    lock.release();
    await flush();
    lock.release();
    await Promise.all(waiters);
    expect(order).toEqual(["one", "two", "three"]);
    lock.release();
  });

  it("never lets two holders in at once", async () => {
    const lock = new InstallLock();
    let inside = 0;
    let maxInside = 0;
    const work = async () => {
      await lock.acquire();
      try {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await flush();
        inside--;
      } finally {
        lock.release();
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    expect(maxInside).toBe(1);
  });

  it("is released in finally when the holder throws", async () => {
    const lock = new InstallLock();
    const failing = (async () => {
      await lock.acquire();
      try {
        throw new Error("install failed");
      } finally {
        lock.release();
      }
    })();
    await expect(failing).rejects.toThrow("install failed");
    const next = lock.acquire();
    await expect(next).resolves.toBeUndefined();
    lock.release();
  });

  it("withdraws a waiter whose signal aborts without blocking later waiters", async () => {
    const lock = new InstallLock();
    await lock.acquire();
    const withdraw = new AbortController();
    const withdrawn = lock.acquire(withdraw.signal);
    const later = lock.acquire();
    let laterGranted = false;
    later.then(() => {
      laterGranted = true;
    });

    withdraw.abort();
    await expect(withdrawn).rejects.toBeInstanceOf(InstallCancelled);

    lock.release();
    await flush();
    expect(laterGranted).toBe(true);
    lock.release();
  });

  it("rejects at once when the withdrawal signal is already aborted", async () => {
    const lock = new InstallLock();
    const withdraw = new AbortController();
    withdraw.abort();
    await expect(lock.acquire(withdraw.signal)).rejects.toBeInstanceOf(InstallCancelled);
    // The lock is still free
    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
  });
});

// ── runSchedule ─────────────────────────────────────────────────────

describe("runSchedule ordering", () => {
  it("diamond: B and C wait for A's install, D waits for both", async () => {
    const g = diamond();
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 4);

    await flush();
    expect(fake.started()).toEqual(["A"]);

    fake.finishBuild("A");
    await flush();
    expect(fake.started()).toEqual(["A"]);

    fake.finishInstall("A");
    await flush();
    expect(fake.started()).toEqual(["A", "B", "C"]);

    await fake.finish("B");
    expect(fake.started()).toEqual(["A", "B", "C"]);
    await fake.finish("C");
    expect(fake.started()).toEqual(["A", "B", "C", "D"]);
    expect(fake.firstTime("start", "B")).toBeGreaterThan(fake.firstTime("install-end", "A"));
    expect(fake.firstTime("start", "D")).toBeGreaterThan(fake.firstTime("install-end", "C"));

    await fake.finish("D");
    const result = await schedule;
    expect(result.completionOrder.map((p) => p.name)).toEqual(["A", "B", "C", "D"]);
    expect(result.cancelled).toBe(false);
  });

  it("tier barrier: a system waits for every component, not only its own dependencies", async () => {
    const g = tierBarrier();
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 4);

    await flush();
    expect(fake.started()).toEqual(["A", "B"]);

    await fake.finish("A");
    expect(fake.started()).toEqual(["A", "B"]);

    await fake.finish("B");
    expect(fake.started()).toEqual(["A", "B", "S"]);
    expect(fake.firstTime("start", "S")).toBeGreaterThan(fake.firstTime("settle", "B"));

    await fake.finish("S");
    await fake.finish("Prog");
    await schedule;
  });

  it("within a tier: a component depending on another starts once that one is installed", async () => {
    const g = withinTier();
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 4);

    await flush();
    expect(fake.started()).toEqual(["A", "B", "C"]);

    await fake.finish("A");
    expect(fake.started()).toEqual(["A", "B", "C", "D"]);
    expect(fake.isRunning("B")).toBe(true);
    expect(fake.isRunning("C")).toBe(true);

    await drive(fake, schedule);
  });

  it("starts the lowest build-order index first among ready projects", async () => {
    const g = wide();
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 2);

    await flush();
    expect(fake.started()).toEqual(["A", "B"]);
    await fake.finish("B");
    expect(fake.started()).toEqual(["A", "B", "C"]);
    await fake.finish("A");
    expect(fake.started()).toEqual(["A", "B", "C", "D"]);

    await drive(fake, schedule);
    expect(fake.started()).toEqual(["A", "B", "C", "D", "E", "S1", "S2", "Prog"]);
  });

  it("does not deadlock on a component that depends on a system", async () => {
    const g = inversion();
    const fake = new FakeBuilds();
    const result = await drive(fake, start(g, fake, 4));

    expect(result.completionOrder).toHaveLength(5);
    expect(fake.firstTime("start", "X")).toBeGreaterThan(fake.firstTime("install-end", "S"));
    expect(fake.firstTime("start", "S")).toBeGreaterThan(fake.firstTime("settle", "B"));
  });

  it.each([1, 2, 4, 8])("builds a single project and a chain one at a time at limit %p", async (limit) => {
    const single = graph([["Prog", P, []]]);
    const singleFake = new FakeBuilds();
    await drive(singleFake, start(single, singleFake, limit));
    expect(singleFake.started()).toEqual(["Prog"]);

    const g = chain();
    const fake = new FakeBuilds();
    await drive(fake, start(g, fake, limit));
    expect(fake.started()).toEqual(["A", "S", "Prog"]);
    expect(fake.maxRunning).toBe(1);
  });

  it.each([
    ["diamond", diamond],
    ["chain", chain],
    ["tier barrier", tierBarrier],
    ["inversion", inversion],
    ["within tier", withinTier],
    ["wide", wide],
  ])("limit 1 reproduces the build order exactly (%s)", async (_name, make) => {
    const g = make();
    const fake = new FakeBuilds();
    const result = await drive(fake, start(g, fake, 1));

    expect(fake.started()).toEqual(g.order.map((p) => p.name));
    expect(result.completionOrder).toEqual(g.order);
    expect(fake.maxRunning).toBe(1);
    // Each project settles before the next one starts
    for (let i = 1; i < g.order.length; i++) {
      expect(fake.firstTime("start", g.order[i].name)).toBeGreaterThan(
        fake.firstTime("settle", g.order[i - 1].name)
      );
    }
  });
});

describe("runSchedule capacity and compile jobs", () => {
  it("never runs more than the limit", async () => {
    const g = wide();
    const fake = new FakeBuilds();
    await drive(fake, start(g, fake, 3, 8));
    expect(fake.maxRunning).toBe(3);
  });

  it("never runs more projects than processors", async () => {
    const g = wide();
    const fake = new FakeBuilds();
    await drive(fake, start(g, fake, 8, 2));
    expect(fake.maxRunning).toBe(2);
  });

  it("gives each project of a tier its share of the processors", async () => {
    const g = graph([
      ["A", C, []],
      ["B", C, []],
      ["C", C, []],
      ["Prog", P, ["A", "B", "C"]],
    ]);
    const fake = new FakeBuilds();
    await drive(fake, start(g, fake, 3, 4));

    const jobs = Object.fromEntries(
      fake.events.filter((e) => e.kind === "start").map((e) => [e.name, e.jobs])
    );
    expect(jobs).toEqual({ A: 1, B: 1, C: 1, Prog: 4 });
  });

  it.each([[2, 4], [3, 4], [4, 4], [3, 8], [8, 2]])(
    "keeps the jobs of running projects within the processor count (limit %p, %p processors)",
    async (limit, processors) => {
      const g = wide();
      const fake = new FakeBuilds();
      const schedule = start(g, fake, limit, processors);

      let done = false;
      schedule.then(() => {
        done = true;
      });
      await flush();
      while (!done) {
        const runningJobs = [...fake.running].map((name) => fake.contexts.get(name)!.jobs!);
        for (const jobs of runningJobs) {
          expect(jobs).toBeGreaterThanOrEqual(1);
        }
        expect(runningJobs.reduce((sum, jobs) => sum + jobs, 0)).toBeLessThanOrEqual(processors);
        const next = fake.started().find((name) => fake.isRunning(name));
        if (!next) break;
        await fake.finish(next);
      }
      await schedule;
    }
  );

  it("leaves jobs undefined at limit 1", async () => {
    const g = wide();
    const fake = new FakeBuilds();
    await drive(fake, start(g, fake, 1));
    for (const context of fake.contexts.values()) {
      expect(context.jobs).toBeUndefined();
    }
  });

  it("passes 0-based start ordinals", async () => {
    const g = wide();
    const fake = new FakeBuilds();
    await drive(fake, start(g, fake, 3));
    const ordinals = fake.started().map((name) => fake.contexts.get(name)!.ordinal);
    expect(ordinals).toEqual(ordinals.map((_, i) => i));
  });
});

describe("runSchedule install exclusivity", () => {
  it("never overlaps two install phases and grants them in request order", async () => {
    const g = graph([
      ["A", C, []],
      ["B", C, []],
      ["C", C, []],
      ["Prog", P, ["A", "B", "C"]],
    ]);
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 3);
    await flush();

    // All three finish compiling; B asks for the lock first, then A, then C.
    fake.finishBuild("B");
    await flush();
    fake.finishBuild("A");
    await flush();
    fake.finishBuild("C");
    await flush();

    expect(installIntervals(fake).map((i) => i.name)).toEqual(["B"]);
    fake.finishInstall("B");
    await flush();
    expect(installIntervals(fake).map((i) => i.name)).toEqual(["B", "A"]);
    fake.finishInstall("A");
    await flush();
    fake.finishInstall("C");
    await flush();
    await fake.finish("Prog");
    await schedule;

    expect(installIntervals(fake).map((i) => i.name)).toEqual(["B", "A", "C", "Prog"]);
    expectNoInstallOverlap(fake);
  });

  it("releases the lock when an install fails so the next project can install", async () => {
    const g = graph([
      ["A", C, []],
      ["B", C, []],
      ["Prog", P, ["A", "B"]],
    ]);
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 2);
    await flush();

    fake.finishBuild("A");
    await flush();
    fake.finishBuild("B");
    await flush();
    fake.failInstall("A");
    await flush();
    expect(installIntervals(fake).map((i) => i.name)).toEqual(["A", "B"]);
    fake.finishInstall("B");
    await flush();

    const result = await schedule;
    expect(stateOf(result, g, "A")).toBe("failed");
    expect(stateOf(result, g, "B")).toBe("completed");
    expect(stateOf(result, g, "Prog")).toBe("notStarted");
    expectNoInstallOverlap(fake);
  });
});

describe("runSchedule failures", () => {
  it("starts nothing new after a failure and lets in-flight projects finish", async () => {
    const g = tierBarrier();
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 2);
    await flush();
    expect(fake.started()).toEqual(["A", "B"]);

    fake.failBuild("A");
    await flush();
    expect(fake.isRunning("B")).toBe(true);

    await fake.finish("B");
    const result = await schedule;

    expect(fake.started()).toEqual(["A", "B"]);
    expect(stateOf(result, g, "A")).toBe("failed");
    expect(stateOf(result, g, "B")).toBe("completed");
    expect(stateOf(result, g, "S")).toBe("notStarted");
    expect(stateOf(result, g, "Prog")).toBe("notStarted");
    expect(result.failures.map((f) => [f.project.name, f.failure])).toEqual([["A", "A broke"]]);
    expect(result.cancelled).toBe(false);
  });

  it("records several in-flight failures in the order they happen", async () => {
    const g = wide();
    const fake = new FakeBuilds();
    const schedule = start(g, fake, 3);
    await flush();
    expect(fake.started()).toEqual(["A", "B", "C"]);

    fake.failBuild("C");
    await flush();
    fake.failBuild("A");
    await flush();
    await fake.finish("B");
    const result = await schedule;

    expect(result.failures.map((f) => f.project.name)).toEqual(["C", "A"]);
    expect(stateOf(result, g, "B")).toBe("completed");
    expect(stateOf(result, g, "D")).toBe("notStarted");
  });

  it("treats a thrown error from runProject as a failure", async () => {
    const g = graph([["Prog", P, []]]);
    const error = new Error("unexpected");
    const result = await runSchedule({
      order: g.order,
      edges: g.edges,
      concurrency: 1,
      processorCount: 4,
      runProject: async () => {
        throw error;
      },
    });
    expect(stateOf(result, g, "Prog")).toBe("failed");
    expect(result.failures[0].failure).toBe(error);
  });
});

describe("runSchedule cancellation", () => {
  const threeComponents = () => graph([
    ["A", C, []],
    ["B", C, []],
    ["C", C, []],
    ["Prog", P, ["A", "B", "C"]],
  ]);

  it("graceful cancel stops every building project and starts nothing new", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    const schedule = start(g, fake, 3, 4, cancel.signal);
    await flush();
    expect(fake.started()).toEqual(["A", "B", "C"]);

    cancel.abort();
    await flush();
    for (const name of ["A", "B", "C"]) {
      expect(fake.contexts.get(name)!.signal.aborted).toBe(true);
    }
    const result = await schedule;

    expect(fake.started()).toEqual(["A", "B", "C"]);
    for (const name of ["A", "B", "C"]) {
      expect(stateOf(result, g, name)).toBe("interrupted");
    }
    expect(stateOf(result, g, "Prog")).toBe("notStarted");
    expect(result.cancelled).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("graceful cancel lets the install in progress finish", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    const schedule = start(g, fake, 2, 4, cancel.signal);
    await flush();
    fake.finishBuild("A");
    await flush();
    expect(installIntervals(fake).map((i) => i.name)).toEqual(["A"]);

    cancel.abort();
    await flush();
    expect(fake.contexts.get("B")!.signal.aborted).toBe(true);
    expect(fake.installSignals.get("A")!.aborted).toBe(false);
    expect(fake.isRunning("A")).toBe(true);

    fake.finishInstall("A");
    const result = await schedule;
    expect(stateOf(result, g, "A")).toBe("completed");
    expect(stateOf(result, g, "B")).toBe("interrupted");
    expect(stateOf(result, g, "C")).toBe("notStarted");
    expect(result.cancelled).toBe(true);
  });

  it("graceful cancel reports the install holder as failed when its install fails", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    const schedule = start(g, fake, 2, 4, cancel.signal);
    await flush();
    fake.finishBuild("A");
    await flush();

    cancel.abort();
    await flush();
    fake.failInstall("A");
    const result = await schedule;

    expect(stateOf(result, g, "A")).toBe("failed");
    expect(stateOf(result, g, "B")).toBe("interrupted");
    expect(result.cancelled).toBe(true);
    expect(result.failures.map((f) => f.project.name)).toEqual(["A"]);
  });

  it("graceful cancel withdraws a project waiting for the install lock", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    const schedule = start(g, fake, 3, 4, cancel.signal);
    await flush();
    fake.finishBuild("A");
    await flush();
    fake.finishBuild("C");
    await flush();
    // A holds the lock, C waits for it, B is still building.
    expect(installIntervals(fake).map((i) => i.name)).toEqual(["A"]);

    cancel.abort();
    await flush();
    fake.finishInstall("A");
    const result = await schedule;

    expect(stateOf(result, g, "A")).toBe("completed");
    expect(stateOf(result, g, "B")).toBe("interrupted");
    expect(stateOf(result, g, "C")).toBe("interrupted");
    expect(installIntervals(fake).map((i) => i.name)).toEqual(["A"]);
  });

  it("refuses to begin an install after a graceful cancel", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    fake.ignoreSignal.add("B");
    const cancel = new AbortController();
    const schedule = start(g, fake, 3, 4, cancel.signal);
    await flush();

    cancel.abort();
    await flush();
    // B did not notice the cancellation and finishes compiling with the lock free.
    fake.finishBuild("B");
    const result = await schedule;

    expect(stateOf(result, g, "B")).toBe("interrupted");
    expect(installIntervals(fake)).toEqual([]);
  });

  it("forced cancel stops the install in progress", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    const force = new AbortController();
    const schedule = start(g, fake, 2, 4, cancel.signal, force.signal);
    await flush();
    fake.finishBuild("A");
    await flush();

    cancel.abort();
    await flush();
    expect(fake.isRunning("A")).toBe(true);
    force.abort();
    expect(fake.installSignals.get("A")!.aborted).toBe(true);
    const result = await schedule;

    expect(stateOf(result, g, "A")).toBe("interrupted");
    expect(stateOf(result, g, "B")).toBe("interrupted");
    expect(result.cancelled).toBe(true);
  });

  it("forced cancel alone also stops building projects", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const force = new AbortController();
    const schedule = start(g, fake, 3, 4, undefined, force.signal);
    await flush();
    force.abort();
    const result = await schedule;

    for (const name of ["A", "B", "C"]) {
      expect(stateOf(result, g, name)).toBe("interrupted");
    }
    expect(stateOf(result, g, "Prog")).toBe("notStarted");
    expect(result.cancelled).toBe(true);
  });

  it("keeps a project that failed before the cancel as failed", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    const schedule = start(g, fake, 3, 4, cancel.signal);
    await flush();
    fake.failBuild("A");
    await flush();

    cancel.abort();
    const result = await schedule;

    expect(stateOf(result, g, "A")).toBe("failed");
    expect(stateOf(result, g, "B")).toBe("interrupted");
    expect(stateOf(result, g, "C")).toBe("interrupted");
    expect(result.cancelled).toBe(true);
  });

  it("starts nothing when the signal is already aborted", async () => {
    const g = threeComponents();
    const fake = new FakeBuilds();
    const cancel = new AbortController();
    cancel.abort();
    const result = await start(g, fake, 3, 4, cancel.signal);

    expect(fake.started()).toEqual([]);
    expect(result.cancelled).toBe(true);
    for (const project of g.order) {
      expect(result.states.get(project.path)!.state).toBe("notStarted");
    }
  });
});
