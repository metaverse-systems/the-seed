import { ProjectType } from "../src/types";
import type {
  BuildableProject,
  RecursiveBuildCallbacks,
  RecursiveBuildResult,
} from "../src/types";

// Mock the process runner before importing RecursiveBuild; keep the real
// formatFailureOutput so the failure text is the production one.
jest.mock("../src/ProcessRunner", () => ({
  ...jest.requireActual("../src/ProcessRunner"),
  runCommand: jest.fn(),
}));

// Fix the processor count so the compile-job shares are predictable.
const mockProcessorCount = jest.fn(() => 4);
jest.mock("../src/BuildScheduler", () => ({
  ...jest.requireActual("../src/BuildScheduler"),
  processorCount: () => mockProcessorCount(),
}));

// Mock Config and Build
jest.mock("../src/Config", () => {
  return jest.fn().mockImplementation(() => ({
    config: { prefix: "/fake/prefix" },
    configDir: "/fake/config",
    loadConfig: jest.fn(),
  }));
});

const mockGetSteps = jest.fn((target: string, fullReconfigure: boolean, jobs?: number) => {
  const steps = [];
  if (fullReconfigure) {
    steps.push({ label: "autogen", program: "./autogen.sh", args: [] as string[] });
    steps.push({
      label: "distclean",
      program: "make",
      args: ["distclean"],
      ignoreExitCode: true,
    });
    steps.push({ label: "configure", program: "./configure", args: ["--prefix=/fake"] });
  }
  steps.push({ label: "compile", program: "make", args: [`-j${jobs ?? mockProcessorCount()}`] });
  steps.push({ label: "install", program: "make", args: ["install"] });
  return steps;
});

jest.mock("../src/Build", () => {
  const MockBuild = jest.fn().mockImplementation(() => ({
    getSteps: mockGetSteps,
  }));
  return {
    __esModule: true,
    default: MockBuild,
  };
});

// The install phase is mocked; each case sets what it does. The default
// behaves like the real one for the parts the recursive build observes: it
// runs the install step through the (mocked) process runner in the project's
// directory, reports it installed, and completes.
jest.mock("../src/InstallPhase", () => ({
  ...jest.requireActual("../src/InstallPhase"),
  runInstallPhase: jest.fn(),
}));

// Mock DependencyWalker: only the two functions are replaced; the error classes are the
// real ones, as RecursiveBuild tests against them.
jest.mock("../src/DependencyWalker", () => ({
  ...jest.requireActual("../src/DependencyWalker"),
  walkDependencies: jest.fn(),
  resolveBuildOrder: jest.fn(),
}));

import {
  walkDependencies,
  resolveBuildOrder,
  CyclicDependencyError,
} from "../src/DependencyWalker";
import { runCommand, formatCommand, formatFailureOutput, CommandResult } from "../src/ProcessRunner";
import { buildRecursive, getRecursiveBuildSteps } from "../src/RecursiveBuild";
import { runInstallPhase } from "../src/InstallPhase";
import type { InstallPhaseOptions, InstallPhaseResult, InstallReport } from "../src/types";

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedInstallPhase = runInstallPhase as jest.MockedFunction<typeof runInstallPhase>;

const FAKE_REPORT: InstallReport = {
  prefix: "/fake/prefix",
  installed: 1,
  stripped: [] as string[],
  signed: [] as { display: string; form: "embedded" | "detached" }[],
  outcome: { kind: "unsigned", reason: "noCertificate" },
};

/** The install phase as the recursive build sees it: install step, then completion. */
async function defaultInstallPhase(options: InstallPhaseOptions): Promise<InstallPhaseResult> {
  const result = await runCommand(options.installStep.program, options.installStep.args, {
    cwd: options.projectDir,
    env: options.env,
    signal: options.signal,
  });
  if (result.killed) return { status: "interrupted" };
  options.onInstalled?.();
  return { status: "completed", report: FAKE_REPORT };
}

/** The option objects the install phase was called with, in call order. */
function phaseCalls(): InstallPhaseOptions[] {
  return mockedInstallPhase.mock.calls.map((call) => call[0]);
}
const mockedWalkDependencies = walkDependencies as jest.MockedFunction<
  typeof walkDependencies
>;
const mockedResolveBuildOrder = resolveBuildOrder as jest.MockedFunction<
  typeof resolveBuildOrder
>;

function makeProject(
  name: string,
  projectPath: string,
  type: ProjectType,
  dependencies: string[] = []
): BuildableProject {
  return { name, path: projectPath, type, dependencies };
}

// A runCommand(program, args, options) call as text, and the step kinds by program and arguments.
function callText(call: unknown[]): string {
  return formatCommand(call[0] as string, call[1] as string[]);
}
function isCompile(program: string, args: string[]): boolean {
  return program === "make" && args[0].startsWith("-j");
}
function isInstall(program: string, args: string[]): boolean {
  return program === "make" && args[0] === "install";
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", killed: false, ...overrides };
}

const killedResult = commandResult({ exitCode: null, signal: "SIGTERM", killed: true });

/** Point the mocked walker and resolver at the given projects (already in build order). */
function useGraph(order: BuildableProject[]): void {
  const byName = new Map(order.map((p) => [p.name, p]));
  mockedWalkDependencies.mockResolvedValue({
    projects: new Map(order.map((p) => [p.path, p])),
    edges: new Map(
      order.map((p) => [p.path, p.dependencies.map((d) => byName.get(d)!.path)])
    ),
  });
  mockedResolveBuildOrder.mockReturnValue(order);
}

function expectRemainingInvariant(result: RecursiveBuildResult, total: number): void {
  expect(result.completed.length + result.remaining.length + (result.failed ? 1 : 0)).toBe(total);
}

const FULL_STEPS = [
  "./autogen.sh",
  "make distclean",
  "./configure --prefix=/fake",
  "make -j4",
  "make install",
];

