import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Package from "../src/Package";
import { targets } from "../src/Build";
import { DependencyResultType, PackageCopyEvent, PackagePlan, PackageRunOptions, ToolLogLevel } from "../src/types";
import { runTheSeed } from "./helpers/RunCli";
import fse from "fs-extra";
import { elfImage } from "./helpers/ElfImage";
import { nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";

// Mock the native addon
jest.mock("../native/build/Release/the_seed_native.node", () => ({
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

// eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
const mockAddon = require("../native/build/Release/the_seed_native.node");
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
  // The shared walker follows only directories that hold both package.json and src/Makefile.am.
  fs.writeFileSync(path.join(depDir, "package.json"), JSON.stringify({ name: depName, version: "1.0.0" }));
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

    it("returns the real file of the development link for a native library", () => {
      const projectDir = createProjectDir(tempDir, "libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      const real = installBuildOutput(projectDir, "libfoo.so.0.0.0", "library");
      fs.symlinkSync("libfoo.so.0.0.0", path.join(projectDir, "src", ".libs", "libfoo.so"));
      const result = pkg.resolveBinaryPaths(projectDir);
      expect(result.map(file => fs.realpathSync(file))).toEqual([fs.realpathSync(real)]);
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

  // plan tests
  describe("plan", () => {
    // Planning analyses the build outputs with the addon, so the mock answers with nothing found.
    beforeEach(() => {
      mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });
    });

    /** The plan as its successful form; a refusal is thrown so its text shows. */
    async function planOk(projectDirs: string[]): Promise<Extract<PackagePlan, { ok: true }>> {
      const plan = await pkg.plan(projectDirs);
      if (!plan.ok) {
        throw new Error("plan refused: " + plan.message);
      }
      return plan;
    }

    /** A program project with a package.json naming it and the given dependencies, and its build output. */
    function createProgram(name: string, dependencies: Record<string, string>): string {
      const projectDir = createProjectDir(tempDir, name,
        "bin_PROGRAMS = " + name + "\n" + name + "_SOURCES = " + name + ".cpp\n");
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "@org/" + name, version: "1.0.0", dependencies
      }));
      installBuildOutput(projectDir, name, "binary");
      return projectDir;
    }

    const real = (dir: string): string => fs.realpathSync(dir);

    it("finds dependency projects from node_modules that have src/Makefile.am", async () => {
      const projectDir = createProgram("myapp", { "@org/libfoo": "^1.0.0", "@org/libbar": "^2.0.0" });
      const libfoo = createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      const libbar = createNodeModuleDep(projectDir, "@org/libbar",
        "lib_LTLIBRARIES = libbar.la\nlibbar_la_SOURCES = bar.cpp\n");

      const plan = await planOk([projectDir]);
      expect(plan.projects).toHaveLength(3);
      expect(plan.projects).toEqual(expect.arrayContaining([real(projectDir), real(libfoo), real(libbar)]));
      expect(fs.existsSync(path.join(tempDir, "my-release"))).toBe(false);
    });

    it("finds a dependency project declared by local path", async () => {
      const libfoo = createProjectDir(tempDir, "libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      fs.writeFileSync(path.join(libfoo, "package.json"), JSON.stringify({ name: "@org/libfoo", version: "1.0.0" }));
      installBuildOutput(libfoo, "libfoo-0.dll", "dll-content");
      const projectDir = createProgram("myapp", { "@org/libfoo": "file:../libfoo" });

      const plan = await planOk([projectDir]);
      expect(plan.projects).toEqual(expect.arrayContaining([real(projectDir), real(libfoo)]));
      expect(plan.projects).toHaveLength(2);
      expect(plan.files.map(file => file.name)).toEqual(expect.arrayContaining(["myapp", "libfoo-0.dll"]));
    });

    it("skips dependencies without src/Makefile.am", async () => {
      const projectDir = createProgram("myapp", { "@org/libfoo": "^1.0.0", "some-js-lib": "^3.0.0" });
      const libfoo = createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      // some-js-lib exists in node_modules but has no Makefile.am
      const jsLibDir = path.join(projectDir, "node_modules", "some-js-lib");
      fs.mkdirSync(jsLibDir, { recursive: true });
      fs.writeFileSync(path.join(jsLibDir, "package.json"), JSON.stringify({ name: "some-js-lib", version: "3.0.0" }));

      const plan = await planOk([projectDir]);
      expect(plan.projects).toHaveLength(2);
      expect(plan.projects).toEqual(expect.arrayContaining([real(projectDir), real(libfoo)]));
    });

    it("gives the directory alone when it has no package.json", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary");

      const plan = await planOk([projectDir]);
      expect(plan.projects).toEqual([real(projectDir)]);
    });

    it("gives the directory alone when package.json has no dependencies", async () => {
      const projectDir = createProgram("myapp", {});

      const plan = await planOk([projectDir]);
      expect(plan.projects).toEqual([real(projectDir)]);
    });

    it("includes transitive dependency projects", async () => {
      const projectDir = createProgram("myapp", { "@org/libfoo": "^1.0.0" });
      const libfooDir = createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      fs.writeFileSync(path.join(libfooDir, "package.json"), JSON.stringify({
        name: "@org/libfoo", version: "1.0.0", dependencies: { "@org/libbar": "^1.0.0" }
      }));
      const libbarDir = createNodeModuleDep(libfooDir, "@org/libbar",
        "lib_LTLIBRARIES = libbar.la\nlibbar_la_SOURCES = bar.cpp\n");

      const plan = await planOk([projectDir]);
      expect(plan.projects).toHaveLength(3);
      expect(plan.projects).toEqual(expect.arrayContaining([real(projectDir), real(libfooDir), real(libbarDir)]));
    });
  });

  // T008: Package binary with dependencies creates dir and copies all files
  describe("run - happy path with dependencies", () => {
    it("creates directory and copies binary plus all resolved dependencies", async () => {
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
      const result = await pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
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
    it("copies binaries from node_modules dependencies alongside the main binary", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary-content");

      // Add a native dependency via package.json + node_modules
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "@org/myapp", version: "1.0.0", dependencies: { "@org/libfoo": "^1.0.0" }
      }));
      const depDir = createNodeModuleDep(projectDir, "@org/libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      installBuildOutput(depDir, "libfoo-0.dll", "dll-content");

      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {},
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libfoo-0.dll"))).toBe(true);
    });
  });

  // T009: Package binary with no non-system dependencies copies only explicit files
  describe("run - no non-system dependencies", () => {
    it("copies only the resolved binary when no project dependencies found", async () => {
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
      const result = await pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(fs.existsSync(outputDir)).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      // Only the resolved binary, no system libs
      expect(fs.readdirSync(outputDir).length).toBe(1);
    });
  });

  // T010: Two project dirs sharing a dependency copies shared library only once
  describe("run - deduplication", () => {
    it("copies a shared dependency only once when two binaries share it", async () => {
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
      const result = await pkg.run(outputDir, [projectDir1, projectDir2]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
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
    it("resolves dependencies of dependencies recursively", async () => {
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
      const result = await pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
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
    it("prints each file during copy and summary count at end", async () => {
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
      const result = await pkg.run(outputDir, [projectDir]);

      const logCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
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
    it("shows error and does not create directory when project directory does not exist", async () => {
      const outputDir = path.join(tempDir, "my-release");
      const nonExistent = path.join(tempDir, "nonexistent");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, [nonExistent]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Directory not found"))).toBe(true);
      expect(result.message).toContain("Directory not found");
    });
  });

  // T020: output directory already exists shows error (US3)
  describe("run - output directory already exists", () => {
    it("shows error when output directory already exists", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");
      fs.mkdirSync(outputDir);

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Output directory already exists"))).toBe(true);
      expect(result.message).toContain("Output directory already exists");
    });
  });

  // T022: DependencyLister returns errors triggers fatal abort (US3)
  describe("run - dependency resolution errors", () => {
    it("aborts with error messages when DependencyLister returns errors", async () => {
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
      const result = await pkg.run(outputDir, [projectDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Failed to analyze binary"))).toBe(true);
      expect(result.message).toContain("Failed to analyze binary");
    });
  });

  // Libraries that could not be read are reported in libraryErrors
  describe("run - library read errors", () => {
    function setupProject(): { binary: string; libGood: string; libBroken: string; outputDir: string; projectDir: string } {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libGood = installBuildOutput(projectDir, "libgood.so", "libgood-content");
      const libBroken = installBuildOutput(projectDir, "libbroken.so", "not a library");
      const outputDir = path.join(tempDir, "my-release");
      return { binary, libGood, libBroken, outputDir, projectDir };
    }

    it("behaves as before when the result has no libraryErrors field", async () => {
      const { binary, libGood, outputDir, projectDir } = setupProject();

      mockedListDependencies
        .mockReturnValueOnce({ dependencies: { [libGood]: [binary] }, errors: {} })
        .mockReturnValueOnce({ dependencies: {}, errors: {} });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const warnCalls = warnSpy.mock.calls.length;
      warnSpy.mockRestore();
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(warnCalls).toBe(0);
      expect(fs.existsSync(path.join(outputDir, "libgood.so"))).toBe(true);
      expect(mockedListDependencies).toHaveBeenCalledTimes(2);
    });

    it("behaves as before when libraryErrors is empty", async () => {
      const { binary, libGood, outputDir, projectDir } = setupProject();

      mockedListDependencies
        .mockReturnValueOnce({ dependencies: { [libGood]: [binary] }, errors: {}, libraryErrors: {} })
        .mockReturnValueOnce({ dependencies: {}, errors: {}, libraryErrors: {} });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const warnCalls = warnSpy.mock.calls.length;
      warnSpy.mockRestore();
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(warnCalls).toBe(0);
      expect(fs.existsSync(path.join(outputDir, "libgood.so"))).toBe(true);
    });

    it("warns with path, reason and affected inputs, does not re-queue the library and still packages it", async () => {
      const { binary, libGood, libBroken, outputDir, projectDir } = setupProject();

      mockedListDependencies
        .mockReturnValueOnce({
          dependencies: { [libGood]: [binary], [libBroken]: [binary] },
          errors: {},
          libraryErrors: { [libBroken]: { reason: "Not a recognized library format", inputs: [binary] } }
        })
        // second round: only the good library is analyzed
        .mockReturnValueOnce({ dependencies: {}, errors: {}, libraryErrors: {} })
        // a third round would mean the unreadable library was queued
        .mockReturnValue({ dependencies: {}, errors: {}, libraryErrors: {} });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const warnings = warnSpy.mock.calls.map(c => c.join(" ")).join("\n");
      warnSpy.mockRestore();
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(warnings).toContain("Warning: Library could not be read: " + libBroken);
      expect(warnings).toContain("Not a recognized library format");
      expect(warnings).toContain(binary);

      // the unreadable library is never passed as an analysis input
      expect(mockedListDependencies).toHaveBeenCalledTimes(2);
      for (const call of mockedListDependencies.mock.calls) {
        expect(call[0]).not.toContain(libBroken);
      }
      expect(mockedListDependencies.mock.calls[1][0]).toEqual([libGood]);

      // but it is still copied
      expect(fs.existsSync(path.join(outputDir, "libbroken.so"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libgood.so"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
    });

    it("warns once per unreadable library", async () => {
      const { binary, libGood, libBroken, outputDir, projectDir } = setupProject();

      mockedListDependencies
        .mockReturnValueOnce({
          dependencies: { [libGood]: [binary], [libBroken]: [binary, libGood] },
          errors: {},
          libraryErrors: {
            [libBroken]: { reason: "Truncated file", inputs: [binary, libGood] }
          }
        })
        .mockReturnValue({ dependencies: {}, errors: {}, libraryErrors: {} });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const warnings = warnSpy.mock.calls.map(c => c.join(" ")).join("\n");
      warnSpy.mockRestore();
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(warnings.split("Library could not be read: " + libBroken).length - 1).toBe(1);
      expect(warnings).toContain("Truncated file");
      expect(warnings).toContain(libGood);
    });

    it("warns once for a library that later rounds report again", async () => {
      const { binary, libGood, libBroken, outputDir, projectDir } = setupProject();
      const report = { [libBroken]: { reason: "Truncated file", inputs: [binary] } };

      mockedListDependencies
        .mockReturnValueOnce({
          dependencies: { [libGood]: [binary], [libBroken]: [binary] },
          errors: {},
          libraryErrors: report
        })
        .mockReturnValueOnce({
          dependencies: { [libBroken]: [libGood] },
          errors: {},
          libraryErrors: { [libBroken]: { reason: "Truncated file", inputs: [libGood] } }
        })
        .mockReturnValue({ dependencies: {}, errors: {}, libraryErrors: {} });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const warnings = warnSpy.mock.calls.map(c => c.join(" ")).join("\n");
      warnSpy.mockRestore();
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(warnings.split("Library could not be read: " + libBroken).length - 1).toBe(1);
    });

    it("still aborts when errors is non-empty, even with libraryErrors present", async () => {
      const { binary, libBroken, outputDir, projectDir } = setupProject();

      mockedListDependencies.mockReturnValue({
        dependencies: { [libBroken]: [binary] },
        errors: { [binary]: "Failed to parse ELF header" },
        libraryErrors: { [libBroken]: { reason: "Not a recognized library format", inputs: [binary] } }
      });

      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const errorCalls = errorSpy.mock.calls.map(c => c[0]);
      errorSpy.mockRestore();
      warnSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Failed to analyze binary"))).toBe(true);
      expect(result.message).toContain("Failed to analyze binary");
    });
  });

  // T022a: input path is not a directory shows error (US3)
  describe("run - input is not a directory", () => {
    it("shows error when input path is a file instead of a directory", async () => {
      const filePath = path.join(tempDir, "notadir");
      fs.writeFileSync(filePath, "content");
      const outputDir = path.join(tempDir, "my-release");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, [filePath]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("Not a directory"))).toBe(true);
      expect(result.message).toContain("Not a directory");
    });
  });

  // No installed binaries found for a valid project directory
  describe("run - no installed binaries", () => {
    it("shows error when project has Makefile.am but no installed binaries", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const outputDir = path.join(tempDir, "my-release");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const errorCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(errorCalls.some(msg => msg.includes("No installed binaries found"))).toBe(true);
      expect(result.message).toContain("No installed binaries found");
    });
  });

  // .sig file copying
  describe("run - copies .sig files when they exist", () => {
    it("copies .sig files alongside their binaries", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      // Create a .sig file next to the binary
      fs.writeFileSync(binary + ".sig", "signature-data");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {},
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const logCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp.sig"))).toBe(true);
      expect(fs.readFileSync(path.join(outputDir, "myapp.sig"), "utf-8")).toBe("signature-data");
      expect(logCalls.some(msg => msg.includes("Copying myapp.sig..."))).toBe(true);
      expect(logCalls.some(msg => msg.includes("signature"))).toBe(true);
      expect(logCalls).toContain("Packaged 2 files into " + outputDir + "/ (1 signature included)");
      expect(result.fileCount).toBe(2);
      expect(result.signatures).toBe(1);
      expect(fs.readdirSync(outputDir).length).toBe(result.fileCount);
    });

    it("skips .sig files when they do not exist", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      installBuildOutput(projectDir, "myapp", "binary-content");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {},
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp.sig"))).toBe(false);
      expect(fs.readdirSync(outputDir).length).toBe(1);
    });

    it("copies .sig files for resolved dependencies too", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libFoo = installBuildOutput(projectDir, "libfoo.so", "libfoo-content");
      // Only the library has a .sig file
      fs.writeFileSync(libFoo + ".sig", "libfoo-sig");
      const outputDir = path.join(tempDir, "my-release");

      mockedListDependencies.mockReturnValue({
        dependencies: {
          [libFoo]: [binary]
        },
        errors: {}
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const logCalls = consoleSpy.mock.calls.map(c => c[0]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "myapp.sig"))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "libfoo.so"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "libfoo.so.sig"))).toBe(true);
      expect(logCalls).toContain("Packaged 3 files into " + outputDir + "/ (1 signature included)");
      expect(result.fileCount).toBe(3);
    });
  });

  // A library that is not ELF keeps its file name
  describe("run - native library that is not ELF", () => {
    it("packages the library under libfoo.so (guard: non-ELF content keeps its name)", async () => {
      const projectDir = createProjectDir(tempDir, "libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      installBuildOutput(projectDir, "libfoo.so", "plain text");
      const outputDir = path.join(tempDir, "my-release");
      mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      consoleSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(fs.readdirSync(outputDir)).toEqual(["libfoo.so"]);
    });
  });

  describe("run - malformed library", () => {
    it("refuses a build-tree library with a corrupt ELF image, naming the file, before the addon is called", async () => {
      const projectDir = createProjectDir(tempDir, "libfoo",
        "lib_LTLIBRARIES = libfoo.la\nlibfoo_la_SOURCES = foo.cpp\n");
      const library = installBuildOutput(projectDir, "libfoo.so");
      fs.writeFileSync(library, elfImage({ bits: 64, endian: "little", type: "dyn", corrupt: "phoff" }));
      const outputDir = path.join(tempDir, "my-release");

      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, [projectDir]);
      const errorCalls = errorSpy.mock.calls.map(c => String(c[0]));
      errorSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.message).toContain(fs.realpathSync(library));
      expect(result.message).toContain("ELF");
      expect(errorCalls).toEqual(["Error: " + result.message]);
      expect(mockedListDependencies).not.toHaveBeenCalled();
      expect(fs.existsSync(outputDir)).toBe(false);
    });
  });

  describe("run - libraries not packaged", () => {
    // The choice for the implementation: a name the addon returns that is not absolute is a library
    // that was not found; it is listed under the packaged name of the first input, in the order of
    // the packaged names, that needs it, and the lines are printed as "  <name> (needed by <input>)".
    const setup = (): { binary: string; libFoo: string; outputDir: string } => {
      const projectDir = createProjectDir(tempDir, "myapp", "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libFoo = installBuildOutput(projectDir, "libfoo.so", "libfoo-content");
      return { binary, libFoo, outputDir: path.join(tempDir, "my-release") };
    };

    it("lists bare names that are not packaged names in name order with the first input that needs them", async () => {
      const { binary, libFoo, outputDir } = setup();
      mockedListDependencies
        .mockReturnValueOnce({
          dependencies: { [libFoo]: [binary], "libz.so.1": [binary, libFoo], "libc.so.6": [binary] },
          errors: {}
        })
        .mockReturnValue({ dependencies: { "libz.so.1": [libFoo], "libm.so.6": [libFoo] }, errors: {} });

      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [path.dirname(path.dirname(path.dirname(binary)))]);
      const lines = logSpy.mock.calls.map(call => call.map(String).join(" "));
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(result.notPackaged).toEqual([
        { name: "libc.so.6", neededBy: "myapp" },
        { name: "libm.so.6", neededBy: "libfoo.so" },
        { name: "libz.so.1", neededBy: "libfoo.so" }
      ]);
      const heading = lines.indexOf("Not packaged (expected on the target system):");
      expect(heading).toBeGreaterThan(lines.findIndex(line => line.startsWith("Packaged ")));
      expect(lines.slice(heading + 1)).toEqual([
        "  libc.so.6 (needed by myapp)",
        "  libm.so.6 (needed by libfoo.so)",
        "  libz.so.1 (needed by libfoo.so)"
      ]);
    });

    it("does not list a bare name equal to a packaged name", async () => {
      const { binary, libFoo, outputDir } = setup();
      mockedListDependencies
        .mockReturnValueOnce({ dependencies: { [libFoo]: [binary], "libfoo.so": [binary], "myapp": [libFoo] }, errors: {} })
        .mockReturnValue({ dependencies: {}, errors: {} });

      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [path.dirname(path.dirname(path.dirname(binary)))]);
      const lines = logSpy.mock.calls.map(call => call.map(String).join(" "));
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(result.notPackaged).toEqual([]);
      expect(lines).not.toContain("Not packaged (expected on the target system):");
    });

    it("does not print the heading when the addon returns no bare names", async () => {
      const { binary, libFoo, outputDir } = setup();
      mockedListDependencies.mockReturnValue({ dependencies: { [libFoo]: [binary] }, errors: {} });

      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await pkg.run(outputDir, [path.dirname(path.dirname(path.dirname(binary)))]);
      const lines = logSpy.mock.calls.map(call => call.map(String).join(" "));
      logSpy.mockRestore();

      expect(result.success).toBe(true);
      expect(result.notPackaged).toEqual([]);
      expect(lines.some(line => line.startsWith("Not packaged"))).toBe(false);
    });
  });

  describe("run - one output name from two projects", () => {
    it("refuses two program projects building different files named app before the addon is called", async () => {
      const dirs = ["one", "two"].map(name => {
        const projectDir = createProjectDir(tempDir, name, "bin_PROGRAMS = app\napp_SOURCES = app.cpp\n");
        fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "@t/" + name, version: "1.0.0" }));
        installBuildOutput(projectDir, "app", "content of " + name);
        return projectDir;
      });
      const outputDir = path.join(tempDir, "my-release");

      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, dirs);
      errorSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.message).toContain("Two different files would be packaged as app:");
      expect(result.message).toContain("build of @t/one");
      expect(result.message).toContain("build of @t/two");
      expect(result.message).toContain("Nothing was written.");
      expect(mockedListDependencies).not.toHaveBeenCalled();
      expect(fs.existsSync(outputDir)).toBe(false);
    });

    it("reports a given directory without binaries before any collision between the others", async () => {
      const dirs = ["one", "two"].map(name => {
        const projectDir = createProjectDir(tempDir, name, "bin_PROGRAMS = app\napp_SOURCES = app.cpp\n");
        fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "@t/" + name, version: "1.0.0" }));
        installBuildOutput(projectDir, "app", "content of " + name);
        return projectDir;
      });
      const empty = createProjectDir(tempDir, "empty", "bin_PROGRAMS = nothing\nnothing_SOURCES = nothing.cpp\n");
      const outputDir = path.join(tempDir, "my-release");

      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await pkg.run(outputDir, [...dirs, empty]);
      errorSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.message).toBe("No installed binaries found for " + empty);
      expect(mockedListDependencies).not.toHaveBeenCalled();
      expect(fs.existsSync(outputDir)).toBe(false);
    });
  });

  describe("run - copy failure", () => {
    // The choice for the implementation: files are copied with the default export of
    // fs-extra, through its copyFileSync, so that is the function this case makes fail.
    it("resolves success false with the failing name and leaves no output directory", async () => {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libFoo = installBuildOutput(projectDir, "libfoo.so", "libfoo-content");
      const outputDir = path.join(tempDir, "my-release");
      mockedListDependencies.mockReturnValue({ dependencies: { [libFoo]: [binary] }, errors: {} });

      const realCopy = fse.copyFileSync.bind(fse);
      let copies = 0;
      const copySpy = jest.spyOn(fse, "copyFileSync").mockImplementation(((from: string, to: string) => {
        copies++;
        if (copies === 2) {
          throw new Error("disk full");
        }
        realCopy(from, to);
      }) as typeof fse.copyFileSync);
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      let result;
      try {
        result = await pkg.run(outputDir, [projectDir]);
      } finally {
        copySpy.mockRestore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/^Copying libfoo\.so failed: .*disk full/);
      expect(fs.existsSync(outputDir)).toBe(false);
    });
  });

  // Package.run and plan given a caller's log and onCopy. Choices where the contract is open:
  // - "What the console received" is recorded by spying on console.log, console.warn and
  //   console.error together, in call order, each call joined into one line with the level of its
  //   method ("info" for console.log); the same project is then run again with the options into the
  //   same output directory, so the two runs print the same paths.
  // - A refusal is compared with the console text of the same refusal made without options.
  describe("run - reporting to a caller's log and onCopy", () => {
    type Line = { line: string; level: ToolLogLevel };
    let printed: Line[];
    let spies: jest.SpyInstance[];

    beforeEach(() => {
      printed = [];
      const record = (level: ToolLogLevel) => (...parts: unknown[]) => {
        printed.push({ line: parts.map(String).join(" "), level });
      };
      spies = [
        jest.spyOn(console, "log").mockImplementation(record("info")),
        jest.spyOn(console, "warn").mockImplementation(record("warn")),
        jest.spyOn(console, "error").mockImplementation(record("error")),
      ];
    });

    afterEach(() => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    });

    /** A log and onCopy that keep what they receive. */
    function sink(): { lines: Line[]; copies: PackageCopyEvent[]; options: PackageRunOptions } {
      const lines: Line[] = [];
      const copies: PackageCopyEvent[] = [];
      return {
        lines,
        copies,
        options: {
          log: (line, level) => {
            lines.push({ line, level });
          },
          onCopy: (event) => {
            copies.push({ ...event });
          },
        },
      };
    }

    /** Runs without options and returns what the console received, then clears the console record. */
    async function consoleRun(outputDir: string, projectDirs: string[]): Promise<{ success: boolean; lines: Line[] }> {
      printed.length = 0;
      const result = await pkg.run(outputDir, projectDirs);
      const lines = printed.slice();
      printed.length = 0;
      for (const spy of spies) {
        spy.mockClear();
      }
      return { success: result.success, lines };
    }

    function signedProgram(): { projectDir: string; binary: string; outputDir: string } {
      const projectDir = createProjectDir(tempDir, "myapp",
        "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      fs.writeFileSync(binary + ".sig", "signature-data");
      return { projectDir, binary, outputDir: path.join(tempDir, "my-release") };
    }

    it("sends every line to log with its console level, reports each copy and calls no console method", async () => {
      const { projectDir, binary, outputDir } = signedProgram();
      mockedListDependencies.mockImplementation((inputs: string[]) => ({
        dependencies: { "libc.so.6": inputs },
        errors: {},
      }));

      const before = await consoleRun(outputDir, [projectDir]);
      expect(before.success).toBe(true);
      fs.rmSync(outputDir, { recursive: true, force: true });

      const { lines, copies, options } = sink();
      const result = await pkg.run(outputDir, [projectDir], options);

      expect(result.success).toBe(true);
      expect(printed).toEqual([]);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(lines).toEqual(before.lines);
      expect(lines).toEqual([
        { line: "Copying myapp...", level: "info" },
        { line: "Copying myapp.sig...", level: "info" },
        { line: "Packaged 2 files into " + outputDir + "/ (1 signature included)", level: "info" },
        { line: "Not packaged (expected on the target system):", level: "info" },
        { line: "  libc.so.6 (needed by myapp)", level: "info" },
      ]);
      expect(copies).toEqual([
        { name: "myapp", source: fs.realpathSync(binary), index: 1, total: 2 },
        { name: "myapp.sig", source: fs.realpathSync(binary + ".sig"), index: 2, total: 2 },
      ]);
      expect(fs.readdirSync(outputDir).sort()).toEqual(["myapp", "myapp.sig"]);
    });

    it("reports a copy only after the file is written", async () => {
      const { projectDir, outputDir } = signedProgram();
      mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });
      const present: boolean[] = [];

      await pkg.run(outputDir, [projectDir], {
        log: () => undefined,
        onCopy: (event) => {
          present.push(fs.existsSync(path.join(outputDir, event.name)));
        },
      });

      expect(present).toEqual([true, true]);
    });

    const refusals: Array<[string, () => { outputDir: string; projectDirs: string[]; text: string }]> = [
      ["an existing output directory", () => {
        const { projectDir, outputDir } = signedProgram();
        fs.mkdirSync(outputDir);
        return { outputDir, projectDirs: [projectDir], text: "Error: Output directory already exists: " + outputDir };
      }],
      ["a project without binaries", () => {
        const projectDir = createProjectDir(tempDir, "myapp", "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
        return { outputDir: path.join(tempDir, "my-release"), projectDirs: [projectDir], text: "Error: No installed binaries found for " + projectDir };
      }],
      ["two different files under one name", () => {
        const projectDirs = ["one", "two"].map(name => {
          const projectDir = createProjectDir(tempDir, name, "bin_PROGRAMS = app\napp_SOURCES = app.cpp\n");
          fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "@t/" + name, version: "1.0.0" }));
          installBuildOutput(projectDir, "app", "content of " + name);
          return projectDir;
        });
        return { outputDir: path.join(tempDir, "my-release"), projectDirs, text: "Error: Two different files would be packaged as app:" };
      }],
    ];

    it.each(refusals)("refuses %s with one error line equal to the console text and no console call", async (_label, setup) => {
      const { outputDir, projectDirs, text } = setup();
      mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });

      const before = await consoleRun(outputDir, projectDirs);
      expect(before.success).toBe(false);
      expect(before.lines).toHaveLength(1);
      expect(before.lines[0].level).toBe("error");
      expect(before.lines[0].line.startsWith(text)).toBe(true);

      const { lines, copies, options } = sink();
      const result = await pkg.run(outputDir, projectDirs, options);

      expect(result.success).toBe(false);
      expect(lines).toEqual(before.lines);
      expect(lines).toEqual([{ line: "Error: " + result.message, level: "error" }]);
      expect(copies).toEqual([]);
      expect(printed).toEqual([]);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it("plan sends the three warning lines of an unreadable library to log, not the console", async () => {
      const projectDir = createProjectDir(tempDir, "myapp", "bin_PROGRAMS = myapp\nmyapp_SOURCES = myapp.cpp\n");
      const binary = installBuildOutput(projectDir, "myapp", "binary-content");
      const libBroken = installBuildOutput(projectDir, "libbroken.so", "not a library");
      mockedListDependencies
        .mockReturnValueOnce({
          dependencies: { [libBroken]: [binary] },
          errors: {},
          libraryErrors: { [libBroken]: { reason: "Not a recognized library format", inputs: [binary] } },
        })
        .mockReturnValue({ dependencies: {}, errors: {}, libraryErrors: {} });
      const { lines, options } = sink();

      const plan = await pkg.plan([projectDir], { log: options.log });

      expect(plan.ok).toBe(true);
      expect(lines).toEqual([
        { line: "Warning: Library could not be read: " + libBroken, level: "warn" },
        { line: "  Not a recognized library format", level: "warn" },
        { line: "  Needed by: " + binary, level: "warn" },
      ]);
      expect(printed).toEqual([]);
    });

    it("parseMakefileAm sends its error line to the given log", () => {
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir);
      const { lines, options } = sink();

      expect(pkg.parseMakefileAm(emptyDir, options.log)).toBeNull();
      expect(lines).toEqual([{ line: "Error: src/Makefile.am not found in " + emptyDir, level: "error" }]);
      expect(printed).toEqual([]);
    });

    it("without options prints to the console as before", async () => {
      const { projectDir, outputDir } = signedProgram();
      mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });

      const result = await pkg.run(outputDir, [projectDir]);

      expect(result.success).toBe(true);
      expect(printed).toEqual([
        { line: "Copying myapp...", level: "info" },
        { line: "Copying myapp.sig...", level: "info" },
        { line: "Packaged 2 files into " + outputDir + "/ (1 signature included)", level: "info" },
      ]);
    });
  });

  // `the-seed package help` and `the-seed package` alone print the command's help on standard output.
  describe("package - help subcommand", () => {
    it("prints usage information when help subcommand is given", async () => {
      const run = await runTheSeed(["package", "help"], { configDir });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("Usage: the-seed package");
      expect(run.stdout).toContain("output-directory");
      expect(run.stdout).toContain("project-dir");
    });

    it("explains how dependency projects are found, how libraries are named and that collisions are refused", async () => {
      const run = await runTheSeed(["package", "help"], { configDir });

      // The help is wrapped by the renderer, so it is compared with whitespace collapsed.
      const help = run.stdout.replace(/\s+/g, " ");
      const sentences = [
        "Dependency projects are found the way \"the-seed build native --recursive\" finds them, from the " +
          "\"dependencies\" of each project's package.json: a \"file:\" path is taken relative to the declaring " +
          "project, and any other dependency (for example one installed from npm) is looked up in that " +
          "project's node_modules.",
        "Linux libraries are written under the name programs load them by (for example libgreet.so.0), " +
          "each with its .sig when signed.",
        "Two different files with the same name are refused; nothing is written."
      ];
      for (const sentence of sentences) {
        expect(help).toContain(sentence);
      }
      expect(help.indexOf(sentences[0])).toBeGreaterThan(help.indexOf("project-dir"));
      for (let i = 1; i < sentences.length; i++) {
        expect(help.indexOf(sentences[i])).toBeGreaterThan(help.indexOf(sentences[i - 1]));
      }
    });
  });

  describe("package - no arguments", () => {
    it("prints the command's help and exits 0 when no arguments are given", async () => {
      const run = await runTheSeed(["package"], { configDir });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("Usage: the-seed package");
    });
  });

  describe("package - no project dirs specified", () => {
    it("shows a usage error with status 3 when output dir given but no project dirs", async () => {
      const run = await runTheSeed(["package", "my-release"], { configDir });

      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Usage: the-seed package");
      expect(run.stderr).toContain("Run \"the-seed help package\" for details.");
    });
  });
});

