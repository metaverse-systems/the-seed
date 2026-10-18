
// Mock Config
jest.mock("../src/Config", () => {
  return jest.fn().mockImplementation((configDir?: string) => ({
    config: { prefix: "/fake/prefix" },
    configDir: configDir || "/fake/config",
    loadConfig: jest.fn(),
  }));
});

// Mock Build: the command line only hands the options to buildProject and reports the result.
const mockBuildProject = jest.fn();
jest.mock("../src/Build", () => {
  const MockBuild = jest.fn().mockImplementation(() => ({
    buildProject: mockBuildProject,
  }));
  return {
    __esModule: true,
    default: MockBuild,
    autoSignIfCertExists: jest.fn().mockResolvedValue(undefined),
    stripBinaries: jest.fn().mockResolvedValue({ strippedFiles: [], stripTool: "strip" }),
  };
});

// Fix the processor count so the help text and default are predictable. Choice for the implementer:
// the help text reads the count through processorCount() exported by src/BuildScheduler.
jest.mock("../src/BuildScheduler", () => ({
  ...jest.requireActual("../src/BuildScheduler"),
  processorCount: () => 6,
}));

// Mock RecursiveBuild
jest.mock("../src/RecursiveBuild", () => ({
  buildRecursive: jest.fn().mockResolvedValue({
    success: true,
    completed: [],
    failed: null,
    failureOutput: null,
    remaining: [],
    cancelled: false,
  }),
}));

import { buildRecursive } from "../src/RecursiveBuild";
import BuildCLI from "../src/scripts/BuildCLI";
import { ScriptArgsType, RecursiveBuildResult, ProjectBuildResult } from "../src/types";

const mockedBuildRecursive = buildRecursive as jest.MockedFunction<typeof buildRecursive>;

function makeArgs(args: string[]): ScriptArgsType {
  return {
    binName: "the-seed",
    args: ["node", "the-seed", "build", ...args],
    configDir: "/fake/config",
  };
}

const completed: ProjectBuildResult = { status: "completed" };

/** The options the most recent plain or incremental build received. */
function lastBuildOptions() {
  expect(mockBuildProject).toHaveBeenCalledTimes(1);
  return mockBuildProject.mock.calls[0][0];
}

describe("BuildCLI --release flag parsing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
    mockBuildProject.mockResolvedValue(completed);
    process.exitCode = undefined;
  });

  it("parses --release from 'native --release'", async () => {
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(lastBuildOptions()).toEqual(expect.objectContaining({ target: "native", release: true }));
  });

  it("parses --release from 'native recursive --release'", async () => {
    await BuildCLI(makeArgs(["native", "recursive", "--release"]));
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ release: true })
    );
  });

  it("parses --release from '--release native'", async () => {
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(lastBuildOptions().release).toBe(true);
  });

  it("handles duplicated --release flag gracefully", async () => {
    await BuildCLI(makeArgs(["native", "--release", "--release"]));
    // One build, asked to strip
    expect(lastBuildOptions().release).toBe(true);
  });

  it("does not ask for stripping when --release is missing", async () => {
    await BuildCLI(makeArgs(["native"]));
    expect(lastBuildOptions().release).toBe(false);
  });

  it("asks for stripping for windows target with --release", async () => {
    await BuildCLI(makeArgs(["windows", "--release"]));
    expect(lastBuildOptions()).toEqual(expect.objectContaining({ target: "windows", release: true }));
  });

  it("leaves compile, install, strip and sign order to buildProject for a non-recursive build", async () => {
    // The ordering itself is asserted in Build.test.ts (buildProject); the command line starts one build.
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(mockBuildProject).toHaveBeenCalledTimes(1);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
  });
});

