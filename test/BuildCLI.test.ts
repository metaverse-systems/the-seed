import fs from "fs";
import path from "path";
import os from "os";

// Mock child_process before importing anything that uses it
jest.mock("child_process", () => ({
  execSync: jest.fn(() => Buffer.from("")),
}));

// Mock Config
jest.mock("../src/Config", () => {
  return jest.fn().mockImplementation((configDir?: string) => ({
    config: { prefix: "/fake/prefix" },
    configDir: configDir || "/fake/config",
    loadConfig: jest.fn(),
  }));
});

// Mock Build
const mockReconfigure = jest.fn();
const mockCompile = jest.fn();
const mockInstall = jest.fn();
jest.mock("../src/Build", () => {
  const MockBuild = jest.fn().mockImplementation(() => ({
    reconfigure: mockReconfigure,
    compile: mockCompile,
    install: mockInstall,
    target: "linux",
  }));
  return {
    __esModule: true,
    default: MockBuild,
    autoSignIfCertExists: jest.fn().mockResolvedValue(undefined),
    stripBinaries: jest.fn().mockResolvedValue({ strippedFiles: [], stripTool: "strip" }),
  };
});

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

import { execSync } from "child_process";
import { autoSignIfCertExists, stripBinaries } from "../src/Build";
import { buildRecursive } from "../src/RecursiveBuild";
import BuildCLI from "../src/scripts/BuildCLI";
import { ScriptArgsType, RecursiveBuildResult } from "../src/types";

const mockedStripBinaries = stripBinaries as jest.MockedFunction<typeof stripBinaries>;
const mockedAutoSign = autoSignIfCertExists as jest.MockedFunction<typeof autoSignIfCertExists>;
const mockedBuildRecursive = buildRecursive as jest.MockedFunction<typeof buildRecursive>;

function makeArgs(args: string[]): ScriptArgsType {
  return {
    binName: "the-seed",
    args: ["node", "the-seed", "build", ...args],
    configDir: "/fake/config",
  };
}

describe("BuildCLI --release flag parsing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconfigure.mockClear();
    mockCompile.mockClear();
    mockInstall.mockClear();
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
    process.exitCode = undefined;
  });

  it("parses --release from 'native --release'", async () => {
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(mockedStripBinaries).toHaveBeenCalled();
  });

  it("parses --release from 'native recursive --release'", async () => {
    await BuildCLI(makeArgs(["native", "recursive", "--release"]));
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ release: true })
    );
  });

  it("parses --release from '--release native'", async () => {
    // --release before target: args[3] = '--release', need flexible parsing
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(mockedStripBinaries).toHaveBeenCalled();
  });

  it("handles duplicated --release flag gracefully", async () => {
    await BuildCLI(makeArgs(["native", "--release", "--release"]));
    // Should not throw and stripBinaries should be called exactly once
    expect(mockedStripBinaries).toHaveBeenCalledTimes(1);
  });

  it("does not call stripBinaries when --release is missing", async () => {
    await BuildCLI(makeArgs(["native"]));
    expect(mockedStripBinaries).not.toHaveBeenCalled();
  });

  it("calls stripBinaries for windows target with --release", async () => {
    await BuildCLI(makeArgs(["windows", "--release"]));
    expect(mockedStripBinaries).toHaveBeenCalledWith(
      expect.any(String),
      "windows"
    );
  });

  it("calls stripBinaries between install and sign for non-recursive build", async () => {
    const callOrder: string[] = [];
    mockCompile.mockImplementation(() => callOrder.push("compile"));
    mockedStripBinaries.mockImplementation(async () => {
      callOrder.push("strip");
      return { strippedFiles: [], stripTool: "strip" };
    });
    mockedAutoSign.mockImplementation(async () => {
      callOrder.push("sign");
    });
    mockInstall.mockImplementation(() => callOrder.push("install"));

    await BuildCLI(makeArgs(["native", "--release"]));

    expect(callOrder).toEqual(["compile", "install", "strip", "sign"]);
  });
});

describe("BuildCLI dashed --recursive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
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
    expect(mockReconfigure).not.toHaveBeenCalled();
    expect(mockCompile).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
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
    expect(mockReconfigure).toHaveBeenCalledWith("native");
    expect(mockCompile).toHaveBeenCalled();
    expect(mockInstall).toHaveBeenCalled();
    expect(mockedStripBinaries).toHaveBeenCalledWith(process.cwd(), "native");
  });

  it("still runs compile, install and auto-sign for 'build' with no target", async () => {
    await BuildCLI(makeArgs([]));
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    expect(mockReconfigure).not.toHaveBeenCalled();
    expect(mockCompile).toHaveBeenCalled();
    expect(mockInstall).toHaveBeenCalled();
    expect(mockedAutoSign).toHaveBeenCalledWith("/fake/config");
  });
});

describe("BuildCLI rejects invalid arguments", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
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
    [["foo"], "Unrecognized build target \"foo\"; expected native or windows."],
  ])("rejects %p before doing any work", async (args, message) => {
    await BuildCLI(makeArgs(args));

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
      message,
      "Valid options: --recursive, --parallel N, --release",
      "Run \"the-seed build help\" for details.",
    ]);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    expect(mockReconfigure).not.toHaveBeenCalled();
    expect(mockCompile).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockedStripBinaries).not.toHaveBeenCalled();
    expect(mockedAutoSign).not.toHaveBeenCalled();
  });

  it("forwards --parallel to the recursive build", async () => {
    await BuildCLI(makeArgs(["native", "--parallel=3", "--recursive"]));
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ target: "native", parallel: 3 })
    );
    expect(errorSpy).not.toHaveBeenCalled();
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

  it("installs no handler for a non-recursive build", async () => {
    let during: Record<string, number> = {};
    mockCompile.mockImplementation(() => {
      during = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
    });
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(during).toEqual(baseline);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
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

    expect(text).toContain("the-seed build <target> [--recursive] [--parallel N] [--release]");
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
