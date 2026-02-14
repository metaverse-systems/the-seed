import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Build, { targets } from "../src/Build";

jest.mock("child_process", () => ({
  execSync: jest.fn(() => Buffer.from(""))
}));

import { execSync } from "child_process";
const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

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
    mockedExecSync.mockClear();
    mockedExecSync.mockReturnValue(Buffer.from(""));
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

  describe("autogen", () => {
    it("runs autogen.sh", () => {
      build.autogen();
      expect(mockedExecSync).toHaveBeenCalledWith(
        "./autogen.sh",
        expect.objectContaining({ stdio: "pipe" })
      );
    });

    it("propagates errors", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("autogen failed");
      });
      expect(() => build.autogen()).toThrow("autogen failed");
    });
  });

  describe("configure", () => {
    it("runs configure for native target", () => {
      build.target = "native";
      build.configure();

      // First call is make distclean
      expect(mockedExecSync).toHaveBeenCalledWith(
        "make distclean",
        expect.anything()
      );

      // Second call is configure
      const configureCalls = mockedExecSync.mock.calls.filter(
        (call) => String(call[0]).includes("./configure")
      );
      expect(configureCalls.length).toBe(1);
      const configureCmd = String(configureCalls[0][0]);
      expect(configureCmd).toContain("--prefix=" + config.config.prefix + "/x86_64-linux-gnu");
      expect(configureCmd).not.toContain("--host");
    });

    it("runs configure for windows target", () => {
      build.target = "windows";
      build.configure();

      const configureCalls = mockedExecSync.mock.calls.filter(
        (call) => String(call[0]).includes("./configure")
      );
      expect(configureCalls.length).toBe(1);
      const configureCmd = String(configureCalls[0][0]);
      expect(configureCmd).toContain("--host=x86_64-w64-mingw32");
    });

    it("runs distclean before configure", () => {
      build.target = "native";
      build.configure();

      const calls = mockedExecSync.mock.calls.map((c) => String(c[0]));
      const distcleanIndex = calls.findIndex((c) => c.includes("make distclean"));
      const configureIndex = calls.findIndex((c) => c.includes("./configure"));
      expect(distcleanIndex).toBeLessThan(configureIndex);
    });
  });

  describe("reconfigure", () => {
    it("chains autogen and configure", () => {
      build.reconfigure("native");

      const calls = mockedExecSync.mock.calls.map((c) => String(c[0]));
      const autogenIndex = calls.findIndex((c) => c.includes("./autogen.sh"));
      const configureIndex = calls.findIndex((c) => c.includes("./configure"));
      expect(autogenIndex).toBeGreaterThanOrEqual(0);
      expect(configureIndex).toBeGreaterThan(autogenIndex);
    });
  });

  describe("compile", () => {
    it("runs make -j", () => {
      build.compile();
      expect(mockedExecSync).toHaveBeenCalledWith("make -j");
    });
  });

  describe("install", () => {
    it("runs make install", () => {
      build.install();
      expect(mockedExecSync).toHaveBeenCalledWith("make install");
    });
  });
});