describe("BuildCLI dashed --recursive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
    mockBuildProject.mockResolvedValue(completed);
    process.exitCode = undefined;
  });

  function expectRecursiveCall(target: string, release: boolean): void {
    expect(mockedBuildRecursive).toHaveBeenCalledTimes(1);
    const options = mockedBuildRecursive.mock.calls[0][0];
    expect(options).toEqual(
      expect.objectContaining({
        target,
        fullReconfigure: true,
        projectDir: process.cwd(),
        release,
      })
    );
    expect([undefined, 1]).toContain(options.parallel);
    expect(mockBuildProject).not.toHaveBeenCalled();
  }

  it("runs a recursive build for 'native --recursive'", async () => {
    await BuildCLI(makeArgs(["native", "--recursive"]));
    expectRecursiveCall("native", false);
  });

  it("runs a recursive build for 'windows --release --recursive'", async () => {
    await BuildCLI(makeArgs(["windows", "--release", "--recursive"]));
    expectRecursiveCall("windows", true);
  });

  it("runs a recursive build for 'windows --recursive --release'", async () => {
    await BuildCLI(makeArgs(["windows", "--recursive", "--release"]));
    expectRecursiveCall("windows", true);
  });

  it("builds only the current project for 'native --release'", async () => {
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    expect(lastBuildOptions()).toEqual(
      expect.objectContaining({
        projectDir: process.cwd(),
        target: "native",
        release: true,
        configDir: "/fake/config",
      })
    );
  });

  it("runs an incremental build through buildProject with no target", async () => {
    // An incremental build is a buildProject call without a target (compile and install; the install phase strips and signs).
    await BuildCLI(makeArgs([]));
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    const options = lastBuildOptions();
    expect(options.target).toBeUndefined();
    expect(options).toEqual(
      expect.objectContaining({ projectDir: process.cwd(), release: false, configDir: "/fake/config" })
    );
  });
});

describe("BuildCLI plain and incremental result handling", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
    process.exitCode = undefined;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("leaves the exit status unset and prints nothing for a completed build", async () => {
    mockBuildProject.mockResolvedValue(completed);
    await BuildCLI(makeArgs(["native"]));
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    [["native"], "compile", "make -j exited with status 2"],
    [[], "install", "make install exited with status 1"],
    [["native", "--release"], "strip", "strip failed on /p/x86_64-linux-gnu/bin/tiny: Command failed: strip --strip-unneeded /stage/bin/tiny"],
    [["native"], "sign", "signing failed on /p/x86_64-linux-gnu/lib/libtiny.so.0.0.0: key file unreadable"],
  ])("prints the failed step on stderr, sets exit status 1 and repeats no output for %p", async (args, step, message) => {
    mockBuildProject.mockResolvedValue({ status: "failed", step, message });
    await BuildCLI(makeArgs(args));
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([`Build failed at ${step}: ${message}.`]);
  });

  it("prints a signing failure as `Build failed at sign: signing failed on <path>: <message>.` with exit status 1", async () => {
    mockBuildProject.mockResolvedValue({
      status: "failed",
      step: "sign",
      message: "signing failed on /p/x86_64-linux-gnu/bin/tiny: EACCES: permission denied, open '/c/signing/@t/key.pem'",
    });
    await BuildCLI(makeArgs(["native"]));
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
      "Build failed at sign: signing failed on /p/x86_64-linux-gnu/bin/tiny: EACCES: permission denied, open '/c/signing/@t/key.pem'.",
    ]);
  });

  it("prints an unreadable certificate as `Build failed at sign: <cert path>: <reason>.` with exit status 1", async () => {
    mockBuildProject.mockResolvedValue({ status: "failed", step: "sign", message: "/c/signing/@t/cert.pem: error:0480006C:PEM routines::no start line" });
    await BuildCLI(makeArgs(["native"]));
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
      "Build failed at sign: /c/signing/@t/cert.pem: error:0480006C:PEM routines::no start line.",
    ]);
  });

  it("prints a missing strip tool with its hint as `Build failed at strip: Strip tool '<tool>' not found on this system.` with exit status 1", async () => {
    const message = "Strip tool 'strip' not found on this system.\nInstall binutils (for example the binutils package) and try again.";
    mockBuildProject.mockResolvedValue({ status: "failed", step: "strip", message });
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([`Build failed at strip: ${message}.`]);
    expect(String(errorSpy.mock.calls[0][0])).toContain("Build failed at strip: Strip tool 'strip' not found on this system.");
  });

  it("sets exit status 130 and prints Build cancelled. on stderr when the first signal was SIGINT", async () => {
    mockBuildProject.mockImplementation(async () => {
      process.emit("SIGINT", "SIGINT");
      return { status: "cancelled" };
    });
    await BuildCLI(makeArgs(["native"]));
    expect(process.exitCode).toBe(130);
    expect(errorSpy).toHaveBeenCalledWith("Build cancelled.");
  });
});

