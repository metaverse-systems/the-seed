import Config from "./Config";
import Build, { autoSignIfCertExists, stripBinaries } from "./Build";
import { runCommand, formatFailureOutput } from "./ProcessRunner";
import {
  runSchedule,
  processorCount,
  effectiveTiers,
  InstallCancelled,
  ProjectOutcome,
  ScheduleContext,
} from "./BuildScheduler";
import {
  BuildStep,
  BuildableProject,
  ProjectFailure,
  RecursiveBuildResult,
  RecursiveBuildOptions,
} from "./types";
import {
  walkDependencies,
  resolveBuildOrder,
} from "./DependencyWalker";

const TIER_NAMES = ["Components", "Systems", "Programs"];

/**
 * Throws a RangeError unless `parallel` is omitted or a positive safe integer.
 */
function validateParallel(parallel: number | undefined): void {
  if (parallel === undefined) return;
  if (!Number.isSafeInteger(parallel) || parallel < 1) {
    throw new RangeError(`parallel must be a positive whole number, got ${parallel}`);
  }
}

/**
 * The environment for build steps when several projects build at once.
 * An inherited MAKEFLAGS or MFLAGS (for example from an outer make) could
 * carry its own -j or jobserver and override each project's job share.
 */
function boundedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MAKEFLAGS;
  delete env.MFLAGS;
  return env;
}

type StepFailure = Omit<ProjectFailure, "project">;

/** One progress line attributed to its project, printed in a single call. */
function progress(project: BuildableProject, message: string): void {
  console.log(`[${project.name}] ${message}`);
}

/**
 * Prints the end-of-build report: each failure's full output as one
 * contiguous block, then the outcome and the projects in each state.
 */
function printReport(result: RecursiveBuildResult, total: number): void {
  if (result.success) {
    console.log(
      `Recursive build complete: ${result.completed.length}/${total} projects built successfully.`
    );
    return;
  }

  for (const failure of result.failures) {
    const name = failure.project.name;
    const body = failure.output.endsWith("\n") ? failure.output : failure.output + "\n";
    console.log("");
    console.log(`===== ${name} failed at ${failure.step} =====\n${body}===== end of ${name} output =====`);
  }

  console.log("");
  console.log(result.cancelled ? "Recursive build cancelled." : "Recursive build failed.");
  const lists: Array<[string, BuildableProject[]]> = [
    ["Completed:", result.completed],
    ["Failed:", result.failures.map((failure) => failure.project)],
    ["Interrupted:", result.interrupted],
    ["Never started:", result.notStarted],
  ];
  for (const [label, projects] of lists) {
    if (projects.length > 0) {
      console.log(`  ${label.padEnd(15)}${projects.map((project) => project.name).join(", ")}`);
    }
  }
}

/**
 * Execute a recursive build across all dependencies of a project.
 *
 * Algorithm:
 * 1. Call walkDependencies(options.projectDir) to discover the graph
 * 2. Call resolveBuildOrder(graph, options.projectDir) to get ordered list
 * 3. Build the projects with runSchedule: up to `parallel` at once (default
 *    1, never more than the processors), each only after its dependencies
 *    and every lower tier have finished, with install, strip and sign of one
 *    project never overlapping another's
 * 4. After the first failure or a cancellation nothing new starts; projects
 *    already building run to the end (or are stopped, when cancelled)
 * 5. Return RecursiveBuildResult
 *
 * At the default limit the same commands run in the same order as a
 * sequential build always has, including an unbounded "make -j".
 *
 * Build failures and cancellation are reported in the result; the promise
 * rejects only for discovery errors and an invalid `parallel`, both before
 * any step runs.
 *
 * @param options - Build configuration including target, project, and callbacks
 * @returns Result describing the outcome of the recursive build
 */
