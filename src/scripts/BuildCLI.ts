import os from "os";
import Config from "../Config";
import Build from "../Build";
import { buildRecursive } from "../RecursiveBuild";
import { DependencyDiscoveryError } from "../DependencyWalker";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { FailedError, HandlerResult } from "../cli/ExitStatus";

/** How a build ended: stopped by a signal, failed, or neither. */
interface BuildOutcome {
  cancelled: boolean;
  failed: boolean;
}

/**
 * Runs a build with Ctrl+C, SIGTERM and SIGHUP turned into cancellation.
 * Build steps run in their own process groups, so a terminal Ctrl+C reaches
 * only this process: the first one stops running steps but lets an install in
 * progress finish, the second also stops the install. SIGTERM and SIGHUP stop
 * everything at once. `run` resolves true when the build was cancelled; the
 * exit status is then 128 plus the number of the first signal received, the
 * status the shell saw when that signal used to kill the tool outright.
 */
const withCancellation = async (
  run: (signals: { signal: AbortSignal; forceSignal: AbortSignal }) => Promise<BuildOutcome>
): Promise<HandlerResult> => {
  const cancel = new AbortController();
  const force = new AbortController();
  let firstSignal: NodeJS.Signals | undefined;

  const onInterrupt = () => {
    firstSignal = firstSignal ?? "SIGINT";
    if (!cancel.signal.aborted) {
      console.error("Cancelling: stopping running builds; an install in progress will finish. Press Ctrl+C again to force.");
      cancel.abort();
    } else {
      force.abort();
    }
  };
  const onTerminate = (signal: NodeJS.Signals) => {
    firstSignal = firstSignal ?? signal;
    cancel.abort();
    force.abort();
  };

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onTerminate);
  try {
    const outcome = await run({ signal: cancel.signal, forceSignal: force.signal });
    if (outcome.cancelled) {
      return { status: firstSignal ? 128 + os.constants.signals[firstSignal] : 1 };
    }
    if (outcome.failed) {
      throw new FailedError("Build failed.", { reported: true });
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGHUP", onTerminate);
  }
};

const runRecursiveBuild = (config: Config, target: string, release: boolean, parallel: number, jobs: number | undefined) =>
  withCancellation(async ({ signal, forceSignal }) => {
    let result;
    try {
      result = await buildRecursive({
        config,
        target,
        fullReconfigure: true,
        projectDir: process.cwd(),
        release,
        parallel,
        jobs,
        signal,
        forceSignal,
      });
    } catch (error) {
      if (error instanceof DependencyDiscoveryError) {
        console.error(error.message);
        return { cancelled: false, failed: true };
      }
      throw error;
    }
    return { cancelled: result.cancelled === true, failed: !result.cancelled && !result.success };
  });

/** Runs a plain (target given) or incremental (no target) build of the current project. */
const runProjectBuild = (build: Build, configDir: string, target: "native" | "windows" | undefined, release: boolean, jobs: number | undefined) =>
  withCancellation(async ({ signal, forceSignal }) => {
    const result = await build.buildProject({
      projectDir: process.cwd(),
      target,
      release,
      jobs,
      configDir,
      signal,
      forceSignal,
    });
    if (result.status === "failed") {
      console.error(`Build failed at ${result.step}: ${result.message}.`);
    } else if (result.status === "cancelled") {
      console.error(result.installed ? "Build cancelled after installing." : "Build cancelled.");
    }
    return { cancelled: result.status === "cancelled", failed: result.status === "failed" };
  });

const BuildCLI = async (parsed: ParsedCommand, context: CliContext): Promise<HandlerResult> => {
  const target = parsed.positionals.target as "native" | "windows" | undefined;
  const release = parsed.options.release === true;
  const jobs = parsed.options.jobs as number | undefined;

  const config = new Config(context.configDir);
  const build = new Build(config);

  if (target === undefined) {
    return runProjectBuild(build, context.configDir, undefined, false, jobs);
  }

  if (parsed.options.recursive === true) {
    const parallel = (parsed.options.parallel as number | undefined) ?? 1;
    return runRecursiveBuild(config, target, release, parallel, jobs);
  }

  return runProjectBuild(build, context.configDir, target, release, jobs);
};

export default BuildCLI;
