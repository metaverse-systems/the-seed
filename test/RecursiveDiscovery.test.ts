import fs from "fs";
import os from "os";
import path from "path";

// The real dependency walker, recursive build and build command run here against scratch
// project trees; RecursiveBuild.test.ts and BuildCLI.test.ts mock them module-wide. Nothing
// that builds is real: the process runner, the build steps, the install phase and the
// configuration are mocked as RecursiveBuild.test.ts sets them up, and every case asserts
// that no step ran.
jest.mock("../src/ProcessRunner", () => ({
  ...jest.requireActual("../src/ProcessRunner"),
  runCommand: jest.fn(),
}));

jest.mock("../src/BuildScheduler", () => ({
  ...jest.requireActual("../src/BuildScheduler"),
  processorCount: () => 4,
}));

// The mock keeps the real ConfigError, which the command dispatcher tests against.
jest.mock("../src/Config", () => ({
  __esModule: true,
  ...jest.requireActual("../src/Config"),
  default: jest.fn().mockImplementation((configDir?: string) => ({
    config: { prefix: "/fake/prefix" },
    configDir: configDir || "/fake/config",
    loadConfig: jest.fn(),
  })),
}));

const mockGetSteps = jest.fn((target: string, fullReconfigure: boolean, jobs?: number) => [
  { label: "compile", program: "make", args: [`-j${jobs ?? 4}`] },
  { label: "install", program: "make", args: ["install"] },
]);
jest.mock("../src/Build", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getSteps: mockGetSteps,
  })),
}));

jest.mock("../src/InstallPhase", () => ({
  ...jest.requireActual("../src/InstallPhase"),
  runInstallPhase: jest.fn(),
}));

import { ConflictingProjectError, CyclicDependencyError } from "../src/DependencyWalker";
import { runCommand } from "../src/ProcessRunner";
import { runInstallPhase } from "../src/InstallPhase";
import { buildRecursive } from "../src/RecursiveBuild";
import { runCli } from "../src/scripts/Cli";
import type { BuildableProject, RecursiveBuildResult } from "../src/types";
import { writeProject, linkModule, readBound, onRead } from "./helpers/ScratchProjects";
import type { Hook } from "./helpers/ScratchProjects";

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedInstallPhase = runInstallPhase as jest.MockedFunction<typeof runInstallPhase>;

/** Time limit of every case: a walk that does not end fails by the read bound well before it. */
const BOUND_TIMEOUT = 5000;
const LIB = "lib_LTLIBRARIES = libx.la";

