import fs from "fs";
import path from "path";
import os from "os";
import { ProjectType } from "../src/types";
import type { BuildableProject, RecursiveBuildCallbacks } from "../src/types";

// Mock child_process before importing RecursiveBuild
jest.mock("child_process", () => ({
  execSync: jest.fn(() => Buffer.from("")),
}));

// Mock Config and Build
jest.mock("../src/Config", () => {
  return jest.fn().mockImplementation(() => ({
    config: { prefix: "/fake/prefix" },
    configDir: "/fake/config",
    loadConfig: jest.fn(),
  }));
});

jest.mock("../src/Build", () => {
  const MockBuild = jest.fn().mockImplementation(() => ({
    getSteps: jest.fn((target: string, fullReconfigure: boolean) => {
      const steps = [];
      if (fullReconfigure) {
        steps.push({ label: "autogen", command: "./autogen.sh" });
        steps.push({
          label: "distclean",
          command: "make distclean",
          ignoreExitCode: true,
        });
        steps.push({ label: "configure", command: "./configure --prefix=/fake" });
      }
      steps.push({ label: "compile", command: "make -j" });
      steps.push({ label: "install", command: "make install" });
      return steps;
    }),
  }));
  return {
    __esModule: true,
    default: MockBuild,
    autoSignIfCertExists: jest.fn().mockResolvedValue(undefined),
    stripBinaries: jest.fn().mockResolvedValue({ strippedFiles: [], stripTool: "strip" }),
  };
});

import { execSync } from "child_process";
const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

// Mock DependencyWalker
jest.mock("../src/DependencyWalker", () => ({
  walkDependencies: jest.fn(),
  resolveBuildOrder: jest.fn(),
  CyclicDependencyError: class CyclicDependencyError extends Error {
    cycleParticipants: string[];
    constructor(participants: string[]) {
      super(`Cyclic dependency detected among: ${participants.join(", ")}`);
      this.name = "CyclicDependencyError";
      this.cycleParticipants = participants;
    }
  },
}));

import { walkDependencies, resolveBuildOrder } from "../src/DependencyWalker";
import { buildRecursive, getRecursiveBuildSteps } from "../src/RecursiveBuild";
import { stripBinaries } from "../src/Build";

const mockedStripBinaries = stripBinaries as jest.MockedFunction<typeof stripBinaries>;

const mockedWalkDependencies = walkDependencies as jest.MockedFunction<
  typeof walkDependencies
>;
const mockedResolveBuildOrder = resolveBuildOrder as jest.MockedFunction<
  typeof resolveBuildOrder
>;

function makeProject(
  name: string,
  projectPath: string,
  type: ProjectType
): BuildableProject {
  return { name, path: projectPath, type, dependencies: [] };
}

