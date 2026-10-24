import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import { BuildStep } from "../src/types";
import { formatCommand, findOnPath } from "../src/ProcessRunner";
import { librarySearchEnv, WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS } from "../src/LibrarySearch";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { findSystemOnlyPackage, writePackageDescription } from "./helpers/SystemPackage";
import {
  checkLib,
  checkLibEcs,
  checkLibTheSeed,
  installLib,
  installLibEcs,
  installLibTheSeed,
  getInstallSteps,
  requiredLibEcsVersion,
  requiredLibTheSeedVersion
} from "../src/Dependencies";

// checkLib runs pkg-config through spawnSync with an argument array and an environment object; no shell.
jest.mock("child_process", () => ({
  spawnSync: jest.fn(),
}));

jest.mock("../src/StepRunner", () => ({
  ...jest.requireActual("../src/StepRunner"),
  runStep: jest.fn(),
}));

// Fix the processor count. Choice for the implementer: the default job count comes from
// processorCount() exported by src/BuildScheduler, which Dependencies must import from there.
jest.mock("../src/BuildScheduler", () => ({
  ...jest.requireActual("../src/BuildScheduler"),
  processorCount: () => 6,
}));

import { spawnSync, SpawnSyncReturns } from "child_process";
import { runStep } from "../src/StepRunner";
import { defined } from "./helpers/Defined";
const mockedSpawnSync = spawnSync as unknown as jest.Mock;

/** What spawnSync returns for a pkg-config that ran. */
function ran(status: number, stdout = ""): SpawnSyncReturns<string> {
  return { status, signal: null, output: [null, stdout, ""], pid: 1, stdout, stderr: "" };
}

/** What spawnSync returns when the program could not be started. */
function notStarted(): SpawnSyncReturns<string> {
  return {
    status: null, signal: null, output: [null, null, null], pid: 0, stdout: null as unknown as string,
    stderr: null as unknown as string, error: new Error("spawn pkg-config ENOENT"),
  };
}

/** Every pkg-config call made so far: [program, args, options]. */
function pkgConfigCalls(): Array<[string, string[], { env?: NodeJS.ProcessEnv; encoding?: string }]> {
  return mockedSpawnSync.mock.calls.map((call) => [call[0], call[1], call[2] ?? {}]);
}
const mockedRunStep = runStep as jest.MockedFunction<typeof runStep>;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deps-test-"));
}