describe("Package without the native component", () => {
  type PackageModule = typeof import("../src/Package");
  type WalkerModule = typeof import("../src/DependencyWalker");
  type ComponentModule = typeof import("../src/NativeComponent");

  let configDir: string;
  let tempDir: string;
  let loaded: { Package: PackageModule["default"]; walker: WalkerModule; component: ComponentModule; walkSpy: jest.SpyInstance };
  let pkg: Package;

  beforeEach(() => {
    configDir = createTempDir();
    tempDir = createTempDir();
    const config = new Config(configDir);
    config.config.prefix = path.join(tempDir, "prefix");
    // The file-wide mock of the component is already built; forget it so the absent mock applies
    jest.resetModules();
    loaded = withoutNativeComponent(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
      const walker = require("../src/DependencyWalker") as WalkerModule;
      const walkSpy = jest.spyOn(walker, "walkDependencies");
      return {
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the walker so the spy is in place
        Package: (require("../src/Package") as PackageModule).default,
        walker,
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- the message comes from the same registry
        component: require("../src/NativeComponent") as ComponentModule,
        walkSpy,
      };
    });
    pkg = new loaded.Package(config);
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
    // Put the file-wide mock of the component back for any later case
    jest.doMock(nativeComponentPath, () => mockAddon, { virtual: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("plan refuses with the missing component message before discovery", async () => {
    const projectDir = createProjectDir(tempDir, "app", "bin_PROGRAMS = app\n");

    const plan = await pkg.plan([projectDir]);

    expect(plan).toEqual({ ok: false, message: loaded.component.nativeComponentMessage() });
    expect(loaded.walkSpy).not.toHaveBeenCalled();
  });

  it("run refuses with the missing component message, creates no output directory and starts no discovery", async () => {
    const projectDir = createProjectDir(tempDir, "app", "bin_PROGRAMS = app\n");
    const outputDir = path.join(tempDir, "release");
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    const result = await pkg.run(outputDir, [projectDir]);
    errorSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.message).toBe(loaded.component.nativeComponentMessage());
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(loaded.walkSpy).not.toHaveBeenCalled();
  });
});
