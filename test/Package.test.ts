import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Package from "../src/Package";
import { targets } from "../src/Build";
import { DependencyResultType, ScriptArgsType } from "../src/types";
import PackageCLI from "../src/scripts/PackageCLI";

// Mock the native addon
jest.mock("../native/build/Release/dependency_lister.node", () => ({
  listDependencies: jest.fn()
}), { virtual: true });

// Mock child_process for MinGW detection in getSearchPaths
jest.mock("child_process", () => ({
  execSync: jest.fn((cmd: string) => {
    if (cmd.includes("libstdc++-6.dll")) {
      return Buffer.from("/usr/lib/gcc/x86_64-w64-mingw32/15-posix/libstdc++-6.dll\n");
    }
    if (cmd.includes("libwinpthread-1.dll")) {
      return Buffer.from("/usr/x86_64-w64-mingw32/lib/libwinpthread-1.dll\n");
    }
    return Buffer.from("");
  })
}));

const mockAddon = require("../native/build/Release/dependency_lister.node");
const mockedListDependencies = mockAddon.listDependencies as jest.MockedFunction<
  (binaryPaths: string[], searchPaths: string[]) => DependencyResultType
>;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "package-test-"));
}

function createTempFile(dir: string, name: string, content = ""): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("test Package", () => {
  let configDir: string;
  let config: Config;
  let pkg: Package;
  let tempDir: string;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);
  });

  beforeEach(() => {
    pkg = new Package(config);
    mockedListDependencies.mockClear();
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });

  // T012: Search paths constructed from Config prefix and all targets
  describe("getSearchPaths", () => {
    it("constructs search paths from Config prefix and all targets, including lib and bin", () => {
      const searchPaths = pkg.getSearchPaths();
      const targetKeys = Object.keys(targets);
      for (const target of targetKeys) {
        const targetDir = targets[target];
        expect(searchPaths).toContain(
          config.config.prefix + "/" + targetDir + "/lib"
        );
        expect(searchPaths).toContain(
          config.config.prefix + "/" + targetDir + "/bin"
        );
      }
      // MinGW runtime paths detected from mocked execSync
      expect(searchPaths).toContain("/usr/lib/gcc/x86_64-w64-mingw32/15-posix");
      expect(searchPaths).toContain("/usr/x86_64-w64-mingw32/lib");
    });
  });

  // T008: Package binary with dependencies creates dir and copies all files
  describe("run - happy path with dependencies", () => {
    it("creates directory and copies binary plus all resolved dependencies", () => {
      const binary = createTempFile(tempDir, "myapp", "binary-content");
      const libFoo = createTempFile(tempDir, "libfoo.so", "libfoo-content");
      const libBar = createTempFile(tempDir, "libbar.so", "libbar-content");

      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          [libFoo]: [binary],
          [libBar]: [binary],
          "libc.so.6": [binary]  // system lib — should be skipped
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [binary]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      expect(fs.existsSync(outputDir)).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libfoo.so"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libbar.so"))).toBe(true);
      // system lib should NOT be copied
      expect(fs.existsSync(path.join(outputDir, "libc.so.6"))).toBe(false);
    });
  });

  // T009: Package binary with no non-system dependencies copies only explicit files
  describe("run - no non-system dependencies", () => {
    it("copies only the explicit binary files when no project dependencies resolved", () => {
      const binary = createTempFile(tempDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          "libc.so.6": [binary],
          "libm.so.6": [binary]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [binary]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      expect(fs.existsSync(outputDir)).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      // Only the explicit binary, no system libs
      expect(fs.readdirSync(outputDir).length).toBe(1);
    });
  });

  // T010: Two binaries sharing a dependency copies shared library only once
  describe("run - deduplication", () => {
    it("copies a shared dependency only once when two binaries share it", () => {
      const binary1 = createTempFile(tempDir, "app1", "app1-content");
      const binary2 = createTempFile(tempDir, "app2", "app2-content");
      const sharedLib = createTempFile(tempDir, "libshared.so", "shared-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          [sharedLib]: [binary1, binary2]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [binary1, binary2]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      const outputFiles = fs.readdirSync(outputDir);
      expect(outputFiles).toContain("app1");
      expect(outputFiles).toContain("app2");
      expect(outputFiles).toContain("libshared.so");
      // 2 binaries + 1 shared lib = 3 files total
      expect(outputFiles.length).toBe(3);
    });
  });

  // Transitive dependency resolution: resolved libs are themselves analyzed
  describe("run - transitive dependencies", () => {
    it("resolves dependencies of dependencies recursively", () => {
      const binary = createTempFile(tempDir, "myapp", "binary-content");
      const libFoo = createTempFile(tempDir, "libfoo.so", "libfoo-content");
      const libBar = createTempFile(tempDir, "libbar.so", "libbar-content");
      const outputDir = path.join(tempDir, "my-release");

      // First call: binary depends on libfoo
      // Second call: libfoo depends on libbar
      // Third call: libbar has no new resolved deps
      mockedListDependencies
        .mockReturnValueOnce({
          dependencies: { [libFoo]: [binary], "libc.so.6": [binary] },
          errors: {}
        })
        .mockReturnValueOnce({
          dependencies: { [libBar]: [libFoo], "libc.so.6": [libFoo] },
          errors: {}
        })
        .mockReturnValueOnce({
          dependencies: { "libc.so.6": [libBar] },
          errors: {}
        });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [binary]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libfoo.so"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libbar.so"))).toBe(true);
      expect(fs.readdirSync(outputDir).length).toBe(3);
      // listDependencies called 3 times (binary, libfoo, libbar)
      expect(mockedListDependencies).toHaveBeenCalledTimes(3);
    });
  });

  // T011: Each file printed during copy and summary count displayed
  describe("run - verbose output", () => {
    it("prints each file during copy and summary count at end", () => {
      const binary = createTempFile(tempDir, "myapp", "binary-content");
      const libFoo = createTempFile(tempDir, "libfoo.so", "libfoo-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          [libFoo]: [binary]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [binary]);

      const logCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      // Check individual file copy messages
      expect(logCalls.some(msg => msg.includes("Copying myapp..."))).toBe(true);
      expect(logCalls.some(msg => msg.includes("Copying libfoo.so..."))).toBe(true);
      // Check summary
      expect(logCalls.some(msg => msg.includes("Packaged 2 files into"))).toBe(true);
    });
  });

  // T016: help subcommand prints usage information (US2)
  // T017: no arguments prints usage message (US2)
  // (These test the CLI handler, included in Phases 4)

  // T019: input file doesn't exist shows error, no directory created (US3)
  describe("run - input file not found", () => {
    it("shows error and does not create directory when input file does not exist", () => {
      const outputDir = path.join(tempDir, "my-release");
      const nonExistent = path.join(tempDir, "nonexistent");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [nonExistent]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("File not found"))).toBe(true);
    });
  });

  // T020: output directory already exists shows error (US3)
  describe("run - output directory already exists", () => {
    it("shows error when output directory already exists", () => {
      const binary = createTempFile(tempDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");
      fs.mkdirSync(outputDir);

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [binary]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Output directory already exists"))).toBe(true);
    });
  });

  // T022: DependencyLister returns errors triggers fatal abort (US3)
  describe("run - dependency resolution errors", () => {
    it("aborts with error messages when DependencyLister returns errors", () => {
      const binary = createTempFile(tempDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {},
        errors: {
          [binary]: "Failed to parse ELF header"
        }
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [binary]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Failed to analyze binary"))).toBe(true);
    });
  });

  // T022a: input path is a directory shows error (US3)
  describe("run - input is a directory", () => {
    it("shows error when input path is a directory instead of a file", () => {
      const subDir = path.join(tempDir, "subdir");
      fs.mkdirSync(subDir);
      const outputDir = path.join(tempDir, "my-release");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [subDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Not a file"))).toBe(true);
    });
  });

  // T016: help subcommand prints usage information (US2)
  describe("PackageCLI - help subcommand", () => {
    it("prints usage information when help subcommand is given", () => {
      const scriptConfig: ScriptArgsType = {
        binName: "the-seed",
        args: ["node", "the-seed", "package", "help"],
        configDir: configDir
      };

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      PackageCLI(scriptConfig);
      const logCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(logCalls.some(msg => msg.includes("Usage: the-seed package"))).toBe(true);
      expect(logCalls.some(msg => msg.includes("directory"))).toBe(true);
      expect(logCalls.some(msg => msg.includes("file1"))).toBe(true);
    });
  });

  // T017: no arguments prints usage message (US2)
  describe("PackageCLI - no arguments", () => {
    it("prints usage message when no arguments are given", () => {
      const scriptConfig: ScriptArgsType = {
        binName: "the-seed",
        args: ["node", "the-seed", "package"],
        configDir: configDir
      };

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      PackageCLI(scriptConfig);
      const logCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(logCalls.some(msg => msg.includes("Usage: the-seed package"))).toBe(true);
    });
  });

  // T021: no files specified shows usage error (US3)
  describe("PackageCLI - no files specified", () => {
    it("shows usage error when output dir given but no files", () => {
      const scriptConfig: ScriptArgsType = {
        binName: "the-seed",
        args: ["node", "the-seed", "package", "my-release"],
        configDir: configDir
      };

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const mockExit = jest.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error("process.exit: " + code);
      });

      expect(() => PackageCLI(scriptConfig)).toThrow("process.exit: 1");

      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();
      mockExit.mockRestore();

      expect(errorCalls.some(msg => msg.includes("Usage: the-seed package"))).toBe(true);
    });
  });
});
