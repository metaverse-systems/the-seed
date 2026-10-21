/*
 * Installer cases. The group at the end of this file ("installer metadata") fixes these interfaces where the
 * contract leaves them open:
 * - The results of `readProjectMetadata`, `run` and the installer config are read through local types
 *   (`MetadataResult`, `RunResult`, `NewInstallerConfig`) so the file compiles whatever the declared types are;
 *   `readProjectMetadata` is read as `{ ok: true, config, notes } | { ok: false, message, status: 2 }`.
 * - `generateWxs(projectDir, config, files)` keeps its signature; `config.packageVersion` names the files.
 * - A refused project is run through `runTheSeed` without a `dist/` directory, so "nothing written" also
 *   shows that nothing was packaged; a message counts as printed once when exactly one line of standard
 *   error holds the refused value.
 * - `xmllint` and `wixl` run for real (the file mocks `child_process` for everything else) and only when
 *   present; otherwise `SKIPPED CHECK:` is printed, or the case fails under THE_SEED_REQUIRE_TOOLS=1.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import Config from "../src/Config";
import Installer, { sanitizeId, generateUpgradeCode, InstallerConfig } from "../src/Installer";
import { nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";
import { runTheSeed, snapshotTree } from "./helpers/RunCli";
import { addScopeHint, buildWindowsHint, createCertHint } from "../src/cli/Hints";
import { readWxs, WxsElement } from "./helpers/WxsReader";
import { optionalExternalCheck } from "./helpers/ExternalTools";

// Mock child_process for wixl/which detection
jest.mock("child_process", () => ({
  execFileSync: jest.fn((command: string, args?: string[]) => {
    if (command === "which" && args && args[0] === "wixl") {
      return Buffer.from("/usr/bin/wixl\n");
    }
    if (command === "wixl") {
      return Buffer.from("");
    }
    // For MinGW detection in Package (dependency of Installer)
    return Buffer.from("");
  }),
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

// Mock the native addon used by Package
jest.mock("../native/build/Release/dependency_lister.node", () => ({
  listDependencies: jest.fn()
}), { virtual: true });

const mockedExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;
// eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
const mockedListDependencies = require("../native/build/Release/dependency_lister.node").listDependencies as jest.Mock;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "installer-test-"));
}

function createProjectDir(
  baseDir: string,
  pkgJson: {
    name: string;
    version: string;
    author?: string | { name: string };
  }
): string {
  const projectDir = path.join(baseDir, pkgJson.name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify(pkgJson, null, 2)
  );
  return projectDir;
}

function createDistDir(projectDir: string, files: string[]): void {
  const distDir = path.join(projectDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(distDir, file), "binary-content");
  }
}

describe("Installer", () => {
  let configDir: string;
  let config: Config;
  let installer: Installer;
  let tempDir: string;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);
  });

  beforeEach(() => {
    tempDir = createTempDir();
    config.config.prefix = path.join(tempDir, "prefix");
    installer = new Installer(config);
    mockedExecFileSync.mockClear();

    // Re-setup default mock behavior after clear
    mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
      if (command === "which" && args && args[0] === "wixl") {
        return Buffer.from("/usr/bin/wixl\n");
      }
      if (command === "wixl") {
        return Buffer.from("");
      }
      return Buffer.from("");
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // ── sanitizeId() ──────────────────────────────────────────

  describe("sanitizeId", () => {
    it("should replace special characters with underscores", () => {
      expect(sanitizeId("libstdc++-6.dll")).toBe("libstdc___6_dll");
    });

    it("should replace hyphens with underscores", () => {
      expect(sanitizeId("libgcc_s_seh-1.dll")).toBe("libgcc_s_seh_1_dll");
    });

    it("should prefix with underscore when name starts with a digit", () => {
      expect(sanitizeId("6-test.exe")).toBe("_6_test_exe");
    });

    it("should leave alphanumeric and underscores unchanged", () => {
      expect(sanitizeId("my_app_binary")).toBe("my_app_binary");
    });

    it("should handle empty-ish names after sanitization", () => {
      expect(sanitizeId("...")).toBe("___");
    });

    it("should handle names starting with underscore", () => {
      expect(sanitizeId("_internal.exe")).toBe("_internal_exe");
    });
  });

  // ── generateUpgradeCode() ────────────────────────────────

  describe("generateUpgradeCode", () => {
    it("should produce deterministic output for same input", () => {
      const code1 = generateUpgradeCode("my-app");
      const code2 = generateUpgradeCode("my-app");
      expect(code1).toBe(code2);
    });

    it("should produce different output for different inputs", () => {
      const code1 = generateUpgradeCode("my-app");
      const code2 = generateUpgradeCode("other-app");
      expect(code1).not.toBe(code2);
    });

    it("should produce uppercase UUID format", () => {
      const code = generateUpgradeCode("test-product");
      // UUID format: XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
      expect(code).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });

    it("should have version 5 UUID bits set", () => {
      const code = generateUpgradeCode("test-product");
      // The 13th character (first of 3rd group) should be '5' for UUID v5
      const parts = code.split("-");
      expect(parts[2][0]).toBe("5");
    });

    it("should have correct variant bits", () => {
      const code = generateUpgradeCode("test-product");
      // The 17th character (first of 4th group) should be 8, 9, A, or B
      const parts = code.split("-");
      expect(["8", "9", "A", "B"]).toContain(parts[3][0]);
    });
  });

  // ── checkWixl() ──────────────────────────────────────────

  describe("checkWixl", () => {
    it("should return true when wixl is found", () => {
      expect(installer.checkWixl()).toBe(true);
    });

    it("should return false when wixl is not found", () => {
      mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
        if (command === "which" && args && args[0] === "wixl") {
          throw new Error("not found");
        }
        return Buffer.from("");
      });
      expect(installer.checkWixl()).toBe(false);
    });
  });

  // ── readProjectMetadata() ────────────────────────────────

  describe("readProjectMetadata", () => {
    it("should read valid package.json and return InstallerConfig", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "my-game",
        version: "1.2.3",
        author: "Test Author"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok).toBe(true);
      const config = result.ok ? result.config : null;
      expect(config!.productName).toBe("my-game");
      expect(config!.version).toBe("1.2.3");
      expect(config!.manufacturer).toBe("Test Author");
      expect(config!.upgradeCode).toBe(generateUpgradeCode("my-game"));
    });

    it("should keep the three numbers of the version", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "2.0.1",
        author: "Dev"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok && result.config.version).toBe("2.0.1");
    });

    it("should handle author as object with name", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "1.0.0",
        author: { name: "Object Author" }
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok && result.config.manufacturer).toBe("Object Author");
    });

    it("should default manufacturer to Unknown when author is missing", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "1.0.0"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok && result.config.manufacturer).toBe("Unknown");
    });

    it("should refuse when package.json is missing", async () => {
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = installer.readProjectMetadata(emptyDir);
      expect(result.ok).toBe(false);
      consoleSpy.mockRestore();
    });

    it("should refuse when name is missing", () => {
      const projectDir = path.join(tempDir, "no-name");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({ version: "1.0.0" })
      );

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok).toBe(false);
      consoleSpy.mockRestore();
    });

    it("should strip npm scope prefix from product name", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "@metaverse-systems/client",
        version: "0.0.1",
        author: "Test"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok).toBe(true);
      const config = result.ok ? result.config : null;
      expect(config!.productName).toBe("client");
      expect(config!.version).toBe("0.0.1");
      // UpgradeCode should use the full scoped name for determinism
      expect(config!.upgradeCode).toBe(generateUpgradeCode("@metaverse-systems/client"));
    });

    it("should handle scoped names with nested scope", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "@org/my-app",
        version: "2.0.0",
        author: "Dev"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result.ok && result.config.productName).toBe("my-app");
    });
  });

  // ── generateWxs() ────────────────────────────────────────

  describe("generateWxs", () => {
    it("should produce valid XML structure with correct elements", () => {
      const projectDir = path.join(tempDir, "wxs-test");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: InstallerConfig = {
        productName: "test-app",
        version: "1.0.0",
        packageVersion: "1.0.0",
        manufacturer: "Test Dev",
        upgradeCode: "12345678-1234-5678-9ABC-DEF012345678"
      };

      const files = ["app.exe", "libfoo.dll"];
      const wxsPath = installer.generateWxs(projectDir, config, files);

      expect(fs.existsSync(wxsPath)).toBe(true);
      expect(path.basename(wxsPath)).toBe("test-app-1.0.0.wxs");

      const content = fs.readFileSync(wxsPath, "utf-8");

      // Check XML declaration
      expect(content).toContain("<?xml version=\"1.0\" encoding=\"utf-8\"?>");

      // Check Product element attributes
      expect(content).toContain("Name=\"test-app\"");
      expect(content).toContain("Version=\"1.0.0\"");
      expect(content).toContain("Manufacturer=\"Test Dev\"");
      expect(content).toContain("UpgradeCode=\"12345678-1234-5678-9ABC-DEF012345678\"");

      // Check Package element
      expect(content).toContain("InstallScope=\"perMachine\"");
      expect(content).toContain("Platform=\"x64\"");

      // Check directory structure
      expect(content).toContain("ProgramFiles64Folder");
      expect(content).toContain("Name=\"test-app\"");

      // Check components for each file
      expect(content).toContain("Id=\"Cmp_app_exe_1a95c6b2\"");
      expect(content).toContain("Id=\"File_app_exe_1a95c6b2\"");
      expect(content).toContain("Source=\"dist/app.exe\"");
      expect(content).toContain("Id=\"Cmp_libfoo_dll_cfbbbde0\"");
      expect(content).toContain("Id=\"File_libfoo_dll_cfbbbde0\"");
      expect(content).toContain("Source=\"dist/libfoo.dll\"");

      // Check component refs in feature
      expect(content).toContain("<ComponentRef Id=\"Cmp_app_exe_1a95c6b2\"");
      expect(content).toContain("<ComponentRef Id=\"Cmp_libfoo_dll_cfbbbde0\"");

      // Check Win64 attribute
      expect(content).toContain("Win64=\"yes\"");

      // Check MajorUpgrade
      expect(content).toContain("MajorUpgrade");
    });

    it("should sanitize file IDs with special characters", () => {
      const projectDir = path.join(tempDir, "wxs-special");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: InstallerConfig = {
        productName: "test",
        version: "1.0.0",
        packageVersion: "1.0.0",
        manufacturer: "Dev",
        upgradeCode: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
      };

      const files = ["libstdc++-6.dll"];
      const wxsPath = installer.generateWxs(projectDir, config, files);
      const content = fs.readFileSync(wxsPath, "utf-8");

      expect(content).toContain("Id=\"Cmp_libstdc___6_dll_003df130\"");
      expect(content).toContain("Id=\"File_libstdc___6_dll_003df130\"");
      // Original filename preserved in Name attribute
      expect(content).toContain("Name=\"libstdc++-6.dll\"");
    });
  });

  // ── ensureDist() ──────────────────────────────────────────

  describe("ensureDist", () => {
    it("should return true when dist/ exists with files", async () => {
      const projectDir = path.join(tempDir, "has-dist");
      fs.mkdirSync(projectDir, { recursive: true });
      createDistDir(projectDir, ["app.exe"]);

      expect(await installer.ensureDist(projectDir)).toBe(true);
    });

    it("should return false when dist/ is empty", async () => {
      const projectDir = path.join(tempDir, "empty-dist");
      fs.mkdirSync(path.join(projectDir, "dist"), { recursive: true });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      expect(await installer.ensureDist(projectDir)).toBe(false);
      consoleSpy.mockRestore();
    });

    it("should package into the project's own dist/ when it is missing, leaving the working directory's dist untouched", async () => {
      const projectDir = createProjectDir(tempDir, { name: "app-project", version: "1.0.0", author: "Dev" });
      fs.mkdirSync(path.join(projectDir, "src", ".libs"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "Makefile.am"), "bin_PROGRAMS = app\napp_SOURCES = app.cpp\n");
      fs.writeFileSync(path.join(projectDir, "src", ".libs", "app"), "program-content");
      mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });
      // The working directory is left as it is: its own dist/ is only observed
      const cwdDist = path.join(process.cwd(), "dist");
      const before = fs.existsSync(cwdDist) ? fs.statSync(cwdDist).mtimeMs : null;

      const logSpy = jest.spyOn(console, "log").mockImplementation();
      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      let result: boolean;
      try {
        result = await installer.ensureDist(projectDir);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }

      expect(result).toBe(true);
      expect(fs.readFileSync(path.join(projectDir, "dist", "app"), "utf-8")).toBe("program-content");
      expect(fs.existsSync(cwdDist) ? fs.statSync(cwdDist).mtimeMs : null).toBe(before);
    });
  });

  // ── compileMsi() ──────────────────────────────────────────

  describe("compileMsi", () => {
    it("should return true on successful compilation", () => {
      const projectDir = path.join(tempDir, "compile-test");
      fs.mkdirSync(projectDir, { recursive: true });

      const result = installer.compileMsi(projectDir, "test.wxs", "test.msi");
      expect(result).toBe(true);
    });

    it("should return false when wixl fails", () => {
      mockedExecFileSync.mockImplementation((command: string, _args?: readonly string[]) => {
        if (command === "wixl") {
          const err = new Error("wixl failed") as Error & { stderr: Buffer };
          err.stderr = Buffer.from("Compilation error details");
          throw err;
        }
        if (command === "which") {
          return Buffer.from("/usr/bin/wixl\n");
        }
        return Buffer.from("");
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const projectDir = path.join(tempDir, "compile-fail");
      fs.mkdirSync(projectDir, { recursive: true });

      const result = installer.compileMsi(projectDir, "test.wxs", "test.msi");
      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  // ── run() ─────────────────────────────────────────────────

  describe("run", () => {
    it("should fail with status 2 when wixl is not installed", async () => {
      mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
        if (command === "which" && args && args[0] === "wixl") {
          throw new Error("not found");
        }
        return Buffer.from("");
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "1.0.0",
        author: "Dev"
      });

      const result = await installer.run(projectDir);
      expect(result).toEqual({ ok: false, status: 2, message: expect.stringContaining("wixl is not installed") });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("wixl is not installed")
      );
      consoleSpy.mockRestore();
    });

    it("should fail with status 2 when package.json is missing", async () => {
      const emptyDir = path.join(tempDir, "no-pkg");
      fs.mkdirSync(emptyDir, { recursive: true });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = await installer.run(emptyDir);
      expect(result.ok).toBe(false);
      consoleSpy.mockRestore();
    });

    it("should orchestrate full pipeline and resolve the MSI path on success", async () => {
      const projectDir = createProjectDir(tempDir, {
        name: "my-game",
        version: "1.0.0",
        author: "Dev"
      });
      createDistDir(projectDir, ["game.exe", "libengine.dll"]);

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = await installer.run(projectDir);

      expect(result).toEqual({ ok: true, msiPath: path.join(projectDir, "my-game-1.0.0.msi") });

      // Verify .wxs was created
      expect(fs.existsSync(path.join(projectDir, "my-game-1.0.0.wxs"))).toBe(true);

      // Verify wixl was called
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "wixl",
        expect.arrayContaining(["-v", "-a", "x64"]),
        expect.objectContaining({ cwd: projectDir })
      );

      // Verify success message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Installer created")
      );
      consoleSpy.mockRestore();
    });

    describe("when dist/ is missing and packaging is refused", () => {
      /** A program project in tempDir with a Makefile.am and, when content is given, a built src/.libs/app. */
      function writeProgramProject(name: string, dependencies: Record<string, string>, content: string | null): string {
        const dir = path.join(tempDir, name);
        fs.mkdirSync(path.join(dir, "src"), { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
          name: "@t/" + name, version: "1.0.0", author: "Dev", dependencies
        }));
        fs.writeFileSync(path.join(dir, "src", "Makefile.am"), "bin_PROGRAMS = app\napp_SOURCES = app.cpp\n");
        if (content !== null) {
          fs.mkdirSync(path.join(dir, "src", ".libs"), { recursive: true });
          fs.writeFileSync(path.join(dir, "src", ".libs", "app"), content);
        }
        return dir;
      }

      async function runQuietly(projectDir: string): Promise<{ result: Awaited<ReturnType<Installer["run"]>>; errors: string[] }> {
        const logSpy = jest.spyOn(console, "log").mockImplementation();
        const errorSpy = jest.spyOn(console, "error").mockImplementation();
        try {
          const result = await installer.run(projectDir);
          return { result, errors: errorSpy.mock.calls.map((call) => call.map(String).join(" ")) };
        } finally {
          logSpy.mockRestore();
          errorSpy.mockRestore();
        }
      }

      it("stops on a name collision without writing a .wxs or .msi or calling wixl", async () => {
        mockedListDependencies.mockReset();
        mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });
        const other = writeProgramProject("other", {}, "content of other");
        const app = writeProgramProject("app", { "@t/other": "file:../other" }, "content of app");

        const { result, errors } = await runQuietly(app);

        expect(result).toMatchObject({ ok: false, status: 1 });
        const output = errors.join("\n");
        expect(output).toContain("Two different files would be packaged as app:");
        expect(output).toContain("build of @t/app");
        expect(output).toContain("build of @t/other");
        expect(errors[errors.length - 1]).toBe("Error: Packaging failed; no installer was built.");
        expect(output).not.toContain(buildWindowsHint());
        expect(fs.existsSync(path.join(app, "dist"))).toBe(false);
        expect(fs.readdirSync(app).filter((entry) => entry.endsWith(".wxs") || entry.endsWith(".msi"))).toEqual([]);
        expect(fs.readdirSync(other).filter((entry) => entry.endsWith(".wxs") || entry.endsWith(".msi"))).toEqual([]);
        expect(mockedExecFileSync).not.toHaveBeenCalledWith("wixl", expect.anything(), expect.anything());
      });

      it("prints the cross-compiling hint only when no installed binaries are found", async () => {
        mockedListDependencies.mockReset();
        mockedListDependencies.mockReturnValue({ dependencies: {}, errors: {} });
        const app = writeProgramProject("app", {}, null);

        const { result, errors } = await runQuietly(app);

        expect(result).toMatchObject({ ok: false, status: 1 });
        const output = errors.join("\n");
        expect(output).toContain("No installed binaries found for");
        expect(output).toContain(buildWindowsHint());
        expect(output).not.toContain("'the-seed");
        expect(errors[errors.length - 1]).toBe("Error: Packaging failed; no installer was built.");
        expect(mockedExecFileSync).not.toHaveBeenCalledWith("wixl", expect.anything(), expect.anything());
      });
    });
  });
});

