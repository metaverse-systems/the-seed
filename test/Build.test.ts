import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Build, { targets, extractScope, getStripTool, isBinaryByMagic, stripBinaries, findBuiltOutputs } from "../src/Build";
import { BuildStep } from "../src/types";

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

  describe("getSteps", () => {
    it("returns 5 steps for full native build", () => {
      const steps: BuildStep[] = build.getSteps("native", true);
      expect(steps).toHaveLength(5);
      expect(steps.map(s => s.label)).toEqual([
        "autogen", "distclean", "configure", "compile", "install"
      ]);
    });

    it("returns 5 steps for full windows build", () => {
      const steps: BuildStep[] = build.getSteps("windows", true);
      expect(steps).toHaveLength(5);
      expect(steps.map(s => s.label)).toEqual([
        "autogen", "distclean", "configure", "compile", "install"
      ]);
    });

    it("returns 2 steps for incremental build (fullReconfigure=false)", () => {
      const steps: BuildStep[] = build.getSteps("native", false);
      expect(steps).toHaveLength(2);
      expect(steps.map(s => s.label)).toEqual(["compile", "install"]);
    });

    it("native configure step does not contain --host flag", () => {
      const steps = build.getSteps("native", true);
      const configureStep = steps.find(s => s.label === "configure");
      expect(configureStep).toBeDefined();
      expect(configureStep!.command).not.toContain("--host");
    });

    it("windows configure step contains --host=x86_64-w64-mingw32", () => {
      const steps = build.getSteps("windows", true);
      const configureStep = steps.find(s => s.label === "configure");
      expect(configureStep).toBeDefined();
      expect(configureStep!.command).toContain("--host=x86_64-w64-mingw32");
    });

    it("distclean step has ignoreExitCode set to true", () => {
      const steps = build.getSteps("native", true);
      const distcleanStep = steps.find(s => s.label === "distclean");
      expect(distcleanStep).toBeDefined();
      expect(distcleanStep!.ignoreExitCode).toBe(true);
    });

    it("non-distclean steps do not have ignoreExitCode set to true", () => {
      const steps = build.getSteps("native", true);
      const nonDistclean = steps.filter(s => s.label !== "distclean");
      for (const step of nonDistclean) {
        expect(step.ignoreExitCode).toBeFalsy();
      }
    });

    it("configure step includes correct prefix path for native", () => {
      const steps = build.getSteps("native", true);
      const configureStep = steps.find(s => s.label === "configure");
      const expectedPrefix = config.config.prefix + "/x86_64-linux-gnu";
      expect(configureStep!.command).toContain("--prefix=" + expectedPrefix);
      expect(configureStep!.command).toContain("PKG_CONFIG_PATH=" + expectedPrefix + "/lib/pkgconfig/");
    });

    it("configure step includes correct prefix path for windows", () => {
      const steps = build.getSteps("windows", true);
      const configureStep = steps.find(s => s.label === "configure");
      const expectedPrefix = config.config.prefix + "/x86_64-w64-mingw32";
      expect(configureStep!.command).toContain("--prefix=" + expectedPrefix);
    });

    it("autogen step command is ./autogen.sh", () => {
      const steps = build.getSteps("native", true);
      expect(steps[0].command).toBe("./autogen.sh");
    });

    it("compile step command is make -j", () => {
      const steps = build.getSteps("native", true);
      const compileStep = steps.find(s => s.label === "compile");
      expect(compileStep!.command).toBe("make -j");
    });

    it("install step command is make install", () => {
      const steps = build.getSteps("native", true);
      const installStep = steps.find(s => s.label === "install");
      expect(installStep!.command).toBe("make install");
    });

    it("incremental build for windows returns 2 steps", () => {
      const steps = build.getSteps("windows", false);
      expect(steps).toHaveLength(2);
      expect(steps.map(s => s.label)).toEqual(["compile", "install"]);
    });
  });

  describe("getInstallPrefix", () => {
    it("returns correct prefix for native target", () => {
      build.target = "native";
      const prefix = build.getInstallPrefix();
      expect(prefix).toBe(config.config.prefix + "/x86_64-linux-gnu");
    });

    it("returns correct prefix for windows target", () => {
      const prefix = build.getInstallPrefix("windows");
      expect(prefix).toBe(config.config.prefix + "/x86_64-w64-mingw32");
    });

    it("uses explicit target over instance target", () => {
      build.target = "native";
      const prefix = build.getInstallPrefix("windows");
      expect(prefix).toBe(config.config.prefix + "/x86_64-w64-mingw32");
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

describe("isBinaryByMagic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns true for ELF binary (\\x7fELF magic)", () => {
    const filePath = path.join(tmpDir, "test.so");
    const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(filePath, elfMagic);
    expect(isBinaryByMagic(filePath)).toBe(true);
  });

  it("returns true for PE binary (MZ magic)", () => {
    const filePath = path.join(tmpDir, "test.dll");
    const peMagic = Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(filePath, peMagic);
    expect(isBinaryByMagic(filePath)).toBe(true);
  });

  it("returns false for a text file", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "#!/bin/bash\necho hello\n");
    expect(isBinaryByMagic(filePath)).toBe(false);
  });

  it("returns false for a file smaller than 4 bytes", () => {
    const filePath = path.join(tmpDir, "tiny");
    fs.writeFileSync(filePath, Buffer.from([0x7f]));
    expect(isBinaryByMagic(filePath)).toBe(false);
  });

  it("returns false for an empty file", () => {
    const filePath = path.join(tmpDir, "empty");
    fs.writeFileSync(filePath, "");
    expect(isBinaryByMagic(filePath)).toBe(false);
  });
});

