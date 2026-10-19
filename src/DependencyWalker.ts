import fs from "fs";
import path from "path";
import {
  ProjectType,
  BuildableProject,
  DependencyGraph,
} from "./types";

/**
 * Base class of the errors that stop dependency discovery because of what
 * the projects declare or contain.
 */
export class DependencyDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "DependencyDiscoveryError";
  }
}

/**
 * Error thrown when projects depend on each other in a cycle, including a
 * project that declares itself.
 */
export class CyclicDependencyError extends DependencyDiscoveryError {
  /** Names of projects involved in the cycle, starting where the cycle was entered */
  cycleParticipants: string[];
  /** The participants followed by the first one again */
  chain: string[];
  /** Real locations of the participants, in the same order; empty when unknown */
  locations: string[];

  /**
   * @param participants - Project names of the cycle, without the repeated first name
   * @param locations - Real locations of the participants in the same order; omitted for the defensive check of resolveBuildOrder
   */
  constructor(participants: string[], locations?: string[]) {
    const chain = [...participants, participants[0]];
    const lines = [`Dependency cycle: ${chain.join(" → ")}`];
    if (locations && locations.length === participants.length) {
      participants.forEach((name, index) => {
        lines.push(`  ${name}  ${locations[index]}`);
      });
      lines.push(
        participants.length === 1
          ? "The project declares itself in its package.json \"dependencies\"; remove that declaration."
          : "Each project above declares the next one in its package.json \"dependencies\"; remove the declaration that closes the cycle."
      );
    } else {
      lines.push(
        "Each project above declares the next one in its package.json \"dependencies\"; remove the declaration that closes the cycle."
      );
    }
    super(lines.join("\n"));
    this.name = "CyclicDependencyError";
    this.cycleParticipants = participants;
    this.chain = chain;
    this.locations = locations ?? [];
  }
}

/**
 * Error thrown when two different projects provide the same package name.
 */
export class ConflictingProjectError extends DependencyDiscoveryError {
  /** The package name both projects carry */
  packageName: string;
  /** Real locations of the two projects, in the order found */
  locations: string[];

  constructor(packageName: string, first: string, second: string) {
    super(
      [
        `Two different projects are named ${packageName}:`,
        `  ${first}`,
        `  ${second}`,
        `Make every declaration of ${packageName} lead to the same directory, or give one of them another name.`,
      ].join("\n")
    );
    this.name = "ConflictingProjectError";
    this.packageName = packageName;
    this.locations = [first, second];
  }
}

/**
 * Error thrown when a project's package.json cannot be read or parsed.
 */
export class ProjectManifestError extends DependencyDiscoveryError {
  /** Path of the package.json file */
  manifestPath: string;
  /** Why it could not be read */
  reason: string;

  constructor(manifestPath: string, reason: string) {
    super(`Cannot read ${manifestPath}: ${reason}`);
    this.name = "ProjectManifestError";
    this.manifestPath = manifestPath;
    this.reason = reason;
  }
}

/**
 * Error thrown when a stop request ends dependency discovery. It is not a
 * discovery failure of the projects.
 */