// `installer windows` chooses its signing scope before it generates anything. Choices: the configuration has
// the scopes @a and @b; the project is a scratch project with a dist/ directory; "nothing generated" is a
// snapshot of the project directory (no .wxs, no .msi, dist/ unchanged) and of the configuration directory.
describe("installer windows --scope", () => {
  let root: string;
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    root = createTempDir();
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir);
    const scopes: Record<string, { author: { name: string; email: string; url: string } }> = {};
    for (const scope of ["@a", "@b"]) {
      scopes[scope] = { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } };
    }
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(root, "prefix"), scopes }));
    projectDir = createProjectDir(root, { name: "my-game", version: "1.0.0", author: "Dev" });
    createDistDir(projectDir, ["game.exe", "libengine.dll"]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("--scope @nope is refused with status 2 naming it and listing the configured scopes, before anything is generated", async () => {
    const before = [snapshotTree(projectDir), snapshotTree(configDir)];

    const run = await runTheSeed(["installer", "windows", "--scope", "@nope"], { home: root, configDir, cwd: projectDir });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("@nope");
    expect(run.stderr).toContain("@a, @b");
    expect(run.prompts).toEqual([]);
    expect(fs.readdirSync(projectDir).filter((entry) => entry.endsWith(".wxs") || entry.endsWith(".msi"))).toEqual([]);
    expect([snapshotTree(projectDir), snapshotTree(configDir)]).toEqual(before);
  });

  it("two scopes, not interactive and no --scope is a usage error naming --scope, with nothing written", async () => {
    const before = [snapshotTree(projectDir), snapshotTree(configDir)];

    const run = await runTheSeed(["installer", "windows"], { home: root, configDir, cwd: projectDir, interactive: false });

    expect(run.status).toBe(3);
    expect(run.stderr).toContain("--scope");
    expect(run.prompts).toEqual([]);
    expect([snapshotTree(projectDir), snapshotTree(configDir)]).toEqual(before);
  });
});

