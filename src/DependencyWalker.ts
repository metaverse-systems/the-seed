import fs from "fs";
import path from "path";
import {
  ProjectType,
  BuildableProject,
  DependencyGraph,
} from "./types";

/**
 * Error thrown when a cyclic dependency is detected during topological sort.
 */
export class CyclicDependencyError extends Error {
  /** Names of projects involved in the cycle */
  cycleParticipants: string[];

  constructor(participants: string[]) {
    super(
      `Cyclic dependency detected among: ${participants.join(", ")}`
    );
    this.name = "CyclicDependencyError";
    this.cycleParticipants = participants;
  }
}

/**
 * Resolve a dependency name/version pair to an absolute directory path.
 *
 * - If `version` starts with "file:" → path.resolve(projectDir, version.slice(5))
 * - Otherwise → path.join(projectDir, "node_modules", packageName)
 *
 * @param projectDir - Absolute path of the project that declares the dependency
 * @param packageName - Key from package.json `dependencies`
 * @param version - Value from package.json `dependencies`
 * @returns Absolute path to the dependency's root directory
 */
export function resolveDependencyPath(
  projectDir: string,
  packageName: string,
  version: string
): string {
  if (version.startsWith("file:")) {
    return path.resolve(projectDir, version.slice(5));
  }
  return path.join(projectDir, "node_modules", packageName);
}

/**
 * Check whether a directory is a buildable autotools project.
 *
 * A project is buildable if it contains both:
 * - package.json (readable)
 * - src/Makefile.am (readable)
 *
 * @param projectDir - Absolute path to check
 * @returns true if both files exist and are readable
 */
