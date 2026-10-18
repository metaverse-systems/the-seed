import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import { BuildStep } from "../src/types";
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

import { execSync } from "child_process";
const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

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

  describe("installLib", () => {
    it("returns true on success", () => {
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      const result = installLib(config, "https://github.com/test/repo.git", "test-dir", "native");
      expect(result).toBe(true);
    });

    it("returns false on build failure", () => {
      // First call (clone) succeeds, second call (build) throws
      mockedExecSync
        .mockReturnValueOnce(Buffer.from("cloned"))
        .mockImplementationOnce(() => {
          throw new Error("build failed");
        });
      const result = installLib(config, "https://github.com/test/repo.git", "test-dir", "native");
      expect(result).toBe(false);
    });

    it("native target has no --host flag", () => {
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      installLib(config, "https://github.com/test/repo.git", "test-dir", "native");

      const buildCall = mockedExecSync.mock.calls.find(
        (call) => String(call[0]).includes("./configure")
      );
      expect(buildCall).toBeDefined();
      expect(String(buildCall![0])).not.toContain("--host");
    });

    it("windows target includes --host flag", () => {
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      installLib(config, "https://github.com/test/repo.git", "test-dir", "windows");

      const buildCall = mockedExecSync.mock.calls.find(
        (call) => String(call[0]).includes("./configure")
      );
      expect(buildCall).toBeDefined();
      expect(String(buildCall![0])).toContain("--host=x86_64-w64-mingw32");
    });
  });

  describe("installLibEcs", () => {
    it("delegates to installLib with libecs-cpp repo", () => {
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      const result = installLibEcs(config, "native");
      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("libecs-cpp"),
        expect.anything()
      );
    });
  });

  describe("installLibTheSeed", () => {
    it("delegates to installLib with libthe-seed repo", () => {
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      const result = installLibTheSeed(config, "native");
      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("libthe-seed"),
        expect.anything()
      );
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

    const commandsRun = () => mockedExecSync.mock.calls.map((call) => String(call[0]));

    it("installLib updates the directory before building", () => {
      cloneExists("test-dir");
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      expect(installLib(config, "https://github.com/test/repo.git", "test-dir", "native")).toBe(true);
      const commands = commandsRun();
      const pull = commands.findIndex((command) => command.includes("git -C test-dir pull --ff-only"));
      const build = commands.findIndex((command) => command.includes("./configure"));
      expect(pull).toBeGreaterThanOrEqual(0);
      expect(build).toBeGreaterThan(pull);
    });

    it("installLib fails naming the directory when the update fails", () => {
      cloneExists("test-dir");
      mockedExecSync.mockImplementation(((command: string) => {
        if (String(command).includes("pull --ff-only")) {
          throw new Error("not possible to fast-forward");
        }
        return Buffer.from("ok");
      }) as unknown as typeof execSync);
      expect(installLib(config, "https://github.com/test/repo.git", "test-dir", "native")).toBe(false);
      expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("test-dir");
      expect(commandsRun().some((command) => command.includes("./configure"))).toBe(false);
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
