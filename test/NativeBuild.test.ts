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

type PrerequisiteName = "compiler" | "make" | "python3" | "pkg-config" | "node-gyp" | "node-addon-api" | "libthe-seed";

interface Prerequisite {
  name: PrerequisiteName;
  state: "present" | "missing" | "too-old";
  detail: string;
  found: string | null;
}

interface BuildReport {
  built: boolean;
  libraryVersion: string | null;
  libraryDir: string | null;
  missing: Prerequisite[];
  buildOutput: string | null;
  prefix: PrefixResolution;
  packageRoot: string;
  requiredVersion: string;
}

interface PkgConfigResult {
  status: number | null;
  stdout: string;
}

interface Probes {
  env: NodeJS.ProcessEnv;
  requiredVersion: string;
  which: (command: string) => string | null;
  runs: (command: string, args: string[]) => boolean;
  exists: (file: string) => boolean;
  resolveModule: (name: string, paths: string[]) => string | null;
  pkgConfig: (args: string[]) => PkgConfigResult;
}

interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

interface RunnerResult {
  status: number | null;
  output: string;
}

interface TerminalWriter {
  write: (text: string) => void;
  close?: () => void;
}

interface RunOptions {
  install?: boolean;
  nativeDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  probes?: Probes;
  runner?: (invocation: Invocation) => RunnerResult | Promise<RunnerResult>;
  stdout?: { write: (text: string) => void; isTTY?: boolean };
  openTerminal?: () => TerminalWriter | null;
}

interface BuildModule {
  checkPrerequisites: (probes: Probes) => Prerequisite[];
  renderReport: (report: BuildReport) => string;
  run: (options: RunOptions) => number | Promise<number>;
}

function loadBuild(): BuildModule {
  return jest.requireActual<BuildModule>("../native/build.js");
}

const required = "0.8.0";
const root = path.resolve(__dirname, "..");
const step = "cd \"" + root + "\" && npm run build-addon";

function probesFor(overrides: Partial<Probes> = {}): Probes {
  return {
    env: {},
    requiredVersion: required,
    which: () => null,
    runs: () => false,
    exists: () => false,
    resolveModule: () => null,
    pkgConfig: () => ({ status: 1, stdout: "" }),
    ...overrides
  };
}

function presentProbes(overrides: Partial<Probes> = {}): Probes {
  return probesFor({
    which: (command) => "/usr/bin/" + command,
    runs: () => true,
    exists: () => true,
    resolveModule: (name) => "/modules/" + name,
    pkgConfig: (args) => {
      if (args.includes("--modversion")) {
        return { status: 0, stdout: required + "\n" };
      }
      if (args.some((arg) => arg.startsWith("--variable=libdir"))) {
        return { status: 0, stdout: "/the/libdir\n" };
      }
      return { status: 0, stdout: "" };
    },
    ...overrides
  });
}

const names: PrerequisiteName[] = ["compiler", "make", "python3", "pkg-config", "node-gyp", "node-addon-api", "libthe-seed"];

function prefixResolution(overrides: Partial<PrefixResolution> = {}): PrefixResolution {
  return {
    prefix: "/the/prefix",
    source: "configuration",
    configPath: "/home/u/the-seed/config.json",
    note: null,
    ...overrides
  };
}

function missingEntry(name: PrerequisiteName, state: "missing" | "too-old" = "missing", detail = "", found: string | null = null): Prerequisite {
  return { name, state, detail, found };
}

function reportOf(overrides: Partial<BuildReport> = {}): BuildReport {
  return {
    built: false,
    libraryVersion: null,
    libraryDir: null,
    missing: [],
    buildOutput: null,
    prefix: prefixResolution(),
    packageRoot: root,
    requiredVersion: required,
    ...overrides
  };
}

function makeNativeDir(withStale: boolean): string {
  const base = scratch("native");
  const dir = path.join(base, "native");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "binding.gyp"), "{}\n");
  if (withStale) {
    fs.mkdirSync(path.join(dir, "build", "Release"), { recursive: true });
    fs.writeFileSync(path.join(dir, "build", "Release", "x.node"), "stale");
  }
  return dir;
}