export async function buildRecursive(
  options: RecursiveBuildOptions
): Promise<RecursiveBuildResult> {
  const { target, fullReconfigure, projectDir, signal, callbacks, release } = options;

  validateParallel(options.parallel);

  // Discover dependency graph and resolve build order
  const graph = await walkDependencies(projectDir);
  const buildOrder = resolveBuildOrder(graph, projectDir);
  const total = buildOrder.length;

  const processors = processorCount();
  const concurrency = Math.min(options.parallel ?? 1, processors);
  const env = concurrency > 1 ? boundedEnv() : undefined;

  // Log build plan
  console.log(`Scanning dependencies for ${buildOrder[buildOrder.length - 1]?.name ?? "project"}...`);
  console.log(`Discovered ${total} buildable project${total === 1 ? "" : "s"}`);
  console.log("Build order:");
  for (let i = 0; i < buildOrder.length; i++) {
    const p = buildOrder[i];
    const typeName = ["Component", "System", "Program"][p.type] ?? "Unknown";
    console.log(`  ${i + 1}. ${p.name} (${typeName})`);
  }
  if (concurrency > 1) {
    console.log(
      `Building up to ${concurrency} projects at once (${processors} processors; compile jobs are shared out per tier)`
    );
  }
  console.log("");

  // Tier sizes for the per-tier lines, from the same effective tiers the scheduler uses.
  const announcedTiers = new Set<number>();
  const tierSizes = new Map<number, number>();
  for (const tier of effectiveTiers(buildOrder, graph.edges).values()) {
    tierSizes.set(tier, (tierSizes.get(tier) ?? 0) + 1);
  }

  const config = new Config();
  config.loadConfig();
  const build = new Build(config);

  const runProject = async (
    project: BuildableProject,
    context: ScheduleContext
  ): Promise<ProjectOutcome<StepFailure>> => {
    if (concurrency > 1 && !announcedTiers.has(context.tier)) {
      announcedTiers.add(context.tier);
      const slots = Math.min(concurrency, tierSizes.get(context.tier) ?? 1);
      console.log(
        `${TIER_NAMES[context.tier] ?? "Tier " + context.tier}: up to ${slots} at once, ${context.jobs} compile jobs each`
      );
    }

    callbacks?.onProjectStart?.(project, context.ordinal, total);
    progress(project, `[${context.ordinal + 1}/${total}] starting`);

    const steps = build.getSteps(target, fullReconfigure, context.jobs);
    const installIndex = steps.findIndex((step) => step.label === "install");
    const buildSteps = installIndex === -1 ? steps : steps.slice(0, installIndex);
    const installSteps = installIndex === -1 ? [] : steps.slice(installIndex);

    // Runs one step; returns null when it succeeded or its failure was ignorable.
    const runStep = async (step: BuildStep, stepSignal: AbortSignal): Promise<ProjectOutcome<StepFailure> | null> => {
      if (stepSignal.aborted) {
        return { status: "interrupted" };
      }

      progress(project, `${step.label}...`);

      const run = await runCommand(step.command, { cwd: project.path, signal: stepSignal, env });

      // A step stopped by cancellation is never a failure and never ignorable.
      if (run.killed) {
        return { status: "interrupted" };
      }

      if (run.exitCode !== 0) {
        if (step.ignoreExitCode) {
          // Step like 'make distclean' — ignore failures
          progress(project, `${step.label}... done`);
          callbacks?.onStepComplete?.(project, step);
          return null;
        }
        const output = formatFailureOutput(step.command, run.stdout, run.stderr);
        return { status: "failed", failure: { step: step.label, output } };
      }

      progress(project, `${step.label}... done`);
      callbacks?.onStepComplete?.(project, step);
      return null;
    };

    const buildProject = async (): Promise<ProjectOutcome<StepFailure>> => {
      for (const step of buildSteps) {
        const outcome = await runStep(step, context.signal);
        if (outcome) return outcome;
      }

      // Install, strip and sign hold the install lock: every project installs
      // into the same prefix. Strip and sign run after install because libtool
      // relinks binaries during "make install", which would invalidate any
      // earlier embedded signatures.
      if (context.signal.aborted) {
        return { status: "interrupted" };
      }
      return context.withInstallLock(async (installSignal): Promise<ProjectOutcome<StepFailure>> => {
        for (const step of installSteps) {
          const stepOutcome = await runStep(step, installSignal);
          if (stepOutcome) return stepOutcome;
        }

        const log = (line: string) => progress(project, line);

        if (release) {
          try {
            await stripBinaries(project.path, target, installSignal, log);
          } catch (e: unknown) {
            if (installSignal.aborted) return { status: "interrupted" };
            return { status: "failed", failure: { step: "strip", output: (e as Error).message ?? String(e) } };
          }
        }

        try {
          const signConfig = new Config();
          signConfig.loadConfig();
          await autoSignIfCertExists(signConfig.configDir, project.path, log);
        } catch (e: unknown) {
          return { status: "failed", failure: { step: "sign", output: (e as Error).message ?? String(e) } };
        }

        return { status: "completed" };
      });
    };

    let outcome: ProjectOutcome<StepFailure>;
    try {
      outcome = await buildProject();
    } catch (e: unknown) {
      // A cancellation withdrew this project's request for the install lock.
      if (!(e instanceof InstallCancelled)) throw e;
      outcome = { status: "interrupted" };
    }

    if (outcome.status === "completed") {
      callbacks?.onProjectComplete?.(project, context.ordinal, total);
      progress(project, "completed");
    } else if (outcome.status === "failed") {
      progress(project, `failed at ${outcome.failure.step}`);
    } else {
      progress(project, "interrupted");
    }
    return outcome;
  };

  const schedule = await runSchedule<StepFailure>({
    order: buildOrder,
    edges: graph.edges,
    concurrency,
    processorCount: processors,
    signal,
    forceSignal: options.forceSignal,
    runProject,
  });

  const failures: ProjectFailure[] = schedule.failures.map(({ project, failure }) => {
    const stepFailure = failure as StepFailure | undefined;
    if (stepFailure && typeof stepFailure.step === "string") {
      return { project, step: stepFailure.step, output: stepFailure.output };
    }
    return { project, step: "build", output: failure instanceof Error ? failure.message : String(failure) };
  });
  const stateOf = (project: BuildableProject) => schedule.states.get(project.path)?.state;
  const failed = failures[0]?.project ?? null;

  const result: RecursiveBuildResult = {
    success: schedule.completionOrder.length === total,
    completed: schedule.completionOrder,
    failed,
    failureOutput: failures[0]?.output ?? null,
    remaining: buildOrder.filter((project) => stateOf(project) !== "completed" && project !== failed),
    cancelled: schedule.cancelled,
    failures,
    interrupted: buildOrder.filter((project) => stateOf(project) === "interrupted"),
    notStarted: buildOrder.filter((project) => stateOf(project) === "notStarted"),
  };

  // Printed only after every project has settled, so no failure block can
  // interleave with progress lines.
  printReport(result, total);
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
