import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { requiredLibTheSeedVersion } from "../src/Dependencies";
import { librarySearchEnv } from "../src/LibrarySearch";
import { optionalExternalCheck } from "./helpers/ExternalTools";

interface PrefixResolution {
  prefix: string;
  source: "configuration" | "default";
  configPath: string;
  note: string | null;
}

interface PkgConfigModule {
  resolvePrefix: (home?: string) => PrefixResolution;
  searchEnv: (prefix: string, inherited?: NodeJS.ProcessEnv) => Record<string, string>;
  requiredVersion: (bindingGypText?: string) => string;
}

const nativeDir = path.join(__dirname, "..", "native");
const helperPath = path.join(nativeDir, "pkg-config.js");

function loadPkgConfig(): PkgConfigModule {
  return jest.requireActual<PkgConfigModule>("../native/pkg-config.js");
}

const scratchDirs: string[] = [];

function scratch(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-build-" + label + "-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(home: string, text: string): string {
  const configPath = path.join(home, "the-seed", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, text);
  return configPath;
}

function writePc(dir: string, version: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "the-seed.pc"), [
    "Name: the-seed",
    "Description: scratch description of the library",
    "Version: " + version,
    "Libs:",
    "Cflags:",
    ""
  ].join("\n"));
}

function prefixPcDir(prefix: string): string {
  return path.join(prefix, "x86_64-linux-gnu", "lib", "pkgconfig");
}

function pkgConfigAvailable(): boolean {
  const result = spawnSync("pkg-config", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function runHelper(home: string, extraEnv: Record<string, string>, args: string[] = ["--modversion", "the-seed"]) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    ...extraEnv
  };
  return spawnSync(process.execPath, [helperPath, ...args], { encoding: "utf8", env });
}

describe("native/pkg-config.js resolvePrefix", () => {
  it("falls back to the default prefix without writing anything when there is no configuration", () => {
    const home = scratch("home");
    const result = loadPkgConfig().resolvePrefix(home);
    const configPath = path.join(home, "the-seed", "config.json");
    expect(result.prefix).toBe(path.join(home, "the-seed"));
    expect(result.source).toBe("default");
    expect(result.configPath).toBe(configPath);
    expect(result.note).toBe(configPath + " not found");
    expect(fs.existsSync(path.join(home, "the-seed"))).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("uses the prefix from the configuration", () => {
    const home = scratch("home");
    const configPath = writeConfig(home, JSON.stringify({ prefix: "/opt/somewhere" }));
    const result = loadPkgConfig().resolvePrefix(home);
    expect(result).toEqual({ prefix: "/opt/somewhere", source: "configuration", configPath, note: null });
  });

  it("uses the default without a note when the configuration has no prefix", () => {
    const home = scratch("home");
    const configPath = writeConfig(home, JSON.stringify({ scopes: {} }));
    const result = loadPkgConfig().resolvePrefix(home);
    expect(result).toEqual({ prefix: path.join(home, "the-seed"), source: "default", configPath, note: null });
  });

  it.each([
    ["invalid JSON", "{ not json", "is not valid JSON"],
    ["an array", "[1, 2]", "must hold a JSON object"],
    ["an empty prefix", JSON.stringify({ prefix: "" }), "\"prefix\" must be a non-empty text value"],
    ["a numeric prefix", JSON.stringify({ prefix: 12 }), "\"prefix\" must be a non-empty text value"]
  ])("uses the default with a note for %s", (_label, text, wording) => {
    const home = scratch("home");
    const configPath = writeConfig(home, text);
    const result = loadPkgConfig().resolvePrefix(home);
    expect(result.prefix).toBe(path.join(home, "the-seed"));
    expect(result.source).toBe("default");
    expect(result.note).not.toBeNull();
    expect(result.note?.startsWith(configPath)).toBe(true);
    expect(result.note).toContain(wording);
    expect(fs.readFileSync(configPath, "utf8")).toBe(text);
  });
});

describe("native/pkg-config.js searchEnv", () => {
  it.each([
    ["absent", {}],
    ["set", { PKG_CONFIG_PATH: "/one:/two" }],
    ["empty", { PKG_CONFIG_PATH: "" }]
  ])("equals the shared search environment when PKG_CONFIG_PATH is %s", (_label, inherited) => {
    const prefix = "/scratch/prefix";
    expect(loadPkgConfig().searchEnv(prefix, inherited)).toEqual(librarySearchEnv(prefix, "native", inherited));
  });

  it("puts the prefix first", () => {
    const env = loadPkgConfig().searchEnv("/p", { PKG_CONFIG_PATH: "/user" });
    expect(env.PKG_CONFIG_PATH).toBe("/p/x86_64-linux-gnu/lib/pkgconfig:/user");
  });
});

describe("native/pkg-config.js command", () => {
  it("finds the library in the configured prefix with no PKG_CONFIG_PATH", () => {
    if (!optionalExternalCheck("pkg-config", pkgConfigAvailable(), "pkg-config is not installed")) {
      return;
    }
    const home = scratch("home");
    const prefix = scratch("prefix");
    writeConfig(home, JSON.stringify({ prefix }));
    writePc(prefixPcDir(prefix), "9.9.9");
    const result = runHelper(home, {});
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("9.9.9");
    expect(result.status).toBe(0);
  });

  it("prefers the prefix over PKG_CONFIG_PATH", () => {
    if (!optionalExternalCheck("pkg-config", pkgConfigAvailable(), "pkg-config is not installed")) {
      return;
    }
    const home = scratch("home");
    const prefix = scratch("prefix");
    const other = scratch("other");
    writeConfig(home, JSON.stringify({ prefix }));
    writePc(prefixPcDir(prefix), "8.8.8");
    writePc(other, "9.9.9");
    const result = runHelper(home, { PKG_CONFIG_PATH: other });
    expect(result.stdout.trim()).toBe("8.8.8");
    expect(result.status).toBe(0);
  });

  it("falls back to the system directories when the prefix is empty", () => {
    if (!optionalExternalCheck("pkg-config", pkgConfigAvailable(), "pkg-config is not installed")) {
      return;
    }
    const home = scratch("home");
    const prefix = scratch("prefix");
    const system = scratch("system");
    writeConfig(home, JSON.stringify({ prefix }));
    writePc(system, "9.9.9");
    const result = runHelper(home, { PKG_CONFIG_LIBDIR: system });
    expect(result.stdout.trim()).toBe("9.9.9");
    expect(result.status).toBe(0);
  });

  it("passes on pkg-config's own status and error when the library is found nowhere", () => {
    if (!optionalExternalCheck("pkg-config", pkgConfigAvailable(), "pkg-config is not installed")) {
      return;
    }
    const home = scratch("home");
    const prefix = scratch("prefix");
    const empty = scratch("empty");
    writeConfig(home, JSON.stringify({ prefix }));
    const result = runHelper(home, { PKG_CONFIG_LIBDIR: empty });
    const direct = spawnSync("pkg-config", ["--modversion", "the-seed"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, PKG_CONFIG_LIBDIR: empty, PKG_CONFIG_PATH: prefixPcDir(prefix) }
    });
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(direct.status);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(direct.stderr);
    expect(result.stderr).toContain("the-seed");
  });
});

describe("native/pkg-config.js requiredVersion", () => {
  it("equals the version the installer requires", () => {
    expect(loadPkgConfig().requiredVersion()).toBe(requiredLibTheSeedVersion);
  });

  it("reads the constraint from the text given", () => {
    expect(loadPkgConfig().requiredVersion("'<!@(pkg-config --cflags \\'the-seed >= 1.2.3\\')'")).toBe("1.2.3");
  });
});
