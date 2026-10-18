import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Config from "../src/Config";
import Build from "../src/Build";
import { buildRecursive } from "../src/RecursiveBuild";
import { findOnPath } from "../src/ProcessRunner";
import { optionalExternalCheck } from "./helpers/ExternalTools";

// Real autotools, make and a C compiler build the fixture in test/fixtures/autotools-tiny with 50 MB of
// compile output. Every case has its own copy of the fixture, its own install prefix and a scratch home
// whose config.json names that prefix; nothing outside the temporary directory is touched. Compile jobs
// are limited to 4 wherever the build accepts a job limit.

const fixtureDir = path.join(__dirname, "fixtures", "autotools-tiny");
const NOISE = 52428800;
const TAIL_BYTES = 65536;
const JOBS = 4;
const CASE_TIMEOUT = 120000;

const ENV_KEYS = ["HOME", "SEED_TEST_NOISE", "SEED_TEST_FAIL", "PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "MAKEFLAGS", "MFLAGS"];

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
    const env: NodeJS.ProcessEnv = { ...process.env, ...vars };
    delete env.PKG_CONFIG_PATH;
    delete env.PKG_CONFIG_LIBDIR;
    delete env.MAKEFLAGS;
    delete env.MFLAGS;
    return env;
  }

  /** Recursive builds read the process environment, so the case's values are set there for its duration. */
  function useProcessEnv(vars: Record<string, string>): void {
    for (const key of ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "MAKEFLAGS", "MFLAGS"]) {
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
    fs.cpSync(fixtureDir, projectDir, { recursive: true });
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
});
