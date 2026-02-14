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
  installLibTheSeed
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
});
