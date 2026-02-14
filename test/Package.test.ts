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

function createProjectDir(baseDir: string, name: string, makefileAmContent: string): string {
  const projectDir = path.join(baseDir, name);
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "Makefile.am"), makefileAmContent);
  return projectDir;
}

function installBuildOutput(projectDir: string, filename: string, content = ""): string {
  const libsDir = path.join(projectDir, "src", ".libs");
  fs.mkdirSync(libsDir, { recursive: true });
  const filePath = path.join(libsDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function createNodeModuleDep(projectDir: string, depName: string, makefileAmContent: string): string {
  const depDir = path.join(projectDir, "node_modules", depName);
  fs.mkdirSync(path.join(depDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(depDir, "src", "Makefile.am"), makefileAmContent);
  return depDir;
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
    tempDir = createTempDir();
    config.config.prefix = path.join(tempDir, "prefix");
    pkg = new Package(config);
    mockedListDependencies.mockClear();
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

  // parseMakefileAm tests
  describe("parseMakefileAm", () => {
    it("parses bin_PROGRAMS as a program type", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "ACLOCAL_AMFLAGS=-I m4\nbin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const result = pkg.parseMakefileAm(projectDir);
      expect(result).toEqual({ type: "program", name: "myapp" });
    });

    it("parses lib_LTLIBRARIES as a library type", () => {
      const projectDir = createProjectDir(tempDir, "libfoo",
        "ACLOCAL_AMFLAGS=-I m4\nlib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      const result = pkg.parseMakefileAm(projectDir);
      expect(result).toEqual({ type: "library", name: "libfoo" });
    });

    it("returns null when src/Makefile.am does not exist", () => {
      const projectDir = path.join(tempDir, "noproject");
      fs.mkdirSync(projectDir, { recursive: true });
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.parseMakefileAm(projectDir);
      consoleSpy.mockRestore();
      expect(result).toBeNull();
    });

    it("returns null when Makefile.am has unrecognized format", () => {
      const projectDir = createProjectDir(tempDir, "weird",
        "ACLOCAL_AMFLAGS=-I m4\n# nothing useful here\n");
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.parseMakefileAm(projectDir);
      consoleSpy.mockRestore();
      expect(result).toBeNull();
    });
  });

  // resolveBinaryPaths tests
  describe("resolveBinaryPaths", () => {
    it("finds native program binary in src/.libs/", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary");
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result).toContain(
        path.join(projectDir, "src", ".libs", "myapp"));
    });

    it("finds Windows program binary (.exe) in src/.libs/", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp.exe", "binary");
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result).toContain(
        path.join(projectDir, "src", ".libs", "myapp.exe"));
    });

    it("finds native library (.so) in src/.libs/", () => {
      const projectDir = createProjectDir(tempDir, "libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      installBuildOutput(projectDir, "libfoo.so", "library");
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result).toContain(
        path.join(projectDir, "src", ".libs", "libfoo.so"));
    });

    it("finds Windows library DLL in src/.libs/", () => {
      const projectDir = createProjectDir(tempDir, "libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      installBuildOutput(projectDir, "libfoo-0.dll", "library");
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result).toContain(
        path.join(projectDir, "src", ".libs", "libfoo-0.dll"));
    });

    it("finds both native and Windows binaries in src/.libs/", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary");
      installBuildOutput(projectDir, "myapp.exe", "binary");
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result).toHaveLength(2);
    });

    it("returns empty array when src/.libs/ does not exist", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result).toEqual([]);
    });
  });

  // getPackageDeps tests
  describe("getPackageDeps", () => {
    it("returns dependency dirs from node_modules that have src/Makefile.am", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        dependencies: { "@org/libfoo": "^1.0.0", "@org/libbar": "^2.0.0" }
      }));
      createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      createNodeModuleDep(projectDir, "@org/libbar",
        "lib_LTLIBRARIES = libbar.la\nlibbar_la_SOURCES = bar.cpp\n");
      const result = pkg.getPackageDeps(projectDir);
      expect(result).toHaveLength(2);
      expect(result).toContain(path.join(projectDir, "node_modules", "@org/libfoo"));
      expect(result).toContain(path.join(projectDir, "node_modules", "@org/libbar"));
    });

    it("skips dependencies without src/Makefile.am", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        dependencies: { "@org/libfoo": "^1.0.0", "some-js-lib": "^3.0.0" }
      }));
      createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      // some-js-lib exists in node_modules but has no Makefile.am
      const jsLibDir = path.join(projectDir, "node_modules", "some-js-lib");
      fs.mkdirSync(jsLibDir, { recursive: true });
      const result = pkg.getPackageDeps(projectDir);
      expect(result).toHaveLength(1);
      expect(result).toContain(path.join(projectDir, "node_modules", "@org/libfoo"));
    });

    it("returns empty array when no package.json exists", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const result = pkg.getPackageDeps(projectDir);
      expect(result).toEqual([]);
    });

    it("returns empty array when package.json has no dependencies", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "myapp", version: "1.0.0"
      }));
      const result = pkg.getPackageDeps(projectDir);
      expect(result).toEqual([]);
    });

    it("recursively collects transitive native dependencies", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      // myapp depends on @org/libfoo
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        dependencies: { "@org/libfoo": "^1.0.0" }
      }));
      const libfooDir = createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      // @org/libfoo depends on @org/libbar
      fs.writeFileSync(path.join(libfooDir, "package.json"), JSON.stringify({
        dependencies: { "@org/libbar": "^1.0.0" }
      }));
      createNodeModuleDep(libfooDir, "@org/libbar",
        "lib_LTLIBRARIES = libbar.la\nlibbar_la_SOURCES = bar.cpp\n");

      const result = pkg.getPackageDeps(projectDir);
      expect(result).toHaveLength(2);
      expect(result).toContain(path.join(projectDir, "node_modules", "@org/libfoo"));
      expect(result).toContain(path.join(libfooDir, "node_modules", "@org/libbar"));
    });
  });

  // T008: Package binary with dependencies creates dir and copies all files
  describe("run - happy path with dependencies", () => {
    it("creates directory and copies binary plus all resolved dependencies", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libFoo = installBuildOutput(projectDir, "libfoo.so", "libfoo-content");
      const libBar = installBuildOutput(projectDir, "libbar.so", "libbar-content");

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
      const result = pkg.run(outputDir, [projectDir]);
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

  // run includes binaries from package.json dependencies in node_modules
  describe("run - includes package.json dependency binaries", () => {
    it("copies binaries from node_modules dependencies alongside the main binary", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");

      // Add a native dependency via package.json + node_modules
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        dependencies: { "@org/libfoo": "^1.0.0" }
      }));
      const depDir = createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      const depLib = installBuildOutput(depDir, "libfoo-0.dll", "dll-content");

      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {},
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libfoo-0.dll"))).toBe(true);
    });
  });

  // T009: Package binary with no non-system dependencies copies only explicit files
  describe("run - no non-system dependencies", () => {
    it("copies only the resolved binary when no project dependencies found", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          "libc.so.6": [binary],
          "libm.so.6": [binary]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result).toBe(true);
      expect(fs.existsSync(outputDir)).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      // Only the resolved binary, no system libs
      expect(fs.readdirSync(outputDir).length).toBe(1);
    });
  });

  // T010: Two project dirs sharing a dependency copies shared library only once
  describe("run - deduplication", () => {
    it("copies a shared dependency only once when two binaries share it", () => {
      const projectDir1 = createProjectDir(tempDir, "app1",
        "bin_PROGRAMS = app1\napp1_SOURCES = app1.cpp\n");
      const projectDir2 = createProjectDir(tempDir, "app2",
        "bin_PROGRAMS = app2\napp2_SOURCES = app2.cpp\n");
      const binary1 = installBuildOutput(projectDir1, "app1", "app1-content");
      const binary2 = installBuildOutput(projectDir2, "app2", "app2-content");
      const sharedLib = installBuildOutput(projectDir1, "libshared.so", "shared-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          [sharedLib]: [binary1, binary2]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [projectDir1, projectDir2]);
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
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libFoo = installBuildOutput(projectDir, "libfoo.so", "libfoo-content");
      const libBar = installBuildOutput(projectDir, "libbar.so", "libbar-content");
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
      const result = pkg.run(outputDir, [projectDir]);
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
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libFoo = installBuildOutput(projectDir, "libfoo.so", "libfoo-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          [libFoo]: [binary]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = pkg.run(outputDir, [projectDir]);

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

  // T019: project directory doesn't exist shows error, no output directory created (US3)
  describe("run - project directory not found", () => {
    it("shows error and does not create directory when project directory does not exist", () => {
      const outputDir = path.join(tempDir, "my-release");
      const nonExistent = path.join(tempDir, "nonexistent");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [nonExistent]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Directory not found"))).toBe(true);
    });
  });

  // T020: output directory already exists shows error (US3)
  describe("run - output directory already exists", () => {
    it("shows error when output directory already exists", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");
      fs.mkdirSync(outputDir);

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [projectDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Output directory already exists"))).toBe(true);
    });
  });

  // T022: DependencyLister returns errors triggers fatal abort (US3)
  describe("run - dependency resolution errors", () => {
    it("aborts with error messages when DependencyLister returns errors", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {},
        errors: {
          [binary]: "Failed to parse ELF header"
        }
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [projectDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Failed to analyze binary"))).toBe(true);
    });
  });

  // T022a: input path is not a directory shows error (US3)
  describe("run - input is not a directory", () => {
    it("shows error when input path is a file instead of a directory", () => {
      const filePath = path.join(tempDir, "notadir");
      fs.writeFileSync(filePath, "content");
      const outputDir = path.join(tempDir, "my-release");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [filePath]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Not a directory"))).toBe(true);
    });
  });

  // No installed binaries found for a valid project directory
  describe("run - no installed binaries", () => {
    it("shows error when project has Makefile.am but no installed binaries", () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const outputDir = path.join(tempDir, "my-release");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = pkg.run(outputDir, [projectDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("No installed binaries found"))).toBe(true);
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
      expect(logCalls.some(msg => msg.includes("output-directory"))).toBe(true);
      expect(logCalls.some(msg => msg.includes("project-dir"))).toBe(true);
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

  // T021: no project dirs specified shows usage error (US3)
  describe("PackageCLI - no project dirs specified", () => {
    it("shows usage error when output dir given but no project dirs", () => {
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