function collector(): { text: () => string; write: (text: string) => void } {
  const chunks: string[] = [];
  return { text: () => chunks.join(""), write: (text: string) => { chunks.push(text); } };
}

const failingRunner = (output = "make: *** [x] Error 1"): ((invocation: Invocation) => RunnerResult) => () => ({ status: 2, output });

describe("native/build.js checkPrerequisites", () => {
  it("lists every prerequisite in order, all missing, when every probe finds nothing", () => {
    const result = loadBuild().checkPrerequisites(probesFor());
    expect(result.map((item) => item.name)).toEqual(names);
    expect(result.every((item) => item.state === "missing")).toBe(true);
  });

  it("reports libthe-seed missing without a version when pkg-config itself is missing", () => {
    const result = loadBuild().checkPrerequisites(presentProbes({
      which: (command) => (command === "pkg-config" ? null : "/usr/bin/" + command)
    }));
    const missing = result.filter((item) => item.state !== "present");
    expect(missing.map((item) => item.name)).toEqual(["pkg-config", "libthe-seed"]);
    expect(missing[1].state).toBe("missing");
    expect(missing[1].found).toBeNull();
  });

  it("reports every prerequisite present when all probes succeed", () => {
    const result = loadBuild().checkPrerequisites(presentProbes());
    expect(result.map((item) => item.name)).toEqual(names);
    expect(result.every((item) => item.state === "present")).toBe(true);
  });

  it("names the CXX setting in the detail when the compiler it points to is missing", () => {
    const result = loadBuild().checkPrerequisites(presentProbes({
      env: { CXX: "/nonexistent/c++" },
      which: (command) => (command === "/nonexistent/c++" ? null : "/usr/bin/" + command)
    }));
    const compiler = result.find((item) => item.name === "compiler");
    expect(compiler?.state).toBe("missing");
    expect(compiler?.detail).toContain("$CXX=/nonexistent/c++");
  });

  it("tries c++ and then g++ when CXX is not set", () => {
    const tried: string[] = [];
    const result = loadBuild().checkPrerequisites(presentProbes({
      runs: (command) => {
        tried.push(command);
        return command === "g++";
      }
    }));
    expect(tried.indexOf("c++")).toBeGreaterThanOrEqual(0);
    expect(tried.indexOf("c++")).toBeLessThan(tried.indexOf("g++"));
    expect(result.find((item) => item.name === "compiler")?.state).toBe("present");
  });

  it("uses the first word of CXX as the compiler", () => {
    const asked: string[] = [];
    loadBuild().checkPrerequisites(presentProbes({
      env: { CXX: "ccache g++ -std=c++17" },
      runs: (command) => {
        asked.push(command);
        return true;
      }
    }));
    expect(asked).toContain("ccache");
    expect(asked).not.toContain("c++");
  });

  it("takes node-gyp from npm_config_node_gyp when that file exists", () => {
    const result = loadBuild().checkPrerequisites(presentProbes({
      env: { npm_config_node_gyp: "/npm/node-gyp-bin/node-gyp.js" },
      which: (command) => (command === "node-gyp" ? null : "/usr/bin/" + command),
      exists: (file) => file === "/npm/node-gyp-bin/node-gyp.js"
    }));
    expect(result.find((item) => item.name === "node-gyp")?.state).toBe("present");
  });

  it("resolves node-addon-api from the native directory", () => {
    const seen: Array<{ name: string; paths: string[] }> = [];
    loadBuild().checkPrerequisites(presentProbes({
      resolveModule: (name, paths) => {
        seen.push({ name, paths });
        return "/modules/" + name;
      }
    }));
    expect(seen.length).toBe(1);
    expect(seen[0].name).toBe("node-addon-api");
    expect(seen[0].paths).toEqual([nativeDir]);
  });

  it("reports a library older than required as too-old with the version found and the version required", () => {
    if (!optionalExternalCheck("pkg-config", pkgConfigAvailable(), "pkg-config is not installed")) {
      return;
    }
    const pcDir = scratch("pc");
    const empty = scratch("empty");
    writePc(pcDir, "0.7.0");
    const real = (args: string[]): PkgConfigResult => {
      const result = spawnSync("pkg-config", args, {
        encoding: "utf8",
        env: { PATH: process.env.PATH, PKG_CONFIG_LIBDIR: empty, PKG_CONFIG_PATH: pcDir }
      });
      return { status: result.status, stdout: result.stdout || "" };
    };
    const result = loadBuild().checkPrerequisites(presentProbes({ pkgConfig: real }));
    const library = result.find((item) => item.name === "libthe-seed");
    expect(library?.state).toBe("too-old");
    expect(library?.found).toBe("0.7.0");
    expect(library?.detail).toContain("found 0.7.0");
    expect(library?.detail).toContain(required);
    expect(result.filter((item) => item.state !== "present").map((item) => item.name)).toEqual(["libthe-seed"]);
  });
});

