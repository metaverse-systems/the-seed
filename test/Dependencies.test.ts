import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
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
      }) as any);
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
      const commands = steps.map((step) => step.command).join("\n");
      expect(commands).toContain("libthe-seed");
      expect(commands).not.toContain("libecs-cpp");
    });

    it("getInstallSteps is empty when both libraries are current", () => {
      installed({ "ecs-cpp": requiredLibEcsVersion, "the-seed": requiredLibTheSeedVersion });
      expect(getInstallSteps(config, "native")).toEqual([]);
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
      }) as any);
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
      }) as any);
      const steps = getInstallSteps(config, "native").map((step) => step.command);
      const pull = steps.findIndex((command) => command.includes("git -C libthe-seed pull --ff-only"));
      const compile = steps.findIndex((command) => /\bmake$/.test(command));
      expect(pull).toBeGreaterThanOrEqual(0);
      expect(compile).toBeGreaterThan(pull);
      expect(steps.some((command) => command.includes("git clone") && command.includes("libthe-seed"))).toBe(false);
    });
  });
});
