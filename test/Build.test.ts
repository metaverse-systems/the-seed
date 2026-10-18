import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Build, { targets, extractScope, getStripTool, isBinaryByMagic, stripBinaries, findBuiltOutputs } from "../src/Build";
import { BuildStep } from "../src/types";

jest.mock("child_process", () => ({
  execSync: jest.fn(() => Buffer.from(""))
}));

jest.mock("../src/ProcessRunner", () => ({
  ...jest.requireActual("../src/ProcessRunner"),
  runCommand: jest.fn(),
  // The resolved tool path is "/mock/bin/<name>"; stripBinaries is expected to run that path.
  findOnPath: jest.fn((name: string) => "/mock/bin/" + name),
}));

import { execSync } from "child_process";
import { runCommand, findOnPath, formatCommand, CommandResult } from "../src/ProcessRunner";
const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockedFindOnPath = findOnPath as jest.MockedFunction<typeof findOnPath>;
const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

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

    it("native configure step has the prefix argument, no --host and the prefix's pkgconfig path", () => {
      const step = stepOf(build.getSteps("native", true), "configure");
      const target = prefix() + "/x86_64-linux-gnu";
      expect(step.program).toBe("./configure");
      expect(step.args).toEqual(["--prefix=" + target]);
      expect(step.env).toEqual({ PKG_CONFIG_PATH: path.join(target, "lib/pkgconfig") });
    });

    it("windows configure step adds --host=x86_64-w64-mingw32", () => {
      const step = stepOf(build.getSteps("windows", true), "configure");
      const target = prefix() + "/x86_64-w64-mingw32";
      expect(step.program).toBe("./configure");
      expect(step.args).toEqual(["--prefix=" + target, "--host=x86_64-w64-mingw32"]);
      expect(step.env).toEqual({ PKG_CONFIG_PATH: path.join(target, "lib/pkgconfig") });
    });

    it("keeps a prefix with a space, quote, double quote and dollar as one unmodified argument", () => {
      const awkward = "/tmp/my prefix/it's \"x\" $HOME";
      const awkwardConfig = new Config(configDir);
      awkwardConfig.config.prefix = awkward;
      const step = stepOf(new Build(awkwardConfig).getSteps("native", true), "configure");
      expect(step.args).toEqual(["--prefix=" + awkward + "/x86_64-linux-gnu"]);
      expect(step.args).toHaveLength(1);
    });

    it("compile step is make -j without jobs", () => {
      const step = stepOf(build.getSteps("native", true), "compile");
      expect(step.program).toBe("make");
      expect(step.args).toEqual(["-j"]);
    });

    it("install step is make install", () => {
      const step = stepOf(build.getSteps("native", true), "install");
      expect(step.program).toBe("make");
      expect(step.args).toEqual(["install"]);
    });

    it("keeps make -j for every target and mode when jobs is not given", () => {
      for (const target of ["native", "windows"]) {
        for (const fullReconfigure of [true, false]) {
          const compileStep = stepOf(build.getSteps(target, fullReconfigure), "compile");
          expect(compileStep.program).toBe("make");
          expect(compileStep.args).toEqual(["-j"]);
        }
      }
    });

    it("uses make -j<jobs> when jobs is given and changes no other step", () => {
      for (const target of ["native", "windows"]) {
        for (const fullReconfigure of [true, false]) {
          const unbounded = build.getSteps(target, fullReconfigure);
          const bounded = build.getSteps(target, fullReconfigure, 3);
          expect(bounded).toHaveLength(unbounded.length);
          for (let i = 0; i < bounded.length; i++) {
            if (bounded[i].label === "compile") {
              expect(bounded[i].program).toBe("make");
              expect(bounded[i].args).toEqual(["-j3"]);
            } else {
              expect(bounded[i]).toEqual(unbounded[i]);
            }
          }
        }
      }
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

  // [program, args] of every runCommand call
  function runCommandCalls(): Array<[string, string[]]> {
    return mockedRunCommand.mock.calls.map((call) => [String(call[0]), call[1] as string[]]);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-test-"));
    mockedExecSync.mockClear();
    mockedRunCommand.mockReset();
    mockedRunCommand.mockResolvedValue(commandResult());
    mockedFindOnPath.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeElf(fileName: string): string {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });
    const filePath = path.join(libsDir, fileName);
    fs.writeFileSync(filePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]));
    return filePath;
  }

  it("throws if strip tool is not found", async () => {
    writeElf("libfoo.so");
    mockedFindOnPath.mockReturnValueOnce(null);

    await expect(stripBinaries(tmpDir, "native")).rejects.toThrow(
      "Strip tool 'strip' not found on this system"
    );
    expect(mockedRunCommand).not.toHaveBeenCalled();
  });

  it("throws if strip tool not found for windows target", async () => {
    mockedFindOnPath.mockReturnValueOnce(null);

    await expect(stripBinaries(tmpDir, "windows")).rejects.toThrow(
      "x86_64-w64-mingw32-strip"
    );
  });

  it("looks the strip tool up with findOnPath and starts no shell", async () => {
    await stripBinaries(tmpDir, "native");
    expect(mockedFindOnPath).toHaveBeenCalledWith("strip");
    expect(runCommandCalls()).toEqual([]);
    expect(mockedExecSync).not.toHaveBeenCalled();
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
    const elfFile = writeElf("libfoo.so.0.0.0");

    const result = await stripBinaries(tmpDir, "native");
    expect(result.strippedFiles).toContain(elfFile);
    expect(result.stripTool).toBe("strip");

    // Verify strip --strip-unneeded was called
    expect(runCommandCalls()).toEqual([["/mock/bin/strip", ["--strip-unneeded", elfFile]]]);
    expect(mockedExecSync).not.toHaveBeenCalled();
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
    expect(mockedFindOnPath).toHaveBeenCalledWith("x86_64-w64-mingw32-strip");
    expect(runCommandCalls()).toEqual([
      ["/mock/bin/x86_64-w64-mingw32-strip", ["--strip-unneeded", peFile]],
    ]);
  });

  it("skips non-binary files silently", async () => {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });

    // A libtool wrapper script (text, not binary)
    fs.writeFileSync(path.join(libsDir, "libfoo.la"), "# libtool script\n");
    // An actual ELF binary
    const elfFile = writeElf("libfoo.so");

    const result = await stripBinaries(tmpDir, "native");
    // Only the ELF file should be stripped (la is excluded by findBuiltOutputs, but even if it weren't it would fail magic check)
    expect(result.strippedFiles).toEqual([elfFile]);
  });

  it("throws when strip fails on a file", async () => {
    const elfFile = writeElf("libfoo.so");

    mockedRunCommand.mockResolvedValue(
      commandResult({ exitCode: 1, stderr: "File format not recognized\n" })
    );

    await expect(stripBinaries(tmpDir, "native")).rejects.toThrow(
      `strip failed on src/.libs/libfoo.so: Command failed: ${formatCommand("/mock/bin/strip", ["--strip-unneeded", elfFile])}\nFile format not recognized\n`
    );
  });

  it("forwards the signal to every runner call", async () => {
    writeElf("libfoo.so");
    writeElf("libbar.so");
    const controller = new AbortController();

    await stripBinaries(tmpDir, "native", controller.signal);

    expect(mockedRunCommand).toHaveBeenCalledTimes(2);
    for (const call of mockedRunCommand.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ signal: controller.signal }));
    }
  });

  it("stops stripping further files once the signal is aborted", async () => {
    writeElf("liba.so");
    writeElf("libb.so");
    writeElf("libc.so");
    const controller = new AbortController();

    let stripCount = 0;
    mockedRunCommand.mockImplementation(async (_program: string, args: string[]) => {
      if (args.includes("--strip-unneeded")) {
        stripCount++;
        controller.abort();
      }
      return commandResult();
    });

    await expect(stripBinaries(tmpDir, "native", controller.signal)).rejects.toThrow();
    expect(stripCount).toBe(1);
  });
});

describe("stripBinaries with a line logger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-log-test-"));
    mockedRunCommand.mockReset();
    mockedRunCommand.mockResolvedValue(commandResult());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sends whole lines to the logger and writes nothing itself", async () => {
    const libsDir = path.join(tmpDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });
    fs.writeFileSync(path.join(libsDir, "libfoo.so"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]));
    const lines: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await stripBinaries(tmpDir, "native", undefined, (line) => lines.push(line));
      expect(logSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }

    expect(lines).toEqual([
      "Using strip tool: strip",
      "Stripping src/.libs/libfoo.so... done",
      "Stripped 1 file(s)",
    ]);
  });
});