describe("RecursiveBuild", () => {
  const comp = makeProject("comp", "/fake/comp", ProjectType.Component);
  const sys = makeProject("sys", "/fake/sys", ProjectType.System);
  const prog = makeProject("prog", "/fake/prog", ProjectType.Program);

  beforeEach(() => {
    jest.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));

    // Default mock: simple 3-project chain
    mockedWalkDependencies.mockResolvedValue({
      projects: new Map([
        [comp.path, comp],
        [sys.path, sys],
        [prog.path, prog],
      ]),
      edges: new Map([
        [comp.path, []],
        [sys.path, [comp.path]],
        [prog.path, [sys.path]],
      ]),
    });
    mockedResolveBuildOrder.mockReturnValue([comp, sys, prog]);
  });

  describe("buildRecursive", () => {
    it("builds all projects in order on success", async () => {
      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(result.success).toBe(true);
      expect(result.completed).toEqual([comp, sys, prog]);
      expect(result.failed).toBeNull();
      expect(result.failureOutput).toBeNull();
      expect(result.remaining).toEqual([]);
      expect(result.cancelled).toBe(false);

      // Verify execSync was called with correct cwd for each project
      const calls = mockedExecSync.mock.calls;
      // Each project has 5 steps (autogen, distclean, configure, compile, install)
      expect(calls.length).toBe(15);

      // First project (comp) steps
      expect(calls[0][1]).toEqual(
        expect.objectContaining({ cwd: "/fake/comp" })
      );
      // Second project (sys) steps
      expect(calls[5][1]).toEqual(
        expect.objectContaining({ cwd: "/fake/sys" })
      );
      // Third project (prog) steps
      expect(calls[10][1]).toEqual(
        expect.objectContaining({ cwd: "/fake/prog" })
      );
    });

    it("halts on failure and reports remaining projects", async () => {
      // Fail on the second project's compile step
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        callCount++;
        // First project has 5 steps (calls 1-5)
        // Second project: autogen(6), distclean(7), configure(8), compile(9) — fail here
        if (callCount === 9) {
          const err = new Error("Compilation failed") as Error & {
            stderr: Buffer;
            stdout: Buffer;
          };
          err.stderr = Buffer.from("error: compile failed");
          err.stdout = Buffer.from("");
          throw err;
        }
        return Buffer.from("");
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(result.success).toBe(false);
      expect(result.completed).toEqual([comp]);
      expect(result.failed).toEqual(sys);
      expect(result.failureOutput).toContain("error: compile failed");
      expect(result.remaining).toEqual([prog]);
      expect(result.cancelled).toBe(false);
    });

    it("cancels via AbortSignal", async () => {
      const controller = new AbortController();

      // Abort after first project completes
      let callCount = 0;
      mockedExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 5) {
          // After first project's last step
          controller.abort();
        }
        return Buffer.from("");
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        signal: controller.signal,
      });

      expect(result.cancelled).toBe(true);
      expect(result.completed).toEqual([comp]);
      expect(result.remaining.length).toBeGreaterThan(0);
    });

    it("builds only root project when no dependencies (single-project fallback)", async () => {
      mockedResolveBuildOrder.mockReturnValue([prog]);

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(result.success).toBe(true);
      expect(result.completed).toEqual([prog]);
    });

    it("invokes callbacks during build", async () => {
      const callbacks: RecursiveBuildCallbacks = {
        onProjectStart: jest.fn(),
        onStepComplete: jest.fn(),
        onProjectComplete: jest.fn(),
      };

      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        callbacks,
      });

      // onProjectStart called 3 times (one per project)
      expect(callbacks.onProjectStart).toHaveBeenCalledTimes(3);
      expect(callbacks.onProjectStart).toHaveBeenCalledWith(comp, 0, 3);
      expect(callbacks.onProjectStart).toHaveBeenCalledWith(sys, 1, 3);
      expect(callbacks.onProjectStart).toHaveBeenCalledWith(prog, 2, 3);

      // onStepComplete called 15 times (5 steps per project, 3 projects)
      expect(callbacks.onStepComplete).toHaveBeenCalledTimes(15);

      // onProjectComplete called 3 times
      expect(callbacks.onProjectComplete).toHaveBeenCalledTimes(3);
    });

    it("continues past ignoreExitCode steps", async () => {
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        callCount++;
        // Fail on distclean (step 2 — should be ignored)
        if (callCount === 2) {
          throw new Error("distclean failed");
        }
        return Buffer.from("");
      });

      const result = await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      // Should still succeed because distclean has ignoreExitCode
      expect(result.success).toBe(true);
    });
  });

  describe("getRecursiveBuildSteps", () => {
    it("returns steps for all projects in build order", async () => {
      const steps = await getRecursiveBuildSteps(prog.path, "native", true);

      expect(steps.length).toBe(3);
      expect(steps[0].project).toEqual(comp);
      expect(steps[1].project).toEqual(sys);
      expect(steps[2].project).toEqual(prog);

      // Each project should have 5 steps (autogen, distclean, configure, compile, install)
      for (const entry of steps) {
        expect(entry.steps.length).toBe(5);
        expect(entry.steps[0].label).toBe("autogen");
        expect(entry.steps[4].label).toBe("install");
      }
    });

    it("returns only compile+install when fullReconfigure is false", async () => {
      const steps = await getRecursiveBuildSteps(prog.path, "native", false);

      for (const entry of steps) {
        expect(entry.steps.length).toBe(2);
        expect(entry.steps[0].label).toBe("compile");
        expect(entry.steps[1].label).toBe("install");
      }
    });
  });

  describe("buildRecursive with release=true", () => {
    it("calls stripBinaries after compile for each project when release=true", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        release: true,
      });

      // stripBinaries should be called once per project (3 projects)
      expect(mockedStripBinaries).toHaveBeenCalledTimes(3);
      expect(mockedStripBinaries).toHaveBeenCalledWith(comp.path, "native");
      expect(mockedStripBinaries).toHaveBeenCalledWith(sys.path, "native");
      expect(mockedStripBinaries).toHaveBeenCalledWith(prog.path, "native");
    });

    it("does not call stripBinaries when release is false", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
        release: false,
      });

      expect(mockedStripBinaries).not.toHaveBeenCalled();
    });

    it("does not call stripBinaries when release is omitted", async () => {
      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: prog.path,
      });

      expect(mockedStripBinaries).not.toHaveBeenCalled();
    });

    it("calls stripBinaries before autoSignIfCertExists in order", async () => {
      const callOrder: string[] = [];
      mockedStripBinaries.mockImplementation(async () => {
        callOrder.push("strip");
        return { strippedFiles: [], stripTool: "strip" };
      });
      const { autoSignIfCertExists } = require("../src/Build");
      (autoSignIfCertExists as jest.Mock).mockImplementation(async () => {
        callOrder.push("sign");
      });

      // Only 1 project to simplify ordering check
      mockedResolveBuildOrder.mockReturnValue([comp]);

      await buildRecursive({
        target: "native",
        fullReconfigure: true,
        projectDir: comp.path,
        release: true,
      });

      // strip should come before sign
      const stripIdx = callOrder.indexOf("strip");
      const signIdx = callOrder.indexOf("sign");
      expect(stripIdx).toBeGreaterThanOrEqual(0);
      expect(signIdx).toBeGreaterThan(stripIdx);
    });
  });
});