describe("BuildCLI rejects invalid arguments", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
    process.exitCode = undefined;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it.each([
    [["native", "--recursve"], "Unrecognized option \"--recursve\"."],
    [["native", "recursve"], "Unrecognized argument \"recursve\"."],
    [["native", "--parallel", "4"], "--parallel applies only to recursive builds; add --recursive."],
    [["native", "--recursive", "--parallel"], "--parallel requires a positive whole number."],
    [["native", "--recursive", "--parallel", "--release"], "--parallel requires a positive whole number."],
    [["native", "--recursive", "--parallel", "0"], "Invalid value \"0\" for --parallel; expected a positive whole number."],
    [["native", "--recursive", "--parallel", "-2"], "Invalid value \"-2\" for --parallel; expected a positive whole number."],
    [["native", "--recursive", "--parallel", "1.5"], "Invalid value \"1.5\" for --parallel; expected a positive whole number."],
    [["native", "--recursive", "--parallel", "x"], "Invalid value \"x\" for --parallel; expected a positive whole number."],
    [["native", "--recursive", "--parallel=0"], "Invalid value \"0\" for --parallel; expected a positive whole number."],
    [["native", "--recursive", "--parallel", "2", "--parallel", "3"], "--parallel was given more than once."],
    [["--recursive"], "A build target is required: native or windows."],
    [["--release"], "A build target is required: native or windows."],
    [["native", "--jobs"], "--jobs requires a positive whole number."],
    [["native", "--jobs", "0"], "Invalid value \"0\" for --jobs; expected a positive whole number."],
    [["native", "--recursive", "--jobs=abc"], "Invalid value \"abc\" for --jobs; expected a positive whole number."],
    [["--jobs", "01"], "Invalid value \"01\" for --jobs; expected a positive whole number."],
    [["native", "--jobs", "2", "--jobs", "3"], "--jobs was given more than once."],
    [["foo"], "Unrecognized build target \"foo\"; expected native or windows."],
  ])("rejects %p before doing any work", async (args, message) => {
    await BuildCLI(makeArgs(args));

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
      message,
      "Valid options: --recursive, --parallel N, --jobs N, --release",
      "Run \"the-seed build help\" for details.",
    ]);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    expect(mockBuildProject).not.toHaveBeenCalled();
  });

  it("forwards --parallel to the recursive build", async () => {
    await BuildCLI(makeArgs(["native", "--parallel=3", "--recursive"]));
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ target: "native", parallel: 3 })
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("BuildCLI --jobs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
    mockBuildProject.mockResolvedValue(completed);
    mockedBuildRecursive.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("passes --jobs to plain, incremental and recursive builds", async () => {
    await BuildCLI(makeArgs(["native", "--jobs", "3"]));
    expect(lastBuildOptions()).toEqual(expect.objectContaining({ target: "native", jobs: 3 }));

    mockBuildProject.mockClear();
    await BuildCLI(makeArgs(["--jobs=2"]));
    const incremental = lastBuildOptions();
    expect(incremental.target).toBeUndefined();
    expect(incremental.jobs).toBe(2);

    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    await BuildCLI(makeArgs(["native", "--recursive", "--jobs", "5", "--parallel", "2"]));
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ target: "native", parallel: 2, jobs: 5 })
    );
  });

  it("leaves jobs undefined when --jobs is not given", async () => {
    await BuildCLI(makeArgs(["native"]));
    expect(lastBuildOptions().jobs).toBeUndefined();

    await BuildCLI(makeArgs(["native", "--recursive"]));
    expect(mockedBuildRecursive.mock.calls[0][0].jobs).toBeUndefined();
  });

  it("accepts --jobs above the processor count", async () => {
    await BuildCLI(makeArgs(["native", "--jobs", "64"]));
    expect(lastBuildOptions().jobs).toBe(64);
  });

  it("rejects a bad incremental --jobs before doing any work", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await BuildCLI(makeArgs(["--jobs", "0"]));
      expect(process.exitCode).toBe(1);
      expect(mockBuildProject).not.toHaveBeenCalled();
      expect(mockedBuildRecursive).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("BuildCLI deprecated bare word", () => {
  const notice = "Warning: \"recursive\" is deprecated; use \"--recursive\" instead.";
  let errorSpy: jest.SpyInstance;
  let events: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    events = [];
    errorSpy = jest.spyOn(console, "error").mockImplementation((message: string) => {
      events.push(`stderr:${message}`);
    });
    mockedBuildRecursive.mockImplementation(async () => {
      events.push("buildRecursive");
      return {
        success: true, completed: [], failed: null, failureOutput: null, remaining: [],
        cancelled: false, failures: [], interrupted: [], notStarted: [],
      };
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it.each([
    [["native", "recursive"]],
    [["native", "recursive", "--recursive"]],
    [["native", "recursive", "recursive", "--release"]],
  ])("prints the notice once before building for %p", async (args) => {
    await BuildCLI(makeArgs(args));
    expect(events).toEqual([`stderr:${notice}`, "buildRecursive"]);
  });

  it("passes the same options as the dashed form", async () => {
    await BuildCLI(makeArgs(["windows", "recursive", "--release", "--parallel", "2"]));
    await BuildCLI(makeArgs(["windows", "--recursive", "--release", "--parallel", "2"]));
    expect(mockedBuildRecursive).toHaveBeenCalledTimes(2);
    // Each build gets its own cancellation signals; everything else is the same.
    const withoutSignals = (call: number) => {
      const { signal, forceSignal, ...rest } = mockedBuildRecursive.mock.calls[call][0];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(forceSignal).toBeInstanceOf(AbortSignal);
      return rest;
    };
    expect(withoutSignals(0)).toEqual(withoutSignals(1));
  });

  it("still sets exit code 1 when the build fails", async () => {
    mockedBuildRecursive.mockResolvedValueOnce({
      success: false, completed: [], failed: null, failureOutput: "boom", remaining: [],
      cancelled: false, failures: [], interrupted: [], notStarted: [],
    });
    await BuildCLI(makeArgs(["native", "recursive"]));
    expect(process.exitCode).toBe(1);
  });

  it("prints no notice for the dashed form", async () => {
    await BuildCLI(makeArgs(["native", "--recursive"]));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("BuildCLI exit status for a recursive build", () => {
  const base = {
    completed: [], failed: null, failureOutput: null, remaining: [],
    failures: [], interrupted: [], notStarted: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedBuildRecursive.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("sets exit code 1 for a failed build", async () => {
    mockedBuildRecursive.mockResolvedValue({ ...base, success: false, cancelled: false, failureOutput: "boom" });
    await BuildCLI(makeArgs(["native", "--recursive", "--parallel", "2"]));
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code unset for a successful build", async () => {
    mockedBuildRecursive.mockResolvedValue({ ...base, success: true, cancelled: false });
    await BuildCLI(makeArgs(["native", "--recursive", "--parallel", "2"]));
    expect(process.exitCode).toBeUndefined();
  });
});

describe("BuildCLI cancellation signals", () => {
  const notice = "Cancelling: stopping running builds; an install in progress will finish. Press Ctrl+C again to force.";
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const cancelledResult: RecursiveBuildResult = {
    success: false, completed: [], failed: null, failureOutput: null, remaining: [],
    cancelled: true, failures: [], interrupted: [], notStarted: [],
  };

  let errorSpy: jest.SpyInstance;
  let baseline: Record<string, number>;

  /** Run a recursive build whose mocked buildRecursive waits until `release` is called. */
  function startBuild(args: string[]) {
    let release: (result: typeof cancelledResult) => void = () => undefined;
    let options: { signal?: AbortSignal; forceSignal?: AbortSignal } = {};
    let listenersDuring: Record<string, number> = {};
    mockedBuildRecursive.mockImplementation((opts) => {
      options = opts;
      listenersDuring = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
      return new Promise((resolve) => {
        release = resolve as typeof release;
      });
    });
    const done = BuildCLI(makeArgs(args));
    return {
      done,
      options: () => options,
      listenersDuring: () => listenersDuring,
      finish: (result = cancelledResult) => release(result),
    };
  }

  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    mockedBuildRecursive.mockReset();
    process.exitCode = undefined;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    baseline = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("installs the handlers for a recursive build and removes them afterwards", async () => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    for (const s of signals) {
      expect(run.listenersDuring()[s]).toBe(baseline[s] + 1);
    }
    run.finish({ ...cancelledResult, cancelled: false, success: true });
    await run.done;
    for (const s of signals) {
      expect(process.listenerCount(s)).toBe(baseline[s]);
    }
  });

  it("removes the handlers when the build throws", async () => {
    mockedBuildRecursive.mockRejectedValue(new Error("discovery failed"));
    await expect(BuildCLI(makeArgs(["native", "--recursive"]))).rejects.toThrow("discovery failed");
    for (const s of signals) {
      expect(process.listenerCount(s)).toBe(baseline[s]);
    }
  });

  it("first Ctrl+C cancels gracefully with a notice; the second forces", async () => {
    const run = startBuild(["native", "--recursive", "--parallel", "2"]);
    await flushMicrotasks();
    const { signal, forceSignal } = run.options();
    expect(signal?.aborted).toBe(false);
    expect(forceSignal?.aborted).toBe(false);

    process.emit("SIGINT", "SIGINT");
    expect(signal?.aborted).toBe(true);
    expect(forceSignal?.aborted).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(notice);

    process.emit("SIGINT", "SIGINT");
    expect(forceSignal?.aborted).toBe(true);

    run.finish();
    await run.done;
    expect(process.exitCode).toBe(130);
  });

  it.each([["SIGTERM", 143], ["SIGHUP", 129]] as const)("%s cancels and forces at once", async (sig, code) => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    process.emit(sig, sig);
    expect(run.options().signal?.aborted).toBe(true);
    expect(run.options().forceSignal?.aborted).toBe(true);
    run.finish();
    await run.done;
    expect(process.exitCode).toBe(code);
  });

  it("uses the first signal received for the exit status", async () => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGTERM", "SIGTERM");
    run.finish();
    await run.done;
    expect(process.exitCode).toBe(130);
  });

  it("sets exit code 1 for a build that failed without being cancelled", async () => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    run.finish({ ...cancelledResult, cancelled: false, failureOutput: "boom" });
    await run.done;
    expect(process.exitCode).toBe(1);
  });

  describe("plain and incremental builds", () => {
    /** Run a plain or incremental build whose mocked buildProject waits until `finish` is called. */
    function startPlain(args: string[]) {
      let release: (result: ProjectBuildResult) => void = () => undefined;
      let options: { signal?: AbortSignal; forceSignal?: AbortSignal } = {};
      let listenersDuring: Record<string, number> = {};
      mockBuildProject.mockImplementation((opts) => {
        options = opts;
        listenersDuring = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
        return new Promise((resolve) => {
          release = resolve as typeof release;
        });
      });
      const done = BuildCLI(makeArgs(args));
      return {
        done,
        options: () => options,
        listenersDuring: () => listenersDuring,
        finish: (result: ProjectBuildResult = { status: "cancelled" }) => release(result),
      };
    }

    beforeEach(() => {
      mockBuildProject.mockReset();
    });

    it.each([[["native"]], [["native", "--release"]], [[]]])(
      "installs the handlers for %p and removes them afterwards",
      async (args) => {
        const run = startPlain(args);
        await flushMicrotasks();
        for (const s of signals) {
          expect(run.listenersDuring()[s]).toBe(baseline[s] + 1);
        }
        run.finish({ status: "completed" });
        await run.done;
        for (const s of signals) {
          expect(process.listenerCount(s)).toBe(baseline[s]);
        }
      }
    );

    it("removes the handlers when buildProject throws", async () => {
      mockBuildProject.mockRejectedValue(new Error("boom"));
      await expect(BuildCLI(makeArgs(["native"]))).rejects.toThrow("boom");
      for (const s of signals) {
        expect(process.listenerCount(s)).toBe(baseline[s]);
      }
    });

    it("plain build: first SIGINT cancels, exit status 130", async () => {
      const run = startPlain(["native"]);
      await flushMicrotasks();
      const { signal, forceSignal } = run.options();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(forceSignal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      process.emit("SIGINT", "SIGINT");
      expect(signal?.aborted).toBe(true);
      expect(forceSignal?.aborted).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(notice);

      run.finish();
      await run.done;
      expect(process.exitCode).toBe(130);
      expect(errorSpy).toHaveBeenCalledWith("Build cancelled.");
    });

    it("plain build: the second SIGINT forces", async () => {
      const run = startPlain(["native"]);
      await flushMicrotasks();
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      expect(run.options().forceSignal?.aborted).toBe(true);
      run.finish();
      await run.done;
      expect(process.exitCode).toBe(130);
    });

    it("incremental build: SIGTERM cancels and forces at once, exit status 143", async () => {
      const run = startPlain([]);
      await flushMicrotasks();
      process.emit("SIGTERM", "SIGTERM");
      expect(run.options().signal?.aborted).toBe(true);
      expect(run.options().forceSignal?.aborted).toBe(true);
      run.finish();
      await run.done;
      expect(process.exitCode).toBe(143);
    });

    it("plain build: a failure without a signal sets exit status 1 only", async () => {
      const run = startPlain(["native"]);
      await flushMicrotasks();
      run.finish({ status: "failed", step: "configure", message: "./configure exited with status 1" });
      await run.done;
      expect(process.exitCode).toBe(1);
    });
  });
});

describe("BuildCLI help", () => {
  it("describes the dashed options, defaults, examples and the deprecation", async () => {
    jest.clearAllMocks();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    let text: string;
    try {
      await BuildCLI(makeArgs(["help"]));
      text = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(text).toContain("the-seed build <target> [--recursive] [--parallel N] [--jobs N] [--release]");
    expect(text).toContain("--recursive");
    expect(text).toContain("--parallel N");
    expect(text).toContain("--release");
    expect(text).toContain("default 1");
    expect(text).toContain("the-seed build native --recursive --parallel 4 --release");
    expect(text).toMatch(/the-seed build windows --recursive/);
    const deprecationLines = text.split("\n").filter((line) => /\brecursive\b/.test(line.replace(/--recursive/g, "")));
    expect(deprecationLines.length).toBeGreaterThan(0);
    for (const line of deprecationLines) {
      expect(line.toLowerCase()).toContain("deprecated");
    }
    expect(text).not.toMatch(/the-seed build (native|windows) recursive/);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
  });
});

describe("BuildCLI help › lists --jobs with its default", () => {
  async function helpText(): Promise<string> {
    jest.clearAllMocks();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await BuildCLI(makeArgs(["help"]));
      return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      logSpy.mockRestore();
    }
  }

  it("shows both usage forms and the incremental line", async () => {
    const text = await helpText();
    expect(text).toContain("the-seed build <target> [--recursive] [--parallel N] [--jobs N] [--release]");
    expect(text).toContain("the-seed build [--jobs N]");
    expect(text).toContain("Rebuild the current project (make, install, sign)");
  });

  it("lists --jobs with the processor count as its default", async () => {
    const text = await helpText();
    expect(text).toContain("--jobs N");
    expect(text).toContain(
      "Run at most N compile jobs at once (default: the processor count, 6 here); with --parallel, the projects building at once share N"
    );
  });

  it("explains the = forms, the reduction and the shared budget", async () => {
    // Whitespace is collapsed so the sentences may be wrapped over several lines.
    const text = (await helpText()).replace(/\s+/g, " ");
    expect(text).toContain(
      "--parallel=N and --jobs=N are the same as --parallel N and --jobs N. --parallel above the processor count, or above --jobs, is reduced to it."
    );
    expect(text).toContain(
      "With --recursive and --parallel above 1, the compile jobs of the projects building at once never add up to more than --jobs, or the processor count when --jobs is not given."
    );
  });

  it("gives an example with --jobs", async () => {
    const text = await helpText();
    expect(text).toContain("the-seed build native --jobs 4");
    expect(text).toContain("Build for Linux with at most 4 compile jobs");
  });
});