// The hints `installer windows` prints when it cannot sign: with no scope there is nothing to create a
// certificate for yet, so the hint is the one that adds a scope; with a scope but no certificate it is the
// one that creates the certificate for that scope. The notice may go to either stream, so both are searched.
describe("installer windows signing hints", () => {
  let root: string;
  let configDir: string;
  let projectDir: string;

  function configure(scopes: string[]): void {
    const entries: Record<string, { author: { name: string; email: string; url: string } }> = {};
    for (const scope of scopes) {
      entries[scope] = { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } };
    }
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(root, "prefix"), scopes: entries }));
  }

  beforeEach(() => {
    root = createTempDir();
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir);
    projectDir = createProjectDir(root, { name: "my-game", version: "1.0.0", author: "Dev" });
    createDistDir(projectDir, ["game.exe", "libengine.dll"]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("with no scopes the installer is made unsigned and the add-scope hint is printed", async () => {
    configure([]);

    const run = await runTheSeed(["installer", "windows"], { home: root, configDir, cwd: projectDir, interactive: false });

    expect(run.status).toBe(0);
    const printed = run.stdout + run.stderr;
    expect(printed).toContain(addScopeHint());
    expect(printed).not.toContain("'the-seed");
  });

  it("with a scope that has no certificate the hint creates the certificate for that scope", async () => {
    configure(["@a"]);

    const run = await runTheSeed(["installer", "windows"], { home: root, configDir, cwd: projectDir, interactive: false });

    expect(run.status).toBe(0);
    const printed = run.stdout + run.stderr;
    expect(printed).toContain(createCertHint("@a"));
    expect(printed).not.toContain("'the-seed");
  });
});

