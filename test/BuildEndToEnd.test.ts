import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Config from "../src/Config";
import Build from "../src/Build";
import Signing from "../src/Signing";
import { buildRecursive } from "../src/RecursiveBuild";
import { findOnPath } from "../src/ProcessRunner";
import { installLib } from "../src/Dependencies";
import { WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS } from "../src/LibrarySearch";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { copyFixture } from "./helpers/Fixture";
import { findSystemOnlyPackage, writePackageDescription } from "./helpers/SystemPackage";

// Real autotools, make and a C compiler build the fixture in test/fixtures/autotools-tiny with 50 MB of
// compile output. Every case has its own copy of the fixture, its own install prefix and a scratch home
// whose config.json names that prefix; nothing outside the temporary directory is touched. Compile jobs
// are limited to 4 wherever the build accepts a job limit.

const NOISE = 52428800;
const TAIL_BYTES = 65536;
const JOBS = 4;
const CASE_TIMEOUT = 120000;

const ENV_KEYS = ["HOME", "PKG_CONFIG", "SEED_TEST_REQUIRES", "SEED_TEST_NOISE", "SEED_TEST_FAIL", "SEED_TEST_INSTALL_FAIL", "PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "MAKEFLAGS", "MFLAGS"];

/** Switches the fixture reads; a value inherited from the developer's shell must not reach a build. */
const FIXTURE_SWITCHES = ["SEED_TEST_NOISE", "SEED_TEST_FAIL", "SEED_TEST_INSTALL_FAIL", "SEED_TEST_REQUIRES"];

const toolsAvailable = ["autoreconf", "make", "cc"].every((tool) => findOnPath(tool) !== null);

/** Remembers how much output went by and the last bytes of it, so 50 MB never has to be held. */
class TailSink {
  total = 0;
  private tail = Buffer.alloc(0);

  private keep(chunk: Buffer): void {
    this.total += chunk.length;
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > TAIL_BYTES) {
      this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
    }
  }

  stdout = (chunk: Buffer): void => this.keep(chunk);
  stderr = (chunk: Buffer): void => this.keep(chunk);

  tailText(): string {
    return this.tail.toString();
  }
}

