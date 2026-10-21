
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

import Config from "../src/Config";
import { buildRecursive } from "../src/RecursiveBuild";
import {
  CyclicDependencyError,
  DependencyDiscoveryError,
  ProjectManifestError,
} from "../src/DependencyWalker";
import { RecursiveBuildResult, ProjectBuildResult } from "../src/types";
import { nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";
import { runTheSeed, RunOptions, RunResult } from "./helpers/RunCli";

const mockedBuildRecursive = buildRecursive as jest.MockedFunction<typeof buildRecursive>;

// Header: the build command is run as `the-seed build <args>` through runTheSeed. The configuration is
// mocked, so the configuration directory is only passed through to the build (it is "/fake/config").
// What the run printed on standard error is compared as whole lines: `stderrOf("a", "b")` is "a\nb\n".
// A usage error is the sentence after "Error: ", the usage line of the build command and the help hint.
const CONFIG_DIR = "/fake/config";

function build(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runTheSeed(["build", ...args], { configDir: CONFIG_DIR, ...options });
}

function stderrOf(...lines: string[]): string {
  return lines.map((line) => line + "\n").join("");
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
  });

  it("parses --release from 'native --release'", async () => {
    await build(["native", "--release"]);
    expect(lastBuildOptions()).toEqual(expect.objectContaining({ target: "native", release: true }));
  });

  it("parses --release from 'native recursive --release'", async () => {
    await build(["native", "recursive", "--release"]);
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ release: true })
    );
  });

  it("parses --release from '--release native'", async () => {
    await build(["native", "--release"]);
    expect(lastBuildOptions().release).toBe(true);
  });

  it("handles duplicated --release flag gracefully", async () => {
    await build(["native", "--release", "--release"]);
    // One build, asked to strip
    expect(lastBuildOptions().release).toBe(true);
  });

  it("does not ask for stripping when --release is missing", async () => {
    await build(["native"]);
    expect(lastBuildOptions().release).toBe(false);
  });

  it("asks for stripping for windows target with --release", async () => {
    await build(["windows", "--release"]);
    expect(lastBuildOptions()).toEqual(expect.objectContaining({ target: "windows", release: true }));
  });

  it("leaves compile, install, strip and sign order to buildProject for a non-recursive build", async () => {
    // The ordering itself is asserted in Build.test.ts (buildProject); the command line starts one build.
    await build(["native", "--release"]);
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
    await build(["native", "--recursive"]);
    expectRecursiveCall("native", false);
  });

  it("runs a recursive build for 'windows --release --recursive'", async () => {
    await build(["windows", "--release", "--recursive"]);
    expectRecursiveCall("windows", true);
  });

  it("runs a recursive build for 'windows --recursive --release'", async () => {
    await build(["windows", "--recursive", "--release"]);
    expectRecursiveCall("windows", true);
  });

  it("passes the recursive build the Config built from the context's configuration directory", async () => {
    const configDir = "/scratch/other-config";
    await build(["native", "--recursive"], { configDir });

    expect(mockedBuildRecursive).toHaveBeenCalledTimes(1);
    // The configuration is a field the options gain when the build is given one; read through a cast so this compiles either way.
    const given = (mockedBuildRecursive.mock.calls[0][0] as unknown as { config?: { configDir: string } }).config;
    expect(given).toBeDefined();
    expect(given?.configDir).toBe(configDir);
    const built = (Config as unknown as jest.Mock).mock.results.map((result) => result.value as unknown);
    expect(built).toContain(given);
  });

  it("builds only the current project for 'native --release'", async () => {
    await build(["native", "--release"]);
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
    await build([]);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    const options = lastBuildOptions();
    expect(options.target).toBeUndefined();
    expect(options).toEqual(
      expect.objectContaining({ projectDir: process.cwd(), release: false, configDir: "/fake/config" })
    );
  });
});

