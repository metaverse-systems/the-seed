import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Installer, { sanitizeId, generateUpgradeCode, InstallerConfig } from "../src/Installer";
import { ScriptArgsType } from "../src/types";

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

const { execFileSync: mockedExecFileSync } = require("child_process") as {
  execFileSync: jest.MockedFunction<typeof import("child_process").execFileSync>;
};

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
      expect(result).not.toBeNull();
      expect(result!.productName).toBe("my-game");
      expect(result!.version).toBe("1.2.3.0");
      expect(result!.manufacturer).toBe("Test Author");
      expect(result!.upgradeCode).toBe(generateUpgradeCode("my-game"));
    });

    it("should convert 3-part version to 4-part", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "2.0.1",
        author: "Dev"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result!.version).toBe("2.0.1.0");
    });

    it("should handle author as object with name", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "1.0.0",
        author: { name: "Object Author" }
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result!.manufacturer).toBe("Object Author");
    });

    it("should default manufacturer to Unknown when author is missing", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "test-app",
        version: "1.0.0"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result!.manufacturer).toBe("Unknown");
    });

    it("should return null when package.json is missing", () => {
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = installer.readProjectMetadata(emptyDir);
      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it("should return null when name is missing", () => {
      const projectDir = path.join(tempDir, "no-name");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({ version: "1.0.0" })
      );

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = installer.readProjectMetadata(projectDir);
      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it("should strip npm scope prefix from product name", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "@metaverse-systems/client",
        version: "0.0.1",
        author: "Test"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result).not.toBeNull();
      expect(result!.productName).toBe("client");
      expect(result!.version).toBe("0.0.1.0");
      // UpgradeCode should use the full scoped name for determinism
      expect(result!.upgradeCode).toBe(generateUpgradeCode("@metaverse-systems/client"));
    });

    it("should handle scoped names with nested scope", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "@org/my-app",
        version: "2.0.0",
        author: "Dev"
      });

      const result = installer.readProjectMetadata(projectDir);
      expect(result!.productName).toBe("my-app");
    });
  });

  // ── generateWxs() ────────────────────────────────────────

  describe("generateWxs", () => {
    it("should produce valid XML structure with correct elements", () => {
      const projectDir = path.join(tempDir, "wxs-test");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: InstallerConfig = {
        productName: "test-app",
        version: "1.0.0.0",
        manufacturer: "Test Dev",
        upgradeCode: "12345678-1234-5678-9ABC-DEF012345678"
      };

      const files = ["app.exe", "libfoo.dll"];
      const wxsPath = installer.generateWxs(projectDir, config, files);

      expect(fs.existsSync(wxsPath)).toBe(true);
      expect(path.basename(wxsPath)).toBe("test-app-1.0.0.0.wxs");

      const content = fs.readFileSync(wxsPath, "utf-8");

      // Check XML declaration
      expect(content).toContain('<?xml version="1.0" encoding="utf-8"?>');

      // Check Product element attributes
      expect(content).toContain('Name="test-app"');
      expect(content).toContain('Version="1.0.0.0"');
      expect(content).toContain('Manufacturer="Test Dev"');
      expect(content).toContain('UpgradeCode="12345678-1234-5678-9ABC-DEF012345678"');

      // Check Package element
      expect(content).toContain('InstallScope="perMachine"');
      expect(content).toContain('Platform="x64"');

      // Check directory structure
      expect(content).toContain('ProgramFiles64Folder');
      expect(content).toContain('Name="test-app"');

      // Check components for each file
      expect(content).toContain('Id="Cmp_app_exe"');
      expect(content).toContain('Id="File_app_exe"');
      expect(content).toContain('Source="dist/app.exe"');
      expect(content).toContain('Id="Cmp_libfoo_dll"');
      expect(content).toContain('Id="File_libfoo_dll"');
      expect(content).toContain('Source="dist/libfoo.dll"');

      // Check component refs in feature
      expect(content).toContain('<ComponentRef Id="Cmp_app_exe"');
      expect(content).toContain('<ComponentRef Id="Cmp_libfoo_dll"');

      // Check Win64 attribute
      expect(content).toContain('Win64="yes"');

      // Check MajorUpgrade
      expect(content).toContain("MajorUpgrade");
    });

    it("should sanitize file IDs with special characters", () => {
      const projectDir = path.join(tempDir, "wxs-special");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: InstallerConfig = {
        productName: "test",
        version: "1.0.0.0",
        manufacturer: "Dev",
        upgradeCode: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
      };

      const files = ["libstdc++-6.dll"];
      const wxsPath = installer.generateWxs(projectDir, config, files);
      const content = fs.readFileSync(wxsPath, "utf-8");

      expect(content).toContain('Id="Cmp_libstdc___6_dll"');
      expect(content).toContain('Id="File_libstdc___6_dll"');
      // Original filename preserved in Name attribute
      expect(content).toContain('Name="libstdc++-6.dll"');
    });
  });

  // ── ensureDist() ──────────────────────────────────────────

  describe("ensureDist", () => {
    it("should return true when dist/ exists with files", () => {
      const projectDir = path.join(tempDir, "has-dist");
      fs.mkdirSync(projectDir, { recursive: true });
      createDistDir(projectDir, ["app.exe"]);

      expect(installer.ensureDist(projectDir)).toBe(true);
    });

    it("should return false when dist/ is empty", () => {
      const projectDir = path.join(tempDir, "empty-dist");
      fs.mkdirSync(path.join(projectDir, "dist"), { recursive: true });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      expect(installer.ensureDist(projectDir)).toBe(false);
      consoleSpy.mockRestore();
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
    it("should return false when wixl is not installed", () => {
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

      const result = installer.run(projectDir);
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("wixl is not installed")
      );
      consoleSpy.mockRestore();
    });

    it("should return false when package.json is missing", () => {
      const emptyDir = path.join(tempDir, "no-pkg");
      fs.mkdirSync(emptyDir, { recursive: true });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const result = installer.run(emptyDir);
      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });

    it("should orchestrate full pipeline and return true on success", () => {
      const projectDir = createProjectDir(tempDir, {
        name: "my-game",
        version: "1.0.0",
        author: "Dev"
      });
      createDistDir(projectDir, ["game.exe", "libengine.dll"]);

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const result = installer.run(projectDir);

      expect(result).toBe(true);

      // Verify .wxs was created
      expect(fs.existsSync(path.join(projectDir, "my-game-1.0.0.0.wxs"))).toBe(true);

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
  });
});