describe("native/build.js renderReport", () => {
  it("renders the built report as one line", () => {
    const text = loadBuild().renderReport(reportOf({ built: true, libraryVersion: "0.8.0", libraryDir: "/the/libdir" }));
    expect(text.split("\n")).toEqual(["the-seed: native component built against libthe-seed 0.8.0 (/the/libdir)."]);
  });

  it("renders every missing prerequisite, the prefix with its source, and the step", () => {
    const text = loadBuild().renderReport(reportOf({
      missing: [
        missingEntry("compiler", "missing", "tried $CXX=/x/c++"),
        missingEntry("make"),
        missingEntry("python3"),
        missingEntry("pkg-config"),
        missingEntry("node-gyp"),
        missingEntry("node-addon-api"),
        missingEntry("libthe-seed")
      ]
    }));
    expect(text.split("\n")).toEqual([
      "the-seed: the native component was not built.",
      "  Missing: a C++ compiler (tried $CXX=/x/c++)",
      "  Missing: make",
      "  Missing: python3",
      "  Missing: pkg-config",
      "  Missing: node-gyp (it comes with npm)",
      "  Missing: node-addon-api (reinstall the package)",
      "  Missing: libthe-seed " + required + " or later (not found)",
      "  Searched for libthe-seed in: /the/prefix/x86_64-linux-gnu/lib/pkgconfig (prefix from /home/u/the-seed/config.json), then PKG_CONFIG_PATH, then the system directories.",
      "  Every other command works. Commands that need the native component: signing and verifying Windows programs, Mac programs and installers, package, installer, Windows builds.",
      "  To build it: install what is missing (run \"the-seed dependencies install\" for libthe-seed), then: " + step
    ]);
  });

  it("renders a too-old library with the version found", () => {
    const text = loadBuild().renderReport(reportOf({
      missing: [missingEntry("libthe-seed", "too-old", "found 0.7.0, 0.8.0 or later required", "0.7.0")]
    }));
    expect(text.split("\n")).toContain("  Missing: libthe-seed " + required + " or later (found 0.7.0)");
  });

  it("renders the default prefix with the reason it was used", () => {
    const configPath = "/home/u/the-seed/config.json";
    const text = loadBuild().renderReport(reportOf({
      missing: [missingEntry("libthe-seed")],
      prefix: prefixResolution({ prefix: "/home/u/the-seed", source: "default", note: configPath + " not found" })
    }));
    expect(text.split("\n")).toContain(
      "  Searched for libthe-seed in: /home/u/the-seed/x86_64-linux-gnu/lib/pkgconfig (default prefix: " + configPath + " not found), then PKG_CONFIG_PATH, then the system directories."
    );
  });

  it("renders the default prefix without a reason when there is no configuration to explain", () => {
    const text = loadBuild().renderReport(reportOf({
      missing: [missingEntry("libthe-seed")],
      prefix: prefixResolution({ prefix: "/home/u/the-seed", source: "default", note: null })
    }));
    expect(text.split("\n")).toContain(
      "  Searched for libthe-seed in: /home/u/the-seed/x86_64-linux-gnu/lib/pkgconfig (default prefix: no configuration), then PKG_CONFIG_PATH, then the system directories."
    );
  });

  it("renders a build failure with the compiler output indented", () => {
    const text = loadBuild().renderReport(reportOf({ buildOutput: "first line\nsecond line" }));
    const lines = text.split("\n");
    expect(lines[0]).toBe("the-seed: the native component was not built.");
    const at = lines.indexOf("  Build failed:");
    expect(at).toBe(1);
    expect(lines.slice(at + 1, at + 3)).toEqual(["    first line", "    second line"]);
    expect(lines.some((line) => line.startsWith("  Missing:"))).toBe(false);
    expect(lines[lines.length - 1]).toContain("then: " + step);
  });
});

