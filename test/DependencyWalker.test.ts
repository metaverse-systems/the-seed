import fs from "fs";
import path from "path";
import os from "os";
import { ProjectType } from "../src/types";
import {
  resolveDependencyPath,
  isBuildable,
  classifyProject,
  walkDependencies,
  resolveBuildOrder,
  CyclicDependencyError,
  DependencyDiscoveryError,
  ConflictingProjectError,
  ProjectManifestError,
  DiscoveryCancelledError,
} from "../src/DependencyWalker";
import type { DependencyGraph, BuildableProject } from "../src/types";
import { writeProject, linkModule, readBound, onRead } from "./helpers/ScratchProjects";
import { defined } from "./helpers/Defined";

/** Jest time limit of every case that walks a tree holding a cycle or a link. */
const BOUND_TIMEOUT = 5000;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "depwalker-test-"));
}

/**
 * Helper: create a minimal buildable project on disk.
 */
function createProject(
  dir: string,
  opts: {
    name: string;
    dependencies?: Record<string, string>;
    makefileAm: string;
    configureAc?: string;
  }
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: opts.name,
      version: "1.0.0",
      dependencies: opts.dependencies || {},
    })
  );
  const srcDir = path.join(dir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "Makefile.am"), opts.makefileAm);
  if (opts.configureAc !== undefined) {
    fs.writeFileSync(path.join(dir, "configure.ac"), opts.configureAc);
  }
}