describe("RecursiveBuild", () => {
  const comp = makeProject("comp", "/fake/comp", ProjectType.Component);
  const sys = makeProject("sys", "/fake/sys", ProjectType.System, ["comp"]);
  const prog = makeProject("prog", "/fake/prog", ProjectType.Program, ["sys"]);

  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRunCommand.mockReset();
    mockedRunCommand.mockResolvedValue(commandResult());
    mockProcessorCount.mockReturnValue(4);
    mockedInstallPhase.mockReset();
    mockedInstallPhase.mockImplementation(defaultInstallPhase);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    // Default mock: simple 3-project chain
    useGraph([comp, sys, prog]);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("buildRecursive", () => {
    it("builds all projects in order on success", async () => {
      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(result.success).toBe(true);
      expect(result.completed).toEqual([comp, sys, prog]);
      expect(result.failed).toBeNull();
      expect(result.failureOutput).toBeNull();
      expect(result.remaining).toEqual([]);
      expect(result.cancelled).toBe(false);
      expect(result.failures).toEqual([]);
      expect(result.interrupted).toEqual([]);
      expect(result.notStarted).toEqual([]);
      expectRemainingInvariant(result, 3);

      // Same commands, cwd and order as the sequential build has always run
      const calls = mockedRunCommand.mock.calls.map((call) => [callText(call), call[2]?.cwd]);
      const expected = [comp, sys, prog].flatMap((p) => FULL_STEPS.map((cmd) => [cmd, p.path]));
      expect(calls).toEqual(expected);

      // Every project asked for the processor count (the mocked 4) as its compile job limit
      expect(mockGetSteps).toHaveBeenCalledTimes(3);
      for (const call of mockGetSteps.mock.calls) {
        expect(call[2]).toBe(4);
      }
    });

    it("passes the inherited environment at the default limit", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      for (const call of mockedRunCommand.mock.calls) {
        expect(call[2]?.env).toEqual(process.env);
      }
    });

    it("halts on failure and reports remaining projects", async () => {
      // Fail on the second project's compile step
      let callCount = 0;
      mockedRunCommand.mockImplementation(async () => {
        callCount++;
        // First project has 5 steps (calls 1-5)
        // Second project: autogen(6), distclean(7), configure(8), compile(9) — fail here
        if (callCount === 9) {
          return commandResult({ exitCode: 2, stdout: "partial build\n", stderr: "error: compile failed\n" });
        }
        return commandResult();
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(result.success).toBe(false);
      expect(result.completed).toEqual([comp]);
      expect(result.failed).toEqual(sys);
      expect(result.failureOutput).toBe(
        formatFailureOutput(formatCommand("make", ["-j4"]), "partial build\n", "error: compile failed\n")
      );
      expect(result.failureOutput).toContain("error: compile failed");
      expect(result.remaining).toEqual([prog]);
      expect(result.cancelled).toBe(false);
      expect(result.failures).toEqual([
        { project: sys, step: "compile", output: result.failureOutput },
      ]);
      expect(result.notStarted).toEqual([prog]);
      expect(result.interrupted).toEqual([]);
      expectRemainingInvariant(result, 3);
      expect(mockedRunCommand).toHaveBeenCalledTimes(9);
    });

    it("cancels via AbortSignal", async () => {
      const controller = new AbortController();

      // Abort after first project completes
      let callCount = 0;
      mockedRunCommand.mockImplementation(async () => {
        callCount++;
        if (callCount === 5) {
          // After first project's last step
          controller.abort();
        }
        return commandResult();
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        signal: controller.signal,
      });

      expect(result.cancelled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.failed).toBeNull();
      expect(result.completed).toEqual([comp]);
      expect(result.remaining).toEqual([sys, prog]);
      expect(result.failures).toEqual([]);
      expect(result.interrupted).toEqual([]);
      expect(result.notStarted).toEqual([sys, prog]);
      expectRemainingInvariant(result, 3);
      expect(mockedRunCommand).toHaveBeenCalledTimes(5);
    });

    it("treats a step killed by cancellation as interrupted, not failed", async () => {
      const controller = new AbortController();
      const callbacks: RecursiveBuildCallbacks = {
        onStepComplete: jest.fn(),
        onProjectComplete: jest.fn(),
      };

      let callCount = 0;
      mockedRunCommand.mockImplementation(async () => {
        callCount++;
        if (callCount === 9) {
          // sys compile is running when the signal aborts
          controller.abort();
          return killedResult;
        }
        return commandResult();
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        signal: controller.signal,
        callbacks,
      });

      expect(result.cancelled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.failed).toBeNull();
      expect(result.failureOutput).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.completed).toEqual([comp]);
      expect(result.interrupted).toEqual([sys]);
      expect(result.notStarted).toEqual([prog]);
      expect(result.remaining).toEqual([sys, prog]);
      expectRemainingInvariant(result, 3);

      const sysSteps = (callbacks.onStepComplete as jest.Mock).mock.calls
        .filter((call) => call[0] === sys)
        .map((call) => call[1].label);
      expect(sysSteps).toEqual(["autogen", "distclean", "configure"]);
      expect(callbacks.onProjectComplete).toHaveBeenCalledTimes(1);
    });

    it("never ignores a killed distclean step even though its exit code is ignorable", async () => {
      const controller = new AbortController();
      const callbacks: RecursiveBuildCallbacks = { onStepComplete: jest.fn() };

      let callCount = 0;
      mockedRunCommand.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          controller.abort();
          return killedResult;
        }
        return commandResult();
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        signal: controller.signal,
        callbacks,
      });

      expect(result.cancelled).toBe(true);
      expect(result.failed).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.completed).toEqual([]);
      expect(result.interrupted).toEqual([comp]);
      expect(result.notStarted).toEqual([sys, prog]);
      expect(result.remaining).toEqual([comp, sys, prog]);
      expect(mockedRunCommand).toHaveBeenCalledTimes(2);
      const labels = (callbacks.onStepComplete as jest.Mock).mock.calls.map((call) => call[1].label);
      expect(labels).toEqual(["autogen"]);
    });

    it("builds only root project when no dependencies (single-project fallback)", async () => {
      useGraph([makeProject("prog", "/fake/prog", ProjectType.Program)]);

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(result.success).toBe(true);
      expect(result.completed.map((p) => p.name)).toEqual(["prog"]);
      expectRemainingInvariant(result, 1);
    });

    it("invokes callbacks during build", async () => {
      const callbacks: RecursiveBuildCallbacks = {
        onProjectStart: jest.fn(),
        onStepComplete: jest.fn(),
        onProjectComplete: jest.fn(),
      };

      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        callbacks,
      });

      // onProjectStart called 3 times (one per project)
      expect(callbacks.onProjectStart).toHaveBeenCalledTimes(3);
      expect(callbacks.onProjectStart).toHaveBeenCalledWith(comp, 0, 3);
      expect(callbacks.onProjectStart).toHaveBeenCalledWith(sys, 1, 3);
      expect(callbacks.onProjectStart).toHaveBeenCalledWith(prog, 2, 3);

      // onStepComplete called 15 times (5 steps per project, 3 projects)
      expect(callbacks.onStepComplete).toHaveBeenCalledTimes(15);

      // onProjectComplete called 3 times
      expect(callbacks.onProjectComplete).toHaveBeenCalledTimes(3);
      expect(callbacks.onProjectComplete).toHaveBeenCalledWith(comp, 0, 3);
      expect(callbacks.onProjectComplete).toHaveBeenCalledWith(sys, 1, 3);
      expect(callbacks.onProjectComplete).toHaveBeenCalledWith(prog, 2, 3);
    });

    it("continues past ignoreExitCode steps and still reports them complete", async () => {
      const callbacks: RecursiveBuildCallbacks = { onStepComplete: jest.fn() };
      let callCount = 0;
      mockedRunCommand.mockImplementation(async () => {
        callCount++;
        // Fail on distclean (step 2 — should be ignored)
        if (callCount === 2) {
          return commandResult({ exitCode: 2, stderr: "No rule to make target 'distclean'\n" });
        }
        return commandResult();
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        callbacks,
      });

      // Should still succeed because distclean has ignoreExitCode
      expect(result.success).toBe(true);
      expect(result.failures).toEqual([]);
      expect(mockedRunCommand).toHaveBeenCalledTimes(15);
      const compSteps = (callbacks.onStepComplete as jest.Mock).mock.calls
        .filter((call) => call[0] === comp)
        .map((call) => call[1].label);
      expect(compSteps).toEqual(["autogen", "distclean", "configure", "compile", "install"]);
    });

    it.each([0, -1, 1.5, NaN])("rejects parallel %p with a RangeError before discovery", async (parallel) => {
      await expect(
        buildRecursive({
          target: "native",
          fullReconfigure: true,
          projectDir: prog.path,
          parallel,
        })
      ).rejects.toThrow(RangeError);
      expect(mockedWalkDependencies).not.toHaveBeenCalled();
      expect(mockedRunCommand).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, NaN])("rejects jobs %p with a RangeError before discovery", async (jobs) => {
      await expect(
        buildRecursive({
          target: "native",
          fullReconfigure: true,
          projectDir: prog.path,
          jobs,
        })
      ).rejects.toThrow(RangeError);
      expect(mockedWalkDependencies).not.toHaveBeenCalled();
      expect(mockedRunCommand).not.toHaveBeenCalled();
    });

    it("parallel 1 gives each compile step the processor count", async () => {
      mockProcessorCount.mockReturnValue(6);

      await buildRecursive({ target: "native", fullReconfigure: true, projectDir: prog.path, parallel: 1 });

      const compiles = mockedRunCommand.mock.calls
        .filter((call) => isCompile(call[0], call[1]))
        .map((call) => callText(call));
      expect(compiles).toEqual(["make -j6", "make -j6", "make -j6"]);
    });

    it("with jobs N gives each compile step N, above the processor count too", async () => {
      for (const jobs of [2, 9]) {
        mockedRunCommand.mockClear();

        await buildRecursive({ target: "native", fullReconfigure: true, projectDir: prog.path, jobs });

        const compiles = mockedRunCommand.mock.calls
          .filter((call) => isCompile(call[0], call[1]))
          .map((call) => callText(call));
        expect(compiles).toEqual([`make -j${jobs}`, `make -j${jobs}`, `make -j${jobs}`]);
      }
    });

    it("with jobs N and parallel 1 prints no plan line", async () => {
      const lines: string[] = [];
      logSpy.mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });

      await buildRecursive({ target: "native", fullReconfigure: true, projectDir: prog.path, jobs: 2 });

      expect(lines.some((line) => line.startsWith("Building up to"))).toBe(false);
    });

    it("rejects with a cyclic dependency error before any step runs", async () => {
      mockedResolveBuildOrder.mockImplementation(() => {
        throw new CyclicDependencyError(["/fake/a", "/fake/b"]);
      });

      await expect(
        buildRecursive({
          target: "native",
          fullReconfigure: true,
          projectDir: prog.path,
        })
      ).rejects.toThrow(CyclicDependencyError);
      expect(mockedRunCommand).not.toHaveBeenCalled();
    });
  });

  describe("getRecursiveBuildSteps", () => {
    it("returns steps for all projects in build order", async () => {
      const steps = await getRecursiveBuildSteps(prog.path, "native", true);

      expect(steps.length).toBe(3);
      expect(steps[0].project).toEqual(comp);
      expect(steps[1].project).toEqual(sys);
      expect(steps[2].project).toEqual(prog);

      // Each project should have 5 steps (autogen, distclean, configure, compile, install)
      for (const entry of steps) {
        expect(entry.steps.length).toBe(5);
        expect(entry.steps[0].label).toBe("autogen");
        expect(entry.steps[3].program).toBe("make");
        expect(entry.steps[3].args).toEqual(["-j4"]); // the mocked processor count
        expect(entry.steps[4].label).toBe("install");
      }
    });

    it("passes the jobs argument to every project's steps", async () => {
      const steps = await getRecursiveBuildSteps(prog.path, "native", true, 3);

      for (const entry of steps) {
        expect(entry.steps[3].args).toEqual(["-j3"]);
      }
      for (const call of mockGetSteps.mock.calls) {
        expect(call[2]).toBe(3);
      }
    });

    it("returns only compile+install when fullReconfigure is false", async () => {
      const steps = await getRecursiveBuildSteps(prog.path, "native", false);

      for (const entry of steps) {
        expect(entry.steps.length).toBe(2);
        expect(entry.steps[0].label).toBe("compile");
        expect(entry.steps[1].label).toBe("install");
      }
    });
  });

  describe("buildRecursive with release=true", () => {
    it("runs the install phase once per project with release as given", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        release: true,
      });

      const calls = phaseCalls();
      expect(calls.map((c) => c.projectDir)).toEqual([comp.path, sys.path, prog.path]);
      for (const call of calls) {
        expect(call.release).toBe(true);
        expect(call.target).toBe("native");
        expect(call.installStep).toEqual({ label: "install", program: "make", args: ["install"] });
        expect(call.configPrefix).toBe("/fake/prefix");
        expect(call.configDir).toBe("/fake/config");
        expect(call.output).toEqual({ mode: "capture" });
      }
    });

    it("passes release false when release is false", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        release: false,
      });

      expect(phaseCalls()).toHaveLength(3);
      expect(phaseCalls().every((c) => c.release === false)).toBe(true);
    });

    it("passes release false when release is omitted", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(phaseCalls()).toHaveLength(3);
      expect(phaseCalls().every((c) => c.release === false)).toBe(true);
    });

    it("gives the target to the install phase when the build is not a full reconfigure", async () => {
      useGraph([comp]);

      await buildRecursive({
        target: "windows",
        fullReconfigure: false,
        projectDir: comp.path,
        release: true,
      });

      expect(phaseCalls().map((c) => [c.target, c.release])).toEqual([["windows", true]]);
    });

    it("runs the install phase after the compile step and nothing else after it", async () => {
      const callOrder: string[] = [];
      mockedRunCommand.mockImplementation(async (program: string, args: string[]) => {
        if (isCompile(program, args)) callOrder.push("compile");
        return commandResult();
      });
      mockedInstallPhase.mockImplementation(async (options) => {
        callOrder.push("install-phase");
        options.onInstalled?.();
        return { status: "completed", report: FAKE_REPORT };
      });
      useGraph([comp]);

      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: comp.path,
        release: true,
      });

      expect(callOrder).toEqual(["compile", "install-phase"]);
    });

    it("passes the install signal and the project's environment to the install phase", async () => {
      useGraph([comp]);

      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: comp.path,
        release: true,
      });

      const call = phaseCalls()[0];
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal?.aborted).toBe(false);
      expect(call.env).toBeDefined();
      expect(call.env?.PATH).toBe(process.env.PATH);
      expect(typeof call.log).toBe("function");
    });

    it("prints install... before the phase and install... done and the step callback when it reports installed", async () => {
      const events: string[] = [];
      logSpy.mockImplementation((...args: unknown[]) => {
        events.push(args.map(String).join(" "));
      });
      mockedInstallPhase.mockImplementation(async (options) => {
        events.push("phase-start");
        options.log("a line from the phase");
        events.push("phase-installed");
        options.onInstalled?.();
        events.push("phase-end");
        return { status: "completed", report: FAKE_REPORT };
      });
      useGraph([comp]);

      const installed: string[] = [];
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: comp.path,
        release: true,
        callbacks: {
          onStepComplete: (_project, step) => {
            events.push(`step-complete:${step.label}`);
            installed.push(step.label);
          },
        },
      });

      const from = events.indexOf("[comp] install...");
      expect(from).toBeGreaterThanOrEqual(0);
      expect(events.slice(from, events.indexOf("[comp] completed") + 1)).toEqual([
        "[comp] install...",
        "phase-start",
        "[comp] a line from the phase",
        "phase-installed",
        "[comp] install... done",
        "step-complete:install",
        "phase-end",
        "[comp] completed",
      ]);
      expect(installed).toContain("install");
    });
  });
});

