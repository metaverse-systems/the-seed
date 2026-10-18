import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Build, { targets, extractScope, getStripTool } from "../src/Build";
import { BuildStep, InstallPhaseOptions, InstallPhaseResult } from "../src/types";
import { runInstallPhase } from "../src/InstallPhase";
import { librarySearchEnv } from "../src/LibrarySearch";

// The install phase has its own cases in InstallPhase.test.ts; here it is replaced so
// buildProject's hand-over to it and the mapping of its result can be observed.
jest.mock("../src/InstallPhase", () => ({
  __esModule: true,
  runInstallPhase: jest.fn(),
}));

jest.mock("../src/ProcessRunner", () => ({
  ...jest.requireActual("../src/ProcessRunner"),
  runCommand: jest.fn(),
  // The resolved tool path is "/mock/bin/<name>"; stripBinaries is expected to run that path.
  findOnPath: jest.fn((name: string) => "/mock/bin/" + name),
}));

// Choice for the implementer: the default job count comes from processorCount() exported by
// src/BuildScheduler, which Build must import from there so this mock applies.
const mockProcessors = { count: 6 };
jest.mock("../src/BuildScheduler", () => ({
  ...jest.requireActual("../src/BuildScheduler"),
  processorCount: () => mockProcessors.count,
}));

import { runCommand, findOnPath, formatCommand, CommandResult, RunCommandOptions } from "../src/ProcessRunner";
const mockedFindOnPath = findOnPath as jest.MockedFunction<typeof findOnPath>;
const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

const mockedPhase = runInstallPhase as jest.MockedFunction<typeof runInstallPhase>;

function completedPhase(): InstallPhaseResult {
  return {
    status: "completed",
    report: { prefix: "/p/x86_64-linux-gnu", installed: 0, stripped: [], signed: [], outcome: { kind: "unsigned", reason: "noScope" } },
  };
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", killed: false, ...overrides };
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "build-test-"));
}