describe("stripBinaries", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-test-"));
    mockedExecSync.mockClear();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws if strip tool is not found", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("command -v")) {
        throw new Error("not found");
      }
      return Buffer.from("");
    });

    await expect(stripBinaries(tmpDir, "native")).rejects.toThrow(
      "Strip tool 'strip' not found on this system"
    );
  });

  it("throws if strip tool not found for windows target", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("command -v")) {
        throw new Error("not found");
      }
      return Buffer.from("");
    });

    await expect(stripBinaries(tmpDir, "windows")).rejects.toThrow(
      "x86_64-w64-mingw32-strip"
    );
  });

  it("returns empty result when no binary files found", async () => {
    // Create src dir with only a text file
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "wrapper.sh"), "#!/bin/bash\necho hello\n");

    const result = await stripBinaries(tmpDir, "native");
    expect(result.strippedFiles).toEqual([]);
    expect(result.stripTool).toBe("strip");
  });

  it("strips ELF binaries found in src/.libs/", async () => {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });

    // Create a fake ELF binary
    const elfFile = path.join(libsDir, "libfoo.so.0.0.0");
    const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(elfFile, elfMagic);

    const result = await stripBinaries(tmpDir, "native");
    expect(result.strippedFiles).toContain(elfFile);
    expect(result.stripTool).toBe("strip");

    // Verify strip --strip-unneeded was called
    const stripCalls = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("strip --strip-unneeded")
    );
    expect(stripCalls.length).toBe(1);
    expect(String(stripCalls[0][0])).toContain(elfFile);
  });

  it("strips PE binaries with windows target using mingw strip", async () => {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });

    // Create a fake PE binary
    const peFile = path.join(libsDir, "libfoo-0.dll");
    const peMagic = Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(peFile, peMagic);

    const result = await stripBinaries(tmpDir, "windows");
    expect(result.strippedFiles).toContain(peFile);
    expect(result.stripTool).toBe("x86_64-w64-mingw32-strip");

    // Verify the correct strip tool was used
    const stripCalls = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("x86_64-w64-mingw32-strip --strip-unneeded")
    );
    expect(stripCalls.length).toBe(1);
  });

  it("skips non-binary files silently", async () => {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });

    // A libtool wrapper script (text, not binary)
    fs.writeFileSync(path.join(libsDir, "libfoo.la"), "# libtool script\n");
    // An actual ELF binary
    const elfFile = path.join(libsDir, "libfoo.so");
    fs.writeFileSync(elfFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]));

    const result = await stripBinaries(tmpDir, "native");
    // Only the ELF file should be stripped (la is excluded by findBuiltOutputs, but even if it weren't it would fail magic check)
    expect(result.strippedFiles).toContain(elfFile);
  });

  it("throws when strip fails on a file", async () => {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });

    const elfFile = path.join(libsDir, "libfoo.so");
    fs.writeFileSync(elfFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]));

    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("strip --strip-unneeded")) {
        throw new Error("File format not recognized");
      }
      return Buffer.from("");
    });

    await expect(stripBinaries(tmpDir, "native")).rejects.toThrow(
      "strip failed on"
    );
  });
});