describe("BuildCLI plain and incremental result handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
  });

  it("leaves the exit status unset and prints nothing for a completed build", async () => {
    mockBuildProject.mockResolvedValue(completed);
    const run = await build(["native"]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  it.each([
    [["native"], "compile", "make -j exited with status 2"],
    [[], "install", "make install exited with status 1"],
    [["native", "--release"], "strip", "strip failed on /p/x86_64-linux-gnu/bin/tiny: Command failed: strip --strip-unneeded /stage/bin/tiny"],
    [["native"], "sign", "signing failed on /p/x86_64-linux-gnu/lib/libtiny.so.0.0.0: key file unreadable"],
  ])("prints the failed step on stderr, sets exit status 1 and repeats no output for %p", async (args, step, message) => {
    mockBuildProject.mockResolvedValue({ status: "failed", step, message });
    const run = await build(args);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(stderrOf(`Build failed at ${step}: ${message}.`));
  });

  it("prints a signing failure as `Build failed at sign: signing failed on <path>: <message>.` with exit status 1", async () => {
    mockBuildProject.mockResolvedValue({
      status: "failed",
      step: "sign",
      message: "signing failed on /p/x86_64-linux-gnu/bin/tiny: EACCES: permission denied, open '/c/signing/@t/key.pem'",
    });
    const run = await build(["native"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      stderrOf("Build failed at sign: signing failed on /p/x86_64-linux-gnu/bin/tiny: EACCES: permission denied, open '/c/signing/@t/key.pem'.")
    );
  });

  it("prints an unreadable certificate as `Build failed at sign: <cert path>: <reason>.` with exit status 1", async () => {
    mockBuildProject.mockResolvedValue({ status: "failed", step: "sign", message: "/c/signing/@t/cert.pem: error:0480006C:PEM routines::no start line" });
    const run = await build(["native"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(stderrOf("Build failed at sign: /c/signing/@t/cert.pem: error:0480006C:PEM routines::no start line."));
  });

  it("prints a missing strip tool with its hint as `Build failed at strip: Strip tool '<tool>' not found on this system.` with exit status 1", async () => {
    const message = "Strip tool 'strip' not found on this system.\nInstall binutils (for example the binutils package) and try again.";
    mockBuildProject.mockResolvedValue({ status: "failed", step: "strip", message });
    const run = await build(["native", "--release"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(stderrOf(`Build failed at strip: ${message}.`));
    expect(run.stderr).toContain("Build failed at strip: Strip tool 'strip' not found on this system.");
  });

  it("sets exit status 130 and prints Build cancelled. on stderr when the first signal was SIGINT", async () => {
    mockBuildProject.mockImplementation(async () => {
      process.emit("SIGINT", "SIGINT");
      return { status: "cancelled" };
    });
    const run = await build(["native"]);
    expect(run.status).toBe(130);
    expect(run.stderr).toContain("Build cancelled.\n");
  });

  it("prints Build cancelled after installing. with exit status 130 when the install finished after the first SIGINT", async () => {
    mockBuildProject.mockImplementation(async () => {
      process.emit("SIGINT", "SIGINT");
      return { status: "cancelled", installed: true };
    });
    const run = await build(["native"]);
    expect(run.status).toBe(130);
    expect(run.stderr).toContain("Build cancelled after installing.\n");
    expect(run.stderr).not.toContain("Build cancelled.\n");
  });

  it("prints Build cancelled after installing. with exit status 143 for SIGTERM", async () => {
    mockBuildProject.mockImplementation(async () => {
      process.emit("SIGTERM", "SIGTERM");
      return { status: "cancelled", installed: true };
    });
    const run = await build([]);
    expect(run.status).toBe(143);
    expect(run.stderr).toContain("Build cancelled after installing.\n");
  });

  it("prints a failed placement as `Build failed at place: cannot place <path>: <reason>.` with exit status 1", async () => {
    mockBuildProject.mockResolvedValue({
      status: "failed",
      step: "place",
      message: "cannot place /p/x86_64-linux-gnu/lib: EACCES: permission denied",
    });
    const run = await build(["native"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(stderrOf("Build failed at place: cannot place /p/x86_64-linux-gnu/lib: EACCES: permission denied."));
  });
});

describe("BuildCLI rejects invalid arguments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
  });

  it.each([
    [["native", "--recursve"], "Unknown option \"--recursve\" for \"the-seed build\"."],
    [["native", "recursve"], "Unexpected argument \"recursve\" for \"the-seed build\"."],
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
    const run = await build(args);

    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    const lines = run.stderr.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`Error: ${message}`);
    expect(lines[1]).toMatch(/^Usage: the-seed build /);
    expect(lines[2]).toBe("Run \"the-seed help build\" for details.");
    expect(lines[3]).toBe("");
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    expect(mockBuildProject).not.toHaveBeenCalled();
  });

  it("forwards --parallel to the recursive build", async () => {
    const run = await build(["native", "--parallel=3", "--recursive"]);
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ target: "native", parallel: 3 })
    );
    expect(run.stderr).toBe("");
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

  it("passes --jobs to plain, incremental and recursive builds", async () => {
    await build(["native", "--jobs", "3"]);
    expect(lastBuildOptions()).toEqual(expect.objectContaining({ target: "native", jobs: 3 }));

    mockBuildProject.mockClear();
    await build(["--jobs=2"]);
    const incremental = lastBuildOptions();
    expect(incremental.target).toBeUndefined();
    expect(incremental.jobs).toBe(2);

    expect(mockedBuildRecursive).not.toHaveBeenCalled();
    await build(["native", "--recursive", "--jobs", "5", "--parallel", "2"]);
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ target: "native", parallel: 2, jobs: 5 })
    );
  });

  it("leaves jobs undefined when --jobs is not given", async () => {
    await build(["native"]);
    expect(lastBuildOptions().jobs).toBeUndefined();

    await build(["native", "--recursive"]);
    expect(mockedBuildRecursive.mock.calls[0][0].jobs).toBeUndefined();
  });

  it("accepts --jobs above the processor count", async () => {
    await build(["native", "--jobs", "64"]);
    expect(lastBuildOptions().jobs).toBe(64);
  });

  it("rejects a bad incremental --jobs before doing any work", async () => {
    const run = await build(["--jobs", "0"]);
    expect(run.status).toBe(3);
    expect(mockBuildProject).not.toHaveBeenCalled();
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
  });
});