describe("test Build", () => {
  let configDir: string;
  let config: Config;
  let build: Build;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);
  });

  beforeEach(() => {
    build = new Build(config);
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });

  describe("targets map", () => {
    it("has correct target mappings", () => {
      expect(targets["native"]).toBe("x86_64-linux-gnu");
      expect(targets["windows"]).toBe("x86_64-w64-mingw32");
    });
  });

  describe("getSteps inherited environment", () => {
    it("extends the PKG_CONFIG_PATH of the environment it is given", () => {
      const configure = build.getSteps("native", true, 2, { PKG_CONFIG_PATH: "/given/path" }).find((s) => s.label === "configure")!;

      expect(configure.env!.PKG_CONFIG_PATH).toBe(
        path.join(config.config.prefix, "x86_64-linux-gnu", "lib", "pkgconfig") + ":/given/path"
      );
    });
  });

  describe("buildProject", () => {
    let projectDir: string;
    let events: string[];
    let sink: { stdout: string[]; stderr: string[] };
    let logSpy: jest.SpyInstance;

    function buildOptions(extra: Record<string, unknown> = {}) {
      return {
        projectDir,
        target: "native" as "native" | "windows" | undefined,
        release: false,
        configDir,
        log: (line: string) => events.push("log:" + line),
        output: {
          stdout: (chunk: Buffer) => sink.stdout.push(chunk.toString()),
          stderr: (chunk: Buffer) => sink.stderr.push(chunk.toString()),
        },
        ...extra,
      };
    }

    /** [program, args] of every runCommand call, in order */
    function programs(): Array<[string, string[]]> {
      return mockedRunCommand.mock.calls.map((call) => [String(call[0]), call[1] as string[]]);
    }

    /** The steps buildProject runs itself: everything before the install step */
    function stepsOf(target: string, full: boolean): Array<[string, string[]]> {
      return build
        .getSteps(target, full)
        .filter((s) => s.label !== "install")
        .map((s) => [s.program, s.args]);
    }

    function installStepOf(target: string, full: boolean): BuildStep {
      return build.getSteps(target, full).find((s) => s.label === "install")!;
    }

    /** Makes the call of the step whose program and first argument match fail with the given result. */
    function failStep(label: string, result: Partial<CommandResult>): void {
      const step = build.getSteps("native", true).find((s) => s.label === label)!;
      mockedRunCommand.mockImplementation(async (program: string, args: string[]) => {
        events.push("run:" + program + " " + args.join(" "));
        return program === step.program && args.join(" ") === step.args.join(" ")
          ? commandResult(result)
          : commandResult();
      });
    }

    /** The options of the one runInstallPhase call */
    function phaseOptions(): InstallPhaseOptions {
      expect(mockedPhase).toHaveBeenCalledTimes(1);
      return mockedPhase.mock.calls[0][0];
    }

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-project-test-"));
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "@scope/proj" }));
      events = [];
      sink = { stdout: [], stderr: [] };
      mockedRunCommand.mockReset();
      mockedRunCommand.mockImplementation(async (program: string, args: string[]) => {
        events.push("run:" + program + " " + args.join(" "));
        return commandResult();
      });
      mockedPhase.mockReset();
      mockedPhase.mockImplementation(async () => {
        events.push("phase");
        return completedPhase();
      });
      mockedFindOnPath.mockClear();
      mockedFindOnPath.mockImplementation((name: string) => "/mock/bin/" + name);
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
      fs.rmSync(projectDir, { recursive: true });
    });

    it("runs the steps before install in order, in the project directory, then the install phase once", async () => {
      const result = await build.buildProject(buildOptions());

      expect(result).toEqual({ status: "completed" });
      expect(programs()).toEqual(stepsOf("native", true));
      expect(programs()).toHaveLength(4);
      for (const call of mockedRunCommand.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ cwd: path.resolve(projectDir) }));
      }
      expect(events[events.length - 1]).toBe("phase");
      expect(mockedPhase).toHaveBeenCalledTimes(1);
    });

    it("hands the install step, the configuration and the build's options to the install phase", async () => {
      const env = { SEED_BASE_VALUE: "kept" };
      await build.buildProject(buildOptions({ release: true, target: "windows", env }));

      const options = phaseOptions();
      expect(options.installStep).toEqual(installStepOf("windows", true));
      expect(options.projectDir).toBe(projectDir);
      expect(options.configPrefix).toBe(config.config.prefix);
      expect(options.configDir).toBe(configDir);
      expect(options.target).toBe("windows");
      expect(options.release).toBe(true);
      expect(options.env).toBe(env);
      expect(typeof options.log).toBe("function");
    });

    it("hands a plain build's output sink to the install phase as stream output", async () => {
      await build.buildProject(buildOptions());

      const options = phaseOptions();
      expect(options.output.mode).toBe("stream");
      const streamed = options.output as { mode: "stream"; output: { stdout(c: Buffer): void; stderr(c: Buffer): void } };
      streamed.output.stdout(Buffer.from("from install out"));
      streamed.output.stderr(Buffer.from("from install err"));
      expect(sink.stdout).toEqual(["from install out"]);
      expect(sink.stderr).toEqual(["from install err"]);
    });

    it("passes the lines the install phase logs to the log option", async () => {
      mockedPhase.mockImplementation(async (options) => {
        options.log("Installed 3 file(s) into /somewhere");
        return completedPhase();
      });

      await build.buildProject(buildOptions());

      expect(events).toContain("log:Installed 3 file(s) into /somewhere");
    });

    it("lays the configure step's environment over the base environment", async () => {
      await build.buildProject(buildOptions({ env: { SEED_BASE_VALUE: "kept" } }));

      const configure = mockedRunCommand.mock.calls.find((call) => call[0] === "./configure")!;
      const env = (configure[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.SEED_BASE_VALUE).toBe("kept");
      expect(env.PKG_CONFIG_PATH).toContain(path.join(build.getInstallPrefix("native"), "lib/pkgconfig"));
      expect(env.PKG_CONFIG_PATH).toBe(
        librarySearchEnv(config.config.prefix, "native", { SEED_BASE_VALUE: "kept" }).PKG_CONFIG_PATH
      );
      expect(env.PKG_CONFIG_PATH).toBe(path.join(config.config.prefix, "x86_64-linux-gnu", "lib", "pkgconfig"));
    });

    it("extends the PKG_CONFIG_PATH of the base environment it was given, not the tool's own", async () => {
      await build.buildProject(buildOptions({ env: { PKG_CONFIG_PATH: "/base/only/path" } }));

      const configure = mockedRunCommand.mock.calls.find((call) => call[0] === "./configure")!;
      const env = (configure[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.PKG_CONFIG_PATH).toBe(
        path.join(config.config.prefix, "x86_64-linux-gnu", "lib", "pkgconfig") + ":/base/only/path"
      );
    });

    it("precedes each step with '==> <label>: <stepText>' through log, the install step too (a line starting with the install command, before the phase runs)", async () => {
      await build.buildProject(buildOptions());

      // Choice: the install line is printed by buildProject before the phase starts and starts with
      // the step's own command text; the stage directory is chosen inside the phase, so any DESTDIR
      // argument may follow it.
      const expected: string[] = [];
      for (const step of build.getSteps("native", true).filter((s) => s.label !== "install")) {
        const text = formatCommand(step.program, step.args);
        expected.push("log:==> " + step.label + ": " + text);
        expected.push("run:" + step.program + " " + step.args.join(" "));
      }
      const installLine = events[expected.length];
      expect(events.slice(0, expected.length)).toEqual(expected);
      expect(installLine.startsWith("log:==> install: make install")).toBe(true);
      expect(events[expected.length + 1]).toBe("phase");
      expect(events).toHaveLength(expected.length + 2);
    });

    it("streams each step's output to the given sink", async () => {
      mockedRunCommand.mockImplementation(async (program: string, _args: string[], options?: RunCommandOptions) => {
        options!.output!.stdout(Buffer.from("out:" + program + ";"));
        options!.output!.stderr(Buffer.from("err:" + program + ";"));
        return commandResult();
      });

      await build.buildProject(buildOptions());

      const programNames = build
        .getSteps("native", true)
        .filter((s) => s.label !== "install")
        .map((s) => s.program);
      expect(sink.stdout).toEqual(programNames.map((p) => "out:" + p + ";"));
      expect(sink.stderr).toEqual(programNames.map((p) => "err:" + p + ";"));
      // Stream mode: nothing is captured
      for (const call of mockedRunCommand.mock.calls) {
        expect((call[2] as RunCommandOptions).output).toBeDefined();
      }
    });

    it("logs an ignored distclean failure and continues", async () => {
      failStep("distclean", { exitCode: 2 });

      const result = await build.buildProject(buildOptions());

      expect(result).toEqual({ status: "completed" });
      expect(events).toContain("log:distclean exited with status 2; ignored.");
      expect(programs()).toEqual(stepsOf("native", true));
      expect(mockedPhase).toHaveBeenCalledTimes(1);
    });

    it("a failure stops before install and returns the step and a one-line message", async () => {
      failStep("compile", { exitCode: 2 });

      const result = await build.buildProject(buildOptions());

      const compile = build.getSteps("native", true).find((s) => s.label === "compile")!;
      expect(result).toEqual({
        status: "failed",
        step: "compile",
        message: formatCommand(compile.program, compile.args) + " exited with status 2",
      });
      expect(mockedPhase).not.toHaveBeenCalled();
      expect(programs()).toHaveLength(4);
    });

    it("a step ended by a signal is a failure of that step (message ends '... was ended by <signal>')", async () => {
      // Wording for the signal case is not fixed by the contract; this is the form the implementation should use.
      failStep("configure", { exitCode: null, signal: "SIGSEGV" });

      const result = await build.buildProject(buildOptions());

      expect(result.status).toBe("failed");
      const failed = result as { status: "failed"; step: string; message: string };
      expect(failed.step).toBe("configure");
      expect(failed.message).toMatch(/was ended by SIGSEGV$/);
      expect(programs()).toHaveLength(3);
      expect(mockedPhase).not.toHaveBeenCalled();
    });

    it("a failure of the first step stops everything after it", async () => {
      failStep("autogen", { exitCode: 1 });
      const result = await build.buildProject(buildOptions());
      expect(result).toEqual({ status: "failed", step: "autogen", message: "./autogen.sh exited with status 1" });
      expect(programs()).toEqual([["./autogen.sh", []]]);
      expect(mockedPhase).not.toHaveBeenCalled();
    });

    it("a program that cannot be started is a failure of that step", async () => {
      mockedRunCommand.mockImplementation(async (program: string) => {
        if (program === "./configure") {
          throw Object.assign(new Error("spawn ./configure ENOENT"), { code: "ENOENT" });
        }
        return commandResult();
      });

      const result = await build.buildProject(buildOptions());

      expect(result).toEqual({ status: "failed", step: "configure", message: "./configure: not found" });
      expect(programs().map(([program]) => program)).toEqual(["./autogen.sh", "make", "./configure"]);
      expect(mockedPhase).not.toHaveBeenCalled();
    });

    it("buildProject returns cancelled and starts no further step", async () => {
      const controller = new AbortController();
      mockedRunCommand.mockImplementation(async (program: string) => {
        if (program === "./autogen.sh") {
          controller.abort();
          return commandResult({ killed: true, exitCode: null, signal: "SIGTERM" });
        }
        return commandResult();
      });

      const result = await build.buildProject(buildOptions({ signal: controller.signal }));

      expect(result).toEqual({ status: "cancelled" });
      expect(programs()).toEqual([["./autogen.sh", []]]);
      expect(mockedPhase).not.toHaveBeenCalled();
    });

    it("starts nothing when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await build.buildProject(buildOptions({ signal: controller.signal }));

      expect(result).toEqual({ status: "cancelled" });
      expect(mockedRunCommand).not.toHaveBeenCalled();
      expect(mockedPhase).not.toHaveBeenCalled();
    });

    it("runs the install phase under the force signal and the other steps under the first signal", async () => {
      const cancel = new AbortController();
      const force = new AbortController();

      await build.buildProject(buildOptions({ signal: cancel.signal, forceSignal: force.signal }));

      for (const call of mockedRunCommand.mock.calls) {
        expect((call[2] as RunCommandOptions).signal).toBe(cancel.signal);
      }
      expect(phaseOptions().signal).toBe(force.signal);
    });

    it("strips under the force signal", async () => {
      const cancel = new AbortController();
      const force = new AbortController();

      await build.buildProject(buildOptions({ release: true, signal: cancel.signal, forceSignal: force.signal }));

      const options = phaseOptions();
      expect(options.release).toBe(true);
      expect(options.target).toBe("native");
      expect(options.signal).toBe(force.signal);
    });

    it("an interrupted install phase gives cancelled", async () => {
      mockedPhase.mockResolvedValue({ status: "interrupted" });

      const result = await build.buildProject(buildOptions({ release: true }));

      expect(result).toEqual({ status: "cancelled" });
    });

    it("starts no install phase after a first cancellation", async () => {
      const cancel = new AbortController();
      const force = new AbortController();
      mockedRunCommand.mockImplementation(async (_program: string, args: string[]) => {
        // The compile step finishes normally just as Ctrl+C arrives
        if (String(args[0]).startsWith("-j")) {
          cancel.abort();
        }
        return commandResult();
      });

      const result = await build.buildProject(buildOptions({ signal: cancel.signal, forceSignal: force.signal }));

      expect(result).toEqual({ status: "cancelled" });
      expect(mockedPhase).not.toHaveBeenCalled();
    });

    it("does not strip an incremental build even with release", async () => {
      await build.buildProject(buildOptions({ release: true, target: undefined }));

      // The phase strips only with release and a target; buildProject hands both over as given
      const options = phaseOptions();
      expect(options.release).toBe(true);
      expect(options.target).toBeUndefined();
      expect(mockedFindOnPath).not.toHaveBeenCalled();
    });

    it.each(["install", "strip", "sign", "place"] as const)(
      "a %s failure of the install phase is a failure at that step with its message",
      async (step) => {
        mockedPhase.mockResolvedValue({ status: "failed", step, message: "the " + step + " message" });

        const result = await build.buildProject(buildOptions({ release: true }));

        expect(result).toEqual({ status: "failed", step, message: "the " + step + " message" });
      }
    );

    it("a first cancellation during an install phase that completes gives cancelled with installed", async () => {
      const cancel = new AbortController();
      const force = new AbortController();
      mockedPhase.mockImplementation(async () => {
        // Ctrl+C once while the install phase runs; the phase is not told to stop and completes
        cancel.abort();
        return completedPhase();
      });

      const result = await build.buildProject(buildOptions({ signal: cancel.signal, forceSignal: force.signal }));

      expect(result).toEqual({ status: "cancelled", installed: true });
      expect(force.signal.aborted).toBe(false);
    });

    it("an install phase that completes with no cancellation has no installed marker", async () => {
      const cancel = new AbortController();

      const result = await build.buildProject(buildOptions({ signal: cancel.signal }));

      expect(result).toEqual({ status: "completed" });
    });

    it("an install phase interrupted after a first cancellation gives plain cancelled, not installed", async () => {
      const cancel = new AbortController();
      mockedPhase.mockImplementation(async () => {
        cancel.abort();
        return { status: "interrupted" };
      });

      const result = await build.buildProject(buildOptions({ signal: cancel.signal }));

      expect(result).toEqual({ status: "cancelled" });
    });

    it("a failed install phase after a first cancellation is still a failure", async () => {
      const cancel = new AbortController();
      mockedPhase.mockImplementation(async () => {
        cancel.abort();
        return { status: "failed", step: "place", message: "cannot place /p/x: denied" };
      });

      const result = await build.buildProject(buildOptions({ signal: cancel.signal }));

      expect(result).toEqual({ status: "failed", step: "place", message: "cannot place /p/x: denied" });
    });

    it("a completed install phase gives completed", async () => {
      const result = await build.buildProject(buildOptions({ release: true }));
      expect(result).toEqual({ status: "completed" });
    });

    it("incremental build (no target) runs compile, then the install phase", async () => {
      const result = await build.buildProject(buildOptions({ target: undefined }));

      expect(result).toEqual({ status: "completed" });
      expect(programs()).toEqual(stepsOf("native", false));
      expect(programs().map(([program]) => program)).toEqual(["make"]);
      const compile = build.getSteps("native", false)[0];
      expect(events.filter((e) => e.startsWith("log:"))[0]).toBe(
        "log:==> compile: " + formatCommand(compile.program, compile.args)
      );
      expect(phaseOptions().installStep).toEqual(installStepOf("native", false));
      expect(phaseOptions().target).toBeUndefined();
    });

    describe("onStepStart", () => {
      it("is called before every step of a full build, the install step included, with a 0-based index and a total of 5", async () => {
        const calls: Array<[string, number, number]> = [];
        mockedRunCommand.mockImplementation(async (program: string, args: string[]) => {
          events.push("run:" + program + " " + args.join(" "));
          return commandResult();
        });
        mockedPhase.mockImplementation(async () => {
          events.push("phase");
          return completedPhase();
        });

        await build.buildProject(
          buildOptions({
            onStepStart: (step: BuildStep, index: number, total: number) => {
              calls.push([step.label, index, total]);
              events.push("start:" + step.label);
            },
          })
        );

        expect(calls).toEqual([
          ["autogen", 0, 5],
          ["distclean", 1, 5],
          ["configure", 2, 5],
          ["compile", 3, 5],
          ["install", 4, 5],
        ]);
        // Each start precedes the step's own work
        expect(events.indexOf("start:autogen")).toBeLessThan(events.indexOf("run:./autogen.sh "));
        expect(events.indexOf("start:install")).toBeLessThan(events.indexOf("phase"));
        expect(events.indexOf("start:compile")).toBeLessThan(events.indexOf("start:install"));
      });

      it("is called with a total of 2 for an incremental build", async () => {
        const calls: Array<[string, number, number]> = [];

        await build.buildProject(
          buildOptions({
            target: undefined,
            onStepStart: (step: BuildStep, index: number, total: number) => calls.push([step.label, index, total]),
          })
        );

        expect(calls).toEqual([
          ["compile", 0, 2],
          ["install", 1, 2],
        ]);
      });

      it("is not called for steps that never start", async () => {
        failStep("configure", { exitCode: 1 });
        const labels: string[] = [];

        await build.buildProject(buildOptions({ onStepStart: (step: BuildStep) => labels.push(step.label) }));

        expect(labels).toEqual(["autogen", "distclean", "configure"]);
        expect(mockedPhase).not.toHaveBeenCalled();
      });
    });
  });

  describe("buildProject jobs", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-jobs-test-"));
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "@scope/proj" }));
      mockedRunCommand.mockReset();
      mockedRunCommand.mockResolvedValue(commandResult());
      mockedPhase.mockReset();
      mockedPhase.mockResolvedValue(completedPhase());
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    function options(extra: Record<string, unknown> = {}) {
      return {
        projectDir,
        target: "native" as "native" | "windows" | undefined,
        release: false,
        configDir,
        log: () => undefined,
        output: { stdout: () => undefined, stderr: () => undefined },
        ...extra,
      };
    }

    function compileArgs(): string[][] {
      return mockedRunCommand.mock.calls
        .filter((call) => call[0] === "make" && String((call[1] as string[])[0]).startsWith("-j"))
        .map((call) => call[1] as string[]);
    }

    it("passes jobs to getSteps for a full build", async () => {
      await build.buildProject(options({ jobs: 3 }));
      expect(compileArgs()).toEqual([["-j3"]]);
    });

    it("passes jobs to getSteps for an incremental build", async () => {
      await build.buildProject(options({ jobs: 2, target: undefined }));
      expect(compileArgs()).toEqual([["-j2"]]);
    });

    it("uses the processor count when no jobs are given", async () => {
      await build.buildProject(options());
      expect(compileArgs()).toEqual([["-j6"]]);
    });
  });

  describe("getSteps", () => {
    const prefix = () => config.config.prefix;

    function stepOf(steps: BuildStep[], label: string): BuildStep {
      const step = steps.find((s) => s.label === label);
      expect(step).toBeDefined();
      return step!;
    }

    it("returns 5 steps for full native build", () => {
      const steps: BuildStep[] = build.getSteps("native", true);
      expect(steps.map(s => s.label)).toEqual([
        "autogen", "distclean", "configure", "compile", "install"
      ]);
    });

    it("returns 5 steps for full windows build", () => {
      const steps: BuildStep[] = build.getSteps("windows", true);
      expect(steps.map(s => s.label)).toEqual([
        "autogen", "distclean", "configure", "compile", "install"
      ]);
    });

    it("returns 2 steps for incremental build (fullReconfigure=false)", () => {
      const steps: BuildStep[] = build.getSteps("native", false);
      expect(steps.map(s => s.label)).toEqual(["compile", "install"]);
    });

    it("incremental build for windows returns 2 steps", () => {
      const steps = build.getSteps("windows", false);
      expect(steps.map(s => s.label)).toEqual(["compile", "install"]);
    });

    it("autogen step runs ./autogen.sh with no arguments", () => {
      const step = stepOf(build.getSteps("native", true), "autogen");
      expect(step.program).toBe("./autogen.sh");
      expect(step.args).toEqual([]);
    });

    it("distclean step runs make distclean and is the only step with ignoreExitCode", () => {
      const steps = build.getSteps("native", true);
      const distclean = stepOf(steps, "distclean");
      expect(distclean.program).toBe("make");
      expect(distclean.args).toEqual(["distclean"]);
      expect(distclean.ignoreExitCode).toBe(true);
      for (const step of steps.filter((s) => s.label !== "distclean")) {
        expect(step.ignoreExitCode).toBeFalsy();
      }
    });

    it("native configure step has the prefix argument, no --host and the native library search environment", () => {
      const step = stepOf(build.getSteps("native", true), "configure");
      const target = prefix() + "/x86_64-linux-gnu";
      expect(step.program).toBe("./configure");
      expect(step.args).toEqual(["--prefix=" + target]);
      expect(step.env).toEqual(librarySearchEnv(prefix(), "native", process.env));
    });

    it("windows configure step adds --host=x86_64-w64-mingw32 and the windows library search environment", () => {
      const step = stepOf(build.getSteps("windows", true), "configure");
      const target = prefix() + "/x86_64-w64-mingw32";
      expect(step.program).toBe("./configure");
      expect(step.args).toEqual(["--prefix=" + target, "--host=x86_64-w64-mingw32"]);
      expect(step.env).toEqual(librarySearchEnv(prefix(), "windows", process.env));
    });

    it("keeps a prefix with a space, quote, double quote and dollar as one unmodified argument", () => {
      const awkward = "/tmp/my prefix/it's \"x\" $HOME";
      const awkwardConfig = new Config(configDir);
      awkwardConfig.config.prefix = awkward;
      const step = stepOf(new Build(awkwardConfig).getSteps("native", true), "configure");
      expect(step.args).toEqual(["--prefix=" + awkward + "/x86_64-linux-gnu"]);
      expect(step.args).toHaveLength(1);
    });

    it("compile step is make -j<processorCount()> without jobs", () => {
      const step = stepOf(build.getSteps("native", true), "compile");
      expect(step.program).toBe("make");
      expect(step.args).toEqual(["-j6"]);
    });

    it("install step is make install", () => {
      const step = stepOf(build.getSteps("native", true), "install");
      expect(step.program).toBe("make");
      expect(step.args).toEqual(["install"]);
    });

    it("getSteps uses make -j<processorCount()> by default for every target and mode", () => {
      for (const count of [1, 6, 16]) {
        mockProcessors.count = count;
        for (const target of ["native", "windows"]) {
          for (const fullReconfigure of [true, false]) {
            const compileStep = stepOf(build.getSteps(target, fullReconfigure), "compile");
            expect(compileStep.program).toBe("make");
            expect(compileStep.args).toEqual([`-j${count}`]);
          }
        }
      }
      mockProcessors.count = 6;
    });

    it("never emits an unbounded make -j", () => {
      for (const target of ["native", "windows"]) {
        for (const fullReconfigure of [true, false]) {
          for (const step of build.getSteps(target, fullReconfigure)) {
            expect(step.args).not.toContain("-j");
          }
        }
      }
    });

    it("uses make -j<jobs> when given and changes no other step", () => {
      for (const target of ["native", "windows"]) {
        for (const fullReconfigure of [true, false]) {
          const byDefault = build.getSteps(target, fullReconfigure);
          const bounded = build.getSteps(target, fullReconfigure, 3);
          expect(bounded).toHaveLength(byDefault.length);
          for (let i = 0; i < bounded.length; i++) {
            if (bounded[i].label === "compile") {
              expect(bounded[i].program).toBe("make");
              expect(bounded[i].args).toEqual(["-j3"]);
            } else {
              expect(bounded[i]).toEqual(byDefault[i]);
            }
          }
        }
      }
    });

    it("accepts a job count above the processor count", () => {
      const step = stepOf(build.getSteps("native", true, 64), "compile");
      expect(step.args).toEqual(["-j64"]);
    });

    it("gives no step a command field", () => {
      for (const target of ["native", "windows"]) {
        for (const fullReconfigure of [true, false]) {
          for (const step of build.getSteps(target, fullReconfigure)) {
            expect(step).not.toHaveProperty("command");
            expect(typeof step.program).toBe("string");
            expect(Array.isArray(step.args)).toBe(true);
          }
        }
      }
    });
  });

  describe("getInstallPrefix", () => {
    it("defaults to the native prefix", () => {
      const prefix = build.getInstallPrefix();
      expect(prefix).toBe(config.config.prefix + "/x86_64-linux-gnu");
    });

    it("returns correct prefix for windows target", () => {
      const prefix = build.getInstallPrefix("windows");
      expect(prefix).toBe(config.config.prefix + "/x86_64-w64-mingw32");
    });

    it("uses the given target", () => {
      expect(build.getInstallPrefix("native")).toBe(config.config.prefix + "/x86_64-linux-gnu");
      expect(build.getInstallPrefix("windows")).toBe(config.config.prefix + "/x86_64-w64-mingw32");
    });
  });
});

describe("extractScope", () => {
  it("extracts scope from a scoped package name", () => {
    expect(extractScope("@metaverse-systems/libecs-cpp")).toBe("@metaverse-systems");
  });

  it("extracts scope from another scoped package name", () => {
    expect(extractScope("@imperian-systems/my-lib")).toBe("@imperian-systems");
  });

  it("returns undefined for an unscoped package name", () => {
    expect(extractScope("express")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(extractScope("")).toBeUndefined();
  });

  it("returns undefined for @ without a slash", () => {
    expect(extractScope("@noslash")).toBeUndefined();
  });
});

describe("getStripTool", () => {
  it("returns 'strip' for native target", () => {
    expect(getStripTool("native")).toBe("strip");
  });

  it("returns 'x86_64-w64-mingw32-strip' for windows target", () => {
    expect(getStripTool("windows")).toBe("x86_64-w64-mingw32-strip");
  });
});