describe("DependencyWalker", () => {
  let tempDir: string;

  beforeEach(() => {
    // The temporary directory may be a link; discovery reports real locations.
    tempDir = fs.realpathSync(createTempDir());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── resolveDependencyPath ──────────────────────────────────

  describe("resolveDependencyPath", () => {
    it("resolves file: protocol as relative path from project dir", () => {
      const result = resolveDependencyPath(
        "/home/user/projects/my-game",
        "physics-system",
        "file:../physics-system"
      );
      expect(result).toBe("/home/user/projects/physics-system");
    });

    it("resolves non-file: protocol to node_modules", () => {
      const result = resolveDependencyPath(
        "/home/user/projects/my-game",
        "libecs-cpp",
        "^1.0.0"
      );
      expect(result).toBe(
        "/home/user/projects/my-game/node_modules/libecs-cpp"
      );
    });

    it("handles scoped packages in node_modules", () => {
      const result = resolveDependencyPath(
        "/home/user/projects/my-game",
        "@org/physics-system",
        "^2.0.0"
      );
      expect(result).toBe(
        "/home/user/projects/my-game/node_modules/@org/physics-system"
      );
    });

    it("handles file: with nested relative paths", () => {
      const result = resolveDependencyPath(
        "/home/user/projects/deep/nested/project",
        "some-lib",
        "file:../../libs/some-lib"
      );
      expect(result).toBe("/home/user/projects/deep/libs/some-lib");
    });
  });

  // ── isBuildable ────────────────────────────────────────────

  describe("isBuildable", () => {
    it("returns true when package.json and src/Makefile.am exist", async () => {
      const projDir = path.join(tempDir, "buildable");
      createProject(projDir, {
        name: "test-component",
        makefileAm: "lib_LTLIBRARIES = libtest.la",
      });
      expect(await isBuildable(projDir)).toBe(true);
    });

    it("returns false when package.json is missing", async () => {
      const projDir = path.join(tempDir, "no-pkg");
      fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "src", "Makefile.am"),
        "lib_LTLIBRARIES = libtest.la"
      );
      expect(await isBuildable(projDir)).toBe(false);
    });

    it("returns false when src/Makefile.am is missing", async () => {
      const projDir = path.join(tempDir, "no-makefile");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "package.json"),
        JSON.stringify({ name: "test" })
      );
      expect(await isBuildable(projDir)).toBe(false);
    });

    it("returns false when directory does not exist", async () => {
      expect(await isBuildable(path.join(tempDir, "nonexistent"))).toBe(false);
    });
  });

  // ── classifyProject ────────────────────────────────────────

  describe("classifyProject", () => {
    it("classifies project with bin_PROGRAMS as Program", async () => {
      const projDir = path.join(tempDir, "program");
      createProject(projDir, {
        name: "my-program",
        makefileAm: "bin_PROGRAMS = my_program\nmy_program_SOURCES = main.cpp",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });
      expect(await classifyProject(projDir)).toBe(ProjectType.Program);
    });

    it("classifies project with lib_LTLIBRARIES and the-seed in PKG_CHECK_MODULES as System", async () => {
      const projDir = path.join(tempDir, "system");
      createProject(projDir, {
        name: "physics-system",
        makefileAm: "lib_LTLIBRARIES = libphysics.la",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });
      expect(await classifyProject(projDir)).toBe(ProjectType.System);
    });

    it("classifies project with lib_LTLIBRARIES and no the-seed reference as Component", async () => {
      const projDir = path.join(tempDir, "component");
      createProject(projDir, {
        name: "libecs-cpp",
        makefileAm: "lib_LTLIBRARIES = libecs.la",
        configureAc: "PKG_CHECK_MODULES([LIBECS], [ecs-cpp])\nAC_OUTPUT",
      });
      expect(await classifyProject(projDir)).toBe(ProjectType.Component);
    });

    it("classifies project with lib_LTLIBRARIES and no configure.ac as Component", async () => {
      const projDir = path.join(tempDir, "no-configure");
      createProject(projDir, {
        name: "basic-lib",
        makefileAm: "lib_LTLIBRARIES = libbasic.la",
        // No configureAc
      });
      expect(await classifyProject(projDir)).toBe(ProjectType.Component);
    });

    it("throws when src/Makefile.am is missing", async () => {
      const projDir = path.join(tempDir, "no-makefile");
      fs.mkdirSync(projDir, { recursive: true });
      await expect(classifyProject(projDir)).rejects.toThrow();
    });
  });

  // ── walkDependencies ───────────────────────────────────────

  describe("walkDependencies", () => {
    it("discovers a single project with no dependencies", async () => {
      const projDir = path.join(tempDir, "solo");
      createProject(projDir, {
        name: "solo-component",
        makefileAm: "lib_LTLIBRARIES = libsolo.la",
        configureAc: "AC_OUTPUT",
      });

      const graph = await walkDependencies(projDir);
      expect(graph.projects.size).toBe(1);
      expect(defined(graph.projects.get(projDir), "project").name).toBe("solo-component");
      expect(defined(graph.projects.get(projDir), "project").type).toBe(ProjectType.Component);
      expect(graph.edges.get(projDir)).toEqual([]);
    });

    it("discovers file: dependencies recursively", async () => {
      // component -> no deps
      const compDir = path.join(tempDir, "component");
      createProject(compDir, {
        name: "test-component",
        makefileAm: "lib_LTLIBRARIES = libcomp.la",
        configureAc: "AC_OUTPUT",
      });

      // system -> depends on component
      const sysDir = path.join(tempDir, "system");
      createProject(sysDir, {
        name: "test-system",
        dependencies: { "test-component": "file:../component" },
        makefileAm: "lib_LTLIBRARIES = libsys.la",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      // program -> depends on system
      const progDir = path.join(tempDir, "program");
      createProject(progDir, {
        name: "test-program",
        dependencies: { "test-system": "file:../system" },
        makefileAm: "bin_PROGRAMS = test_prog",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      const graph = await walkDependencies(progDir);
      expect(graph.projects.size).toBe(3);
      expect(graph.projects.has(compDir)).toBe(true);
      expect(graph.projects.has(sysDir)).toBe(true);
      expect(graph.projects.has(progDir)).toBe(true);
    });

    it("skips non-buildable dependencies", async () => {
      // non-buildable dependency (no src/Makefile.am)
      const nonBuildDir = path.join(tempDir, "non-buildable");
      fs.mkdirSync(nonBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nonBuildDir, "package.json"),
        JSON.stringify({ name: "non-buildable", version: "1.0.0" })
      );

      // project depending on non-buildable
      const projDir = path.join(tempDir, "proj");
      createProject(projDir, {
        name: "my-project",
        dependencies: { "non-buildable": "file:../non-buildable" },
        makefileAm: "bin_PROGRAMS = my_proj",
        configureAc: "AC_OUTPUT",
      });

      const graph = await walkDependencies(projDir);
      expect(graph.projects.size).toBe(1); // only the root project
      expect(graph.projects.has(projDir)).toBe(true);
    });

    it("deduplicates diamond dependencies", async () => {
      // shared-component (no deps)
      const sharedDir = path.join(tempDir, "shared");
      createProject(sharedDir, {
        name: "shared-component",
        makefileAm: "lib_LTLIBRARIES = libshared.la",
        configureAc: "AC_OUTPUT",
      });

      // system-a -> depends on shared
      const sysADir = path.join(tempDir, "system-a");
      createProject(sysADir, {
        name: "system-a",
        dependencies: { "shared-component": "file:../shared" },
        makefileAm: "lib_LTLIBRARIES = libsysa.la",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      // system-b -> depends on shared
      const sysBDir = path.join(tempDir, "system-b");
      createProject(sysBDir, {
        name: "system-b",
        dependencies: { "shared-component": "file:../shared" },
        makefileAm: "lib_LTLIBRARIES = libsysb.la",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      // program -> depends on system-a and system-b
      const progDir = path.join(tempDir, "program");
      createProject(progDir, {
        name: "test-program",
        dependencies: {
          "system-a": "file:../system-a",
          "system-b": "file:../system-b",
        },
        makefileAm: "bin_PROGRAMS = test_prog",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      const graph = await walkDependencies(progDir);

      // shared appears exactly once despite being depended on by both systems
      expect(graph.projects.size).toBe(4);
      const sharedProject = graph.projects.get(sharedDir);
      expect(sharedProject).toBeDefined();
      expect(defined(sharedProject, "shared project").name).toBe("shared-component");
    });

    it("throws ProjectManifestError naming the file when root project has no package.json", async () => {
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      const manifest = path.join(emptyDir, "package.json");
      let caught: unknown;
      try {
        await walkDependencies(emptyDir);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProjectManifestError);
      expect((caught as ProjectManifestError).manifestPath).toBe(manifest);
      expect((caught as Error).message.startsWith(`Cannot read ${manifest}: `)).toBe(true);
    });
  });

  // ── walkDependencies: cycles, bad manifests, cancellation ──

  describe("walkDependencies cycles and cancellation", () => {
    // Every case here runs under a hard bound of 200 file reads, so a walk that
    // never ends fails by the bound instead of hanging.
    const LIB = "lib_LTLIBRARIES = libx.la";

    interface Outcome {
      graph?: DependencyGraph;
      error?: unknown;
      reads: number;
    }

    /** Runs the walk under the read bound; extra hooks are installed inside it and restored first. */
    async function discover(
      dir: string,
      options?: { signal?: AbortSignal },
      hooks: Array<{ restore(): void }> = []
    ): Promise<Outcome> {
      const bound = readBound(200);
      try {
        const graph = await walkDependencies(dir, options);
        return { graph, reads: bound.count() };
      } catch (error) {
        return { error, reads: bound.count() };
      } finally {
        for (const hook of [...hooks].reverse()) {
          hook.restore();
        }
        bound.restore();
      }
    }

    /** The error of the walk as the given class; any other outcome is thrown so its text shows. */
    function expectError<T extends Error>(outcome: Outcome, type: new (...args: never[]) => T): T {
      if (outcome.error === undefined) {
        throw new Error("the walk finished without an error");
      }
      if (!(outcome.error instanceof type)) {
        throw outcome.error;
      }
      return outcome.error;
    }

    it("reports two projects declaring each other by local path", async () => {
      const a = path.join(tempDir, "a");
      const b = path.join(tempDir, "b");
      writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
      writeProject(b, { name: "@t/b", makefileAm: LIB, dependencies: { "@t/a": "file:../a" } });

      const outcome = await discover(a);
      const error = expectError(outcome, CyclicDependencyError);
      expect(error.cycleParticipants).toEqual(["@t/a", "@t/b"]);
      expect(error.chain).toEqual(["@t/a", "@t/b", "@t/a"]);
      expect(error.locations).toEqual([a, b]);
      expect(error.message.split("\n")[0]).toBe("Dependency cycle: @t/a → @t/b → @t/a");
      expect(outcome.reads).toBeLessThan(10);
    }, BOUND_TIMEOUT);

    it("reports a project that declares itself with file:.", async () => {
      const s = path.join(tempDir, "s");
      writeProject(s, { name: "@t/s", makefileAm: LIB, dependencies: { "@t/s": "file:." } });

      const outcome = await discover(s);
      const error = expectError(outcome, CyclicDependencyError);
      expect(error.cycleParticipants).toEqual(["@t/s"]);
      expect(error.chain).toEqual(["@t/s", "@t/s"]);
      expect(error.locations).toEqual([s]);
      expect(error.message.split("\n")[0]).toBe("Dependency cycle: @t/s → @t/s");
      expect(outcome.reads).toBeLessThan(10);
    }, BOUND_TIMEOUT);

    it("reports a project whose node_modules entry links to itself", async () => {
      const s = path.join(tempDir, "s");
      writeProject(s, { name: "@t/s", makefileAm: LIB, dependencies: { "@t/s": "^1.0.0" } });
      linkModule(s, "@t/s", "../..");

      const outcome = await discover(s);
      const error = expectError(outcome, CyclicDependencyError);
      expect(error.cycleParticipants).toEqual(["@t/s"]);
      expect(error.locations).toEqual([s]);
      expect(outcome.reads).toBeLessThan(10);
    }, BOUND_TIMEOUT);

    it("reports a three-project cycle that passes through a node_modules link", async () => {
      const a = path.join(tempDir, "a");
      const b = path.join(tempDir, "b");
      const c = path.join(tempDir, "c");
      writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
      writeProject(b, { name: "@t/b", makefileAm: LIB, dependencies: { "@t/c": "^1.0.0" } });
      linkModule(b, "@t/c", "../../../c");
      writeProject(c, { name: "@t/c", makefileAm: LIB, dependencies: { "@t/a": "file:../a" } });

      const outcome = await discover(a);
      const error = expectError(outcome, CyclicDependencyError);
      expect(error.chain).toEqual(["@t/a", "@t/b", "@t/c", "@t/a"]);
      expect(error.locations).toEqual([a, b, c]);
      expect(error.message.split("\n")[0]).toBe("Dependency cycle: @t/a → @t/b → @t/c → @t/a");
      expect(outcome.reads).toBeLessThan(20);
    }, BOUND_TIMEOUT);

    it("starts the chain of a cycle below the root at the first project of the cycle", async () => {
      const root = path.join(tempDir, "root");
      const a = path.join(tempDir, "a");
      const b = path.join(tempDir, "b");
      writeProject(root, { name: "@t/root", makefileAm: "bin_PROGRAMS = root", dependencies: { "@t/a": "file:../a" } });
      writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
      writeProject(b, { name: "@t/b", makefileAm: LIB, dependencies: { "@t/a": "file:../a" } });

      const outcome = await discover(root);
      const error = expectError(outcome, CyclicDependencyError);
      expect(error.chain).toEqual(["@t/a", "@t/b", "@t/a"]);
      expect(error.locations).toEqual([a, b]);
      expect(error.message).not.toContain("@t/root");
    }, BOUND_TIMEOUT);

    it("finds a diamond without error, the shared component once, with an edge from each system", async () => {
      const root = path.join(tempDir, "root");
      const s1 = path.join(tempDir, "s1");
      const s2 = path.join(tempDir, "s2");
      const comp = path.join(tempDir, "comp");
      writeProject(root, {
        name: "@t/root",
        makefileAm: "bin_PROGRAMS = root",
        dependencies: { "@t/s1": "file:../s1", "@t/s2": "file:../s2" },
      });
      writeProject(s1, { name: "@t/s1", makefileAm: LIB, dependencies: { "@t/comp": "file:../comp" } });
      writeProject(s2, { name: "@t/s2", makefileAm: LIB, dependencies: { "@t/comp": "file:../comp" } });
      writeProject(comp, { name: "@t/comp", makefileAm: LIB });

      const outcome = await discover(root);
      expect(outcome.error).toBeUndefined();
      const graph = outcome.graph as DependencyGraph;
      expect([...graph.projects.keys()].sort()).toEqual([comp, root, s1, s2].sort());
      expect(graph.edges.get(s1)).toEqual([comp]);
      expect(graph.edges.get(s2)).toEqual([comp]);
      expect(graph.edges.get(root)).toEqual([s1, s2]);
      expect(graph.edges.get(comp)).toEqual([]);
    }, BOUND_TIMEOUT);

    it("names the package.json of a dependency that holds invalid JSON", async () => {
      const a = path.join(tempDir, "a");
      const b = path.join(tempDir, "b");
      writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
      writeProject(b, { name: "@t/b", makefileAm: LIB });
      fs.writeFileSync(path.join(b, "package.json"), "{ not json");

      const outcome = await discover(a);
      const error = expectError(outcome, ProjectManifestError);
      expect(error.manifestPath).toBe(path.join(b, "package.json"));
      expect(error.message.startsWith(`Cannot read ${path.join(b, "package.json")}: `)).toBe(true);
      expect(error).not.toBeInstanceOf(SyntaxError);
    }, BOUND_TIMEOUT);

    it("ends with DiscoveryCancelledError when the signal aborts while the last project is read", async () => {
      const a = path.join(tempDir, "a");
      const b = path.join(tempDir, "b");
      writeProject(a, { name: "@t/a", makefileAm: LIB, dependencies: { "@t/b": "file:../b" } });
      writeProject(b, { name: "@t/b", makefileAm: LIB });
      const controller = new AbortController();

      const hook = onRead("b/package.json", () => controller.abort());
      const outcome = await discover(a, { signal: controller.signal }, [hook]);
      expectError(outcome, DiscoveryCancelledError);
    }, BOUND_TIMEOUT);

    it("rejects without reading anything when the signal is aborted before the call", async () => {
      const a = path.join(tempDir, "a");
      writeProject(a, { name: "@t/a", makefileAm: LIB });
      const controller = new AbortController();
      controller.abort();

      const outcome = await discover(a, { signal: controller.signal });
      expectError(outcome, DiscoveryCancelledError);
      expect(outcome.reads).toBe(0);
    }, BOUND_TIMEOUT);
  });

  describe("walkDependencies identity and conflicts", () => {
    // Projects are identified by real location. Cases that hold a link run under the
    // hard bound of 200 file reads so that a walk that never ends fails fast.
    const LIB = "lib_LTLIBRARIES = libx.la";

    async function discover(dir: string): Promise<DependencyGraph> {
      const bound = readBound(200);
      try {
        return await walkDependencies(dir);
      } finally {
        bound.restore();
      }
    }

    it("finds one project, at its real location, for a link and a local path to one directory", async () => {
      const root = path.join(tempDir, "root");
      const q = path.join(tempDir, "q");
      writeProject(root, {
        name: "@t/root",
        makefileAm: LIB,
        dependencies: { "@t/q": "file:../q", "@t/q-alias": "^1.0.0" },
      });
      writeProject(q, { name: "@t/q", makefileAm: LIB });
      linkModule(root, "@t/q-alias", "../../../q");

      const graph = await discover(root);
      expect([...graph.projects.keys()].sort()).toEqual([q, root].sort());
      expect(graph.projects.get(q)?.path).toBe(q);
      expect(graph.edges.get(root)).toEqual([q]);
    }, BOUND_TIMEOUT);

    it("finds one project for a file: path through a link to the project's parent directory", async () => {
      const root = path.join(tempDir, "root");
      const parent = path.join(tempDir, "parent");
      const q = path.join(parent, "q");
      writeProject(root, {
        name: "@t/root",
        makefileAm: LIB,
        dependencies: { "@t/q": "file:../parent/q", "@t/q-via-link": "file:../parentlink/q" },
      });
      writeProject(q, { name: "@t/q", makefileAm: LIB });
      fs.symlinkSync("parent", path.join(tempDir, "parentlink"));

      const graph = await discover(root);
      expect([...graph.projects.keys()].sort()).toEqual([q, root].sort());
      expect(graph.edges.get(root)).toEqual([q]);
    }, BOUND_TIMEOUT);

    it("lists dependencies as package names, once each, in declaration order, when two keys reach one directory", async () => {
      const root = path.join(tempDir, "root");
      writeProject(root, {
        name: "@t/root",
        makefileAm: LIB,
        dependencies: { "@t/q": "file:../q", "@t/r": "file:../r", "@t/q-again": "file:../q" },
      });
      writeProject(path.join(tempDir, "q"), { name: "@t/q", makefileAm: LIB });
      writeProject(path.join(tempDir, "r"), { name: "@t/r", makefileAm: LIB });

      const graph = await discover(root);
      expect(graph.projects.get(root)?.dependencies).toEqual(["@t/q", "@t/r"]);
      expect(graph.edges.get(root)).toEqual([path.join(tempDir, "q"), path.join(tempDir, "r")]);
    }, BOUND_TIMEOUT);

    it("reports a local-path project and a separate copy under one name, with both real locations in the order found", async () => {
      const root = path.join(tempDir, "root");
      const local = path.join(tempDir, "q");
      const copy = path.join(root, "node_modules", "@t", "q");
      writeProject(root, {
        name: "@t/root",
        makefileAm: LIB,
        dependencies: { "q-local": "file:../q", "@t/q": "^1.0.0" },
      });
      writeProject(local, { name: "@t/q", makefileAm: LIB });
      writeProject(copy, { name: "@t/q", makefileAm: LIB });

      let thrown: unknown;
      try {
        await discover(root);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConflictingProjectError);
      const error = thrown as ConflictingProjectError;
      expect(error.packageName).toBe("@t/q");
      expect(error.locations).toEqual([local, copy]);
      expect(error.message).toContain(local);
      expect(error.message).toContain(copy);
    }, BOUND_TIMEOUT);

    it("skips a dangling node_modules link and a missing file: directory (guard)", async () => {
      const root = path.join(tempDir, "root");
      writeProject(root, {
        name: "@t/root",
        makefileAm: LIB,
        dependencies: { "@t/dangling": "^1.0.0", "@t/missing": "file:../missing" },
      });
      linkModule(root, "@t/dangling", "../../../nowhere");

      const graph = await discover(root);
      expect([...graph.projects.keys()]).toEqual([root]);
      expect(graph.projects.get(root)?.dependencies).toEqual([]);
    }, BOUND_TIMEOUT);

    it("discovers a project directory named with spaces and shell characters at its exact path (guard)", async () => {
      const root = path.join(tempDir, "root");
      const oddName = "a b$'\"";
      const odd = path.join(tempDir, oddName);
      writeProject(root, { name: "@t/root", makefileAm: LIB, dependencies: { "@t/odd": "file:../" + oddName } });
      writeProject(odd, { name: "@t/odd", makefileAm: LIB });

      const graph = await discover(root);
      expect(graph.projects.get(odd)?.path).toBe(odd);
      expect(graph.edges.get(root)).toEqual([odd]);
    }, BOUND_TIMEOUT);
  });

  // ── resolveBuildOrder ──────────────────────────────────────

  describe("resolveBuildOrder", () => {
    it("returns single project when no dependencies", () => {
      const projPath = "/fake/solo";
      const project: BuildableProject = {
        name: "solo",
        path: projPath,
        type: ProjectType.Component,
        dependencies: [],
      };

      const graph: DependencyGraph = {
        projects: new Map([[projPath, project]]),
        edges: new Map([[projPath, []]]),
      };

      const order = resolveBuildOrder(graph, projPath);
      expect(order).toEqual([project]);
    });

    it("orders components before systems before programs", () => {
      const compPath = "/fake/comp";
      const sysPath = "/fake/sys";
      const progPath = "/fake/prog";

      const comp: BuildableProject = {
        name: "comp",
        path: compPath,
        type: ProjectType.Component,
        dependencies: [],
      };
      const sys: BuildableProject = {
        name: "sys",
        path: sysPath,
        type: ProjectType.System,
        dependencies: ["comp"],
      };
      const prog: BuildableProject = {
        name: "prog",
        path: progPath,
        type: ProjectType.Program,
        dependencies: ["sys"],
      };

      const graph: DependencyGraph = {
        projects: new Map([
          [compPath, comp],
          [sysPath, sys],
          [progPath, prog],
        ]),
        edges: new Map([
          [compPath, []],
          [sysPath, [compPath]],
          [progPath, [sysPath]],
        ]),
      };

      const order = resolveBuildOrder(graph, progPath);
      expect(order.map((p) => p.name)).toEqual(["comp", "sys", "prog"]);
    });

    it("places root project last even if it has lowest tier", () => {
      // Root is a component, but a system depends on it
      const rootPath = "/fake/root-comp";
      const otherPath = "/fake/other-sys";

      const root: BuildableProject = {
        name: "root-comp",
        path: rootPath,
        type: ProjectType.Component,
        dependencies: [],
      };
      const other: BuildableProject = {
        name: "other-sys",
        path: otherPath,
        type: ProjectType.System,
        dependencies: [],
      };

      const graph: DependencyGraph = {
        projects: new Map([
          [rootPath, root],
          [otherPath, other],
        ]),
        edges: new Map([
          [rootPath, [otherPath]],
          [otherPath, []],
        ]),
      };

      const order = resolveBuildOrder(graph, rootPath);
      expect(order[order.length - 1].name).toBe("root-comp");
    });

    it("handles diamond dependencies correctly", () => {
      const sharedPath = "/fake/shared";
      const aPath = "/fake/a";
      const bPath = "/fake/b";
      const rootPath = "/fake/root";

      const shared: BuildableProject = {
        name: "shared",
        path: sharedPath,
        type: ProjectType.Component,
        dependencies: [],
      };
      const a: BuildableProject = {
        name: "system-a",
        path: aPath,
        type: ProjectType.System,
        dependencies: ["shared"],
      };
      const b: BuildableProject = {
        name: "system-b",
        path: bPath,
        type: ProjectType.System,
        dependencies: ["shared"],
      };
      const root: BuildableProject = {
        name: "program",
        path: rootPath,
        type: ProjectType.Program,
        dependencies: ["system-a", "system-b"],
      };

      const graph: DependencyGraph = {
        projects: new Map([
          [sharedPath, shared],
          [aPath, a],
          [bPath, b],
          [rootPath, root],
        ]),
        edges: new Map([
          [sharedPath, []],
          [aPath, [sharedPath]],
          [bPath, [sharedPath]],
          [rootPath, [aPath, bPath]],
        ]),
      };

      const order = resolveBuildOrder(graph, rootPath);
      expect(order.length).toBe(4);
      // shared must come before both systems
      const sharedIdx = order.findIndex((p) => p.name === "shared");
      const aIdx = order.findIndex((p) => p.name === "system-a");
      const bIdx = order.findIndex((p) => p.name === "system-b");
      const rootIdx = order.findIndex((p) => p.name === "program");

      expect(sharedIdx).toBeLessThan(aIdx);
      expect(sharedIdx).toBeLessThan(bIdx);
      expect(aIdx).toBeLessThan(rootIdx);
      expect(bIdx).toBeLessThan(rootIdx);
    });

    it("throws CyclicDependencyError on circular dependencies", () => {
      const aPath = "/fake/a";
      const bPath = "/fake/b";

      const a: BuildableProject = {
        name: "project-a",
        path: aPath,
        type: ProjectType.System,
        dependencies: ["project-b"],
      };
      const b: BuildableProject = {
        name: "project-b",
        path: bPath,
        type: ProjectType.System,
        dependencies: ["project-a"],
      };

      const graph: DependencyGraph = {
        projects: new Map([
          [aPath, a],
          [bPath, b],
        ]),
        edges: new Map([
          [aPath, [bPath]],
          [bPath, [aPath]],
        ]),
      };

      expect(() => resolveBuildOrder(graph, aPath)).toThrow(
        CyclicDependencyError
      );

      // Defensive form: leftover names in name order, no location lines.
      let caught: unknown;
      try {
        resolveBuildOrder(graph, aPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CyclicDependencyError);
      expect((caught as Error).message.split("\n")).toEqual([
        "Dependency cycle: project-a → project-b → project-a",
        "Each project above declares the next one in its package.json \"dependencies\"; remove the declaration that closes the cycle.",
      ]);
      expect((caught as CyclicDependencyError).cycleParticipants).toEqual([
        "project-a",
        "project-b",
      ]);
    });

    it("sorts same-tier projects alphabetically for stability", () => {
      const zPath = "/fake/z-comp";
      const aCompPath = "/fake/a-comp";
      const rootPath = "/fake/root";

      const zComp: BuildableProject = {
        name: "z-component",
        path: zPath,
        type: ProjectType.Component,
        dependencies: [],
      };
      const aComp: BuildableProject = {
        name: "a-component",
        path: aCompPath,
        type: ProjectType.Component,
        dependencies: [],
      };
      const root: BuildableProject = {
        name: "my-program",
        path: rootPath,
        type: ProjectType.Program,
        dependencies: ["z-component", "a-component"],
      };

      const graph: DependencyGraph = {
        projects: new Map([
          [zPath, zComp],
          [aCompPath, aComp],
          [rootPath, root],
        ]),
        edges: new Map([
          [zPath, []],
          [aCompPath, []],
          [rootPath, [zPath, aCompPath]],
        ]),
      };

      const order = resolveBuildOrder(graph, rootPath);
      // a-component should come before z-component (alphabetical)
      expect(order[0].name).toBe("a-component");
      expect(order[1].name).toBe("z-component");
      expect(order[2].name).toBe("my-program");
    });

    it("uses tier priority over alphabetical order", () => {
      const sysPath = "/fake/a-system"; // alphabetically first but higher tier
      const compPath = "/fake/z-component"; // alphabetically last but lower tier
      const rootPath = "/fake/root";

      const sys: BuildableProject = {
        name: "a-system",
        path: sysPath,
        type: ProjectType.System,
        dependencies: [],
      };
      const comp: BuildableProject = {
        name: "z-component",
        path: compPath,
        type: ProjectType.Component,
        dependencies: [],
      };
      const root: BuildableProject = {
        name: "program",
        path: rootPath,
        type: ProjectType.Program,
        dependencies: ["a-system", "z-component"],
      };

      const graph: DependencyGraph = {
        projects: new Map([
          [sysPath, sys],
          [compPath, comp],
          [rootPath, root],
        ]),
        edges: new Map([
          [sysPath, []],
          [compPath, []],
          [rootPath, [sysPath, compPath]],
        ]),
      };

      const order = resolveBuildOrder(graph, rootPath);
      // z-component (Component=0) should come before a-system (System=1)
      expect(order[0].name).toBe("z-component");
      expect(order[1].name).toBe("a-system");
    });
  });

  // ── Discovery errors ───────────────────────────────────────

  describe("discovery errors", () => {
    // Constructor forms chosen here: CyclicDependencyError(participants,
    // locations?) takes the project names without the repeated first name,
    // and optionally their real locations in the same order;
    // ConflictingProjectError(packageName, first, second);
    // ProjectManifestError(manifestPath, reason) where manifestPath is the
    // path of the package.json file; DiscoveryCancelledError() takes no
    // arguments.
    const cycleMessage = [
      "Dependency cycle: @t/a → @t/b → @t/a",
      "  @t/a  /loc/a",
      "  @t/b  /loc/b",
      "Each project above declares the next one in its package.json \"dependencies\"; remove the declaration that closes the cycle.",
    ].join("\n");

    it("CyclicDependencyError describes a two-project cycle", () => {
      const error = new CyclicDependencyError(
        ["@t/a", "@t/b"],
        ["/loc/a", "/loc/b"]
      );
      expect(error.cycleParticipants).toEqual(["@t/a", "@t/b"]);
      expect(error.chain).toEqual(["@t/a", "@t/b", "@t/a"]);
      expect(error.locations).toEqual(["/loc/a", "/loc/b"]);
      expect(error.message).toBe(cycleMessage);
    });

    it("CyclicDependencyError describes a cycle of one", () => {
      const error = new CyclicDependencyError(["@t/s"], ["/loc/s"]);
      expect(error.cycleParticipants).toEqual(["@t/s"]);
      expect(error.chain).toEqual(["@t/s", "@t/s"]);
      expect(error.message).toBe(
        [
          "Dependency cycle: @t/s → @t/s",
          "  @t/s  /loc/s",
          "The project declares itself in its package.json \"dependencies\"; remove that declaration.",
        ].join("\n")
      );
    });

    it("ConflictingProjectError names both locations", () => {
      const error = new ConflictingProjectError("@t/q", "/one/q", "/two/q");
      expect(error.packageName).toBe("@t/q");
      expect(error.locations).toEqual(["/one/q", "/two/q"]);
      expect(error.message).toBe(
        [
          "Two different projects are named @t/q:",
          "  /one/q",
          "  /two/q",
          "Make every declaration of @t/q lead to the same directory, or give one of them another name.",
        ].join("\n")
      );
    });

    it("ProjectManifestError names the file and the reason", () => {
      const error = new ProjectManifestError(
        "/loc/x/package.json",
        "Unexpected token"
      );
      expect(error.manifestPath).toBe("/loc/x/package.json");
      expect(error.reason).toBe("Unexpected token");
      expect(error.message).toBe(
        "Cannot read /loc/x/package.json: Unexpected token"
      );
    });

    it("the three discovery errors share DependencyDiscoveryError", () => {
      const errors = [
        new CyclicDependencyError(["@t/a", "@t/b"], ["/loc/a", "/loc/b"]),
        new ConflictingProjectError("@t/q", "/one/q", "/two/q"),
        new ProjectManifestError("/loc/x/package.json", "bad"),
      ];
      for (const error of errors) {
        expect(error).toBeInstanceOf(DependencyDiscoveryError);
        expect(error).toBeInstanceOf(Error);
      }
    });

    it("DiscoveryCancelledError is an Error but not a discovery error", () => {
      const error = new DiscoveryCancelledError();
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DependencyDiscoveryError);
    });

    it("each class sets name to its class name", () => {
      expect(new CyclicDependencyError(["@t/a"], ["/a"]).name).toBe(
        "CyclicDependencyError"
      );
      expect(new ConflictingProjectError("@t/q", "/a", "/b").name).toBe(
        "ConflictingProjectError"
      );
      expect(new ProjectManifestError("/a/package.json", "x").name).toBe(
        "ProjectManifestError"
      );
      expect(new DiscoveryCancelledError().name).toBe(
        "DiscoveryCancelledError"
      );
      expect(new DependencyDiscoveryError("x").name).toBe(
        "DependencyDiscoveryError"
      );
    });
  });

  // ── Integration: walkDependencies + resolveBuildOrder ──────

  describe("integration: full dependency chain", () => {
    it("produces correct build order for component → system → program chain", async () => {
      // Create 3-project chain
      const compDir = path.join(tempDir, "component");
      createProject(compDir, {
        name: "test-component",
        makefileAm: "lib_LTLIBRARIES = libcomp.la",
        configureAc: "PKG_CHECK_MODULES([LIBECS], [ecs-cpp])\nAC_OUTPUT",
      });

      const sysDir = path.join(tempDir, "system");
      createProject(sysDir, {
        name: "test-system",
        dependencies: { "test-component": "file:../component" },
        makefileAm: "lib_LTLIBRARIES = libsys.la",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      const progDir = path.join(tempDir, "program");
      createProject(progDir, {
        name: "test-program",
        dependencies: { "test-system": "file:../system" },
        makefileAm: "bin_PROGRAMS = test_prog",
        configureAc:
          "PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT",
      });

      const graph = await walkDependencies(progDir);
      const order = resolveBuildOrder(graph, progDir);

      expect(order.map((p) => p.name)).toEqual([
        "test-component",
        "test-system",
        "test-program",
      ]);
      expect(order[0].type).toBe(ProjectType.Component);
      expect(order[1].type).toBe(ProjectType.System);
      expect(order[2].type).toBe(ProjectType.Program);
    });
  });
});