export class DiscoveryCancelledError extends Error {
  constructor() {
    super("Dependency discovery cancelled");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "DiscoveryCancelledError";
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
 * The walk is depth-first. A project is identified by its real location
 * (symbolic links resolved), so a project reached through different paths is
 * one project. A project is marked visited on entering, before its
 * dependencies are walked, and kept on a stack until it is left:
 *
 * 1. Read package.json at the project's real location
 * 2. For each key in `dependencies`, in package.json order:
 *    a. Resolve the path via resolveDependencyPath() and then its real
 *       location; a path that cannot be resolved is not a project
 *    b. Skip it unless isBuildable()
 *    c. On the stack → CyclicDependencyError naming the chain
 *    d. Already visited → record the edge only
 *    e. Otherwise read its package.json and walk it
 *
 * Edges are recorded once per dependency project and `dependencies` lists the
 * dependency projects' package names in declaration order. A package name found
 * at two different real locations is a ConflictingProjectError.
 *
 * Projects appear in the graph in the order they were entered (root first).
 * A stop request is looked for before each package.json is read and once
 * more when the walk ends.
 *
 * @param projectDir - Path of the root project
 * @param options - `signal` ends discovery with DiscoveryCancelledError when aborted
 * @returns The complete dependency graph, keyed by real location
 * @throws CyclicDependencyError if projects depend on each other, including a project on itself
 * @throws ConflictingProjectError if two different projects carry one package name
 * @throws ProjectManifestError if a package.json (the root's included) cannot be read or parsed
 * @throws DiscoveryCancelledError if the signal is aborted during discovery
 */
export async function walkDependencies(
  projectDir: string,
  options?: { signal?: AbortSignal }
): Promise<DependencyGraph> {
  const graph: DependencyGraph = {
    projects: new Map(),
    edges: new Map(),
  };
  const walk: WalkState = {
    graph,
    stack: [],
    byName: new Map(),
    signal: options?.signal,
  };

  const rootDir = await realLocation(path.resolve(projectDir));
  await walkProject(rootDir, walk);
  throwIfCancelled(walk.signal);
  return graph;
}

interface WalkState {
  graph: DependencyGraph;
  /** Projects being walked, root first */
  stack: BuildableProject[];
  /** Real location of the first project found under each package name */
  byName: Map<string, string>;
  signal?: AbortSignal;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DiscoveryCancelledError();
  }
}

async function realLocation(dir: string): Promise<string> {
  return fs.promises.realpath(dir).catch(() => dir);
}

async function readManifest(
  projectDir: string
): Promise<{ name?: string; dependencies?: Record<string, string> }> {
  const manifestPath = path.join(projectDir, "package.json");
  try {
    const parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new ProjectManifestError(
      manifestPath,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function walkProject(projectDir: string, walk: WalkState): Promise<void> {
  throwIfCancelled(walk.signal);
  const manifest = await readManifest(projectDir);
  const projectType = await classifyProject(projectDir);

  const name = manifest.name || path.basename(projectDir);
  const known = walk.byName.get(name);
  if (known !== undefined && known !== projectDir) {
    throw new ConflictingProjectError(name, known, projectDir);
  }
  walk.byName.set(name, projectDir);

  const project: BuildableProject = {
    name,
    path: projectDir,
    type: projectType,
    dependencies: [],
  };
  const edgePaths: string[] = [];
  walk.graph.projects.set(projectDir, project);
  walk.graph.edges.set(projectDir, edgePaths);
  walk.stack.push(project);

  for (const [depName, depVersion] of Object.entries(manifest.dependencies || {})) {
    const declared = resolveDependencyPath(projectDir, depName, depVersion as string);
    let depDir: string;
    try {
      depDir = await fs.promises.realpath(declared);
    } catch {
      continue;
    }
    if (!(await isBuildable(depDir))) {
      continue;
    }

    const onStack = walk.stack.findIndex((entry) => entry.path === depDir);
    if (onStack >= 0) {
      const members = walk.stack.slice(onStack);
      throw new CyclicDependencyError(
        members.map((entry) => entry.name),
        members.map((entry) => entry.path)
      );
    }

    if (!walk.graph.projects.has(depDir)) {
      await walkProject(depDir, walk);
    }
    if (!edgePaths.includes(depDir)) {
      edgePaths.push(depDir);
      project.dependencies.push(walk.graph.projects.get(depDir)!.name);
    }
  }

  walk.stack.pop();
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
  let resolvedRoot = path.resolve(rootProjectPath);
  try {
    resolvedRoot = fs.realpathSync(resolvedRoot);
  } catch {
    // keep the resolved path
  }

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
    cycleParticipants.sort();
    throw new CyclicDependencyError(cycleParticipants);
  }

  // Add root project last
  const rootProject = graph.projects.get(resolvedRoot);
  if (rootProject) {
    result.push(rootProject);
  }

  return result;
}