describe("Installer without the native component", () => {
  type InstallerModule = typeof import("../src/Installer");
  type ComponentModule = typeof import("../src/NativeComponent");

  let configDir: string;
  let tempDir: string;

  beforeEach(() => {
    configDir = createTempDir();
    tempDir = createTempDir();
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
    // Put the file-wide mock of the component back for any later case
    jest.doMock(nativeComponentPath, () => ({ listDependencies: mockedListDependencies }), { virtual: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a status 2 failure, prints the missing component message and creates nothing in the project", async () => {
    // The file-wide mock of the component is already built; forget it so the absent mock applies
    jest.resetModules();
    const loaded = withoutNativeComponent(() => ({
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
      Installer: (require("../src/Installer") as InstallerModule).default,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the message comes from the same registry
      component: require("../src/NativeComponent") as ComponentModule,
    }));
    const config = new Config(configDir);
    config.config.prefix = path.join(tempDir, "prefix");
    const projectDir = createProjectDir(tempDir, { name: "test-app", version: "1.0.0", author: "Dev" });
    const before = fs.readdirSync(projectDir).sort();
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const result = await new loaded.Installer(config).run(projectDir);
    const printed = consoleSpy.mock.calls.map((call) => String(call[0]));
    consoleSpy.mockRestore();

    expect(result).toEqual({ ok: false, status: 2, message: loaded.component.nativeComponentMessage() });
    expect(printed).toContain(loaded.component.nativeComponentMessage());
    expect(fs.readdirSync(projectDir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(projectDir, "dist"))).toBe(false);
    expect(fs.readdirSync(projectDir).filter((name) => name.endsWith(".wxs") || name.endsWith(".msi"))).toEqual([]);
  });
});

// ── installer metadata ─────────────────────────────────────────────────────────────────────────────

type NewInstallerConfig = InstallerConfig & { packageVersion: string };
type MetadataResult =
  | { ok: true; config: NewInstallerConfig; notes: string[] }
  | { ok: false; message: string; status: number };
type RunResult = { ok: true; msiPath: string } | { ok: false; status: number; message: string };

const realChildProcess = jest.requireActual<typeof import("child_process")>("child_process");

function toolPresent(tool: string): boolean {
  return realChildProcess.spawnSync(tool, ["--version"], { stdio: "ignore" }).error === undefined;
}

function defaultExec(): void {
  mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
    if (command === "which" && args && args[0] === "wixl") {
      return Buffer.from("/usr/bin/wixl\n");
    }
    return Buffer.from("");
  });
}