describe("native/build.js run", () => {
  it("with install, removes the earlier component, prints the report and exits 0 after a failed build", async () => {
    const nativeDirCopy = makeNativeDir(true);
    const home = scratch("home");
    const out = collector();
    const calls: Invocation[] = [];
    let staleAtCall: boolean | null = null;
    const status = await loadBuild().run({
      install: true,
      nativeDir: nativeDirCopy,
      home,
      env: {},
      probes: presentProbes(),
      stdout: { write: out.write, isTTY: false },
      openTerminal: () => null,
      runner: (invocation) => {
        calls.push(invocation);
        staleAtCall = fs.existsSync(path.join(nativeDirCopy, "build"));
        return { status: 2, output: "error: something broke" };
      }
    });
    expect(status).toBe(0);
    expect(calls.length).toBe(1);
    expect(staleAtCall).toBe(false);
    expect(fs.existsSync(path.join(nativeDirCopy, "build"))).toBe(false);
    expect(out.text()).toContain("the-seed: the native component was not built.");
    expect(out.text()).toContain("  Build failed:");
    expect(out.text()).toContain("error: something broke");
    expect(out.text().endsWith("\n")).toBe(true);
  });

  it("without install, exits 1 after a failed build", async () => {
    const nativeDirCopy = makeNativeDir(false);
    const out = collector();
    const status = await loadBuild().run({
      install: false,
      nativeDir: nativeDirCopy,
      home: scratch("home"),
      env: {},
      probes: presentProbes(),
      stdout: { write: out.write, isTTY: false },
      openTerminal: () => null,
      runner: failingRunner()
    });
    expect(status).toBe(1);
  });

  it("without install, exits 1 when a prerequisite is missing and does not run the build", async () => {
    const nativeDirCopy = makeNativeDir(false);
    const out = collector();
    let called = false;
    const status = await loadBuild().run({
      install: false,
      nativeDir: nativeDirCopy,
      home: scratch("home"),
      env: {},
      probes: presentProbes({ which: (command) => (command === "make" ? null : "/usr/bin/" + command) }),
      stdout: { write: out.write, isTTY: false },
      openTerminal: () => null,
      runner: () => {
        called = true;
        return { status: 0, output: "" };
      }
    });
    expect(status).toBe(1);
    expect(called).toBe(false);
    expect(out.text()).toContain("  Missing: make");
  });

  it("without install, exits 0 and reports success when the build leaves the component", async () => {
    const nativeDirCopy = makeNativeDir(false);
    const out = collector();
    const status = await loadBuild().run({
      install: false,
      nativeDir: nativeDirCopy,
      home: scratch("home"),
      env: {},
      probes: presentProbes(),
      stdout: { write: out.write, isTTY: false },
      openTerminal: () => null,
      runner: () => {
        fs.mkdirSync(path.join(nativeDirCopy, "build", "Release"), { recursive: true });
        fs.writeFileSync(path.join(nativeDirCopy, "build", "Release", "dependency_lister.node"), "built");
        return { status: 0, output: "ok" };
      }
    });
    expect(status).toBe(0);
    expect(out.text()).toBe("the-seed: native component built against libthe-seed " + required + " (/the/libdir).\n");
  });

  it("with install and every prerequisite missing, removes the earlier component and runs no build", async () => {
    const nativeDirCopy = makeNativeDir(true);
    const out = collector();
    let called = false;
    const status = await loadBuild().run({
      install: true,
      nativeDir: nativeDirCopy,
      home: scratch("home"),
      env: {},
      probes: probesFor(),
      stdout: { write: out.write, isTTY: false },
      openTerminal: () => null,
      runner: () => {
        called = true;
        return { status: 0, output: "" };
      }
    });
    expect(status).toBe(0);
    expect(called).toBe(false);
    expect(fs.existsSync(path.join(nativeDirCopy, "build"))).toBe(false);
    for (const label of ["a C++ compiler", "make", "python3", "pkg-config", "node-gyp", "node-addon-api", "libthe-seed"]) {
      expect(out.text()).toContain("  Missing: " + label);
    }
  });

  it("runs node-gyp rebuild with --jobs=4 and --directory, without MAKEFLAGS and MFLAGS, searching the prefix", async () => {
    const nativeDirCopy = makeNativeDir(false);
    const home = scratch("home");
    const prefix = scratch("prefix");
    writeConfig(home, JSON.stringify({ prefix }));
    const calls: Invocation[] = [];
    await loadBuild().run({
      install: false,
      nativeDir: nativeDirCopy,
      home,
      env: { PATH: "/usr/bin", MAKEFLAGS: "-j16", MFLAGS: "-j16", PKG_CONFIG_PATH: "/user/pc", KEEP: "yes" },
      probes: presentProbes(),
      stdout: { write: () => undefined, isTTY: false },
      openTerminal: () => null,
      runner: (invocation) => {
        calls.push(invocation);
        return { status: 1, output: "" };
      }
    });
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.args).toContain("rebuild");
    expect(call.args).toContain("--jobs=4");
    expect(call.args).toContain("--directory=" + nativeDirCopy);
    expect("MAKEFLAGS" in call.env).toBe(false);
    expect("MFLAGS" in call.env).toBe(false);
    expect(call.env.PKG_CONFIG_PATH).toBe(prefixPcDir(prefix) + ":/user/pc");
    expect(call.env.KEEP).toBe("yes");
  });

  it("keeps only the last 20 lines of the build output in the report", async () => {
    const nativeDirCopy = makeNativeDir(false);
    const out = collector();
    const lines = Array.from({ length: 30 }, (_value, index) => "output line " + (index + 1));
    await loadBuild().run({
      install: true,
      nativeDir: nativeDirCopy,
      home: scratch("home"),
      env: {},
      probes: presentProbes(),
      stdout: { write: out.write, isTTY: false },
      openTerminal: () => null,
      runner: failingRunner(lines.join("\n"))
    });
    const printed = out.text().split("\n");
    expect(printed).not.toContain("    output line 10");
    expect(printed).toContain("    output line 11");
    expect(printed).toContain("    output line 30");
    expect(printed.filter((line) => line.startsWith("    output line ")).length).toBe(20);
  });

  describe("terminal copy", () => {
    async function runWith(options: { install: boolean; isTTY: boolean; terminal: TerminalWriter | null }): Promise<{ stdout: string; opened: number }> {
      const out = collector();
      let opened = 0;
      await loadBuild().run({
        install: options.install,
        nativeDir: makeNativeDir(false),
        home: scratch("home"),
        env: {},
        probes: presentProbes(),
        stdout: { write: out.write, isTTY: options.isTTY },
        openTerminal: () => {
          opened++;
          return options.terminal;
        },
        runner: failingRunner()
      });
      return { stdout: out.text(), opened };
    }

    it("writes the report to the terminal too, with install, when standard output is not a terminal", async () => {
      const terminal = collector();
      const result = await runWith({ install: true, isTTY: false, terminal });
      expect(terminal.text()).toBe(result.stdout);
      expect(terminal.text()).toContain("the-seed: the native component was not built.");
    });

    it("does not write to the terminal when standard output is itself a terminal", async () => {
      const terminal = collector();
      const result = await runWith({ install: true, isTTY: true, terminal });
      expect(terminal.text()).toBe("");
      expect(result.stdout).toContain("the-seed: the native component was not built.");
    });

    it("does not open the terminal without install", async () => {
      const terminal = collector();
      const result = await runWith({ install: false, isTTY: false, terminal });
      expect(result.opened).toBe(0);
      expect(terminal.text()).toBe("");
    });

    it("carries on with standard output alone when the terminal cannot be opened", async () => {
      const result = await runWith({ install: true, isTTY: false, terminal: null });
      expect(result.stdout).toContain("the-seed: the native component was not built.");
    });
  });
});
