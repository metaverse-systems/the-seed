import os from "os";
import { BuildableProject } from "./types";

/** Rejection of an install-lock request withdrawn because the build was cancelled. */
export class InstallCancelled extends Error {
  constructor() {
    super("Install cancelled before it started");
    this.name = "InstallCancelled";
  }
}

interface LockWaiter {
  grant: () => void;
  withdraw: () => void;
}

/**
 * A first-in, first-out async mutex. All projects of one build install into
 * the same prefix, so their install phases (install, strip, sign) must never
 * overlap.
 */
export class InstallLock {
  private held = false;
  private waiters: LockWaiter[] = [];

  /**
   * Resolves once the caller holds the lock. If `withdrawSignal` aborts while
   * the caller is still waiting, the request is withdrawn and rejects with
   * InstallCancelled.
   */
  acquire(withdrawSignal?: AbortSignal): Promise<void> {
    if (withdrawSignal?.aborted) {
      return Promise.reject(new InstallCancelled());
    }
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter !== entry);
        reject(new InstallCancelled());
      };
      const entry: LockWaiter = {
        grant: () => {
          withdrawSignal?.removeEventListener("abort", onAbort);
          resolve();
        },
        withdraw: onAbort,
      };
      this.waiters.push(entry);
      withdrawSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Hands the lock to the next waiter, or frees it. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.grant();
    } else {
      this.held = false;
    }
  }
}

/** The number of processors available to this process, never below 1. */
export function processorCount(): number {
  const withAvailable = os as typeof os & { availableParallelism?: () => number };
  const count = typeof withAvailable.availableParallelism === "function"
    ? withAvailable.availableParallelism()
    : os.cpus().length;
  return Math.max(1, count);
}

/**
 * Each project's effective tier: the highest of its own tier and its
 * dependencies' effective tiers. In a well-formed graph this is the declared
 * tier; a project that depends on a higher tier is raised to it, so the tier
 * barrier can never wait on a project's own dependents.
 *
 * @param order - projects in build order (dependencies before dependents)
 * @param edges - project path → paths of its dependencies
 */
export function effectiveTiers(order: BuildableProject[], edges: Map<string, string[]>): Map<string, number> {
  const tiers = new Map<string, number>();
  for (const project of order) {
    let tier: number = project.type;
    for (const dep of edges.get(project.path) ?? []) {
      tier = Math.max(tier, tiers.get(dep) ?? 0);
    }
    tiers.set(project.path, tier);
  }
  return tiers;
}

/**
 * The compile job limit for each project of a tier. At concurrency 1 there is
 * no limit (an unbounded "make -j", as a sequential build has always used).
 * Otherwise the processors are shared among the projects of the tier that can
 * run at once; tiers never overlap, so the running total never exceeds the
 * processor count.
 */
export function tierJobs(concurrency: number, processors: number, tierSize: number): number | undefined {
  if (concurrency <= 1) return undefined;
  return Math.max(1, Math.floor(processors / Math.min(concurrency, tierSize)));
}

/** What runSchedule hands each project it starts. */
export interface ScheduleContext {
  /** Compile job limit for this project, or undefined for no limit */
  jobs: number | undefined;
  /** Aborted when the build is cancelled; for every step outside the install phase */
  signal: AbortSignal;
  /**
   * Runs `fn` while holding the build's install lock. The signal passed to
   * `fn` is aborted only by a forced cancellation.
   */
  withInstallLock: <T>(fn: (installSignal: AbortSignal) => Promise<T>) => Promise<T>;
  /** 0-based position of this project in the start order */
  ordinal: number;
  /** Effective tier of this project */
  tier: number;
}

/** How a project's run ended. */
export type ProjectOutcome<F> =
  | { status: "completed" }
  | { status: "failed"; failure: F }
  | { status: "interrupted" };

/** A project's final state. */
export type ProjectState<F> =
  | { state: "completed" }
  | { state: "failed"; failure: F | unknown }
  | { state: "interrupted" }
  | { state: "notStarted" };

export interface ScheduleOptions<F> {
  /** Projects in build order */
  order: BuildableProject[];
  /** Project path → paths of its dependencies */
  edges: Map<string, string[]>;
  /** Maximum number of projects at once; capped at processorCount */
  concurrency: number;
  /** Processors to share out as compile jobs */
  processorCount: number;
  /** Graceful cancellation: start nothing new */
  signal?: AbortSignal;
  /** Forced cancellation */
  forceSignal?: AbortSignal;
  /** Builds one project; a rejection counts as a failure with the rejection as its reason */
  runProject: (project: BuildableProject, context: ScheduleContext) => Promise<ProjectOutcome<F>>;
}

export interface ScheduleResult<F> {
  /** Final state of every project, by path */
  states: Map<string, ProjectState<F>>;
  /** Projects in the order they started */
  startOrder: BuildableProject[];
  /** Projects in the order they completed */
  completionOrder: BuildableProject[];
  /** Every failure, in the order it happened */
  failures: Array<{ project: BuildableProject; failure: F | unknown }>;
  /** Cancellation was requested before every project completed */
  cancelled: boolean;
}