export async function isBuildable(projectDir: string): Promise<boolean> {
  try {
    await fs.promises.access(
      path.join(projectDir, "package.json"),
      fs.constants.R_OK
    );
    await fs.promises.access(
      path.join(projectDir, "src", "Makefile.am"),
      fs.constants.R_OK
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a buildable project into Component, System, or Program.
 *
 * Classification algorithm:
 * 1. Read src/Makefile.am
 * 2. If it contains "bin_PROGRAMS" → Program
 * 3. If it contains "lib_LTLIBRARIES" → read configure.ac
 *    a. If configure.ac matches /PKG_CHECK_MODULES\s*\([^)]*\bthe-seed\b/ → System
 *    b. Otherwise → Component
 *
 * @param projectDir - Absolute path with src/Makefile.am and configure.ac
 * @returns The project's tier classification
 * @throws If src/Makefile.am is missing or unreadable
 */
export async function classifyProject(
  projectDir: string
): Promise<ProjectType> {
  const makefileContent = await fs.promises.readFile(
    path.join(projectDir, "src", "Makefile.am"),
    "utf-8"
  );

  if (makefileContent.includes("bin_PROGRAMS")) {
    return ProjectType.Program;
  }

  if (makefileContent.includes("lib_LTLIBRARIES")) {
    try {
      const configureContent = await fs.promises.readFile(
        path.join(projectDir, "configure.ac"),
        "utf-8"
      );
      if (/PKG_CHECK_MODULES\s*\([^)]*\bthe-seed\b/.test(configureContent)) {
        return ProjectType.System;
      }
    } catch {
      // configure.ac not found/readable — treat as Component
    }
    return ProjectType.Component;
  }

  // Fallback: if neither bin_PROGRAMS nor lib_LTLIBRARIES, warn and treat as Component
  console.warn(
    `Warning: ${projectDir}/src/Makefile.am contains neither bin_PROGRAMS nor lib_LTLIBRARIES — classifying as Component`
  );
  return ProjectType.Component;
}

/**
 * Build the complete dependency graph for a project.
 *
 * Algorithm:
 * 1. Read package.json at `projectDir`
 * 2. For each key in `dependencies`:
 *    a. Resolve path via resolveDependencyPath()
 *    b. Check isBuildable(); if false, skip (do NOT recurse)
 *    c. If already visited (by absolute path), skip (dedup)
 *    d. Classify and add to graph
 *    e. Recurse into that dependency
 * 3. Add `projectDir` itself as a node
 *
 * @param projectDir - Absolute path to the root project
 * @returns The complete dependency graph
 * @throws If projectDir has no readable package.json
 */
export async function walkDependencies(
  projectDir: string
): Promise<DependencyGraph> {
  const graph: DependencyGraph = {
    projects: new Map(),
    edges: new Map(),
  };

  await walkRecursive(projectDir, graph);
  return graph;
}

async function walkRecursive(
  projectDir: string,
  graph: DependencyGraph
): Promise<void> {
  const resolvedDir = path.resolve(projectDir);

  // Already visited — skip (deduplicates diamond dependencies)
  if (graph.projects.has(resolvedDir)) {
    return;
  }

  // Read package.json
  const pkgPath = path.join(resolvedDir, "package.json");
  const pkgContent = await fs.promises.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent);

  // Classify this project
  const projectType = await classifyProject(resolvedDir);

  const buildableDeps: string[] = [];
  const edgePaths: string[] = [];
  const deps = pkg.dependencies || {};

  for (const [depName, depVersion] of Object.entries(deps)) {
    const depPath = resolveDependencyPath(
      resolvedDir,
      depName,
      depVersion as string
    );
    const resolvedDepPath = path.resolve(depPath);

    // Check if the dependency is buildable
    const buildable = await isBuildable(resolvedDepPath);
    if (!buildable) {
      continue;
    }

    buildableDeps.push(depName);
    edgePaths.push(resolvedDepPath);

    // Recurse into the dependency (if not already visited)
    if (!graph.projects.has(resolvedDepPath)) {
      await walkRecursive(resolvedDepPath, graph);
    }
  }

  // Add this project to the graph
  const project: BuildableProject = {
    name: pkg.name || path.basename(resolvedDir),
    path: resolvedDir,
    type: projectType,
    dependencies: buildableDeps,
  };

  graph.projects.set(resolvedDir, project);
  graph.edges.set(resolvedDir, edgePaths);
}

/**
 * Produce a build order using Kahn's algorithm with a tier-priority key.
 *
 * When multiple projects have in-degree 0, the one with the lowest
 * ProjectType value (Component < System < Program) is dequeued first.
 * The root project (projectDir) is always placed last in the sequence.
 *
 * @param graph - Dependency graph from walkDependencies()
 * @param rootProjectPath - Absolute path of the invoking project (sorted to end)
 * @returns Ordered array of BuildableProject to build in sequence
 * @throws CyclicDependencyError if the graph contains a cycle
 */
export function resolveBuildOrder(
  graph: DependencyGraph,
  rootProjectPath: string
): BuildableProject[] {
  const resolvedRoot = path.resolve(rootProjectPath);

  // Compute in-degrees
  const inDegree = new Map<string, number>();
  for (const projectPath of graph.projects.keys()) {
    inDegree.set(projectPath, 0);
  }
  for (const [, depPaths] of graph.edges) {
    for (const depPath of depPaths) {
      if (inDegree.has(depPath)) {
        inDegree.set(depPath, (inDegree.get(depPath) || 0) + 1);
      }
    }
  }

  // Reverse edges: for Kahn's, we need to know which projects depend on a given project
  // Actually, Kahn's uses forward edges. Let me re-think.
  // In our graph, edges[A] = [B, C] means "A depends on B and C" (B and C must be built before A).
  // For Kahn's: in-degree of a node = number of projects that must be built before it.
  // Wait no — in-degree = number of edges pointing TO a node.
  // If A depends on B, then there's an edge A -> B (A depends on B).
  // For build ordering, B must come before A.
  // In Kahn's for topological sort on a DAG:
  //   - We want to produce an order where dependencies come first
  //   - The edge "A depends on B" means B -> A in build order
  //   - In-degree: count how many prerequisites each node has
  //   - A node with in-degree 0 has no prerequisites → can be built first

  // Recompute in-degrees correctly:
  // edges[A] = [B, C] means A depends on B and C
  // So A's in-degree should count its dependencies (B and C are prerequisites of A)
  // In-degree of A = number of dependencies of A = edges[A].length
  const correctInDegree = new Map<string, number>();
  for (const projectPath of graph.projects.keys()) {
    const deps = graph.edges.get(projectPath) || [];
    correctInDegree.set(projectPath, deps.length);
  }

  // Seed the ready queue with nodes that have no dependencies (in-degree 0)
  // Use a sorted array as a priority queue (small scale: 2-10 projects)
  let readyQueue: string[] = [];
  for (const [projectPath, deg] of correctInDegree) {
    if (deg === 0) {
      readyQueue.push(projectPath);
    }
  }

  // Sort ready queue by tier priority (lowest ProjectType first), then by name for stability
  const sortReady = (queue: string[]): string[] => {
    return queue.sort((a, b) => {
      const projA = graph.projects.get(a)!;
      const projB = graph.projects.get(b)!;
      if (projA.type !== projB.type) {
        return projA.type - projB.type;
      }
      return projA.name.localeCompare(projB.name);
    });
  };

  readyQueue = sortReady(readyQueue);

  const result: BuildableProject[] = [];
  const processed = new Set<string>();

  while (readyQueue.length > 0) {
    // Dequeue the highest priority (first in sorted queue)
    const current = readyQueue.shift()!;
    processed.add(current);

    const project = graph.projects.get(current)!;

    // Don't add root to result yet — it goes last
    if (current !== resolvedRoot) {
      result.push(project);
    }

    // For each project that depends on `current`, decrement its in-degree
    // We need to find all projects whose edges include `current`
    for (const [projectPath, depPaths] of graph.edges) {
      if (depPaths.includes(current) && !processed.has(projectPath)) {
        const newDeg = (correctInDegree.get(projectPath) || 1) - 1;
        correctInDegree.set(projectPath, newDeg);
        if (newDeg === 0) {
          readyQueue.push(projectPath);
        }
      }
    }

    readyQueue = sortReady(readyQueue);
  }

  // Check for cycles: if we haven't processed all nodes, there's a cycle
  if (processed.size < graph.projects.size) {
    const cycleParticipants: string[] = [];
    for (const [projectPath, project] of graph.projects) {
      if (!processed.has(projectPath)) {
        cycleParticipants.push(project.name);
      }
    }
    throw new CyclicDependencyError(cycleParticipants);
  }

  // Add root project last
  const rootProject = graph.projects.get(resolvedRoot);
  if (rootProject) {
    result.push(rootProject);
  }

  return result;
}