describe("RecursiveBuild in parallel", () => {
  const a = makeProject("a", "/fake/a", ProjectType.Component);
  const b = makeProject("b", "/fake/b", ProjectType.Component);
  const c = makeProject("c", "/fake/c", ProjectType.Component);
  const game = makeProject("game", "/fake/game", ProjectType.Program, ["a", "b", "c"]);

  let logSpy: jest.SpyInstance;
  let logLines: string[];
  const savedMakeflags = process.env.MAKEFLAGS;
  const savedMflags = process.env.MFLAGS;

  /** Resolve after the event loop turns, so several projects really overlap. */
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessorCount.mockReturnValue(4);
    mockedRunCommand.mockReset();
    mockedRunCommand.mockImplementation(async () => {
      await tick();
      return commandResult();
    });
    mockedInstallPhase.mockReset();
    mockedInstallPhase.mockImplementation(defaultInstallPhase);
    logLines = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    process.env.MAKEFLAGS = "-j8 --jobserver-auth=3,4";
    process.env.MFLAGS = "-j8";
    useGraph([a, b, c, game]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (savedMakeflags === undefined) delete process.env.MAKEFLAGS;
    else process.env.MAKEFLAGS = savedMakeflags;
    if (savedMflags === undefined) delete process.env.MFLAGS;
    else process.env.MFLAGS = savedMflags;
  });

  it("prints no concurrency or tier lines and keeps the environment at the default limit", async () => {
    const result = await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path });

    expect(result.success).toBe(true);
    expect(logLines.some((line) => line.startsWith("Building up to"))).toBe(false);
    expect(logLines.some((line) => line.includes("compile jobs each"))).toBe(false);
    for (const call of mockedRunCommand.mock.calls) {
      expect(call[2]?.env).toEqual(process.env);
    }
    const compiles = mockedRunCommand.mock.calls
      .filter((call) => isCompile(call[0], call[1]))
      .map((call) => callText(call));
    expect(compiles).toEqual(["make -j4", "make -j4", "make -j4", "make -j4"]);
  });

  it("shares compile jobs per tier and prints the concurrency and tier lines", async () => {
    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 3,
    });

    expect(result.success).toBe(true);
    expect(logLines).toContain(
      "Building up to 3 projects at once (4 compile jobs shared out per tier)"
    );
    expect(logLines.filter((line) => line.includes("compile jobs each"))).toEqual([
      "Components: up to 3 at once, 1 compile jobs each",
      "Programs: up to 1 at once, 4 compile jobs each",
    ]);

    const jobsByProject = Object.fromEntries(
      mockGetSteps.mock.calls.map((call, i) => [i, call[2]])
    );
    expect(Object.values(jobsByProject).sort()).toEqual([1, 1, 1, 4]);

    const compileCalls = mockedRunCommand.mock.calls.filter((call) => isCompile(call[0], call[1]));
    expect(compileCalls.map((call) => [callText(call), call[2]?.cwd]).sort()).toEqual([
      ["make -j1", "/fake/a"],
      ["make -j1", "/fake/b"],
      ["make -j1", "/fake/c"],
      ["make -j4", "/fake/game"],
    ]);
  });

  it("--jobs 2 --parallel 4 builds at most 2 at once and names the budget in the plan line", async () => {
    let running = 0;
    let maxRunning = 0;
    const callbacks: RecursiveBuildCallbacks = {
      onProjectStart: () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
      },
      onProjectComplete: () => {
        running--;
      },
    };

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 4,
      jobs: 2,
      callbacks,
    });

    expect(result.success).toBe(true);
    expect(maxRunning).toBe(2);
    expect(logLines).toContain("Building up to 2 projects at once (2 compile jobs shared out per tier)");
    // Two components at once share the 2 jobs, one each; the program tier runs alone with both.
    const compiles = mockedRunCommand.mock.calls
      .filter((call) => isCompile(call[0], call[1]))
      .map((call) => [callText(call), call[2]?.cwd]);
    expect(compiles.filter(([, cwd]) => cwd !== "/fake/game").map(([text]) => text)).toEqual(["make -j1", "make -j1", "make -j1"]);
    expect(compiles.filter(([, cwd]) => cwd === "/fake/game")).toEqual([["make -j2", "/fake/game"]]);
  });

  it("jobs larger than the processors still keeps projects at once within the processors", async () => {
    mockProcessorCount.mockReturnValue(2);
    let running = 0;
    let maxRunning = 0;
    const callbacks: RecursiveBuildCallbacks = {
      onProjectStart: () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
      },
      onProjectComplete: () => {
        running--;
      },
    };

    await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 4,
      jobs: 8,
      callbacks,
    });

    expect(maxRunning).toBe(2);
    expect(logLines).toContain("Building up to 2 projects at once (8 compile jobs shared out per tier)");
  });

  it("removes MAKEFLAGS and MFLAGS from every step's environment above the default limit", async () => {
    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path, parallel: 2 });

    expect(mockedRunCommand).toHaveBeenCalledTimes(20);
    for (const call of mockedRunCommand.mock.calls) {
      const env = call[2]?.env;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("MAKEFLAGS");
      expect(env).not.toHaveProperty("MFLAGS");
      expect(env?.PATH).toBe(process.env.PATH);
    }
    // The install phase gets the same bounded environment.
    expect(phaseCalls()).toHaveLength(4);
    for (const call of phaseCalls()) {
      expect(call.env).toBeDefined();
      expect(call.env).not.toHaveProperty("MAKEFLAGS");
      expect(call.env).not.toHaveProperty("MFLAGS");
    }
  });

  it("keeps each project's install phase apart from every other project's", async () => {
    const events: string[] = [];
    mockedInstallPhase.mockImplementation(async (options) => {
      const name = options.projectDir.split("/").pop();
      events.push(`phase-begin:${name}`);
      await tick();
      options.onInstalled?.();
      await tick();
      events.push(`phase-end:${name}`);
      return { status: "completed", report: FAKE_REPORT };
    });

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 3,
      release: true,
    });

    expect(result.success).toBe(true);
    // Every install phase is one uninterrupted block of two events for one project.
    expect(events).toHaveLength(8);
    for (let i = 0; i < events.length; i += 2) {
      const name = events[i].split(":")[1];
      expect(events.slice(i, i + 2)).toEqual([`phase-begin:${name}`, `phase-end:${name}`]);
    }
    expect(events.filter((e) => e.startsWith("phase-begin")).sort()).toEqual([
      "phase-begin:a",
      "phase-begin:b",
      "phase-begin:c",
      "phase-begin:game",
    ]);
  });

  it("starts a dependent only after its dependency's install phase returned", async () => {
    const events: string[] = [];
    mockedInstallPhase.mockImplementation(async (options) => {
      const name = options.projectDir.split("/").pop();
      events.push(`phase-begin:${name}`);
      await tick();
      await tick();
      events.push(`phase-end:${name}`);
      return { status: "completed", report: FAKE_REPORT };
    });
    const callbacks: RecursiveBuildCallbacks = {
      onProjectStart: (project) => {
        events.push(`start:${project.name}`);
      },
    };

    await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 3,
      callbacks,
    });

    const startOfGame = events.indexOf("start:game");
    for (const dep of ["a", "b", "c"]) {
      expect(events.indexOf(`phase-end:${dep}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`phase-end:${dep}`)).toBeLessThan(startOfGame);
    }
  });

  it.each(["install", "strip", "sign", "place"] as const)(
    "records a failure of the install phase at %s as that project's failure at that step",
    async (step) => {
      mockedInstallPhase.mockResolvedValueOnce({
        status: "failed",
        step,
        message: `message from ${step}`,
        output: step === "install" ? `captured output of ${step}` : undefined,
      });
      useGraph([a]);

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: a.path,
        parallel: 2,
        release: true,
      });

      expect(result.success).toBe(false);
      expect(result.failed).toBe(a);
      expect(result.failures).toEqual([
        {
          project: a,
          step,
          output: step === "install" ? "captured output of install" : `message from ${step}`,
        },
      ]);
    }
  );

  it("records an interrupted install phase as the project's interruption", async () => {
    mockedInstallPhase.mockResolvedValueOnce({ status: "interrupted" });
    useGraph([a]);

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: a.path,
      parallel: 2,
      release: true,
    });

    expect(result.success).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.interrupted).toEqual([a]);
    expect(result.completed).toEqual([]);
  });

  it("never runs more projects than processors", async () => {
    mockProcessorCount.mockReturnValue(2);
    const many = ["p", "q", "r", "s", "t"].map((name) => makeProject(name, `/fake/${name}`, ProjectType.Component));
    const root = makeProject("root", "/fake/root", ProjectType.Program, many.map((p) => p.name));
    useGraph([...many, root]);

    let running = 0;
    let maxRunning = 0;
    const callbacks: RecursiveBuildCallbacks = {
      onProjectStart: () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
      },
      onProjectComplete: () => {
        running--;
      },
    };

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: root.path,
      parallel: 8,
      callbacks,
    });

    expect(result.success).toBe(true);
    expect(maxRunning).toBe(2);
    expect(logLines).toContain(
      "Building up to 2 projects at once (2 compile jobs shared out per tier)"
    );
  });

  it("never starts a project before every dependency has completed", async () => {
    const top = makeProject("top", "/fake/top", ProjectType.Component);
    const left = makeProject("left", "/fake/left", ProjectType.Component, ["top"]);
    const right = makeProject("right", "/fake/right", ProjectType.Component, ["top"]);
    const sys = makeProject("sys", "/fake/sys", ProjectType.System, ["left"]);
    const app = makeProject("app", "/fake/app", ProjectType.Program, ["sys", "right"]);
    useGraph([top, left, right, sys, app]);

    const completedNames = new Set<string>();
    const violations: string[] = [];
    const callbacks: RecursiveBuildCallbacks = {
      onProjectStart: (project) => {
        for (const dep of project.dependencies) {
          if (!completedNames.has(dep)) violations.push(`${project.name} before ${dep}`);
        }
      },
      onProjectComplete: (project) => {
        completedNames.add(project.name);
      },
    };

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: app.path,
      parallel: 4,
      callbacks,
    });

    expect(result.success).toBe(true);
    expect(violations).toEqual([]);
    expect(result.completed).toHaveLength(5);
  });
});

describe("RecursiveBuild progress and report", () => {
  const a = makeProject("@org/a", "/fake/a", ProjectType.Component);
  const b = makeProject("@org/b", "/fake/b", ProjectType.Component);
  const game = makeProject("@org/game", "/fake/game", ProjectType.Program, ["@org/a", "@org/b"]);

  let logSpy: jest.SpyInstance;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  /** Every console.log call, as the single string it was called with. */
  function logCalls(): string[] {
    return logSpy.mock.calls.map((call) => {
      expect(call).toHaveLength(1);
      return String(call[0]);
    });
  }

  /** The lines printed after the plan header (which ends with a blank line). */
  function runLines(): string[] {
    const calls = logCalls();
    return calls.slice(calls.indexOf("") + 1);
  }

  function failureBlock(name: string, step: string, output: string): string {
    return `===== ${name} failed at ${step} =====\n${output}${output.endsWith("\n") ? "" : "\n"}===== end of ${name} output =====`;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessorCount.mockReturnValue(4);
    mockedRunCommand.mockReset();
    mockedRunCommand.mockImplementation(async () => {
      await tick();
      return commandResult();
    });
    mockedInstallPhase.mockReset();
    mockedInstallPhase.mockImplementation(defaultInstallPhase);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    useGraph([a, b, game]);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prefixes every progress line with the project name, one call per line", async () => {
    const result = await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path });

    expect(result.success).toBe(true);
    const lines = runLines();
    expect(lines[lines.length - 1]).toBe("Recursive build complete: 3/3 projects built successfully.");
    const progress = lines.slice(0, -1);
    for (const line of progress) {
      expect(line).toMatch(/^\[@org\/(a|b|game)\] /);
      expect(line).not.toContain("\n");
    }
    expect(progress.filter((line) => line.startsWith("[@org/a]"))).toEqual([
      "[@org/a] [1/3] starting",
      "[@org/a] autogen...",
      "[@org/a] autogen... done",
      "[@org/a] distclean...",
      "[@org/a] distclean... done",
      "[@org/a] configure...",
      "[@org/a] configure... done",
      "[@org/a] compile...",
      "[@org/a] compile... done",
      "[@org/a] install...",
      "[@org/a] install... done",
      "[@org/a] completed",
    ]);
    expect(progress).toContain("[@org/b] [2/3] starting");
    expect(progress).toContain("[@org/game] [3/3] starting");
  });

  it("allows only the tier lines unprefixed when building in parallel", async () => {
    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path, parallel: 2 });

    const lines = runLines();
    const unprefixed = lines.slice(0, -1).filter((line) => !line.startsWith("["));
    expect(unprefixed).toEqual([
      "Components: up to 2 at once, 2 compile jobs each",
      "Programs: up to 1 at once, 4 compile jobs each",
    ]);
  });

  it("prefixes the install phase's log lines with the project name", async () => {
    mockedInstallPhase.mockImplementation(async (options) => {
      options.log("Using strip tool: strip");
      options.log("Auto-signed 1 file(s) using scope '@org'");
      options.onInstalled?.();
      return { status: "completed", report: FAKE_REPORT };
    });
    useGraph([a]);

    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: a.path, release: true });

    const lines = runLines();
    expect(lines).toContain("[@org/a] Using strip tool: strip");
    expect(lines).toContain("[@org/a] Auto-signed 1 file(s) using scope '@org'");
  });

  it("prefixes a multi-project phase's lines with the project they came from", async () => {
    mockedInstallPhase.mockImplementation(async (options) => {
      const name = options.projectDir.split("/").pop();
      options.log(`Not signed: notice for ${name}`);
      options.onInstalled?.();
      return { status: "completed", report: FAKE_REPORT };
    });

    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path, release: true });

    const lines = runLines();
    expect(lines).toContain("[@org/a] Not signed: notice for a");
    expect(lines).toContain("[@org/b] Not signed: notice for b");
    expect(lines).toContain("[@org/game] Not signed: notice for game");
  });

  it("shows a failed install phase's message in the failure block", async () => {
    mockedInstallPhase.mockResolvedValueOnce({
      status: "failed",
      step: "sign",
      message: "signing failed on lib/libx.so: key unreadable",
    });
    useGraph([a]);

    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: a.path, release: true });

    expect(logCalls()).toContain(failureBlock("@org/a", "sign", "signing failed on lib/libx.so: key unreadable"));
    expect(runLines()).toContain("[@org/a] failed at sign");
  });

  it("reports a sequential failure with one block and the outcome lists", async () => {
    mockedRunCommand.mockImplementation(async (program: string, args: string[], options) => {
      await tick();
      if (options?.cwd === b.path && (isCompile(program, args) && args[0] === "-j4")) {
        return commandResult({ exitCode: 2, stdout: "making b\n", stderr: "b.cpp:1: error: oops\n" });
      }
      return commandResult();
    });

    const result = await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path });

    const output = formatFailureOutput(formatCommand("make", ["-j4"]), "making b\n", "b.cpp:1: error: oops\n");
    expect(result.failureOutput).toBe(output);
    const lines = runLines();
    const blockIndex = lines.indexOf(failureBlock("@org/b", "compile", output));
    expect(blockIndex).toBeGreaterThan(0);
    expect(lines.slice(blockIndex + 1)).toEqual([
      "",
      "Recursive build failed.",
      "  Completed:     @org/a",
      "  Failed:        @org/b",
      "  Never started: @org/game",
    ]);
    for (const line of lines.slice(0, blockIndex)) {
      expect(line.startsWith("[") || line === "").toBe(true);
    }
    expect(lines).toContain("[@org/b] failed at compile");
  });

  it("lets an in-flight project finish after another fails and starts nothing new", async () => {
    let releaseB: () => void = () => undefined;
    const bMayFinish = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const started: string[] = [];
    mockedRunCommand.mockImplementation(async (program: string, args: string[], options) => {
      await tick();
      if (program === "./autogen.sh") started.push(String(options?.cwd));
      if (options?.cwd === a.path && isCompile(program, args)) {
        setImmediate(releaseB);
        return commandResult({ exitCode: 1, stderr: "a failed\n" });
      }
      if (options?.cwd === b.path && isCompile(program, args)) {
        await bMayFinish;
      }
      return commandResult();
    });

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 2,
    });

    expect(started).toEqual([a.path, b.path]);
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.completed).toEqual([b]);
    expect(result.failed).toBe(a);
    expect(result.notStarted).toEqual([game]);
    expect(result.remaining).toEqual([b, game].filter((p) => !result.completed.includes(p)));
    expectRemainingInvariant(result, 3);

    const lines = runLines();
    const blockIndex = lines.findIndex((line) => line.startsWith("===== @org/a failed at compile ====="));
    const lastProgress = Math.max(...lines.map((line, i) => (line.startsWith("[") ? i : -1)));
    expect(lines).toContain("[@org/b] completed");
    expect(blockIndex).toBeGreaterThan(lastProgress);
    expect(lines.slice(-4)).toEqual([
      "Recursive build failed.",
      "  Completed:     @org/b",
      "  Failed:        @org/a",
      "  Never started: @org/game",
    ]);
  });

  it("reports two in-flight failures in the order they happened", async () => {
    mockedRunCommand.mockImplementation(async (program: string, args: string[], options) => {
      await tick();
      if (options?.cwd === b.path && isCompile(program, args)) {
        return commandResult({ exitCode: 1, stderr: "b failed\n" });
      }
      if (options?.cwd === a.path && isCompile(program, args)) {
        for (let i = 0; i < 5; i++) await tick();
        return commandResult({ exitCode: 1, stderr: "a failed\n" });
      }
      return commandResult();
    });

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 2,
    });

    expect(result.failures.map((f) => f.project)).toEqual([b, a]);
    expect(result.failed).toBe(b);
    expect(result.remaining).toEqual([a, game]);
    expectRemainingInvariant(result, 3);
    const lines = runLines();
    const blocks = lines.filter((line) => line.startsWith("====="));
    expect(blocks).toEqual([
      failureBlock("@org/b", "compile", result.failures[0].output),
      failureBlock("@org/a", "compile", result.failures[1].output),
    ]);
    expect(lines).toContain("  Failed:        @org/b, @org/a");
    expect(lines.some((line) => line.startsWith("  Completed:"))).toBe(false);
  });
});

describe("RecursiveBuild cancellation", () => {
  const a = makeProject("@org/a", "/fake/a", ProjectType.Component);
  const b = makeProject("@org/b", "/fake/b", ProjectType.Component);
  const c = makeProject("@org/c", "/fake/c", ProjectType.Component);
  const game = makeProject("@org/game", "/fake/game", ProjectType.Program, ["@org/a", "@org/b", "@org/c"]);
  const soloGame = makeProject("@org/solo", "/fake/solo", ProjectType.Program, ["@org/a"]);
  const pairGame = makeProject("@org/pair", "/fake/pair", ProjectType.Program, ["@org/a", "@org/b"]);

  let logSpy: jest.SpyInstance;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessorCount.mockReturnValue(4);
    mockedRunCommand.mockReset();
    mockedInstallPhase.mockReset();
    mockedInstallPhase.mockImplementation(defaultInstallPhase);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    useGraph([a, b, c, game]);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("stops running steps on a graceful cancel and reports the outcome", async () => {
    const controller = new AbortController();
    // a and b compile until they are stopped; c builds quickly.
    mockedRunCommand.mockImplementation(async (program: string, args: string[], options) => {
      await tick();
      if (isCompile(program, args) && options?.cwd !== c.path) {
        const signal = options?.signal;
        if (!signal) throw new Error("compile step without a signal");
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        return killedResult;
      }
      return commandResult();
    });
    const callbacks: RecursiveBuildCallbacks = {
      onStepComplete: jest.fn(),
      onProjectComplete: (project) => {
        if (project === c) controller.abort();
      },
    };

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 3,
      signal: controller.signal,
      callbacks,
    });

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.failed).toBeNull();
    expect(result.failures).toEqual([]);
    expect(result.completed).toEqual([c]);
    expect(result.interrupted).toEqual([a, b]);
    expect(result.notStarted).toEqual([game]);
    expect(result.remaining).toEqual([a, b, game]);
    const progressLines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(progressLines).toContain("[@org/a] interrupted");
    expect(progressLines).toContain("[@org/b] interrupted");
    expectRemainingInvariant(result, 4);

    const killedSteps = (callbacks.onStepComplete as jest.Mock).mock.calls.filter(
      (call) => call[0] !== c && call[1].label === "compile"
    );
    expect(killedSteps).toEqual([]);

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.slice(-4)).toEqual([
      "Recursive build cancelled.",
      "  Completed:     @org/c",
      "  Interrupted:   @org/a, @org/b",
      "  Never started: @org/game",
    ]);
  });

  it("lets an install in progress finish on a graceful cancel and stops it on a forced one", async () => {
    for (const forced of [false, true]) {
      mockedRunCommand.mockReset();
      useGraph([a, soloGame]);
      const controller = new AbortController();
      const force = new AbortController();
      mockedRunCommand.mockImplementation(async (program: string, args: string[], options) => {
        await tick();
        if (isInstall(program, args) && options?.cwd === a.path) {
          controller.abort();
          if (forced) force.abort();
          await tick();
          return options?.signal?.aborted ? killedResult : commandResult();
        }
        return commandResult();
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: soloGame.path,
        signal: controller.signal,
        forceSignal: force.signal,
      });

      expect(result.cancelled).toBe(true);
      expect(result.notStarted).toEqual([soloGame]);
      if (forced) {
        expect(result.completed).toEqual([]);
        expect(result.interrupted).toEqual([a]);
      } else {
        expect(result.completed).toEqual([a]);
        expect(result.interrupted).toEqual([]);
      }
    }
  });

  (process.platform === "win32" ? it.skip : it)(
    "leaves no step process behind once the build resolves",
    async () => {
      const fs = jest.requireActual("fs") as typeof import("fs");
      const os = jest.requireActual("os") as typeof import("os");
      const pathModule = jest.requireActual("path") as typeof import("path");
      const actual = jest.requireActual("../src/ProcessRunner") as typeof import("../src/ProcessRunner");
      const pidDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), "recursive-cancel-test-"));
      useGraph([a, b, pairGame]);

      // Compile steps really run (as long sleeps); the others succeed at once.
      mockedRunCommand.mockImplementation(async (program: string, args: string[], options) => {
        if (isCompile(program, args)) {
          const name = String(options?.cwd).split("/").pop();
          return actual.runCommand(
            "sh",
            ["-c", "echo $$ > \"$1\"; sleep 30", "sh", `${pidDir}/${name}.pid`],
            { signal: options?.signal }
          );
        }
        return commandResult();
      });

      const waitForPid = async (name: string): Promise<number> => {
        const file = pathModule.join(pidDir, `${name}.pid`);
        for (let i = 0; i < 250; i++) {
          if (fs.existsSync(file) && fs.readFileSync(file, "utf-8").trim()) {
            return Number(fs.readFileSync(file, "utf-8").trim());
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`${name} never started`);
      };
      const groupAlive = (pgid: number) => {
        try {
          process.kill(-pgid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const controller = new AbortController();
      const build = buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: pairGame.path,
        parallel: 2,
        signal: controller.signal,
      });

      try {
        const pgids = [await waitForPid("a"), await waitForPid("b")];
        expect(pgids.every(groupAlive)).toBe(true);

        const abortedAt = Date.now();
        controller.abort();
        const result = await build;

        expect(Date.now() - abortedAt).toBeLessThan(3000);
        expect(result.cancelled).toBe(true);
        expect(result.interrupted).toEqual([a, b]);
        for (const pgid of pgids) {
          let alive = groupAlive(pgid);
          for (let i = 0; alive && i < 50; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            alive = groupAlive(pgid);
          }
          expect(alive).toBe(false);
        }
        expect(actual.liveProcessGroups()).toEqual([]);
      } finally {
        controller.abort();
        await build.catch(() => undefined);
        fs.rmSync(pidDir, { recursive: true, force: true });
      }
    },
    15000
  );
});