/**
 * Builds projects concurrently while keeping every ordering guarantee of a
 * sequential build:
 * - a project starts only when each of its dependencies has completed,
 *   install phase included;
 * - no project starts while a project of a lower effective tier is unfinished;
 * - among startable projects, the earliest in build order starts first, so at
 *   concurrency 1 projects start in exactly the build order;
 * - at most `concurrency` projects (and never more than the processors) run
 *   at once, and install phases never overlap;
 * - after the first failure or a cancellation nothing new starts, and the
 *   promise resolves only once every running project has settled.
 */
export function runSchedule<F>(options: ScheduleOptions<F>): Promise<ScheduleResult<F>> {
  const { order, signal, forceSignal, runProject } = options;
  const processors = Math.max(1, options.processorCount);
  const concurrency = Math.max(1, Math.min(options.concurrency, processors));

  const known = new Set(order.map((project) => project.path));
  const edges = new Map(order.map((project) => [
    project.path,
    (options.edges.get(project.path) ?? []).filter((dep) => known.has(dep)),
  ]));
  const tiers = effectiveTiers(order, edges);
  const tierSizes = new Map<number, number>();
  for (const tier of tiers.values()) {
    tierSizes.set(tier, (tierSizes.get(tier) ?? 0) + 1);
  }

  type Status = "waiting" | "running" | "completed" | "failed" | "interrupted";
  const status = new Map<string, Status>(order.map((project) => [project.path, "waiting"]));
  const result: ScheduleResult<F> = {
    states: new Map(),
    startOrder: [],
    completionOrder: [],
    failures: [],
    cancelled: false,
  };
  const lock = new InstallLock();
  let running = 0;
  let stopped = false;

  const isCancelled = () => Boolean(signal?.aborted || forceSignal?.aborted);

  // Aborts `controller` when any of `sources` aborts (or already has).
  const follow = (controller: AbortController, sources: Array<AbortSignal | undefined>) => {
    for (const source of sources) {
      if (!source) continue;
      if (source.aborted) {
        controller.abort();
        return;
      }
      source.addEventListener("abort", () => controller.abort(), { once: true });
    }
  };

  const tierOf = (project: BuildableProject) => tiers.get(project.path) ?? project.type;

  const isUnfinished = (path: string) => {
    const s = status.get(path);
    return s === "waiting" || s === "running";
  };

  const canStart = (project: BuildableProject): boolean => {
    if (status.get(project.path) !== "waiting") return false;
    if (!(edges.get(project.path) ?? []).every((dep) => status.get(dep) === "completed")) return false;
    const tier = tierOf(project);
    return !order.some((other) => tierOf(other) < tier && isUnfinished(other.path));
  };

  return new Promise<ScheduleResult<F>>((resolve) => {
    const finish = () => {
      for (const project of order) {
        const s = status.get(project.path);
        if (s === "waiting") {
          result.states.set(project.path, { state: "notStarted" });
        } else if (s === "completed" || s === "interrupted") {
          result.states.set(project.path, { state: s });
        }
      }
      result.cancelled = isCancelled() && result.completionOrder.length < order.length;
      resolve(result);
    };

    const settle = (project: BuildableProject, outcome: ProjectOutcome<F> | { status: "failed"; failure: unknown }) => {
      running--;
      if (outcome.status === "completed") {
        status.set(project.path, "completed");
        result.completionOrder.push(project);
      } else if (outcome.status === "interrupted") {
        status.set(project.path, "interrupted");
      } else {
        status.set(project.path, "failed");
        stopped = true;
        result.failures.push({ project, failure: outcome.failure });
        result.states.set(project.path, { state: "failed", failure: outcome.failure });
      }
      pump();
    };

    const start = (project: BuildableProject) => {
      status.set(project.path, "running");
      running++;
      const ordinal = result.startOrder.length;
      result.startOrder.push(project);
      const tier = tierOf(project);

      // Steps outside the install phase stop on either cancellation; the
      // install phase stops only on a forced one, so a graceful cancel never
      // leaves a half-written install behind.
      const projectController = new AbortController();
      follow(projectController, [signal, forceSignal]);
      const installController = new AbortController();
      follow(installController, [forceSignal]);

      const context: ScheduleContext = {
        jobs: tierJobs(concurrency, processors, tierSizes.get(tier) ?? 1),
        signal: projectController.signal,
        ordinal,
        tier,
        withInstallLock: async <T>(fn: (installSignal: AbortSignal) => Promise<T>): Promise<T> => {
          // A cancellation withdraws a waiting request and refuses a new one.
          await lock.acquire(projectController.signal);
          try {
            return await fn(installController.signal);
          } finally {
            lock.release();
          }
        },
      };

      new Promise<ProjectOutcome<F>>((res) => res(runProject(project, context))).then(
        (outcome) => settle(project, outcome),
        (reason: unknown) => settle(
          project,
          reason instanceof InstallCancelled ? { status: "interrupted" } : { status: "failed", failure: reason }
        )
      );
    };

    const pump = () => {
      if (!stopped && !isCancelled()) {
        for (const project of order) {
          if (running >= concurrency) break;
          if (canStart(project)) start(project);
        }
      }
      if (running === 0) finish();
    };

    pump();
  });
}
