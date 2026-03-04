import { execSync } from "child_process";
import Config from "./Config";
import Build, { autoSignIfCertExists, stripBinaries } from "./Build";
import {
  BuildStep,
  BuildableProject,
  RecursiveBuildResult,
  RecursiveBuildOptions,
} from "./types";
import {
  walkDependencies,
  resolveBuildOrder,
} from "./DependencyWalker";

/**
 * Execute a recursive build across all dependencies of a project.
 *
 * Algorithm:
 * 1. Call walkDependencies(options.projectDir) to discover the graph
 * 2. Call resolveBuildOrder(graph, options.projectDir) to get ordered list
 * 3. For each project in order:
 *    a. Change cwd to project.path
 *    b. Generate steps via Build.getSteps(target, fullReconfigure)
 *    c. Execute steps sequentially
 *    d. On failure: populate `failed`, `failureOutput`, `remaining`; stop.
 *    e. On cancel (signal.aborted): set `cancelled = true`; stop.
 *    f. On success: add to `completed`
 * 4. Return RecursiveBuildResult
 *
 * @param options - Build configuration including target, project, and callbacks
 * @returns Result describing the outcome of the recursive build
 */
export async function buildRecursive(
  options: RecursiveBuildOptions
): Promise<RecursiveBuildResult> {
  const { target, fullReconfigure, projectDir, signal, callbacks, release } = options;

  // Discover dependency graph and resolve build order
  const graph = await walkDependencies(projectDir);
  const buildOrder = resolveBuildOrder(graph, projectDir);
  const total = buildOrder.length;

  const result: RecursiveBuildResult = {
    success: false,
    completed: [],
    failed: null,
    failureOutput: null,
    remaining: [],
    cancelled: false,
  };

  // Log build plan
  console.log(`Scanning dependencies for ${buildOrder[buildOrder.length - 1]?.name ?? "project"}...`);
  console.log(`Discovered ${total} buildable project${total === 1 ? "" : "s"}`);
  console.log("Build order:");
  for (let i = 0; i < buildOrder.length; i++) {
    const p = buildOrder[i];
    const typeName = ["Component", "System", "Program"][p.type] ?? "Unknown";
    console.log(`  ${i + 1}. ${p.name} (${typeName})`);
  }
  console.log("");

  // Build each project in order
  for (let i = 0; i < buildOrder.length; i++) {
    const project = buildOrder[i];

    // Check cancellation before starting
    if (signal?.aborted) {
      result.cancelled = true;
      result.remaining = buildOrder.slice(i);
      return result;
    }

    // Notify callbacks
    callbacks?.onProjectStart?.(project, i, total);

    console.log(`[${i + 1}/${total}] Building ${project.name}...`);

    // Generate build steps for this project
    const config = new Config();
    config.loadConfig();
    const build = new Build(config);
    const steps = build.getSteps(target, fullReconfigure);

    // Execute each step
    let stepFailed = false;
    let failOutput = "";

    for (const step of steps) {
      // Check cancellation before each step
      if (signal?.aborted) {
        result.cancelled = true;
        result.remaining = buildOrder.slice(i);
        return result;
      }

      console.log(`  ${step.label}...`);

      try {
        execSync(step.command, {
          cwd: project.path,
          stdio: "pipe",
        });
        console.log(`  ${step.label}... done`);
        callbacks?.onStepComplete?.(project, step);
      } catch (e: unknown) {
        if (step.ignoreExitCode) {
          // Step like 'make distclean' — ignore failures
          callbacks?.onStepComplete?.(project, step);
          continue;
        }

        // Capture failure output
        const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
        failOutput =
          (err.stderr?.toString() ?? "") +
          (err.stdout?.toString() ?? "") +
          (err.message ?? "");

        stepFailed = true;
        break;
      }

      // Strip and sign after install — libtool relinks binaries during
      // "make install", which would invalidate any earlier embedded signatures.
      if (step.label === "install") {
        if (release) {
          await stripBinaries(project.path, target);
        }
        const signConfig = new Config();
        signConfig.loadConfig();
        await autoSignIfCertExists(signConfig.configDir, project.path);
      }
    }

    if (stepFailed) {
      result.failed = project;
      result.failureOutput = failOutput;
      result.remaining = buildOrder.slice(i + 1);
      console.log(`\nBuild failed on ${project.name}`);
      return result;
    }

    // Project built successfully
    result.completed.push(project);
    callbacks?.onProjectComplete?.(project, i, total);
    console.log("");
  }

  result.success = true;
  console.log(
    `Recursive build complete: ${result.completed.length}/${total} projects built successfully.`
  );
  return result;
}

/**
 * Generate a flat list of all build steps across all projects, in dependency order.
 * Useful for dry-run / preview in VS Code progress UI.
 *
 * @param projectDir - Absolute path of the root project
 * @param target - 'native' or 'windows'
 * @param fullReconfigure - Whether to include autogen/configure steps
 * @returns Array of { project, steps } tuples in build order
 */
export async function getRecursiveBuildSteps(
  projectDir: string,
  target: string,
  fullReconfigure: boolean
): Promise<Array<{ project: BuildableProject; steps: BuildStep[] }>> {
  const graph = await walkDependencies(projectDir);
  const buildOrder = resolveBuildOrder(graph, projectDir);

  const config = new Config();
  config.loadConfig();
  const build = new Build(config);

  return buildOrder.map((project) => ({
    project,
    steps: build.getSteps(target, fullReconfigure),
  }));
}
