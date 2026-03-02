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
} from "../src/DependencyWalker";
import type { DependencyGraph, BuildableProject } from "../src/types";

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
    tempDir = createTempDir();
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
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
      });
      expect(await classifyProject(projDir)).toBe(ProjectType.Program);
    });

    it("classifies project with lib_LTLIBRARIES and the-seed in PKG_CHECK_MODULES as System", async () => {
      const projDir = path.join(tempDir, "system");
      createProject(projDir, {
        name: "physics-system",
        makefileAm: "lib_LTLIBRARIES = libphysics.la",
        configureAc:
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
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
      expect(graph.projects.get(projDir)!.name).toBe("solo-component");
      expect(graph.projects.get(projDir)!.type).toBe(ProjectType.Component);
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
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
      });

      // program -> depends on system
      const progDir = path.join(tempDir, "program");
      createProject(progDir, {
        name: "test-program",
        dependencies: { "test-system": "file:../system" },
        makefileAm: "bin_PROGRAMS = test_prog",
        configureAc:
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
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
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
      });

      // system-b -> depends on shared
      const sysBDir = path.join(tempDir, "system-b");
      createProject(sysBDir, {
        name: "system-b",
        dependencies: { "shared-component": "file:../shared" },
        makefileAm: "lib_LTLIBRARIES = libsysb.la",
        configureAc:
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
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
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
      });

      const graph = await walkDependencies(progDir);

      // shared appears exactly once despite being depended on by both systems
      expect(graph.projects.size).toBe(4);
      const sharedProject = graph.projects.get(sharedDir);
      expect(sharedProject).toBeDefined();
      expect(sharedProject!.name).toBe("shared-component");
    });

    it("throws when root project has no package.json", async () => {
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      await expect(walkDependencies(emptyDir)).rejects.toThrow();
    });
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
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
      });

      const progDir = path.join(tempDir, "program");
      createProject(progDir, {
        name: "test-program",
        dependencies: { "test-system": "file:../system" },
        makefileAm: "bin_PROGRAMS = test_prog",
        configureAc:
          'PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed])\nAC_OUTPUT',
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
