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
    steps.push({ label: "autogen", command: "./autogen.sh" });
    steps.push({
      label: "distclean",
      command: "make distclean",
      ignoreExitCode: true,
    });
    steps.push({ label: "configure", command: "./configure --prefix=/fake" });
  }
  steps.push({ label: "compile", command: jobs === undefined ? "make -j" : `make -j${jobs}` });
  steps.push({ label: "install", command: "make install" });
  return steps;
});

jest.mock("../src/Build", () => {
  const MockBuild = jest.fn().mockImplementation(() => ({
    getSteps: mockGetSteps,
  }));
  return {
    __esModule: true,
    default: MockBuild,
    autoSignIfCertExists: jest.fn().mockResolvedValue(undefined),
    stripBinaries: jest.fn().mockResolvedValue({ strippedFiles: [], stripTool: "strip" }),
  };
});

// Mock DependencyWalker
jest.mock("../src/DependencyWalker", () => ({
  walkDependencies: jest.fn(),
  resolveBuildOrder: jest.fn(),
  CyclicDependencyError: class CyclicDependencyError extends Error {
    cycleParticipants: string[];
    constructor(participants: string[]) {
      super(`Cyclic dependency detected among: ${participants.join(", ")}`);
      this.name = "CyclicDependencyError";
      this.cycleParticipants = participants;
    }
  },
}));