describe("test Dependencies", () => {
  let configDir: string;
  let config: Config;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);
  });

  beforeEach(() => {
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockReturnValue(ran(0, ""));
    mockedRunStep.mockReset();
    mockedRunStep.mockResolvedValue({ status: "completed" });
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });

  describe("checkLib", () => {
    it("returns true when library is found", () => {
      mockedSpawnSync.mockReturnValue(ran(0, "-l ecs-cpp -I/usr/include/ecs-cpp"));
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(true);
    });

    it("returns false when pkg-config cannot be started", () => {
      mockedSpawnSync.mockReturnValue(notStarted());
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(false);
    });

    it("returns false when pkg-config does not know the library", () => {
      mockedSpawnSync.mockReturnValue(ran(1, ""));
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(false);
    });

    it("returns false when output does not include library name", () => {
      mockedSpawnSync.mockReturnValue(ran(0, "-l other-lib"));
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(false);
    });

    it("runs pkg-config itself with an argument array, no shell and no PKG_CONFIG_PATH in an argument", () => {
      mockedSpawnSync.mockReturnValue(ran(0, "-l ecs-cpp"));
      checkLib(config, "ecs-cpp", "native", "1.2.3");
      const calls = pkgConfigCalls();
      expect(calls.map(([program, args]) => [program, args])).toEqual([
        ["pkg-config", ["--cflags", "--libs", "ecs-cpp"]],
        ["pkg-config", ["--atleast-version=1.2.3", "ecs-cpp"]],
      ]);
      for (const [, args, options] of calls) {
        expect(args.some((arg) => arg.includes("PKG_CONFIG_PATH="))).toBe(false);
        expect(options).not.toHaveProperty("shell");
        expect(options.env).toEqual(expect.objectContaining({ PKG_CONFIG_PATH: expect.any(String) }));
      }
    });

    it("asks for the version with --modversion when the library is older", () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      mockedSpawnSync.mockImplementation((_program: string, args: string[]) => {
        if (args[0].startsWith("--atleast-version=")) return ran(1, "");
        if (args[0] === "--modversion") return ran(0, "0.9.0\n");
        return ran(0, "-l ecs-cpp");
      });
      try {
        expect(checkLib(config, "ecs-cpp", "native", "1.0.0")).toBe(false);
        expect(pkgConfigCalls().map(([, args]) => args)).toContainEqual(["--modversion", "ecs-cpp"]);
        expect(errorSpy).toHaveBeenCalledWith("ecs-cpp 0.9.0 is older than the required 1.0.0");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("says unknown version when the version cannot be read", () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      mockedSpawnSync.mockImplementation((_program: string, args: string[]) => {
        if (args[0].startsWith("--atleast-version=")) return ran(1, "");
        if (args[0] === "--modversion") return ran(1, "");
        return ran(0, "-l ecs-cpp");
      });
      try {
        expect(checkLib(config, "ecs-cpp", "native", "1.0.0")).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith("ecs-cpp unknown version is older than the required 1.0.0");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("checkLib passes the prefix exactly", () => {
      // Choice: the lookup directory is <prefix>/<triplet>/lib/pkgconfig built with path.join, passed in
      // env.PKG_CONFIG_PATH (a trailing separator is tolerated). Nothing of the prefix reaches an argument.
      const odd = path.join(createTempDir(), "pre fix '$HOME \"q\"");
      const configDir = createTempDir();
      const oddConfig = new Config(configDir);
      oddConfig.config.prefix = odd;
      const savedPath = process.env.PKG_CONFIG_PATH;
      delete process.env.PKG_CONFIG_PATH;
      try {
        mockedSpawnSync.mockReturnValue(ran(0, "-l ecs-cpp"));
        expect(checkLib(oddConfig, "ecs-cpp", "native", "1.0.0")).toBe(true);
        const calls = pkgConfigCalls();
        expect(calls).toHaveLength(2);
        const expected = path.join(odd, "x86_64-linux-gnu", "lib", "pkgconfig");
        for (const [, args, options] of calls) {
          expect(args.join(" ")).not.toContain(odd);
          expect(String(options.env?.PKG_CONFIG_PATH).replace(/[\\/]+$/, "")).toBe(expected);
        }
      } finally {
        if (savedPath === undefined) delete process.env.PKG_CONFIG_PATH;
        else process.env.PKG_CONFIG_PATH = savedPath;
        fs.rmSync(path.dirname(odd), { recursive: true, force: true });
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe("checkLib library search settings", () => {
    const realSpawnSync = jest.requireActual<typeof import("child_process")>("child_process").spawnSync;
    let savedPath: string | undefined;
    let savedLibdir: string | undefined;
    let scratch: string;
    let searchConfig: Config;
    let searchConfigDir: string;

    beforeEach(() => {
      savedPath = process.env.PKG_CONFIG_PATH;
      savedLibdir = process.env.PKG_CONFIG_LIBDIR;
      delete process.env.PKG_CONFIG_LIBDIR;
      scratch = createTempDir();
      searchConfigDir = createTempDir();
      searchConfig = new Config(searchConfigDir);
      searchConfig.config.prefix = path.join(scratch, "prefix");
    });

    afterEach(() => {
      if (savedPath === undefined) delete process.env.PKG_CONFIG_PATH;
      else process.env.PKG_CONFIG_PATH = savedPath;
      if (savedLibdir === undefined) delete process.env.PKG_CONFIG_LIBDIR;
      else process.env.PKG_CONFIG_LIBDIR = savedLibdir;
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.rmSync(searchConfigDir, { recursive: true, force: true });
    });

    /** Sends checkLib's pkg-config calls to the real program. */
    function useRealPkgConfig(): void {
      mockedSpawnSync.mockImplementation((program: string, args: string[], options: object) =>
        realSpawnSync(program, args, options));
    }

    const pkgConfigAvailable = findOnPath("pkg-config") !== null;

    it("native lookups get the prefix first and the user's path after", () => {
      process.env.PKG_CONFIG_PATH = "/opt/user/pkgconfig";
      mockedSpawnSync.mockReturnValue(ran(0, "-l ecs-cpp"));
      checkLib(searchConfig, "ecs-cpp", "native", "1.0.0");
      const expected = librarySearchEnv(searchConfig.config.prefix, "native", process.env);
      expect(expected.PKG_CONFIG_PATH).toBe(
        path.join(searchConfig.config.prefix, "x86_64-linux-gnu", "lib", "pkgconfig") + ":/opt/user/pkgconfig");
      const calls = pkgConfigCalls();
      expect(calls).toHaveLength(2);
      for (const [, , options] of calls) {
        expect(options.env?.PKG_CONFIG_PATH).toBe(expected.PKG_CONFIG_PATH);
        expect(options.env?.PKG_CONFIG_LIBDIR).toBeUndefined();
      }
    });

    it("windows lookups use only the Windows prefix and toolchain directories", () => {
      process.env.PKG_CONFIG_PATH = "/opt/user/pkgconfig";
      mockedSpawnSync.mockReturnValue(ran(0, "-l ecs-cpp"));
      checkLib(searchConfig, "ecs-cpp", "windows", "1.0.0");
      const expected = librarySearchEnv(searchConfig.config.prefix, "windows", process.env);
      expect(expected.PKG_CONFIG_PATH).toBe("");
      expect(expected.PKG_CONFIG_LIBDIR).toBe([
        path.join(searchConfig.config.prefix, "x86_64-w64-mingw32", "lib", "pkgconfig"),
        ...WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS,
      ].join(":"));
      const calls = pkgConfigCalls();
      expect(calls).toHaveLength(2);
      for (const [, , options] of calls) {
        expect(options.env?.PKG_CONFIG_PATH).toBe("");
        expect(options.env?.PKG_CONFIG_LIBDIR).toBe(expected.PKG_CONFIG_LIBDIR);
      }
    });

    it("checkLib for native finds a library in the user's PKG_CONFIG_PATH", () => {
      if (!optionalExternalCheck("pkg-config", pkgConfigAvailable, "pkg-config not found")) return;
      const userDir = path.join(scratch, "user pkgconfig");
      writePackageDescription(userDir, "seedtest-native");
      process.env.PKG_CONFIG_PATH = userDir;
      useRealPkgConfig();
      expect(checkLib(searchConfig, "seedtest-native", "native")).toBe(true);
    });

    it("checkLib for windows finds a library in the Windows prefix", () => {
      if (!optionalExternalCheck("pkg-config", pkgConfigAvailable, "pkg-config not found")) return;
      writePackageDescription(
        path.join(searchConfig.config.prefix, "x86_64-w64-mingw32", "lib", "pkgconfig"), "seedtest-windows");
      useRealPkgConfig();
      expect(checkLib(searchConfig, "seedtest-windows", "windows")).toBe(true);
    });

    it("checkLib for windows does not find a library described only in a system directory", () => {
      if (!optionalExternalCheck("pkg-config", pkgConfigAvailable, "pkg-config not found")) return;
      const windowsDir = path.join(searchConfig.config.prefix, "x86_64-w64-mingw32", "lib", "pkgconfig");
      // The package is chosen at run time from pkg-config's own directories, leaving out any name the
      // Windows prefix or the toolchain directories also describe.
      const system = findSystemOnlyPackage([windowsDir, ...WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS]);
      if (!optionalExternalCheck("system-only-package", system !== null, "no package described only in a system directory")) return;
      delete process.env.PKG_CONFIG_PATH;
      useRealPkgConfig();
      expect(checkLib(searchConfig, system as string, "native")).toBe(true);
      expect(checkLib(searchConfig, system as string, "windows")).toBe(false);
    });

    it("checkLib for windows ignores the user's PKG_CONFIG_PATH", () => {
      if (!optionalExternalCheck("pkg-config", pkgConfigAvailable, "pkg-config not found")) return;
      const userDir = path.join(scratch, "user pkgconfig");
      writePackageDescription(userDir, "seedtest-native");
      process.env.PKG_CONFIG_PATH = userDir;
      useRealPkgConfig();
      expect(checkLib(searchConfig, "seedtest-native", "windows")).toBe(false);
    });
  });

  describe("checkLibEcs", () => {
    it("delegates to checkLib with ecs-cpp", () => {
      mockedSpawnSync.mockReturnValue(ran(0, "-l ecs-cpp"));
      const result = checkLibEcs(config, "native");
      expect(result).toBe(true);
      expect(pkgConfigCalls()[0][1]).toEqual(["--cflags", "--libs", "ecs-cpp"]);
    });
  });

  describe("checkLibTheSeed", () => {
    it("delegates to checkLib with the-seed", () => {
      mockedSpawnSync.mockReturnValue(ran(0, "-l the-seed"));
      const result = checkLibTheSeed(config, "native");
      expect(result).toBe(true);
      expect(pkgConfigCalls()[0][1]).toEqual(["--cflags", "--libs", "the-seed"]);
    });
  });

  // installLib runs its steps through runStep (mocked here). Choices where the contract is open:
  // the steps are labelled after the install directory (`clone <dir>`, `update <dir>`, `<dir> autogen`,
  // `<dir> configure`, `<dir> compile`, `<dir> install`), progress goes to console.log and the
  // `Failed at <label>: <message>` line to console.error, with a failed step's message reading
  // `<command> exited with status <n>`.
  describe("installLib", () => {
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    const repo = "https://github.com/test/repo.git";

    beforeEach(() => {
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    const stepsRun = (): BuildStep[] => mockedRunStep.mock.calls.map((call) => call[0]);
    const printed = () => logSpy.mock.calls.map((call) => call.join(" "));
    const errors = () => errorSpy.mock.calls.map((call) => call.join(" "));

    it("returns true on success", async () => {
      const result = await installLib(config, repo, "test-dir", "native");
      expect(result).toBe(true);
    });

    it("returns false on build failure", async () => {
      // The clone succeeds, the build step after it fails
      mockedRunStep.mockImplementation(async (step) =>
        step.label === "test-dir compile"
          ? { status: "failed", exitCode: 2, signal: null, output: "" }
          : { status: "completed" }
      );
      const result = await installLib(config, repo, "test-dir", "native");
      expect(result).toBe(false);
    });

    it("uses options.jobs for the compile step", async () => {
      await installLib(config, repo, "test-dir", "native", { jobs: 3 });

      const compile = defined(stepsRun().find((step) => step.label === "test-dir compile"), "test-dir compile step");
      expect(compile).toMatchObject({ program: "make", args: ["-j3"], cwd: "test-dir" });
    });

    it("gives the configure step the library search environment for each target", async () => {
      const saved = process.env.PKG_CONFIG_PATH;
      process.env.PKG_CONFIG_PATH = "/opt/user/pkgconfig";
      try {
        for (const target of ["native", "windows"]) {
          mockedRunStep.mockClear();
          await installLib(config, repo, "test-dir", target);
          const configure = defined(stepsRun().find((step) => step.label === "test-dir configure"), "test-dir configure step");
          expect(configure.env).toEqual(librarySearchEnv(config.config.prefix, target, process.env));
        }
      } finally {
        if (saved === undefined) delete process.env.PKG_CONFIG_PATH;
        else process.env.PKG_CONFIG_PATH = saved;
      }
    });

    it("runs the five steps in order from the current directory", async () => {
      await installLib(config, repo, "test-dir", "native");

      const steps = stepsRun();
      expect(steps.map((step) => step.label)).toEqual([
        "clone test-dir", "test-dir autogen", "test-dir configure", "test-dir compile", "test-dir install",
      ]);
      expect(steps[0]).toMatchObject({ program: "git", args: ["clone", repo, "test-dir"] });
      expect(steps[1]).toMatchObject({ program: "./autogen.sh", cwd: "test-dir" });
      expect(steps[2]).toMatchObject({ program: "./configure", cwd: "test-dir" });
      expect(steps[3]).toMatchObject({ program: "make", args: ["-j6"], cwd: "test-dir" });
      expect(steps[4]).toMatchObject({ program: "make", args: ["install"], cwd: "test-dir" });
      for (const call of mockedRunStep.mock.calls) {
        expect(call[1]).toEqual(expect.objectContaining({ baseDir: process.cwd() }));
        expect(call[1].output.mode).toBe("stream");
      }
    });

    it("precedes each step with '==> <label>: <command>'", async () => {
      await installLib(config, repo, "test-dir", "native");

      const expected = stepsRun().map(
        (step) => `==> ${step.label}: ${formatCommand(step.program, step.args)}`
      );
      expect(printed().filter((line) => line.startsWith("==> "))).toEqual(expected);
    });

    it("prints each heading before the step runs", async () => {
      const order: string[] = [];
      logSpy.mockImplementation((line: string) => {
        if (String(line).startsWith("==> ")) order.push("print:" + String(line).split(":")[0].slice(4));
      });
      mockedRunStep.mockImplementation(async (step) => {
        order.push("run:" + step.label);
        return { status: "completed" };
      });

      await installLib(config, repo, "test-dir", "native");

      expect(order).toEqual([
        "print:clone test-dir", "run:clone test-dir",
        "print:test-dir autogen", "run:test-dir autogen",
        "print:test-dir configure", "run:test-dir configure",
        "print:test-dir compile", "run:test-dir compile",
        "print:test-dir install", "run:test-dir install",
      ]);
    });

    it("stops at the first step that does not complete and says which", async () => {
      mockedRunStep.mockImplementation(async (step) =>
        step.label === "test-dir configure"
          ? { status: "failed", exitCode: 1, signal: null, output: "" }
          : { status: "completed" }
      );

      const result = await installLib(config, repo, "test-dir", "native");

      expect(result).toBe(false);
      expect(stepsRun().map((step) => step.label)).toEqual(["clone test-dir", "test-dir autogen", "test-dir configure"]);
      expect(errors().some((line) => line.startsWith("Failed at test-dir configure: ") && line.includes("exited with status 1"))).toBe(true);
    });

    it("a failed clone stops everything", async () => {
      mockedRunStep.mockImplementation(async (step) =>
        step.label === "clone test-dir"
          ? { status: "failed", exitCode: 128, signal: null, output: "" }
          : { status: "completed" }
      );

      const result = await installLib(config, repo, "test-dir", "native");

      expect(result).toBe(false);
      expect(stepsRun()).toHaveLength(1);
      expect(errors().some((line) => line.startsWith("Failed at clone test-dir: "))).toBe(true);
    });

    it("a program that cannot be started stops the install with its message", async () => {
      mockedRunStep.mockImplementation(async (step) =>
        step.label === "test-dir autogen"
          ? { status: "notFound", message: "./autogen.sh: not found" }
          : { status: "completed" }
      );

      const result = await installLib(config, repo, "test-dir", "native");

      expect(result).toBe(false);
      expect(errors()).toContain("Failed at test-dir autogen: ./autogen.sh: not found");
      expect(stepsRun()).toHaveLength(2);
    });

    it("an interrupted step stops the install", async () => {
      mockedRunStep.mockImplementation(async (step) =>
        step.label === "test-dir compile" ? { status: "interrupted" } : { status: "completed" }
      );
      expect(await installLib(config, repo, "test-dir", "native")).toBe(false);
      expect(stepsRun().map((step) => step.label)).not.toContain("test-dir install");
    });

    it("an ignored exit counts as having completed", async () => {
      mockedRunStep.mockResolvedValue({ status: "ignored", exitCode: 1 });
      expect(await installLib(config, repo, "test-dir", "native")).toBe(true);
    });

    it("native target has no --host flag", async () => {
      await installLib(config, repo, "test-dir", "native");

      const configure = stepsRun().find((step) => step.program === "./configure");
      expect(configure).toBeDefined();
      expect(defined(configure, "configure step").args.join(" ")).not.toContain("--host");
      expect(defined(configure, "configure step").args).toEqual(["--prefix=" + config.config.prefix + "/x86_64-linux-gnu"]);
    });

    it("windows target includes --host flag", async () => {
      await installLib(config, repo, "test-dir", "windows");

      const configure = stepsRun().find((step) => step.program === "./configure");
      expect(configure).toBeDefined();
      expect(defined(configure, "configure step").args).toContain("--host=x86_64-w64-mingw32");
    });
  });

  describe("installLibEcs", () => {
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    });
    afterEach(() => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("delegates to installLib with libecs-cpp repo", async () => {
      const result = await installLibEcs(config, "native");
      expect(result).toBe(true);
      const clone = defined(mockedRunStep.mock.calls.map((call) => call[0]).find((step) => step.program === "git"), "git step");
      expect(clone.args).toEqual(["clone", expect.stringContaining("libecs-cpp"), "libecs-cpp"]);
    });

    it("reports Failed to build libecs-cpp when the install fails", async () => {
      mockedRunStep.mockResolvedValue({ status: "failed", exitCode: 1, signal: null, output: "" });
      expect(await installLibEcs(config, "native")).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("Failed to build libecs-cpp");
    });
  });

  describe("installLibTheSeed", () => {
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    });
    afterEach(() => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("delegates to installLib with libthe-seed repo", async () => {
      const result = await installLibTheSeed(config, "native");
      expect(result).toBe(true);
      const clone = defined(mockedRunStep.mock.calls.map((call) => call[0]).find((step) => step.program === "git"), "git step");
      expect(clone.args).toEqual(["clone", expect.stringContaining("libthe-seed"), "libthe-seed"]);
    });

    it("reports Failed to build libthe-seed when the install fails", async () => {
      mockedRunStep.mockResolvedValue({ status: "failed", exitCode: 1, signal: null, output: "" });
      expect(await installLibTheSeed(config, "native")).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("Failed to build libthe-seed");
    });
  });

  describe("version checks", () => {
    // Pretends pkg-config knows the given installed versions (by library name).
    const installed = (versions: { [library: string]: string }) => {
      const compare = (a: string, b: string) => {
        const left = a.split(".").map(Number);
        const right = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if (left[i] !== right[i]) return left[i] - right[i];
        }
        return 0;
      };
      mockedSpawnSync.mockImplementation((_program: string, args: string[]) => {
        const library = args[args.length - 1];
        if (!(library in versions)) {
          return ran(1, "");
        }
        const atLeast = args[0].match(/^--atleast-version=(\S+)$/);
        if (atLeast) {
          return ran(compare(versions[library], atLeast[1]) < 0 ? 1 : 0, "");
        }
        if (args[0] === "--modversion") {
          return ran(0, versions[library] + "\n");
        }
        return ran(0, "-l" + library + " -I/prefix/include/" + library);
      });
    };

    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    const logged = () => errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    it("requires libthe-seed 0.8.0 and libecs-cpp 2.1.0", () => {
      expect(requiredLibTheSeedVersion).toBe("0.8.0");
      expect(requiredLibEcsVersion).toBe("2.1.0");
    });

    it("checkLibTheSeed is false and says so when the installed copy is older", () => {
      installed({ "the-seed": "0.7.0" });
      expect(checkLibTheSeed(config, "native")).toBe(false);
      expect(logged()).toContain("the-seed 0.7.0 is older than the required " + requiredLibTheSeedVersion);
    });

    it("checkLibTheSeed is true when the installed copy is current", () => {
      installed({ "the-seed": requiredLibTheSeedVersion });
      expect(checkLibTheSeed(config, "native")).toBe(true);
    });

    it("checkLibEcs passes the required libecs-cpp version", () => {
      installed({ "ecs-cpp": requiredLibEcsVersion });
      expect(checkLibEcs(config, "native")).toBe(true);
      expect(pkgConfigCalls().map(([, args]) => args)).toContainEqual([
        "--atleast-version=" + requiredLibEcsVersion,
        "ecs-cpp",
      ]);
    });

    it("checkLibEcs is false when libecs-cpp is older than required", () => {
      installed({ "ecs-cpp": "2.0.0" });
      expect(checkLibEcs(config, "native")).toBe(false);
      expect(logged()).toContain("ecs-cpp 2.0.0 is older than the required " + requiredLibEcsVersion);
    });

    it("getInstallSteps includes a library whose installed version is too old", () => {
      installed({ "ecs-cpp": requiredLibEcsVersion, "the-seed": "0.7.0" });
      const steps = getInstallSteps(config, "native");
      const labels = steps.map((step) => step.label).join("\n");
      expect(labels).toContain("libthe-seed");
      expect(labels).not.toContain("libecs-cpp");
    });

    it("getInstallSteps is empty when both libraries are current", () => {
      installed({ "ecs-cpp": requiredLibEcsVersion, "the-seed": requiredLibTheSeedVersion });
      expect(getInstallSteps(config, "native")).toEqual([]);
    });
  });

  describe("getInstallSteps structured steps", () => {
    beforeEach(() => {
      // No library is installed: every pkg-config query fails
      mockedSpawnSync.mockReturnValue(ran(1, ""));
    });

    const forLib = (steps: BuildStep[], name: string) =>
      steps.filter((step) => step.label.includes(name));

    it("lists clone, autogen, configure, compile and install for each library with unchanged labels", () => {
      const steps = getInstallSteps(config, "native");
      expect(steps.map((step) => step.label)).toEqual([
        "clone libecs-cpp", "libecs-cpp autogen", "libecs-cpp configure", "libecs-cpp compile", "libecs-cpp install",
        "clone libthe-seed", "libthe-seed autogen", "libthe-seed configure", "libthe-seed compile", "libthe-seed install",
      ]);
    });

    it("clones a repository into the named directory", () => {
      const steps = getInstallSteps(config, "native");
      for (const lib of ["libecs-cpp", "libthe-seed"]) {
        const clone = defined(steps.find((step) => step.label === "clone " + lib), "clone step");
        expect(clone.program).toBe("git");
        expect(clone.args).toEqual(["clone", expect.stringContaining(lib), lib]);
        expect(clone).not.toHaveProperty("command");
      }
    });

    it("pulls an existing directory with git -C", () => {
      const existsSpy = jest.spyOn(fs, "existsSync").mockImplementation(
        (target: fs.PathLike) => path.basename(String(target)) === "libecs-cpp"
      );
      try {
        const update = defined(getInstallSteps(config, "native").find((step) => step.label === "update libecs-cpp"), "update step");
        expect(update.program).toBe("git");
        expect(update.args).toEqual(["-C", "libecs-cpp", "pull", "--ff-only"]);
      } finally {
        existsSpy.mockRestore();
      }
    });

    it("runs autogen, configure, compile and install with the library directory as cwd", () => {
      const steps = getInstallSteps(config, "native");
      const prefix = config.config.prefix + "/x86_64-linux-gnu";
      for (const lib of ["libecs-cpp", "libthe-seed"]) {
        const byLabel = defined((suffix: string) => steps.find((step) => step.label === `${lib} ${suffix}`), "step");
        expect(byLabel("autogen")).toMatchObject({ program: "./autogen.sh", args: [], cwd: lib });
        expect(byLabel("configure")).toMatchObject({
          program: "./configure",
          args: ["--prefix=" + prefix],
          cwd: lib,
        });
        expect(byLabel("compile")).toMatchObject({ program: "make", args: ["-j6"], cwd: lib });
        expect(byLabel("install")).toMatchObject({ program: "make", args: ["install"], cwd: lib });
      }
      for (const step of forLib(steps, "lib")) {
        expect(step).not.toHaveProperty("command");
      }
    });

    it("gives every library's compile step make -j<processorCount()> for both targets", () => {
      for (const target of ["native", "windows"]) {
        const compiles = getInstallSteps(config, target).filter((step) => step.label.endsWith(" compile"));
        expect(compiles).toHaveLength(2);
        for (const step of compiles) {
          expect(step.program).toBe("make");
          expect(step.args).toEqual(["-j6"]);
        }
      }
    });

    it("uses make -j<jobs> when jobs is given and changes no other step", () => {
      const byDefault = getInstallSteps(config, "native");
      const bounded = getInstallSteps(config, "native", 2);
      expect(bounded).toHaveLength(byDefault.length);
      for (let i = 0; i < bounded.length; i++) {
        if (bounded[i].label.endsWith(" compile")) {
          expect(bounded[i].args).toEqual(["-j2"]);
        } else {
          expect(bounded[i]).toEqual(byDefault[i]);
        }
      }
    });

    it("gives every library's configure step the library search environment for the target", () => {
      const inherited = { PKG_CONFIG_PATH: "/opt/user/pkgconfig" };
      for (const target of ["native", "windows"]) {
        const steps = getInstallSteps(config, target, undefined, inherited);
        const configures = steps.filter((step) => step.label.endsWith(" configure"));
        expect(configures).toHaveLength(2);
        for (const step of configures) {
          expect(step.env).toEqual(librarySearchEnv(config.config.prefix, target, inherited));
        }
      }
    });

    it("leaves the other install steps without a search environment", () => {
      for (const step of getInstallSteps(config, "native", undefined, { PKG_CONFIG_PATH: "/opt/user" })) {
        if (!step.label.endsWith(" configure")) {
          expect(step.env).toBeUndefined();
        }
      }
    });

    it("adds --host for the windows target", () => {
      const steps = getInstallSteps(config, "windows");
      const configure = defined(steps.find((step) => step.label === "libecs-cpp configure"), "configure step");
      expect(configure.args).toEqual([
        "--prefix=" + config.config.prefix + "/x86_64-w64-mingw32",
        "--host=x86_64-w64-mingw32",
      ]);
    });
  });

  describe("plan computed outside the prefix", () => {
    let scratch: string;
    let prefixed: Config;
    let originalCwd: string;

    beforeEach(() => {
      // No library is installed: every pkg-config query fails
      mockedSpawnSync.mockReturnValue(ran(1, ""));
      scratch = fs.realpathSync(createTempDir());
      const configDir = path.join(scratch, "config");
      fs.mkdirSync(configDir);
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(scratch, "prefix"), scopes: {} }));
      prefixed = new Config(configDir);
      fs.mkdirSync(path.join(scratch, "elsewhere"));
      originalCwd = process.cwd();
      process.chdir(path.join(scratch, "elsewhere"));
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(scratch, { recursive: true, force: true });
    });

    const labels = (target: string) => getInstallSteps(prefixed, target).map((step) => step.label);

    it.each(["native", "windows"])("%s: pulls and cleans a clone present in the prefix", (target) => {
      fs.mkdirSync(path.join(prefixed.config.prefix, "libecs-cpp"), { recursive: true });
      const steps = getInstallSteps(prefixed, target);
      expect(steps.map((step) => step.label)).toEqual([
        "update libecs-cpp", "libecs-cpp autogen", "libecs-cpp distclean", "libecs-cpp configure", "libecs-cpp compile", "libecs-cpp install",
        "clone libthe-seed", "libthe-seed autogen", "libthe-seed configure", "libthe-seed compile", "libthe-seed install",
      ]);
      expect(steps[0]).toEqual({ label: "update libecs-cpp", program: "git", args: ["-C", "libecs-cpp", "pull", "--ff-only"] });
      expect(steps[2]).toEqual({ label: "libecs-cpp distclean", program: "make", args: ["distclean"], cwd: "libecs-cpp", ignoreExitCode: true });
    });

    it("clones a library absent from the prefix even when the working directory holds it", () => {
      fs.mkdirSync(path.join(process.cwd(), "libecs-cpp"));
      fs.mkdirSync(path.join(process.cwd(), "libthe-seed"));
      expect(labels("windows")).toEqual([
        "clone libecs-cpp", "libecs-cpp autogen", "libecs-cpp configure", "libecs-cpp compile", "libecs-cpp install",
        "clone libthe-seed", "libthe-seed autogen", "libthe-seed configure", "libthe-seed compile", "libthe-seed install",
      ]);
    });

    it("gives the same plan from the prefix as from elsewhere", () => {
      fs.mkdirSync(path.join(prefixed.config.prefix, "libthe-seed"), { recursive: true });
      const fromElsewhere = getInstallSteps(prefixed, "windows");
      process.chdir(prefixed.config.prefix);
      expect(getInstallSteps(prefixed, "windows")).toEqual(fromElsewhere);
    });
  });

  describe("existing clone directory", () => {
    let existsSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;

    const cloneExists = (directory: string) => {
      existsSpy = jest.spyOn(fs, "existsSync").mockImplementation(
        (target: fs.PathLike) => path.basename(String(target)) === directory
      );
    };

    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
      if (existsSpy) {
        existsSpy.mockRestore();
      }
    });

    const labelsRun = () => mockedRunStep.mock.calls.map((call) => call[0].label);

    it("installLib updates the directory before building", async () => {
      cloneExists("test-dir");
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        expect(await installLib(config, "https://github.com/test/repo.git", "test-dir", "native")).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
      const steps = mockedRunStep.mock.calls.map((call) => call[0]);
      const pull = steps.findIndex((step) => step.program === "git" && step.args.join(" ") === "-C test-dir pull --ff-only");
      const build = steps.findIndex((step) => step.program === "./configure");
      const distclean = steps.findIndex((step) => step.label === "test-dir distclean");
      expect(pull).toBe(0);
      expect(distclean).toBeGreaterThan(pull);
      expect(steps[distclean]).toMatchObject({ program: "make", args: ["distclean"], cwd: "test-dir", ignoreExitCode: true });
      expect(build).toBeGreaterThan(distclean);
      expect(steps.some((step) => step.args[0] === "clone")).toBe(false);
    });

    it("installLib fails naming the directory when the update fails", async () => {
      cloneExists("test-dir");
      mockedRunStep.mockImplementation(async (step) =>
        step.args.includes("pull")
          ? { status: "failed", exitCode: 128, signal: null, output: "" }
          : { status: "completed" }
      );
      expect(await installLib(config, "https://github.com/test/repo.git", "test-dir", "native")).toBe(false);
      expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("test-dir");
      expect(labelsRun().some((label) => label.includes("configure"))).toBe(false);
    });

    it("getInstallSteps updates an existing directory before compiling", () => {
      cloneExists("libthe-seed");
      mockedSpawnSync.mockImplementation((_program: string, args: string[]) =>
        args[args.length - 1] === "ecs-cpp" ? ran(0, "-lecs-cpp") : ran(1, "")
      );
      const steps = getInstallSteps(config, "native");
      const pull = steps.findIndex(
        (step) => step.program === "git" && step.args.join(" ") === "-C libthe-seed pull --ff-only"
      );
      const compile = steps.findIndex((step) => step.label === "libthe-seed compile");
      expect(pull).toBeGreaterThanOrEqual(0);
      expect(compile).toBeGreaterThan(pull);
      expect(steps.some((step) => step.program === "git" && step.args[0] === "clone" && step.args.includes("libthe-seed"))).toBe(false);
    });
  });
});