describe("BuildEndToEnd", () => {
  let root: string;
  let projectDir: string;
  let prefix: string;
  let nativePrefix: string;
  let home: string;
  let configDir: string;
  let savedEnv: Record<string, string | undefined>;
  let logSpy: jest.SpyInstance;
  let homedirSpy: jest.SpyInstance;

  /** The environment passed to builds: PKG_CONFIG_PATH is removed because the hosted job exports its own. */
  function caseEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of FIXTURE_SWITCHES) {
      delete env[key];
    }
    Object.assign(env, vars);
    delete env.PKG_CONFIG_PATH;
    delete env.PKG_CONFIG_LIBDIR;
    delete env.MAKEFLAGS;
    delete env.MFLAGS;
    // A libtool cross build of a library runs winepath, and wine writes menu files under the
    // configuration home; both homes are the case's scratch home, never the process's.
    env.HOME = home;
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    return env;
  }

  /** Recursive builds read the process environment, so the case's values are set there for its duration. */
  function useProcessEnv(vars: Record<string, string>): void {
    for (const key of ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "MAKEFLAGS", "MFLAGS", ...FIXTURE_SWITCHES]) {
      delete process.env[key];
    }
    Object.assign(process.env, vars);
  }

  function installedTiny(): string {
    return path.join(nativePrefix, "bin", "tiny");
  }

  function runInstalledTiny(): string {
    const run = spawnSync(installedTiny(), [], { encoding: "utf-8" });
    return run.stdout;
  }

  /** Configures the copy by hand, so an incremental build has a tree to rebuild. */
  function prepareConfiguredTree(): void {
    const env = caseEnv({});
    for (const [program, args] of [
      ["./autogen.sh", []],
      ["./configure", ["--prefix=" + nativePrefix]],
    ] as Array<[string, string[]]>) {
      const run = spawnSync(program, args, { cwd: projectDir, env, encoding: "utf-8" });
      if (run.status !== 0) {
        throw new Error(program + " failed while preparing the case: " + run.stderr);
      }
    }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-e2e-"));
    projectDir = path.join(root, "project");
    prefix = path.join(root, "prefix");
    nativePrefix = path.join(prefix, "x86_64-linux-gnu");
    home = path.join(root, "home");
    configDir = path.join(home, "the-seed");
    copyFixture(projectDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix, scopes: {} }));
    // Properties are set one by one, never the whole object: os.homedir() reads the real environment.
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = home;
    // Jest gives the test its own copy of process.env, so os.homedir() (which buildRecursive reads for its
    // Config) does not see HOME; it is pointed at the scratch home directly.
    homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(home);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    homedirSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function plainBuild(sink: TailSink, vars: Record<string, string>) {
    const build = new Build(new Config(configDir));
    return build.buildProject({
      projectDir,
      target: "native",
      release: false,
      jobs: JOBS,
      configDir,
      env: caseEnv(vars),
      output: sink,
      log: () => undefined,
    });
  }

  function incrementalBuild(sink: TailSink, vars: Record<string, string>) {
    const build = new Build(new Config(configDir));
    return build.buildProject({
      projectDir,
      release: false,
      jobs: JOBS,
      configDir,
      env: caseEnv(vars),
      output: sink,
      log: () => undefined,
    });
  }

  function recursiveBuild() {
    // jobs is not known to every version of the options type; the object is built apart so it is accepted either way.
    const options = {
      target: "native",
      fullReconfigure: true,
      projectDir,
      release: false,
      jobs: JOBS,
    };
    return buildRecursive(options);
  }

  it("plain build with 50 MB of compile output succeeds and installs", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    const sink = new TailSink();

    const result = await plainBuild(sink, { SEED_TEST_NOISE: String(NOISE) });

    expect(result).toEqual({ status: "completed" });
    expect(sink.total).toBeGreaterThan(NOISE);
    expect(runInstalledTiny()).toContain("tiny ok");
  }, CASE_TIMEOUT);

  it("incremental build with 50 MB of output succeeds", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    prepareConfiguredTree();
    const sink = new TailSink();

    const result = await incrementalBuild(sink, { SEED_TEST_NOISE: String(NOISE) });

    expect(result).toEqual({ status: "completed" });
    expect(sink.total).toBeGreaterThan(NOISE);
    expect(runInstalledTiny()).toContain("tiny ok");
  }, CASE_TIMEOUT);

  it("recursive build with 50 MB of output succeeds", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    useProcessEnv({ SEED_TEST_NOISE: String(NOISE), HOME: home });

    const result = await recursiveBuild();

    expect(result.success).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(runInstalledTiny()).toContain("tiny ok");
  }, CASE_TIMEOUT);

  it("plain build with 50 MB of output that fails reports failure at compile with the end of the output visible", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    const sink = new TailSink();

    const result = await plainBuild(sink, { SEED_TEST_NOISE: String(NOISE), SEED_TEST_FAIL: "1" });

    expect(result.status).toBe("failed");
    expect((result as { step: string }).step).toBe("compile");
    expect((result as { message: string }).message).toMatch(/exited with status \d+$/);
    expect(sink.total).toBeGreaterThan(NOISE);
    expect(sink.tailText()).toContain("tiny: deliberate failure");
    expect(fs.existsSync(installedTiny())).toBe(false);
  }, CASE_TIMEOUT);

  it("incremental build with 50 MB of output that fails reports failure at compile with the end of the output visible", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    prepareConfiguredTree();
    const sink = new TailSink();

    const result = await incrementalBuild(sink, { SEED_TEST_NOISE: String(NOISE), SEED_TEST_FAIL: "1" });

    expect(result.status).toBe("failed");
    expect((result as { step: string }).step).toBe("compile");
    expect(sink.total).toBeGreaterThan(NOISE);
    expect(sink.tailText()).toContain("tiny: deliberate failure");
    expect(fs.existsSync(installedTiny())).toBe(false);
  }, CASE_TIMEOUT);

  it("recursive build with 50 MB of output that fails reports failure at compile with the end of the output visible", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    useProcessEnv({ SEED_TEST_NOISE: String(NOISE), SEED_TEST_FAIL: "1", HOME: home });

    const result = await recursiveBuild();

    expect(result.success).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].step).toBe("compile");
    // The failure block keeps the whole output; the error line is in the last part of it
    const output = result.failureOutput ?? "";
    expect(output.length).toBeGreaterThan(NOISE);
    expect(output.slice(-4096)).toContain("tiny: deliberate failure");
    expect(fs.existsSync(installedTiny())).toBe(false);
  }, CASE_TIMEOUT);

  // The fixture's make recipe prints a MAKEFLAGS: line, so the job limit make was started with is visible.
  function makeflagsLine(sink: TailSink): string {
    const line = sink.tailText().split("\n").find((text) => text.startsWith("MAKEFLAGS:"));
    expect(line).toBeDefined();
    return line as string;
  }

  it("the compile step runs with the default job limit", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    // The processor count is mocked to 4 so that the default is the real build's limit without a 16-job build.
    const processorSpy = jest
      .spyOn(os as unknown as { availableParallelism: () => number }, "availableParallelism")
      .mockReturnValue(4);
    const sink = new TailSink();
    try {
      const build = new Build(new Config(configDir));
      const result = await build.buildProject({
        projectDir,
        target: "native",
        release: false,
        configDir,
        env: caseEnv({}),
        output: sink,
        log: () => undefined,
      });

      expect(result).toEqual({ status: "completed" });
    } finally {
      processorSpy.mockRestore();
    }
    expect(makeflagsLine(sink)).toMatch(/^MAKEFLAGS:.* -j4( |$)/);
    expect(runInstalledTiny()).toContain("tiny ok");
  }, CASE_TIMEOUT);

  it("with MAKEFLAGS=-j64 inherited the tool's limit wins", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    const sink = new TailSink();
    const build = new Build(new Config(configDir));

    const result = await build.buildProject({
      projectDir,
      target: "native",
      release: false,
      jobs: JOBS,
      configDir,
      env: { ...caseEnv({}), MAKEFLAGS: "-j64" },
      output: sink,
      log: () => undefined,
    });

    expect(result).toEqual({ status: "completed" });
    const line = makeflagsLine(sink);
    expect(line).toMatch(/^MAKEFLAGS:.* -j4( |$)/);
    expect(line).not.toContain("-j64");
  }, CASE_TIMEOUT);

  // Paths with a space, a quote, parentheses, a semicolon, a glob character and a percent sign in them.
  // Every one of them must reach every program as it is: nothing is split, expanded or unquoted on the way.
  // Choice: no double quote, dollar sign, ampersand or backtick, because autoconf refuses them in the
  // working directory ("unsafe absolute working directory name") and make expands a dollar sign or breaks
  // on a double quote in the prefix. Those characters are covered where no autotools program is involved:
  // the argument and environment assertions in the Dependencies, Build and StepRunner cases.
  const SPECIAL_PROJECT = "proj q (x);y %z";
  const SPECIAL_PREFIX = "prefix 'q (x);y *z ~";
  const releaseToolsAvailable = ["strip", "file"].every((tool) => findOnPath(tool) !== null);
  const gitAvailable = findOnPath("git") !== null;

  /** Every path below dir, relative to it, sorted; symbolic links are listed, not followed. */
  function listTree(dir: string): string[] {
    const found: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        found.push(path.relative(dir, full));
        if (entry.isDirectory()) {
          walk(full);
        }
      }
    };
    walk(dir);
    return found.sort();
  }

  interface Places {
    home: string;
    tmp: string;
    cwd: string;
  }

  /** Moves the case to the special-character project and prefix; returns where nothing may appear. */
  function useSpecialPaths(): { places: Places; snapshot: () => Record<keyof Places, string[]> } {
    projectDir = path.join(root, SPECIAL_PROJECT);
    prefix = path.join(root, SPECIAL_PREFIX);
    nativePrefix = path.join(prefix, "x86_64-linux-gnu");
    copyFixture(projectDir);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix, scopes: {} }));
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    process.env.TMPDIR = tmp;
    const places: Places = { home, tmp, cwd: process.cwd() };
    const snapshot = () => ({
      home: listTree(places.home),
      tmp: listTree(places.tmp),
      cwd: fs.readdirSync(places.cwd).sort(),
    });
    return { places, snapshot };
  }

  /** The prefix the installed program lives in is exactly the requested one, and nothing else was created. */
  function expectNothingElse(before: Record<keyof Places, string[]>, after: Record<keyof Places, string[]>): void {
    expect(after.home).toEqual(before.home);
    expect(after.tmp).toEqual(before.tmp);
    expect(after.cwd).toEqual(before.cwd);
    // Directly under the case's directory only the fixed places, the project and the prefix exist.
    const allowed = ["home", "project", "tmp", SPECIAL_PROJECT, SPECIAL_PREFIX];
    expect(fs.readdirSync(root).filter((name) => !allowed.includes(name))).toEqual([]);
  }

  function savedTmpdir(): () => void {
    const saved = process.env.TMPDIR;
    return () => {
      if (saved === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = saved;
      }
    };
  }

  it("plain native build from a project directory and into a prefix named with space, ', ;, (, *, ~ installs at exactly that prefix", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    const restoreTmp = savedTmpdir();
    try {
      const { snapshot } = useSpecialPaths();
      const before = snapshot();
      const sink = new TailSink();

      const result = await plainBuild(sink, {});

      expect(result).toEqual({ status: "completed" });
      expect(installedTiny()).toBe(path.join(root, SPECIAL_PREFIX, "x86_64-linux-gnu", "bin", "tiny"));
      expect(fs.existsSync(installedTiny())).toBe(true);
      expect(runInstalledTiny()).toContain("tiny ok");
      expectNothingElse(before, snapshot());
    } finally {
      restoreTmp();
    }
  }, CASE_TIMEOUT);

  it("release build strips the installed program in that directory", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable && releaseToolsAvailable, "autoreconf, make, cc, strip or file not found")) return;
    const restoreTmp = savedTmpdir();
    try {
      const { snapshot } = useSpecialPaths();
      const before = snapshot();
      const sink = new TailSink();
      const build = new Build(new Config(configDir));

      const result = await build.buildProject({
        projectDir,
        target: "native",
        release: true,
        jobs: JOBS,
        configDir,
        env: caseEnv({}),
        output: sink,
        log: () => undefined,
      });

      expect(result).toEqual({ status: "completed" });
      // The program installed in the prefix, not only the one built in the project directory, is stripped
      const installedDescription = spawnSync("file", ["--brief", installedTiny()], { encoding: "utf-8" }).stdout;
      expect(installedTiny()).toBe(path.join(prefix, "x86_64-linux-gnu", "bin", "tiny"));
      expect(installedDescription).toContain("stripped");
      expect(installedDescription).not.toContain("not stripped");
      expect(runInstalledTiny()).toContain("tiny ok");
      expectNothingElse(before, snapshot());
    } finally {
      restoreTmp();
    }
  }, CASE_TIMEOUT);

  it("incremental build in that directory succeeds", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    const restoreTmp = savedTmpdir();
    try {
      const { snapshot } = useSpecialPaths();
      prepareConfiguredTree();
      const before = snapshot();
      const sink = new TailSink();

      const result = await incrementalBuild(sink, {});

      expect(result).toEqual({ status: "completed" });
      expect(runInstalledTiny()).toContain("tiny ok");
      expectNothingElse(before, snapshot());
    } finally {
      restoreTmp();
    }
  }, CASE_TIMEOUT);

  it("recursive build in that directory succeeds", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable, "autoreconf, make or cc not found")) return;
    const restoreTmp = savedTmpdir();
    try {
      const { snapshot } = useSpecialPaths();
      useProcessEnv({ HOME: home });
      const before = snapshot();

      const result = await recursiveBuild();

      expect(result.success).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(runInstalledTiny()).toContain("tiny ok");
      expectNothingElse(before, snapshot());
    } finally {
      restoreTmp();
    }
  }, CASE_TIMEOUT);

  it("installLib clones a local repository and installs into the prefix with special characters", async () => {
    if (!optionalExternalCheck("build-end-to-end", toolsAvailable && gitAvailable, "autoreconf, make, cc or git not found")) return;
    const restoreTmp = savedTmpdir();
    try {
      const { snapshot } = useSpecialPaths();
      // A repository made from the fixture, outside the project and the prefix; no network is used.
      const repository = path.join(root, "tmp", "source repo");
      copyFixture(repository);
      const gitIn = (args: string[]) => {
        const run = spawnSync("git", args, { cwd: repository, encoding: "utf-8", env: caseEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }) });
        if (run.status !== 0) {
          throw new Error("git " + args.join(" ") + " failed while preparing the case: " + run.stderr);
        }
      };
      gitIn(["init", "--quiet"]);
      gitIn(["add", "-A"]);
      gitIn(["-c", "user.name=Seed Test", "-c", "user.email=seed@example.invalid", "commit", "--quiet", "-m", "fixture"]);
      // An absolute directory inside the case, so nothing is cloned into the Jest working directory.
      const installDir = path.join(root, "tmp", "clone dir (x);y");
      const before = snapshot();
      useProcessEnv({ HOME: home });
      const config = new Config(configDir);

      const installed = await installLib(config, repository, installDir, "native", { jobs: JOBS });

      expect(installed).toBe(true);
      expect(fs.existsSync(path.join(installDir, ".git"))).toBe(true);
      expect(fs.existsSync(installedTiny())).toBe(true);
      expect(runInstalledTiny()).toContain("tiny ok");
      // Only the clone directory is new under tmp; home and the working directory are unchanged.
      const after = snapshot();
      expect(after.home).toEqual(before.home);
      expect(after.cwd).toEqual(before.cwd);
      expect(after.tmp.filter((entry) => !before.tmp.includes(entry) && !entry.startsWith(path.basename(installDir)))).toEqual([]);
    } finally {
      restoreTmp();
    }
  }, CASE_TIMEOUT);

  describe("strip and sign", () => {
    const SCOPE = "@t";
    const windowsPrefix = () => path.join(prefix, "x86_64-w64-mingw32");
    const mingwAvailable = ["x86_64-w64-mingw32-gcc", "x86_64-w64-mingw32-strip", "x86_64-w64-mingw32-objdump"].every((tool) => findOnPath(tool) !== null);
    const mingwReason = "x86_64-w64-mingw32-gcc, x86_64-w64-mingw32-strip or x86_64-w64-mingw32-objdump not found";
    const GROUP_TIMEOUT = CASE_TIMEOUT * 2;
    let signing: Signing;

    beforeEach(async () => {
      // A scratch certificate for the scope, in the scratch home; the project belongs to that scope and has the libraries
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ prefix, scopes: { [SCOPE]: { author: { name: "Test User", email: "t@example.invalid", url: "" } } } })
      );
      signing = new Signing(configDir);
      await signing.createCert({ validityDays: 365, scope: SCOPE });
      fs.rmSync(projectDir, { recursive: true, force: true });
      copyFixture(projectDir, { withLibrary: true, packageName: "@t/tiny" });
    });

    function fullBuild(target: "native" | "windows", release: boolean) {
      // buildProject gets its environment as an option; the process environment is cleared of the same names as well
      useProcessEnv({ HOME: home });
      return new Build(new Config(configDir)).buildProject({
        projectDir,
        target,
        release,
        jobs: JOBS,
        configDir,
        env: caseEnv({}),
        output: new TailSink(),
        log: () => undefined,
      });
    }

    function describeFile(file: string): string {
      return spawnSync("file", ["--brief", file], { encoding: "utf-8" }).stdout;
    }

    function expectStripped(file: string): void {
      const described = describeFile(file);
      expect([file, described.includes("stripped")]).toEqual([file, true]);
      expect([file, described.includes("not stripped")]).toEqual([file, false]);
    }

    function expectNotStripped(file: string): void {
      expect([file, describeFile(file).includes("not stripped")]).toEqual([file, true]);
    }

    async function expectValid(file: string, type: "embedded" | "detached"): Promise<void> {
      const result = await signing.verifyFile(file);
      expect([file, result.status, result.reason]).toEqual([file, "VALID", undefined]);
      expect([file, result.signatureType]).toEqual([file, type]);
    }

    const nativeLibraries = () => ["libtinygreet.so.0.0.0", "libtinyrelink.so.0.0.0"].map((name) => path.join(nativePrefix, "lib", name));
    const nativeLinkNames = () => ["libtinygreet.so.0", "libtinygreet.so", "libtinyrelink.so.0", "libtinyrelink.so"].map((name) => path.join(nativePrefix, "lib", name));
    const windowsFiles = () => ["tiny.exe", "libtinygreet-0.dll", "libtinyrelink-0.dll"].map((name) => path.join(windowsPrefix(), "bin", name));

    it("native release build strips and signs the installed program and library", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && releaseToolsAvailable, "autoreconf, make, cc, strip or file not found")) return;

      const result = await fullBuild("native", true);

      expect(result).toEqual({ status: "completed" });
      const installed = [installedTiny(), ...nativeLibraries()];
      for (const file of installed) {
        expectStripped(file);
        await expectValid(file, "detached");
      }
      // Every name of a library verifies, not only the real file
      for (const link of nativeLinkNames()) {
        expect([link, fs.lstatSync(link).isSymbolicLink()]).toEqual([link, true]);
        await expectValid(link, "detached");
      }
      expect(runInstalledTiny()).toContain("tiny library ok");
    }, GROUP_TIMEOUT);

    it("windows release build strips and signs the installed program and DLL", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && mingwAvailable, mingwReason)) return;

      const result = await fullBuild("windows", true);

      expect(result).toEqual({ status: "completed" });
      for (const file of windowsFiles()) {
        const sections = spawnSync("x86_64-w64-mingw32-objdump", ["-h", file], { encoding: "utf-8" }).stdout;
        expect([file, sections.length > 0, /\.debug_/.test(sections)]).toEqual([file, true, false]);
        await expectValid(file, "embedded");
        expect([file, fs.existsSync(file + ".sig")]).toEqual([file, false]);
      }
    }, GROUP_TIMEOUT);

    it("native build without release signs the installed files and does not strip them", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && releaseToolsAvailable, "autoreconf, make, cc, strip or file not found")) return;

      const result = await fullBuild("native", false);

      expect(result).toEqual({ status: "completed" });
      for (const file of [installedTiny(), ...nativeLibraries()]) {
        expectNotStripped(file);
        await expectValid(file, "detached");
        expect([file, fs.existsSync(file + ".sig")]).toEqual([file, true]);
      }
    }, GROUP_TIMEOUT);

    it("detached signatures sit beside the installed file and each of its link names", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && releaseToolsAvailable, "autoreconf, make, cc, strip or file not found")) return;

      const result = await fullBuild("native", true);

      expect(result).toEqual({ status: "completed" });
      const lib = path.join(nativePrefix, "lib");
      expect(fs.lstatSync(path.join(lib, "libtinygreet.so.0.0.0.sig")).isFile()).toBe(true);
      // Each signature link points where its name's link points, with .sig added (libtool decides the shape of the chain)
      for (const name of ["libtinygreet.so.0", "libtinygreet.so"]) {
        const sig = path.join(lib, name + ".sig");
        expect([sig, fs.lstatSync(sig).isSymbolicLink()]).toEqual([sig, true]);
        expect([sig, fs.readlinkSync(sig)]).toEqual([sig, fs.readlinkSync(path.join(lib, name)) + ".sig"]);
      }
      // ... so the link reaches the real signature through the chain
      expect(fs.realpathSync(path.join(lib, "libtinygreet.so.sig"))).toBe(fs.realpathSync(path.join(lib, "libtinygreet.so.0.0.0.sig")));
      expect((await signing.verifyFile(path.join(lib, "libtinygreet.so"))).status).toBe("VALID");
    }, GROUP_TIMEOUT);

    /** The program built in the project, where the build leaves it */
    function buildTreeProgram(name: string): string {
      const inLibs = path.join(projectDir, "src", ".libs", name);
      return fs.existsSync(inLibs) ? inLibs : path.join(projectDir, "src", name);
    }

    it("building twice leaves one valid signature and the same size (native)", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && releaseToolsAvailable, "autoreconf, make, cc, strip or file not found")) return;
      const files = () => [installedTiny(), ...nativeLibraries(), buildTreeProgram("tiny")];

      expect(await fullBuild("native", true)).toEqual({ status: "completed" });
      const sizes = files().map((file) => fs.statSync(file).size);
      expect(await fullBuild("native", true)).toEqual({ status: "completed" });

      expect(files().map((file) => fs.statSync(file).size)).toEqual(sizes);
      for (const file of [installedTiny(), ...nativeLibraries()]) {
        expectStripped(file);
        await expectValid(file, "detached");
      }
    }, GROUP_TIMEOUT * 2);

    it("building twice leaves one valid signature and the same size (windows)", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && mingwAvailable, mingwReason)) return;
      const files = () => [...windowsFiles(), buildTreeProgram("tiny.exe")];

      expect(await fullBuild("windows", true)).toEqual({ status: "completed" });
      const sizes = files().map((file) => fs.statSync(file).size);
      expect(await fullBuild("windows", true)).toEqual({ status: "completed" });

      expect(files().map((file) => fs.statSync(file).size)).toEqual(sizes);
      for (const file of windowsFiles()) {
        await expectValid(file, "embedded");
        expect([file, fs.existsSync(file + ".sig")]).toEqual([file, false]);
      }
    }, GROUP_TIMEOUT * 2);
  });

  describe("library search", () => {
    const pkgConfigAvailable = findOnPath("pkg-config") !== null;
    const mingwAvailable = findOnPath("x86_64-w64-mingw32-gcc") !== null;
    const toolsReason = "autoreconf, make, cc or pkg-config not found";

    function build(target: "native" | "windows", userPath: string, requires: string, sink: TailSink) {
      // The user's search path is given both in the process environment and in the environment passed to the
      // build, so it reaches the configure step whichever of the two the implementation reads.
      // PKG_CONFIG names the plain pkg-config for configure: a distribution's host-prefixed wrapper
      // (x86_64-w64-mingw32-pkg-config) would otherwise narrow the search by itself and hide the defect.
      useProcessEnv({ PKG_CONFIG_PATH: userPath, PKG_CONFIG: "pkg-config", HOME: home });
      return new Build(new Config(configDir)).buildProject({
        projectDir,
        target,
        release: false,
        jobs: JOBS,
        configDir,
        env: { ...caseEnv({ SEED_TEST_REQUIRES: requires, PKG_CONFIG: "pkg-config" }), PKG_CONFIG_PATH: userPath },
        output: sink,
        log: () => undefined,
      });
    }

    it("native configure finds a library from the prefix and one from the user's path", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && pkgConfigAvailable, toolsReason)) return;
      const userDir = path.join(root, "user pkgconfig");
      writePackageDescription(path.join(nativePrefix, "lib", "pkgconfig"), "seedtest-prefix");
      writePackageDescription(userDir, "seedtest-user");
      const sink = new TailSink();

      const result = await build("native", userDir, "seedtest-prefix seedtest-user", sink);

      expect(result).toEqual({ status: "completed" });
      expect(runInstalledTiny()).toContain("tiny ok");
    }, CASE_TIMEOUT);

    it("windows configure reports a native-only package missing and finds one in the Windows prefix", async () => {
      if (!optionalExternalCheck("build-end-to-end", toolsAvailable && pkgConfigAvailable && mingwAvailable,
        "autoreconf, make, cc, pkg-config or x86_64-w64-mingw32-gcc not found")) return;
      const windowsPrefix = path.join(prefix, "x86_64-w64-mingw32");
      const windowsDir = path.join(windowsPrefix, "lib", "pkgconfig");
      // A package described only in a system directory, chosen from what this machine has.
      const system = findSystemOnlyPackage([windowsDir, ...WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS]);
      if (!optionalExternalCheck("system-only-package", system !== null, "no package described only in a system directory")) return;
      const userDir = path.join(root, "user pkgconfig");
      writePackageDescription(windowsDir, "seedtest-windows");
      writePackageDescription(userDir, "seedtest-user");

      const missing = new TailSink();
      const failed = await build("windows", userDir, "seedtest-windows " + system, missing);

      expect(failed.status).toBe("failed");
      expect((failed as { step: string }).step).toBe("configure");
      expect(missing.tailText()).toContain(system as string);

      const found = new TailSink();
      const completed = await build("windows", userDir, "seedtest-windows", found);

      expect(completed).toEqual({ status: "completed" });
      expect(fs.existsSync(path.join(windowsPrefix, "bin", "tiny.exe"))).toBe(true);
    }, CASE_TIMEOUT * 2);
  });
});