import {
  walkDependencies,
  resolveBuildOrder,
  CyclicDependencyError,
} from "../src/DependencyWalker";
import { runCommand, formatFailureOutput, CommandResult } from "../src/ProcessRunner";
import { buildRecursive, getRecursiveBuildSteps } from "../src/RecursiveBuild";
import { stripBinaries, autoSignIfCertExists } from "../src/Build";

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedStripBinaries = stripBinaries as jest.MockedFunction<typeof stripBinaries>;
const mockedAutoSign = autoSignIfCertExists as jest.MockedFunction<typeof autoSignIfCertExists>;
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
  "make -j",
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
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
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
      const calls = mockedRunCommand.mock.calls.map((call) => [call[0], call[1]?.cwd]);
      const expected = [comp, sys, prog].flatMap((p) => FULL_STEPS.map((cmd) => [cmd, p.path]));
      expect(calls).toEqual(expected);

      // Every project asked for the unbounded compile step
      expect(mockGetSteps).toHaveBeenCalledTimes(3);
      for (const call of mockGetSteps.mock.calls) {
        expect(call[2]).toBeUndefined();
      }
    });

    it("passes the inherited environment at the default limit", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      for (const call of mockedRunCommand.mock.calls) {
        expect(call[1]?.env).toBeUndefined();
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
        formatFailureOutput("make -j", "partial build\n", "error: compile failed\n")
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
        expect(entry.steps[3].command).toBe("make -j");
        expect(entry.steps[4].label).toBe("install");
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
    it("calls stripBinaries after install for each project when release=true", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        release: true,
      });

      // stripBinaries should be called once per project (3 projects)
      expect(mockedStripBinaries).toHaveBeenCalledTimes(3);
      const stripped = mockedStripBinaries.mock.calls.map((call) => [call[0], call[1]]);
      expect(stripped).toEqual([
        [comp.path, "native"],
        [sys.path, "native"],
        [prog.path, "native"],
      ]);
    });

    it("does not call stripBinaries when release is false", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        release: false,
      });

      expect(mockedStripBinaries).not.toHaveBeenCalled();
    });

    it("does not call stripBinaries when release is omitted", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(mockedStripBinaries).not.toHaveBeenCalled();
    });

    it("calls stripBinaries before autoSignIfCertExists in order", async () => {
      const callOrder: string[] = [];
      mockedRunCommand.mockImplementation(async (cmd: string) => {
        if (cmd === "make install") callOrder.push("install");
        return commandResult();
      });
      mockedStripBinaries.mockImplementation(async () => {
        callOrder.push("strip");
        return { strippedFiles: [], stripTool: "strip" };
      });
      mockedAutoSign.mockImplementation(async () => {
        callOrder.push("sign");
      });

      // Only 1 project to simplify ordering check
      useGraph([comp]);

      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: comp.path,
        release: true,
      });

      expect(callOrder).toEqual(["install", "strip", "sign"]);
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
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
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
      expect(call[1]?.env).toBeUndefined();
    }
    const compiles = mockedRunCommand.mock.calls.map((call) => call[0]).filter((cmd) => cmd.startsWith("make -j"));
    expect(compiles).toEqual(["make -j", "make -j", "make -j", "make -j"]);
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
      "Building up to 3 projects at once (4 processors; compile jobs are shared out per tier)"
    );
    expect(logLines.filter((line) => line.includes("compile jobs each"))).toEqual([
      "Components: up to 3 at once, 1 compile jobs each",
      "Programs: up to 1 at once, 4 compile jobs each",
    ]);

    const jobsByProject = Object.fromEntries(
      mockGetSteps.mock.calls.map((call, i) => [i, call[2]])
    );
    expect(Object.values(jobsByProject).sort()).toEqual([1, 1, 1, 4]);

    const compileCalls = mockedRunCommand.mock.calls.filter((call) => call[0].startsWith("make -j"));
    expect(compileCalls.map((call) => [call[0], call[1]?.cwd]).sort()).toEqual([
      ["make -j1", "/fake/a"],
      ["make -j1", "/fake/b"],
      ["make -j1", "/fake/c"],
      ["make -j4", "/fake/game"],
    ]);
  });

  it("removes MAKEFLAGS and MFLAGS from every step's environment above the default limit", async () => {
    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path, parallel: 2 });

    expect(mockedRunCommand).toHaveBeenCalledTimes(20);
    for (const call of mockedRunCommand.mock.calls) {
      const env = call[1]?.env;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("MAKEFLAGS");
      expect(env).not.toHaveProperty("MFLAGS");
      expect(env?.PATH).toBe(process.env.PATH);
    }
  });

  it("keeps each project's install, strip and sign together and apart from every other project's", async () => {
    const events: string[] = [];
    mockedRunCommand.mockImplementation(async (cmd: string, options) => {
      const name = String(options?.cwd).split("/").pop();
      if (cmd === "make install") events.push(`install-begin:${name}`);
      await tick();
      if (cmd === "make install") events.push(`install-end:${name}`);
      return commandResult();
    });
    mockedStripBinaries.mockImplementation(async (projectDir: string) => {
      const name = projectDir.split("/").pop();
      events.push(`strip-begin:${name}`);
      await tick();
      events.push(`strip-end:${name}`);
      return { strippedFiles: [], stripTool: "strip" };
    });
    mockedAutoSign.mockImplementation(async (_configDir: string, projectDir?: string) => {
      const name = String(projectDir).split("/").pop();
      events.push(`sign-begin:${name}`);
      await tick();
      events.push(`sign-end:${name}`);
    });

    const result = await buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir: game.path,
      parallel: 3,
      release: true,
    });

    expect(result.success).toBe(true);
    // Every install phase is one uninterrupted block of six events for one project.
    expect(events).toHaveLength(24);
    for (let i = 0; i < events.length; i += 6) {
      const name = events[i].split(":")[1];
      expect(events.slice(i, i + 6)).toEqual([
        `install-begin:${name}`,
        `install-end:${name}`,
        `strip-begin:${name}`,
        `strip-end:${name}`,
        `sign-begin:${name}`,
        `sign-end:${name}`,
      ]);
    }
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
      "Building up to 2 projects at once (2 processors; compile jobs are shared out per tier)"
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

  it("records a strip failure as a failure of the install phase", async () => {
    mockedStripBinaries.mockRejectedValueOnce(new Error("Strip tool 'strip' not found on this system."));
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
      { project: a, step: "strip", output: "Strip tool 'strip' not found on this system." },
    ]);
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
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
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

  it("routes strip and sign output through the project prefix", async () => {
    mockedStripBinaries.mockImplementation(async (_dir, _target, _signal, log) => {
      log?.("Using strip tool: strip");
      return { strippedFiles: [], stripTool: "strip" };
    });
    mockedAutoSign.mockImplementation(async (_configDir, _projectDir, log) => {
      log?.("Auto-signed 1 file(s) using scope '@org'");
    });
    useGraph([a]);

    await buildRecursive({ target: "native", fullReconfigure: true, projectDir: a.path, release: true });

    const lines = runLines();
    expect(lines).toContain("[@org/a] Using strip tool: strip");
    expect(lines).toContain("[@org/a] Auto-signed 1 file(s) using scope '@org'");
  });

  it("reports a sequential failure with one block and the outcome lists", async () => {
    mockedRunCommand.mockImplementation(async (cmd: string, options) => {
      await tick();
      if (options?.cwd === b.path && cmd === "make -j") {
        return commandResult({ exitCode: 2, stdout: "making b\n", stderr: "b.cpp:1: error: oops\n" });
      }
      return commandResult();
    });

    const result = await buildRecursive({ target: "native", fullReconfigure: true, projectDir: game.path });

    const output = formatFailureOutput("make -j", "making b\n", "b.cpp:1: error: oops\n");
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
    mockedRunCommand.mockImplementation(async (cmd: string, options) => {
      await tick();
      if (cmd === "./autogen.sh") started.push(String(options?.cwd));
      if (options?.cwd === a.path && cmd.startsWith("make -j")) {
        setImmediate(releaseB);
        return commandResult({ exitCode: 1, stderr: "a failed\n" });
      }
      if (options?.cwd === b.path && cmd.startsWith("make -j")) {
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
    mockedRunCommand.mockImplementation(async (cmd: string, options) => {
      await tick();
      if (options?.cwd === b.path && cmd.startsWith("make -j")) {
        return commandResult({ exitCode: 1, stderr: "b failed\n" });
      }
      if (options?.cwd === a.path && cmd.startsWith("make -j")) {
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
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    useGraph([a, b, c, game]);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("stops running steps on a graceful cancel and reports the outcome", async () => {
    const controller = new AbortController();
    // a and b compile until they are stopped; c builds quickly.
    mockedRunCommand.mockImplementation(async (cmd: string, options) => {
      await tick();
      if (cmd.startsWith("make -j") && options?.cwd !== c.path) {
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
      mockedRunCommand.mockImplementation(async (cmd: string, options) => {
        await tick();
        if (cmd === "make install" && options?.cwd === a.path) {
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
      mockedRunCommand.mockImplementation(async (cmd: string, options) => {
        if (cmd.startsWith("make -j")) {
          const name = String(options?.cwd).split("/").pop();
          return actual.runCommand(`echo $$ > ${pidDir}/${name}.pid; sleep 30`, { signal: options?.signal });
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
