import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import { BuildStep } from "../src/types";
import { formatCommand } from "../src/ProcessRunner";
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

jest.mock("child_process", () => ({
  execSync: jest.fn(() => Buffer.from(""))
}));

jest.mock("../src/StepRunner", () => ({
  ...jest.requireActual("../src/StepRunner"),
  runStep: jest.fn(),
}));

import { execSync } from "child_process";
import { runStep } from "../src/StepRunner";
const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
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
    mockedExecSync.mockClear();
    mockedExecSync.mockReturnValue(Buffer.from(""));
    mockedRunStep.mockReset();
    mockedRunStep.mockResolvedValue({ status: "completed" });
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });

  describe("checkLib", () => {
    it("returns true when library is found", () => {
      mockedExecSync.mockReturnValue(Buffer.from("-l ecs-cpp -I/usr/include/ecs-cpp"));
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(true);
    });

    it("returns false when pkg-config throws", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("pkg-config not found");
      });
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(false);
    });

    it("returns false when output does not include library name", () => {
      mockedExecSync.mockReturnValue(Buffer.from("-l other-lib"));
      const result = checkLib(config, "ecs-cpp", "native");
      expect(result).toBe(false);
    });
  });

  describe("checkLibEcs", () => {
    it("delegates to checkLib with ecs-cpp", () => {
      mockedExecSync.mockReturnValue(Buffer.from("-l ecs-cpp"));
      const result = checkLibEcs(config, "native");
      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("ecs-cpp"),
        expect.anything()
      );
    });
  });

  describe("checkLibTheSeed", () => {
    it("delegates to checkLib with the-seed", () => {
      mockedExecSync.mockReturnValue(Buffer.from("-l the-seed"));
      const result = checkLibTheSeed(config, "native");
      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("the-seed"),
        expect.anything()
      );
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

    it("runs the five steps in order from the current directory", async () => {
      await installLib(config, repo, "test-dir", "native");

      const steps = stepsRun();
      expect(steps.map((step) => step.label)).toEqual([
        "clone test-dir", "test-dir autogen", "test-dir configure", "test-dir compile", "test-dir install",
      ]);
      expect(steps[0]).toMatchObject({ program: "git", args: ["clone", repo, "test-dir"] });
      expect(steps[1]).toMatchObject({ program: "./autogen.sh", cwd: "test-dir" });
      expect(steps[2]).toMatchObject({ program: "./configure", cwd: "test-dir" });
      expect(steps[3]).toMatchObject({ program: "make", cwd: "test-dir" });
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
      expect(configure!.args.join(" ")).not.toContain("--host");
      expect(configure!.args).toEqual(["--prefix=" + config.config.prefix + "/x86_64-linux-gnu"]);
    });

    it("windows target includes --host flag", async () => {
      await installLib(config, repo, "test-dir", "windows");

      const configure = stepsRun().find((step) => step.program === "./configure");
      expect(configure).toBeDefined();
      expect(configure!.args).toContain("--host=x86_64-w64-mingw32");
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
      const clone = mockedRunStep.mock.calls.map((call) => call[0]).find((step) => step.program === "git")!;
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
      const clone = mockedRunStep.mock.calls.map((call) => call[0]).find((step) => step.program === "git")!;
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
      mockedExecSync.mockImplementation(((command: string) => {
        const text = String(command);
        const library = Object.keys(versions).find((name) => new RegExp(name + "\\s*$|" + name + "\\s").test(text));
        if (!library) {
          throw new Error("No package found");
        }
        const atLeast = text.match(/--atleast-version=(\S+)/);
        if (atLeast) {
          if (compare(versions[library], atLeast[1]) < 0) {
            throw new Error("version too old");
          }
          return Buffer.from("");
        }
        if (text.includes("--modversion")) {
          return Buffer.from(versions[library] + "\n");
        }
        return Buffer.from("-l" + library + " -I/prefix/include/" + library);
      }) as unknown as typeof execSync);
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
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("--atleast-version=" + requiredLibEcsVersion),
        expect.anything()
      );
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
      mockedExecSync.mockImplementation((() => {
        throw new Error("No package found");
      }) as unknown as typeof execSync);
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
        const clone = steps.find((step) => step.label === "clone " + lib)!;
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
        const update = getInstallSteps(config, "native").find((step) => step.label === "update libecs-cpp")!;
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
        const byLabel = (suffix: string) => steps.find((step) => step.label === `${lib} ${suffix}`)!;
        expect(byLabel("autogen")).toMatchObject({ program: "./autogen.sh", args: [], cwd: lib });
        expect(byLabel("configure")).toMatchObject({
          program: "./configure",
          args: ["--prefix=" + prefix],
          cwd: lib,
        });
        expect(byLabel("compile")).toMatchObject({ program: "make", args: [], cwd: lib });
        expect(byLabel("install")).toMatchObject({ program: "make", args: ["install"], cwd: lib });
      }
      for (const step of forLib(steps, "lib")) {
        expect(step).not.toHaveProperty("command");
      }
    });

    it("adds --host for the windows target", () => {
      const steps = getInstallSteps(config, "windows");
      const configure = steps.find((step) => step.label === "libecs-cpp configure")!;
      expect(configure.args).toEqual([
        "--prefix=" + config.config.prefix + "/x86_64-w64-mingw32",
        "--host=x86_64-w64-mingw32",
      ]);
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
      expect(pull).toBe(0);
      expect(build).toBeGreaterThan(pull);
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
      mockedExecSync.mockImplementation(((command: string) => {
        if (String(command).includes("ecs-cpp")) {
          return Buffer.from("-lecs-cpp");
        }
        throw new Error("No package found");
      }) as unknown as typeof execSync);
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
