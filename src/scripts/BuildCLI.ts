import os from "os";
import Config from "../Config";
import Build from "../Build";
import { ScriptArgsType } from "../types";
import { buildRecursive } from "../RecursiveBuild";
import { DependencyDiscoveryError } from "../DependencyWalker";
import { NativeComponentMissingError } from "../NativeComponent";
import { parseBuildArgs, optionHelp, VALID_OPTIONS_LINE } from "../BuildArgs";

const printHelp = () => {
  const options = optionHelp();
  const width = Math.max(...options.map((option) => option.usage.length)) + 2;

  console.log("\nUsage: the-seed build <target> [--recursive] [--parallel N] [--jobs N] [--release]");
  console.log("       the-seed build [--jobs N]      Rebuild the current project (make, install, sign)");
  console.log("\nAvailable build targets:");
  console.log("  native   - Builds for the current Linux environment");
  console.log("  windows  - Cross-compiles for Windows using MinGW");
  console.log("\nOptions (any order, after the target):");
  for (const option of options) {
    console.log(`  ${option.usage.padEnd(width)}${option.help}`);
  }
  console.log("  --parallel=N and --jobs=N are the same as --parallel N and --jobs N. --parallel above the processor count, or above --jobs, is reduced to it.");
  console.log("\nExamples:");
  console.log("  the-seed build native                                  - Build for Linux");
  console.log("  the-seed build native --jobs 4                         - Build for Linux with at most 4 compile jobs");
  console.log("  the-seed build native --release                        - Build for Linux (stripped)");
  console.log("  the-seed build native --recursive                      - Build all deps + project for Linux");
  console.log("  the-seed build native --recursive --parallel 4 --release");
  console.log("                                                         - Same, up to 4 projects at once (stripped)");
  console.log("  the-seed build windows                                 - Build for Windows (MinGW)");
  console.log("  the-seed build windows --recursive --release           - Build all deps + project for Windows (stripped)");
  console.log("\nInstalling: \"make install\" runs into a staging directory; the programs and shared libraries it");
  console.log("installed, and their copies in src/ and src/.libs/ that \"the-seed package\" reads, are stripped");
  console.log("(with --release) and signed with the project's scope certificate, and only then is everything");
  console.log("moved into the prefix. Archives, import libraries, wrappers and other files are not stripped");
  console.log("or signed. A failure leaves the prefix as it was. Without a certificate the build says so in");
  console.log("one line and installs unsigned files.");
  console.log("With --recursive, dependencies always finish installing before anything that needs them");
  console.log("starts, and all components finish before systems, and systems before programs. Install");
  console.log("phases never overlap.");
  console.log("With --recursive and --parallel above 1, the compile jobs of the projects building at once");
  console.log("never add up to more than --jobs, or the processor count when --jobs is not given.");
  console.log("\nPress Ctrl+C once to stop the running builds; an install in progress finishes first.");
  console.log("Press it again to stop at once; an install that has not reached the prefix is discarded.");
  console.log("\nThe bare word \"recursive\" after the target is deprecated; it still works for now");
  console.log("but prints a warning. Use --recursive instead.");
};

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
  run: (signals: { signal: AbortSignal; forceSignal: AbortSignal }) => Promise<boolean>
): Promise<void> => {
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
    const cancelled = await run({ signal: cancel.signal, forceSignal: force.signal });
    if (cancelled) {
      process.exitCode = firstSignal ? 128 + os.constants.signals[firstSignal] : 1;
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGHUP", onTerminate);
  }
};

const runRecursiveBuild = (target: string, release: boolean, parallel: number, jobs: number | undefined) =>
  withCancellation(async ({ signal, forceSignal }) => {
    let result;
    try {
      result = await buildRecursive({
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
      if (error instanceof DependencyDiscoveryError || error instanceof NativeComponentMissingError) {
        console.error(error.message);
        process.exitCode = 1;
        return false;
      }
      throw error;
    }
    if (!result.cancelled && !result.success) {
      process.exitCode = 1;
    }
    return result.cancelled === true;
  });

/** Runs a plain (target given) or incremental (no target) build of the current project. */
const runProjectBuild = (build: Build, configDir: string, target: "native" | "windows" | undefined, release: boolean, jobs: number | undefined) =>
  withCancellation(async ({ signal, forceSignal }) => {
    let result;
    try {
      result = await build.buildProject({
        projectDir: process.cwd(),
        target,
        release,
        jobs,
        configDir,
        signal,
        forceSignal,
      });
    } catch (error) {
      if (error instanceof NativeComponentMissingError) {
        console.error(error.message);
        process.exitCode = 1;
        return false;
      }
      throw error;
    }
    if (result.status === "failed") {
      console.error(`Build failed at ${result.step}: ${result.message}.`);
      process.exitCode = 1;
    } else if (result.status === "cancelled") {
      console.error(result.installed ? "Build cancelled after installing." : "Build cancelled.");
    }
    return result.status === "cancelled";
  });

const BuildCLI = async (scriptConfig: ScriptArgsType) => {
  // Validate every argument before any work, so a typo never starts a build.
  const parsed = parseBuildArgs(scriptConfig.args.slice(3));
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(VALID_OPTIONS_LINE);
    console.error("Run \"the-seed build help\" for details.");
    process.exitCode = 1;
    return;
  }
  const request = parsed.request;

  if (request.mode === "help") {
    printHelp();
    return;
  }

  const config = new Config(scriptConfig.configDir);
  const build = new Build(config);

  if (request.mode === "incremental") {
    return runProjectBuild(build, scriptConfig.configDir, undefined, false, request.jobs);
  }

  const target = request.target as "native" | "windows";

  if (request.recursive) {
    if (request.deprecatedBareWord) {
      console.error("Warning: \"recursive\" is deprecated; use \"--recursive\" instead.");
    }
    return runRecursiveBuild(target, request.release, request.parallel, request.jobs);
  }

  return runProjectBuild(build, scriptConfig.configDir, target, request.release, request.jobs);
};

export default BuildCLI;