function elementsNamed(elements: WxsElement[], name: string): WxsElement[] {
  return elements.filter((element) => element.name === name);
}

type Author = string | { name: string };
interface AcceptedCase {
  label: string;
  product: string;
  author: Author;
  manufacturer: string;
  files: string[];
}

const longName = "n".repeat(116) + ".dll";
const acceptedCases: AcceptedCase[] = [
  { label: "plain", product: "hello", author: "Dev", manufacturer: "Dev", files: ["hello.exe"] },
  { label: "accented product, ampersand and angle brackets in the manufacturer", product: "prödüct", author: "Smith & Jones <sales@example.com>", manufacturer: "Smith & Jones <sales@example.com>", files: ["a-b.dll", "a_b.dll"] },
  { label: "ampersand product, object author with quotes", product: "a&b", author: { name: "O'Brien \"Ltd\"" }, manufacturer: "O'Brien \"Ltd\"", files: ["ü&'q.txt"] },
  { label: "apostrophe product, string author with quotes", product: "a'b", author: "O'Brien \"Ltd\"", manufacturer: "O'Brien \"Ltd\"", files: ["x<y>.txt"] },
  { label: "East Asian product, non-Latin manufacturer in object form", product: "東京", author: { name: "Zoë Ωmega 東京" }, manufacturer: "Zoë Ωmega 東京", files: ["東京.dll", longName] },
  { label: "string manufacturer with non-Latin text", product: "hello", author: "Zoë Ωmega 東京", manufacturer: "Zoë Ωmega 東京", files: ["a.dll"] },
  { label: "object manufacturer with a symbol", product: "hello", author: { name: "Smith & Jones <sales@example.com>" }, manufacturer: "Smith & Jones <sales@example.com>", files: ["a.dll"] },
];