describe("recursive discovery", () => {
  let tempDir: string;
  let home: string;
  let configDir: string;
  let originalHome: string | undefined;
  let originalExitCode: typeof process.exitCode;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let cwdSpy: jest.SpyInstance | undefined;

  const logged = () => logSpy.mock.calls.map((call) => call.map(String).join(" "));
  const errored = () => errorSpy.mock.calls.map((call) => call.map(String).join(" "));

  /** Two projects that declare each other by local path; returns the root's directory and both. */
  function writeCycle(): { a: string; b: string } {
    const a = path.join(tempDir, "a");
    const b = path.join(tempDir, "b");
    writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
    writeProject(b, { name: "@t/b", makefileAm: LIB, dependencies: { "@t/a": "file:../a" } });
    return { a, b };
  }

  /** Two projects, a depending on b, where b is the last one discovered. */
  function writeChain(): { a: string; b: string } {
    const a = path.join(tempDir, "a");
    const b = path.join(tempDir, "b");
    writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
    writeProject(b, { name: "@t/b", makefileAm: LIB });
    return { a, b };
  }

  /**
   * Program p declaring library q by local path, by a node_modules link and by an alias key
   * through node_modules, all reaching one directory.
   */
  function writeLinkedTree(): { p: string; q: string } {
    const p = path.join(tempDir, "p");
    const q = path.join(tempDir, "q");
    writeProject(q, { name: "@t/q", makefileAm: LIB });
    writeProject(p, {
      name: "@t/p",
      makefileAm: "bin_PROGRAMS = p",
      dependencies: { "@t/q": "file:../q", "@t/q-link": "^1.0.0", "@t/q-alias": "^0.0.1" },
    });
    linkModule(p, "@t/q-link", "../../../q");
    linkModule(p, "@t/q-alias", "../../../q");
    return { p, q };
  }

  /** Program p declaring a local-path q and, under another key, a separate copy named @t/q. */
  function writeConflict(): { p: string; local: string; copy: string } {
    const p = path.join(tempDir, "p");
    const local = path.join(tempDir, "q");
    const copy = path.join(p, "node_modules", "@t", "q");
    writeProject(local, { name: "@t/q", makefileAm: LIB });
    writeProject(p, {
      name: "@t/p",
      makefileAm: "bin_PROGRAMS = p",
      dependencies: { "q-local": "file:../q", "@t/q": "^1.0.0" },
    });
    writeProject(copy, { name: "@t/q", makefileAm: LIB });
    return { p, local, copy };
  }

  /** The mocked install phase completes without installing anything. */
  function installPhaseCompletes(): void {
    mockedInstallPhase.mockImplementation(async (options) => {
      options.onInstalled?.();
      return {
        status: "completed",
        report: { prefix: "/fake/prefix", installed: 0, stripped: [], signed: [], outcome: { kind: "unsigned", reason: "noScope" } },
      };
    });
  }

  /** Directories the mocked process runner was asked to run steps in. */
  function stepDirectories(): string[] {
    return mockedRunCommand.mock.calls.map((call) => String(call[2]?.cwd));
  }

  /** Runs `body` with the hard bound of 200 file reads and the given hooks installed, then restores them. */
  async function bounded<T>(body: () => Promise<T>, makeHooks: () => Hook[] = () => []): Promise<T> {
    const bound = readBound(200);
    const hooks = makeHooks();
    try {
      return await body();
    } finally {
      for (const hook of [...hooks].reverse()) {
        hook.restore();
      }
      bound.restore();
    }
  }

  /** Records the path of every file read into `paths`, passing the reads on unchanged. */
  function recordReads(paths: string[]): Hook {
    const previous = fs.promises.readFile;
    const call = previous as unknown as (...args: unknown[]) => Promise<unknown>;
    const wrapper = ((...args: unknown[]) => {
      paths.push(String(args[0]));
      return call(...args);
    }) as unknown as typeof fs.promises.readFile;
    fs.promises.readFile = wrapper;
    return {
      restore(): void {
        if (fs.promises.readFile === wrapper) {
          fs.promises.readFile = previous;
        }
      },
    };
  }

  function recursiveBuild(
    projectDir: string,
    extra: { signal?: AbortSignal; onProjectStart?: (project: BuildableProject) => void } = {}
  ): Promise<RecursiveBuildResult> {
    return buildRecursive({
      target: "native",
      fullReconfigure: true,
      projectDir,
      jobs: 4,
      signal: extra.signal,
      callbacks: extra.onProjectStart ? { onProjectStart: extra.onProjectStart } : undefined,
    });
  }

  function expectNothingBuilt(): void {
    expect(mockedRunCommand).not.toHaveBeenCalled();
    expect(mockedInstallPhase).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recdisc-test-")));
    home = path.join(tempDir, "home");
    configDir = path.join(home, "the-seed");
    fs.mkdirSync(configDir, { recursive: true });
    originalHome = process.env.HOME;
    originalExitCode = process.exitCode;
    process.env.HOME = home;
    process.exitCode = undefined;
    mockedRunCommand.mockReset();
    mockedInstallPhase.mockReset();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.HOME = originalHome;
    process.exitCode = originalExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("buildRecursive", () => {
    it("rejects a two-project cycle with CyclicDependencyError and runs nothing", async () => {
      const { a } = writeCycle();
      const started: string[] = [];

      const outcome = bounded(() => recursiveBuild(a, { onProjectStart: (project) => started.push(project.name) }));
      await expect(outcome).rejects.toBeInstanceOf(CyclicDependencyError);
      expect(started).toEqual([]);
      expectNothingBuilt();
    }, BOUND_TIMEOUT);

    it("prints the scanning line before the first file read of discovery", async () => {
      const { a } = writeChain();
      const events: string[] = [];
      logSpy.mockImplementation((message?: unknown) => {
        events.push(`log:${String(message)}`);
      });

      await bounded(
        () => recursiveBuild(a),
        () => [onRead("package.json", () => events.push("read"))]
      );

      const scanning = events.indexOf(`log:Scanning dependencies of ${a}...`);
      const firstRead = events.indexOf("read");
      expect(scanning).toBeGreaterThanOrEqual(0);
      expect(firstRead).toBeGreaterThanOrEqual(0);
      expect(scanning).toBeLessThan(firstRead);
    }, BOUND_TIMEOUT);

    it("resolves cancelled with every list empty when the signal aborts during discovery", async () => {
      const { a } = writeChain();
      const controller = new AbortController();
      const started: string[] = [];

      const result = await bounded(
        () => recursiveBuild(a, { signal: controller.signal, onProjectStart: (project) => started.push(project.name) }),
        () => [onRead("b/package.json", () => controller.abort())]
      );

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.completed).toEqual([]);
      expect(result.remaining).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(result.interrupted).toEqual([]);
      expect(result.notStarted).toEqual([]);
      expect(result.failed).toBeNull();
      expect(result.failureOutput).toBeNull();
      expect(logged()).toContain("Recursive build cancelled.");
      expect(started).toEqual([]);
      expectNothingBuilt();
    }, BOUND_TIMEOUT);

    it("lists a dependency reached by a link, a local path and an alias key once, and builds it once", async () => {
      const { p, q } = writeLinkedTree();
      mockedRunCommand.mockResolvedValue({ exitCode: 0, signal: null, stdout: "", stderr: "", killed: false });
      installPhaseCompletes();

      const result = await bounded(() => recursiveBuild(p));

      expect(result.success).toBe(true);
      expect(result.completed.map((project) => project.name)).toEqual(["@t/q", "@t/p"]);
      expect(logged().filter((line) => /^ +\d+\. @t\/q /.test(line))).toEqual(["  1. @t/q (Component)"]);
      expect(logged()).toContain("Discovered 2 buildable projects");
      const directories = stepDirectories();
      const forQ = directories.filter((dir) => dir === q).length;
      expect(forQ).toBeGreaterThan(0);
      expect(forQ).toBe(directories.filter((dir) => dir === p).length);
      expect(directories.every((dir) => dir === p || dir === q)).toBe(true);
    }, BOUND_TIMEOUT);

    it("places a root reached through a linked directory last in the build order", async () => {
      const { p } = writeLinkedTree();
      const through = path.join(tempDir, "through");
      fs.symlinkSync(p, through);
      mockedRunCommand.mockResolvedValue({ exitCode: 0, signal: null, stdout: "", stderr: "", killed: false });
      installPhaseCompletes();

      const result = await bounded(() => recursiveBuild(through));

      expect(result.success).toBe(true);
      expect(result.completed.map((project) => project.name)).toEqual(["@t/q", "@t/p"]);
      expect(logged()).toContain("  2. @t/p (Program)");
    }, BOUND_TIMEOUT);
  });

  describe("the build command", () => {
    const argv = ["node", "the-seed", "build", "native", "--recursive", "--jobs", "4"];

    function inProject(dir: string): void {
      cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(dir);
    }

    it("exits 1 with exactly the cycle message and builds nothing for a two-project cycle", async () => {
      const { a, b } = writeCycle();
      inProject(a);

      await bounded(() => runCli(argv, configDir, "the-seed"));

      const expected = new CyclicDependencyError(["@t/a", "@t/b"], [a, b]).message;
      expect(process.exitCode).toBe(1);
      expect(errored()).toEqual([expected]);
      expectNothingBuilt();
    }, BOUND_TIMEOUT);

    it("exits 1 with the Cannot read message, and no stack trace, for a dependency with invalid JSON", async () => {
      const { a, b } = writeChain();
      fs.writeFileSync(path.join(b, "package.json"), "{ not json");
      inProject(a);

      await bounded(() => runCli(argv, configDir, "the-seed"));

      expect(process.exitCode).toBe(1);
      const output = errored();
      expect(output).toHaveLength(1);
      expect(output[0].startsWith(`Cannot read ${path.join(b, "package.json")}: `)).toBe(true);
      expect(output[0]).not.toMatch(/\n\s+at /);
      expectNothingBuilt();
    }, BOUND_TIMEOUT);

    it("exits 1 with exactly the conflicting-locations message, and builds nothing, for two directories named alike", async () => {
      const { p, local, copy } = writeConflict();
      inProject(p);

      await bounded(() => runCli(argv, configDir, "the-seed"));

      const expected = new ConflictingProjectError("@t/q", local, copy).message;
      expect(process.exitCode).toBe(1);
      expect(errored()).toEqual([expected]);
      expect(errored()[0]).toContain(local);
      expect(errored()[0]).toContain(copy);
      expect(errored()[0]).not.toMatch(/\n\s+at /);
      expectNothingBuilt();
    }, BOUND_TIMEOUT);

    it("exits 143, reports the cancellation and reads no further project when SIGTERM arrives during discovery", async () => {
      const a = path.join(tempDir, "a");
      const b = path.join(tempDir, "b");
      const c = path.join(tempDir, "c");
      writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
      writeProject(b, { name: "@t/b", makefileAm: LIB, dependencies: { "@t/c": "file:../c" } });
      writeProject(c, { name: "@t/c", makefileAm: LIB });
      inProject(a);
      const reads: string[] = [];

      await bounded(
        () => runCli(argv, configDir, "the-seed"),
        () => [
          recordReads(reads),
          onRead("b/package.json", () => process.emit("SIGTERM", "SIGTERM")),
        ]
      );

      expect(reads).toContain(path.join(b, "package.json"));
      expect(reads).not.toContain(path.join(c, "package.json"));
      expect(process.exitCode).toBe(143);
      expect(logged()).toContain("Recursive build cancelled.");
      expectNothingBuilt();
    }, BOUND_TIMEOUT);
  });
});