describe("BuildCLI discovery errors in a recursive build", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedBuildRecursive.mockReset();
  });

  it.each([
    ["a DependencyDiscoveryError", new DependencyDiscoveryError("Discovery stopped.\nSecond line.")],
    ["a CyclicDependencyError", new CyclicDependencyError(["@t/a", "@t/b"], ["/loc/a", "/loc/b"])],
    ["a ProjectManifestError", new ProjectManifestError("/loc/b/package.json", "Unexpected end of JSON input")],
  ])("prints exactly the message, exits 1 and throws nothing when the build rejects with %s", async (_name, error) => {
    mockedBuildRecursive.mockRejectedValueOnce(error);

    const run = await build(["native", "--recursive"]);

    expect(run.stderr).toBe(stderrOf(error.message));
    expect(run.status).toBe(1);
  });

  it("reports an unexpected error as one line with status 1 and no stack trace", async () => {
    mockedBuildRecursive.mockRejectedValueOnce(new Error("not a discovery error"));

    const run = await build(["native", "--recursive"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not a discovery error");
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(run.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("BuildCLI deprecated bare word", () => {
  const notice = "Warning: \"recursive\" is deprecated; use \"--recursive\" instead.";
  let events: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    mockedBuildRecursive.mockImplementation(async () => {
      events.push("buildRecursive");
      return {
        success: true, completed: [], failed: null, failureOutput: null, remaining: [],
        cancelled: false, failures: [], interrupted: [], notStarted: [],
      };
    });
  });

  it.each([
    [["native", "recursive"]],
    [["native", "recursive", "--recursive"]],
    [["native", "recursive", "recursive", "--release"]],
  ])("prints the notice once before building for %p", async (args) => {
    const run = await build(args);
    expect(run.stderr).toBe(stderrOf(notice));
    expect(events).toEqual(["buildRecursive"]);
  });

  it("passes the same options as the dashed form", async () => {
    await build(["windows", "recursive", "--release", "--parallel", "2"]);
    await build(["windows", "--recursive", "--release", "--parallel", "2"]);
    expect(mockedBuildRecursive).toHaveBeenCalledTimes(2);
    // Each build gets its own cancellation signals and its own configuration object (built from the
    // same directory); everything else is the same.
    const withoutSignals = (call: number) => {
      const { signal, forceSignal, config, ...rest } = mockedBuildRecursive.mock.calls[call][0];
      expect(config.configDir).toBe("/fake/config");
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
    const run = await build(["native", "recursive"]);
    expect(run.status).toBe(1);
  });

  it("prints no notice for the dashed form", async () => {
    const run = await build(["native", "--recursive"]);
    expect(run.stderr).toBe("");
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
  });

  it("sets exit code 1 for a failed build", async () => {
    mockedBuildRecursive.mockResolvedValue({ ...base, success: false, cancelled: false, failureOutput: "boom" });
    const run = await build(["native", "--recursive", "--parallel", "2"]);
    expect(run.status).toBe(1);
  });

  it("leaves the exit code unset for a successful build", async () => {
    mockedBuildRecursive.mockResolvedValue({ ...base, success: true, cancelled: false });
    const run = await build(["native", "--recursive", "--parallel", "2"]);
    expect(run.status).toBe(0);
  });
});

describe("BuildCLI cancellation signals", () => {
  const notice = "Cancelling: stopping running builds; an install in progress will finish. Press Ctrl+C again to force.";
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const cancelledResult: RecursiveBuildResult = {
    success: false, completed: [], failed: null, failureOutput: null, remaining: [],
    cancelled: true, failures: [], interrupted: [], notStarted: [],
  };

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
    const done = build(args);
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
    baseline = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
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
    const run = await build(["native", "--recursive"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("discovery failed");
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

    process.emit("SIGINT", "SIGINT");
    expect(forceSignal?.aborted).toBe(true);

    run.finish();
    const result = await run.done;
    expect(result.status).toBe(130);
    expect(result.stderr).toContain(notice + "\n");
  });

  it.each([["SIGTERM", 143], ["SIGHUP", 129]] as const)("%s cancels and forces at once", async (sig, code) => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    process.emit(sig, sig);
    expect(run.options().signal?.aborted).toBe(true);
    expect(run.options().forceSignal?.aborted).toBe(true);
    run.finish();
    expect((await run.done).status).toBe(code);
  });

  it("uses the first signal received for the exit status", async () => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGTERM", "SIGTERM");
    run.finish();
    expect((await run.done).status).toBe(130);
  });

  it("sets exit code 1 for a build that failed without being cancelled", async () => {
    const run = startBuild(["native", "--recursive"]);
    await flushMicrotasks();
    run.finish({ ...cancelledResult, cancelled: false, failureOutput: "boom" });
    expect((await run.done).status).toBe(1);
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
      const done = build(args);
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
      const run = await build(["native"]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("boom");
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

      run.finish();
      const result = await run.done;
      expect(result.status).toBe(130);
      expect(result.stderr).toContain(notice + "\n");
      expect(result.stderr).toContain("Build cancelled.\n");
    });

    it("plain build: the second SIGINT forces", async () => {
      const run = startPlain(["native"]);
      await flushMicrotasks();
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      expect(run.options().forceSignal?.aborted).toBe(true);
      run.finish();
      expect((await run.done).status).toBe(130);
    });

    it("incremental build: SIGTERM cancels and forces at once, exit status 143", async () => {
      const run = startPlain([]);
      await flushMicrotasks();
      process.emit("SIGTERM", "SIGTERM");
      expect(run.options().signal?.aborted).toBe(true);
      expect(run.options().forceSignal?.aborted).toBe(true);
      run.finish();
      expect((await run.done).status).toBe(143);
    });

    it("plain build: a failure without a signal sets exit status 1 only", async () => {
      const run = startPlain(["native"]);
      await flushMicrotasks();
      run.finish({ status: "failed", step: "configure", message: "./configure exited with status 1" });
      expect((await run.done).status).toBe(1);
    });
  });
});

// Choices: the help is the one rendered from the command registry, so the placeholders are written <n>, the
// processor count is not part of the text, and sentences that may be wrapped over several lines are compared with
// whitespace collapsed.
describe("BuildCLI help", () => {
  async function helpText(args: string[] = ["help"]): Promise<string> {
    jest.clearAllMocks();
    const run = await build(args);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    return run.stdout;
  }
  const collapse = (text: string) => text.replace(/\s+/g, " ");

  it.each([[["--help"]], [["-h"]], [["help"]], [["native", "--jobs", "0", "-h"]], [["native", "--recursve", "--help"]]])(
    "build %p prints build's help with status 0 and runs no step",
    async (args) => {
      const reference = await helpText(["help"]);
      const text = await helpText(args);
      expect(text).toBe(reference);
      expect(text).toContain("Usage: the-seed build");
      expect(mockBuildProject).not.toHaveBeenCalled();
      expect(mockedBuildRecursive).not.toHaveBeenCalled();
    }
  );

  it("explains that a second Ctrl+C discards an install that has not reached the prefix", async () => {
    const text = collapse(await helpText());
    expect(text).toContain("Press it again to stop at once; an install that has not reached the prefix is discarded.");
  });

  it("describes the dashed options, defaults, examples and the deprecation", async () => {
    const text = await helpText();

    expect(text).toContain("[--recursive] [--parallel <n>] [--jobs <n>] [--release]");
    expect(text).toContain("--recursive");
    expect(text).toContain("--parallel <n>");
    expect(text).toContain("--release");
    expect(text).toContain("default 1");
    expect(text).toContain("the-seed build native --recursive --parallel 4 --release");
    expect(text).toMatch(/the-seed build windows --recursive/);
    expect(collapse(text)).toMatch(/bare word "recursive"[^.]*deprecated/);
    expect(text).not.toMatch(/the-seed build (native|windows) recursive/);
    expect(mockedBuildRecursive).not.toHaveBeenCalled();
  });
});

describe("BuildCLI help › lists --jobs with its default", () => {
  const helpText = async (): Promise<string> => {
    jest.clearAllMocks();
    return (await build(["help"])).stdout;
  };

  it("shows both usage forms and the incremental line", async () => {
    const text = (await helpText()).replace(/\s+/g, " ");
    expect(text).toContain("[--recursive] [--parallel <n>] [--jobs <n>] [--release]");
    expect(text).toContain("\"the-seed build [--jobs <n>]\" rebuilds the current project (make, install, sign)");
  });

  it("lists --jobs with the processor count as its default", async () => {
    const text = (await helpText()).replace(/\s+/g, " ");
    expect(text).toContain("--jobs <n>");
    expect(text).toContain(
      "Run at most <n> compile jobs at once (default: the processor count); with --parallel, the projects building at once share <n>"
    );
  });

  it("explains the = forms, the reduction and the shared budget", async () => {
    // Whitespace is collapsed so the sentences may be wrapped over several lines.
    const text = (await helpText()).replace(/\s+/g, " ");
    expect(text).toContain(
      "--parallel=<n> and --jobs=<n> are the same as --parallel <n> and --jobs <n>. --parallel above the processor count, or above --jobs, is reduced to it."
    );
    expect(text).toContain(
      "With --recursive and --parallel above 1, the compile jobs of the projects building at once never add up to more than --jobs, or the processor count when --jobs is not given."
    );
  });

  it("describes the install phase", async () => {
    // Whitespace is collapsed so the sentences may be wrapped over several lines.
    const text = (await helpText()).replace(/\s+/g, " ");
    expect(text).toContain(
      "Strip the installed programs and libraries (and the build-tree copies \"the-seed package\" reads) before they are signed"
    );
    expect(text).toContain("staging directory");
    expect(text).toContain("Archives, import libraries, wrappers and other files are not stripped or signed.");
    expect(text).toContain("A failure leaves the prefix as it was.");
    expect(text).toContain("Install phases never overlap.");
    expect(text).not.toContain("Installs (with strip and sign) never overlap.");
  });

  it("gives an example with --jobs", async () => {
    const text = await helpText();
    expect(text).toContain("the-seed build native --jobs 4");
    expect(text).toContain("Build for Linux with at most 4 compile jobs");
  });
});

describe("BuildCLI without the native component", () => {
  type RunModule = typeof import("./helpers/RunCli");
  type RecursiveModule = typeof import("../src/RecursiveBuild");
  type ComponentModule = typeof import("../src/NativeComponent");

  let isolated: { run: RunModule["runTheSeed"]; recursive: jest.MockedFunction<RecursiveModule["buildRecursive"]>; component: ComponentModule };

  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildProject.mockReset();
    isolated = withoutNativeComponent(() => ({
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
      run: (require("./helpers/RunCli") as RunModule).runTheSeed,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the recursive build of the same registry
      recursive: (require("../src/RecursiveBuild") as RecursiveModule).buildRecursive as jest.MockedFunction<RecursiveModule["buildRecursive"]>,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the error class of the same registry
      component: require("../src/NativeComponent") as ComponentModule,
    }));
    // The builds refuse a Windows target the way the real ones do without the component.
    mockBuildProject.mockImplementation(async () => {
      throw new isolated.component.NativeComponentMissingError();
    });
    isolated.recursive.mockImplementation(async () => {
      throw new isolated.component.NativeComponentMissingError();
    });
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
  });

  it.each([
    [["windows"]],
    [["windows", "--release"]],
    [["windows", "--release", "--recursive"]],
  ])("prints the missing component message alone on standard error and exits 2 for build %p", async (args) => {
    const run = await isolated.run(["build", ...args], { configDir: CONFIG_DIR });

    expect(run.stderr).toBe(stderrOf("Error: " + isolated.component.nativeComponentMessage()));
    expect(run.stderr).not.toContain("Build failed");
    expect(run.stderr).not.toMatch(/\n\s+at /);
    expect(run.status).toBe(2);
  });
});