describe("installer metadata", () => {
  let tempDir: string;
  let installer: Installer;

  beforeEach(() => {
    tempDir = createTempDir();
    const config = new Config(path.join(tempDir, "config"));
    config.config.prefix = path.join(tempDir, "prefix");
    installer = new Installer(config);
    mockedExecFileSync.mockClear();
    defaultExec();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function metadata(projectDir: string): MetadataResult {
    return installer.readProjectMetadata(projectDir) as unknown as MetadataResult;
  }

  function makeProject(name: string, version: string, author: Author | undefined, files: string[] | null): string {
    const projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const pkg: Record<string, unknown> = { name, version };
    if (author !== undefined) {
      pkg.author = author;
    }
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify(pkg));
    if (files !== null) {
      createDistDir(projectDir, files);
    }
    return projectDir;
  }

  describe("run result", () => {
    it("resolves { ok: true, msiPath } on success", async () => {
      const projectDir = makeProject("hello", "1.0.0", "Dev", ["hello.exe"]);
      jest.spyOn(console, "log").mockImplementation();

      const result = (await installer.run(projectDir)) as unknown as RunResult;

      expect(result).toEqual({ ok: true, msiPath: path.join(projectDir, "hello-1.0.0.msi") });
    });

    it("resolves a status 2 failure, printed once, when wixl is missing, before the metadata is read", async () => {
      mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
        if (command === "which" && args && args[0] === "wixl") {
          throw new Error("not found");
        }
        return Buffer.from("");
      });
      const projectDir = makeProject("hello", "1.0", "Dev", null);
      const before = snapshotTree(projectDir);
      const errors = jest.spyOn(console, "error").mockImplementation();

      const result = (await installer.run(projectDir)) as unknown as RunResult;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(2);
        expect(result.message).toContain("wixl");
        expect(errors.mock.calls.filter((call) => String(call[0]).includes(result.message))).toHaveLength(1);
      }
      expect(snapshotTree(projectDir)).toEqual(before);
    });

    it("resolves a status 2 failure, printed once, for a missing package.json", async () => {
      const emptyDir = path.join(tempDir, "no-pkg");
      fs.mkdirSync(emptyDir);
      const errors = jest.spyOn(console, "error").mockImplementation();

      const result = (await installer.run(emptyDir)) as unknown as RunResult;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(2);
        expect(errors.mock.calls.filter((call) => String(call[0]).includes(result.message))).toHaveLength(1);
      }
      expect(fs.readdirSync(emptyDir)).toEqual([]);
    });

    it("resolves a status 1 failure, printed once, when wixl fails to compile", async () => {
      mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
        if (command === "which" && args && args[0] === "wixl") {
          return Buffer.from("/usr/bin/wixl\n");
        }
        if (command === "wixl") {
          throw Object.assign(new Error("wixl failed"), { stderr: Buffer.from("bad description") });
        }
        return Buffer.from("");
      });
      const projectDir = makeProject("hello", "1.0.0", "Dev", ["hello.exe"]);
      jest.spyOn(console, "log").mockImplementation();
      const errors = jest.spyOn(console, "error").mockImplementation();

      const result = (await installer.run(projectDir)) as unknown as RunResult;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(1);
        expect(errors.mock.calls.filter((call) => String(call[0]).includes(result.message))).toHaveLength(1);
      }
    });

    it("resolves a one-line status 1 failure naming wixl and the signal when wixl is killed by a signal", async () => {
      mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
        if (command === "which" && args && args[0] === "wixl") {
          return Buffer.from("/usr/bin/wixl\n");
        }
        if (command === "wixl") {
          throw Object.assign(new Error("Command failed: wixl"), { signal: "SIGSEGV", status: null, stderr: Buffer.from("") });
        }
        return Buffer.from("");
      });
      const projectDir = makeProject("hello", "1.0.0", "Dev", ["hello.exe"]);
      jest.spyOn(console, "log").mockImplementation();
      const errors = jest.spyOn(console, "error").mockImplementation();

      const result = (await installer.run(projectDir)) as unknown as RunResult;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(1);
        expect(result.message).toBe("Error: wixl was killed by signal SIGSEGV while compiling the installer");
        expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([result.message]);
      }
    });

    it("resolves a status 2 failure naming the value for a refused version, without printing it twice", async () => {
      const projectDir = makeProject("hello", "256.0.0", "Dev", null);
      const errors = jest.spyOn(console, "error").mockImplementation();

      const result = (await installer.run(projectDir)) as unknown as RunResult;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(2);
        expect(result.message).toContain("256.0.0");
        expect(errors.mock.calls.filter((call) => String(call[0]).includes("256.0.0"))).toHaveLength(1);
      }
      expect(fs.existsSync(path.join(projectDir, "dist"))).toBe(false);
    });
  });

  describe("readProjectMetadata", () => {
    it("returns the installer version with three numbers and the full package version", () => {
      const projectDir = makeProject("hello", "1.2.3", "Dev", null);
      const log = jest.spyOn(console, "log").mockImplementation();
      const error = jest.spyOn(console, "error").mockImplementation();

      const result = metadata(projectDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.version).toBe("1.2.3");
        expect(result.config.packageVersion).toBe("1.2.3");
        expect(result.config.productName).toBe("hello");
        expect(result.config.manufacturer).toBe("Dev");
        expect(result.notes).toEqual([]);
      }
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it("drops a prerelease from the installer version, keeps it in the package version and returns the note", () => {
      const projectDir = makeProject("hello", "2.1.0-beta.3", "Dev", null);

      const result = metadata(projectDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.version).toBe("2.1.0");
        expect(result.config.packageVersion).toBe("2.1.0-beta.3");
        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]).toContain("Installer version 2.1.0 (from 2.1.0-beta.3");
      }
    });

    it("accepts the largest installer version", () => {
      const result = metadata(makeProject("hello", "255.255.65535", "Dev", null));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.version).toBe("255.255.65535");
      }
    });

    const refusedVersions: Array<[string, string]> = [
      ["1.0", "valid version"],
      ["1.0.0.0", "valid version"],
      ["01.0.0", "valid version"],
      ["v1.0.0", "valid version"],
      ["1.0.0-", "valid version"],
      ["256.0.0", "above 255"],
      ["0.256.0", "above 255"],
      ["0.0.65536", "above 65535"],
    ];
    it.each(refusedVersions)("refuses the version %j naming it and the problem, printing nothing", (version, limit) => {
      const projectDir = makeProject("hello", version, "Dev", null);
      const before = snapshotTree(projectDir);
      const log = jest.spyOn(console, "log").mockImplementation();
      const error = jest.spyOn(console, "error").mockImplementation();

      const result = metadata(projectDir);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(2);
        expect(result.message).toContain("\"" + version + "\"");
        expect(result.message).toContain(limit);
      }
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(snapshotTree(projectDir)).toEqual(before);
    });

    const refusedProducts = ["a<b", "a:b", "a\"b", "a|b", "a?b", "a*b", "a\\b", "name.", "name ", "CON", "nul.txt"];
    it.each(refusedProducts)("refuses the product name %j naming it", (name) => {
      const projectDir = makeProject(name, "1.0.0", "Dev", null);
      const error = jest.spyOn(console, "error").mockImplementation();

      const result = metadata(projectDir);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(2);
        expect(result.message).toContain("\"" + name + "\"");
      }
      expect(error).not.toHaveBeenCalled();
    });

    it.each<[string, Author]>([
      ["a string manufacturer", "Bad\u0001Maker"],
      ["an object manufacturer", { name: "Bad\u0001Maker" }],
    ])("refuses %s holding U+0001", (_label, author) => {
      const result = metadata(makeProject("hello", "1.0.0", author, null));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(2);
        expect(result.message).toContain("U+0001");
      }
    });

    it("refuses a missing package.json, invalid JSON and a missing name without printing", () => {
      const error = jest.spyOn(console, "error").mockImplementation();
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir);
      expect(metadata(emptyDir).ok).toBe(false);

      const brokenDir = path.join(tempDir, "broken");
      fs.mkdirSync(brokenDir);
      fs.writeFileSync(path.join(brokenDir, "package.json"), "{ not json");
      expect(metadata(brokenDir).ok).toBe(false);

      const unnamedDir = path.join(tempDir, "unnamed");
      fs.mkdirSync(unnamedDir);
      fs.writeFileSync(path.join(unnamedDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
      const unnamed = metadata(unnamedDir);
      expect(unnamed.ok).toBe(false);
      if (!unnamed.ok) {
        expect(unnamed.status).toBe(2);
      }
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("generateWxs", () => {
    describe.each(acceptedCases)("$label", (accepted) => {
      function generate(): { projectDir: string; wxsPath: string; elements: WxsElement[] } {
        const projectDir = makeProject(accepted.product, "1.0.0", accepted.author, accepted.files);
        const result = metadata(projectDir);
        if (!result.ok) {
          throw new Error("metadata refused: " + result.message);
        }
        const wxsPath = installer.generateWxs(projectDir, result.config, accepted.files);
        return { projectDir, wxsPath, elements: readWxs(fs.readFileSync(wxsPath, "utf-8")) };
      }

      it("reads back exactly through the independent reader, under the package version's file name", () => {
        const { wxsPath, elements } = generate();

        expect(path.basename(wxsPath)).toBe(accepted.product + "-1.0.0.wxs");
        const product = elementsNamed(elements, "Product")[0];
        expect(product.attributes.Name).toBe(accepted.product);
        expect(product.attributes.Manufacturer).toBe(accepted.manufacturer);
        expect(product.attributes.Version).toBe("1.0.0");
        const folder = elementsNamed(elements, "Directory").find((element) => element.attributes.Id === "INSTALLFOLDER");
        expect(folder?.attributes.Name).toBe(accepted.product);
        expect(elementsNamed(elements, "Feature")[0].attributes.Title).toBe(accepted.product);
        const files = elementsNamed(elements, "File");
        expect(files.map((file) => file.attributes.Name)).toEqual(accepted.files);
        expect(files.map((file) => file.attributes.Source)).toEqual(accepted.files.map((name) => "dist/" + name));
      });

      it("gives every file and component its own identifier, each referenced by the feature", () => {
        const { elements } = generate();

        const fileIds = elementsNamed(elements, "File").map((file) => file.attributes.Id);
        const componentIds = elementsNamed(elements, "Component").map((component) => component.attributes.Id);
        const references = elementsNamed(elements, "ComponentRef").map((ref) => ref.attributes.Id);
        expect(new Set(fileIds).size).toBe(accepted.files.length);
        expect(new Set(componentIds).size).toBe(accepted.files.length);
        expect(references).toEqual(componentIds);
        for (const id of [...fileIds, ...componentIds]) {
          expect(id.length).toBeLessThanOrEqual(72);
          expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.]*$/);
        }
      });

      it("is accepted by xmllint when present", () => {
        if (!optionalExternalCheck("xmllint", toolPresent("xmllint"), "xmllint is not installed")) {
          return;
        }
        const { wxsPath } = generate();
        expect(() => realChildProcess.execFileSync("xmllint", ["--noout", wxsPath], { stdio: "pipe" })).not.toThrow();
      });

      // wixl 0.106 segfaults inside libmsi on text that mixes Windows-1252 letters (such as "ë") with
      // other scripts (such as "東"). The .wxs is valid XML (the xmllint and reader cases above check it), so that
      // is a wixl defect, not the tool's. Those inputs are decided by their text, never compiled, and the cases
      // above still check them.
      const text = [accepted.product, accepted.manufacturer, ...accepted.files].join("");
      const mixesScripts = /[\u0080-\u00FF]/.test(text) && /[\u0100-\uFFFF]/.test(text);

      if (!mixesScripts) {
        it("compiles with wixl to the package version's file name when present", () => {
          if (!optionalExternalCheck("wixl", toolPresent("wixl"), "wixl is not installed")) {
            return;
          }
          const { projectDir, wxsPath } = generate();
          const msiPath = path.join(projectDir, accepted.product + "-1.0.0.msi");
          realChildProcess.execFileSync("wixl", ["-a", "x64", "-o", msiPath, wxsPath], { cwd: projectDir, stdio: "pipe" });
          expect(fs.existsSync(msiPath)).toBe(true);
        });
      }
    });

    it("writes both a-b.dll and a_b.dll with distinct identifiers", () => {
      const projectDir = makeProject("hello", "1.0.0", "Dev", ["a-b.dll", "a_b.dll"]);
      const result = metadata(projectDir);
      if (!result.ok) {
        throw new Error(result.message);
      }
      const elements = readWxs(fs.readFileSync(installer.generateWxs(projectDir, result.config, ["a-b.dll", "a_b.dll"]), "utf-8"));
      const names = elementsNamed(elements, "File").map((file) => file.attributes.Name);
      expect(names).toEqual(["a-b.dll", "a_b.dll"]);
      const ids = elementsNamed(elements, "File").map((file) => file.attributes.Id);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it("keeps the full package version in the file name and the three numbers in the description", () => {
      const projectDir = makeProject("hello", "2.1.0-beta.3", "Dev", ["hello.exe"]);
      const result = metadata(projectDir);
      if (!result.ok) {
        throw new Error(result.message);
      }
      const wxsPath = installer.generateWxs(projectDir, result.config, ["hello.exe"]);
      expect(path.basename(wxsPath)).toBe("hello-2.1.0-beta.3.wxs");
      expect(elementsNamed(readWxs(fs.readFileSync(wxsPath, "utf-8")), "Product")[0].attributes.Version).toBe("2.1.0");
    });

    it("refuses a value XML cannot carry, writing nothing", () => {
      const projectDir = makeProject("hello", "1.0.0", "Dev", ["hello.exe"]);
      const config = {
        productName: "hello",
        version: "1.0.0",
        packageVersion: "1.0.0",
        manufacturer: "Bad\u0001Maker",
        upgradeCode: "12345678-1234-5678-9ABC-DEF012345678",
      } as unknown as InstallerConfig;
      const before = snapshotTree(projectDir);

      expect(() => installer.generateWxs(projectDir, config, ["hello.exe"])).toThrow(/U\+0001/);
      expect(snapshotTree(projectDir)).toEqual(before);
    });
  });

  describe("run with a version that drops a suffix", () => {
    it("prints the note once on standard output and names the files with the package version", async () => {
      const projectDir = makeProject("hello", "2.1.0-beta.3", "Dev", ["hello.exe"]);
      const log = jest.spyOn(console, "log").mockImplementation();

      const result = (await installer.run(projectDir)) as unknown as RunResult;

      expect(result).toEqual({ ok: true, msiPath: path.join(projectDir, "hello-2.1.0-beta.3.msi") });
      const notes = log.mock.calls.filter((call) => String(call[0]).includes("Installer version 2.1.0 (from 2.1.0-beta.3"));
      expect(notes).toHaveLength(1);
      expect(fs.existsSync(path.join(projectDir, "hello-2.1.0-beta.3.wxs"))).toBe(true);
      const product = elementsNamed(readWxs(fs.readFileSync(path.join(projectDir, "hello-2.1.0-beta.3.wxs"), "utf-8")), "Product")[0];
      expect(product.attributes.Version).toBe("2.1.0");
    });

    it("prints no note for a plain version", async () => {
      const projectDir = makeProject("hello", "1.0.0", "Dev", ["hello.exe"]);
      const log = jest.spyOn(console, "log").mockImplementation();

      await installer.run(projectDir);

      expect(log.mock.calls.filter((call) => String(call[0]).includes("Installer version"))).toHaveLength(0);
    });
  });
});

// Refusals seen through the command line: the status, the message and that nothing was written.
describe("installer windows refusals", () => {
  let root: string;
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    root = createTempDir();
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir);
    const scopes = { "@a": { author: { name: "Signer", email: "signer@example.com", url: "" } } };
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(root, "prefix"), scopes }));
    projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir);
    mockedExecFileSync.mockClear();
    defaultExec();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writePackage(name: string, version: string, author = "Dev"): void {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name, version, author }));
  }

  async function install(): Promise<Awaited<ReturnType<typeof runTheSeed>>> {
    return runTheSeed(["installer", "windows", "--scope", "@a"], { home: root, configDir, cwd: projectDir, interactive: false });
  }

  function linesHolding(text: string, value: string): string[] {
    return text.split("\n").filter((line) => line.includes(value));
  }

  const refusedVersions: Array<[string, string]> = [
    ["1.0", "not a valid version"],
    ["1.0.0.0", "not a valid version"],
    ["01.0.0", "not a valid version"],
    ["v1.0.0", "not a valid version"],
    ["1.0.0-", "not a valid version"],
    ["256.0.0", "above 255"],
    ["0.256.0", "above 255"],
    ["0.0.65536", "above 65535"],
  ];
  it.each(refusedVersions)("version %j gives status 2 naming the value and the limit, and writes nothing", async (version, limit) => {
    writePackage("hello", version);
    const before = snapshotTree(projectDir);

    const run = await install();

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(limit);
    expect(linesHolding(run.stderr, "\"" + version + "\"")).toHaveLength(1);
    expect(snapshotTree(projectDir)).toEqual(before);
  });

  const refusedProducts = ["a<b", "a:b", "a\"b", "a|b", "a?b", "a*b", "a\\b", "name.", "name ", "CON", "nul.txt"];
  it.each(refusedProducts)("product name %j gives status 2 naming the name, and writes nothing", async (name) => {
    writePackage(name, "1.0.0");
    const before = snapshotTree(projectDir);

    const run = await install();

    expect(run.status).toBe(2);
    expect(linesHolding(run.stderr, "\"" + name + "\"")).toHaveLength(1);
    expect(snapshotTree(projectDir)).toEqual(before);
  });

  it("a manufacturer holding U+0001 gives status 2 naming the character, and writes nothing", async () => {
    writePackage("hello", "1.0.0", "Bad\u0001Maker");
    const before = snapshotTree(projectDir);

    const run = await install();

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("U+0001");
    expect(snapshotTree(projectDir)).toEqual(before);
  });

  it("wixl missing gives status 2 and writes nothing", async () => {
    writePackage("hello", "1.0.0");
    mockedExecFileSync.mockImplementation((command: string, args?: readonly string[]) => {
      if (command === "which" && args && args[0] === "wixl") {
        throw new Error("not found");
      }
      return Buffer.from("");
    });
    const before = snapshotTree(projectDir);

    const run = await install();

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("wixl");
    expect(linesHolding(run.stderr, "wixl is not installed")).toHaveLength(1);
    expect(snapshotTree(projectDir)).toEqual(before);
  });

  it("the native component missing gives status 2 and writes nothing", async () => {
    writePackage("hello", "1.0.0");
    type RunModule = typeof import("./helpers/RunCli");
    type ComponentModule = typeof import("../src/NativeComponent");
    jest.resetModules();
    const isolated = withoutNativeComponent(() => ({
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for this case
      run: (require("./helpers/RunCli") as RunModule).runTheSeed,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the message comes from the same registry
      component: require("../src/NativeComponent") as ComponentModule,
    }));
    const before = snapshotTree(projectDir);
    try {
      const run = await isolated.run(["installer", "windows", "--scope", "@a"], { home: root, configDir, cwd: projectDir, interactive: false });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(isolated.component.nativeComponentMessage());
      expect(snapshotTree(projectDir)).toEqual(before);
    } finally {
      jest.dontMock(nativeComponentPath);
      jest.doMock(nativeComponentPath, () => ({ listDependencies: mockedListDependencies }), { virtual: true });
    }
  });
});
