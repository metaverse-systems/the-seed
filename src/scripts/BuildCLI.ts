import os from "os";
import Config from "../Config";
import Build, { autoSignIfCertExists, stripBinaries } from "../Build";
import { ScriptArgsType } from "../types";
import { buildRecursive } from "../RecursiveBuild";
import { parseBuildArgs, optionHelp, VALID_OPTIONS_LINE } from "../BuildArgs";

const printHelp = () => {
  const options = optionHelp();
  const width = Math.max(...options.map((option) => option.usage.length)) + 2;

  console.log("\nUsage: the-seed build <target> [--recursive] [--parallel N] [--release]");
  console.log("       the-seed build                 Rebuild the current project (make, install, sign)");
  console.log("\nAvailable build targets:");
  console.log("  native   - Builds for the current Linux environment");
  console.log("  windows  - Cross-compiles for Windows using MinGW");
  console.log("\nOptions (any order, after the target):");
  for (const option of options) {
    console.log(`  ${option.usage.padEnd(width)}${option.help}`);
  }
  console.log("  --parallel=N is the same as --parallel N; N above the processor count is reduced to it.");
  console.log("\nExamples:");
  console.log("  the-seed build native                                  - Build for Linux");
  console.log("  the-seed build native --release                        - Build for Linux (stripped)");
  console.log("  the-seed build native --recursive                      - Build all deps + project for Linux");
  console.log("  the-seed build native --recursive --parallel 4 --release");
  console.log("                                                         - Same, up to 4 projects at once (stripped)");
  console.log("  the-seed build windows                                 - Build for Windows (MinGW)");
  console.log("  the-seed build windows --recursive --release           - Build all deps + project for Windows (stripped)");
  console.log("\nWith --recursive, dependencies always finish installing before anything that needs them");
  console.log("starts, and all components finish before systems, and systems before programs. Installs");
  console.log("(with strip and sign) never overlap. With --parallel above 1, the compile jobs of the");
  console.log("projects building at once never add up to more than the processor count.");
  console.log("\nPress Ctrl+C once to stop the running builds; an install in progress finishes first.");
  console.log("Press it again to stop at once.");
  console.log("\nThe bare word \"recursive\" after the target is deprecated; it still works for now");
  console.log("but prints a warning. Use --recursive instead.");
};

/**
 * Runs a recursive build with Ctrl+C, SIGTERM and SIGHUP turned into
 * cancellation. Build steps run in their own process groups, so a terminal
 * Ctrl+C reaches only this process: the first one stops running steps but
 * lets an install in progress finish, the second also stops the install.
 * SIGTERM and SIGHUP stop everything at once. A cancelled build exits with
 * 128 plus the number of the first signal received, the status the shell saw
 * when that signal used to kill the tool outright.
 */
const runRecursiveBuild = async (target: string, release: boolean, parallel: number) => {
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
    const result = await buildRecursive({
      target,
      fullReconfigure: true,
      projectDir: process.cwd(),
      release,
      parallel,
      signal: cancel.signal,
      forceSignal: force.signal,
    });
    if (result.cancelled) {
      process.exitCode = firstSignal ? 128 + os.constants.signals[firstSignal] : 1;
    } else if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGHUP", onTerminate);
  }
};

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
    build.compile();
    build.install();
    await autoSignIfCertExists(scriptConfig.configDir);
    return;
  }

  const target = request.target as string;

  if (request.recursive) {
    if (request.deprecatedBareWord) {
      console.error("Warning: \"recursive\" is deprecated; use \"--recursive\" instead.");
    }
    await runRecursiveBuild(target, request.release, request.parallel);
    return;
  }

  build.reconfigure(target);
  build.compile();
  build.install();
  if (request.release) {
    await stripBinaries(process.cwd(), target);
  }
  await autoSignIfCertExists(scriptConfig.configDir);
};

export default BuildCLI;
