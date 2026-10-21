import Config from "./Config";
import { BuildStep, ProjectBuildOptions, ProjectBuildResult } from "./types";
import { processorCount } from "./BuildScheduler";
import { autotoolsSteps } from "./AutotoolsSteps";
import { librarySearchEnv } from "./LibrarySearch";
import { runStep, stepText } from "./StepRunner";
import { runInstallPhase } from "./InstallPhase";
import { requireNativeComponent } from "./NativeComponent";

export const targets: {
  [key: string]: string;
} = {
  native: "x86_64-linux-gnu",
  windows: "x86_64-w64-mingw32",
};

/** The tool's own output streams, used when a build is given no sink. */
const ownOutput = {
  stdout: (chunk: Buffer) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk: Buffer) => {
    process.stderr.write(chunk);
  },
};

class Build {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Builds the project in `options.projectDir`: a full build (autogen,
   * distclean, configure, compile, install) when a target is given, otherwise
   * an incremental one (compile and install). The install step runs as the
   * install phase: the installed programs and libraries are stripped (a
   * release build with a target) and signed (when the project's scope has a
   * certificate) before they are placed in the prefix.
   *
   * Rejects with NativeComponentMissingError, before any step, for a Windows
   * target when the native component is unavailable. An incremental build (no
   * target) is not checked here: its install phase fails as step "sign" when
   * it installs a Windows program.
   *
   * Each step's output is passed on as it arrives, never kept, so a build can
   * write any amount. The first cancellation stops the running step and
   * starts no other; the install phase runs under the force signal so a
   * single Ctrl+C lets an install in progress finish.
   */
  async buildProject(options: ProjectBuildOptions): Promise<ProjectBuildResult> {
    // A Windows build signs and strips Windows programs, which needs the native component; an incremental build
    // (no target) is stopped by the install phase instead, only when it installs a Windows program
    if (options.target === "windows") {
      requireNativeComponent();
    }

    const log = options.log ?? ((line: string) => console.log(line));
    const output = options.output ?? ownOutput;
    const fullReconfigure = options.target !== undefined;
    const target = options.target ?? "native";

    const steps = this.getSteps(target, fullReconfigure, options.jobs, options.env);

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const isInstall = step.label === "install";
      if (isInstall && (options.signal?.aborted || options.forceSignal?.aborted)) {
        return { status: "cancelled" };
      }

      options.onStepStart?.(step, index, steps.length);
      const text = stepText(step);
      log(`==> ${step.label}: ${text}`);

      if (isInstall) {
        const phase = await runInstallPhase({
          projectDir: options.projectDir,
          configPrefix: this.config.config.prefix,
          configDir: options.configDir,
          target: options.target,
          release: options.release,
          installStep: step,
          env: options.env,
          signal: options.forceSignal,
          output: { mode: "stream", output },
          log,
        });
        switch (phase.status) {
          case "completed":
            // One cancellation during the phase lets it finish; say so
            return options.signal?.aborted ? { status: "cancelled", installed: true } : { status: "completed" };
          case "failed":
            return { status: "failed", step: phase.step, message: phase.message };
          case "interrupted":
            return { status: "cancelled" };
        }
      }

      const outcome = await runStep(step, {
        baseDir: options.projectDir,
        baseEnv: options.env,
        signal: options.signal,
        output: { mode: "stream", output },
      });

      switch (outcome.status) {
        case "interrupted":
          return { status: "cancelled" };
        case "notFound":
          return { status: "failed", step: step.label, message: outcome.message };
        case "failed":
          return {
            status: "failed",
            step: step.label,
            message: outcome.exitCode === null ? `${text} was ended by ${outcome.signal}` : `${text} exited with status ${outcome.exitCode}`,
          };
        case "ignored":
          log(`${step.label} exited with status ${outcome.exitCode}; ignored.`);
          break;
        case "completed":
          break;
      }
    }

    return { status: "completed" };
  }

  /**
   * Returns an ordered array of BuildStep objects for the given target and mode.
   * @param target - 'native' or 'windows'
   * @param fullReconfigure - if true, includes autogen/distclean/configure steps; if false, only compile+install
   * @param jobs - compile job limit; defaults to the processor count, so the compile step is always "make -j<jobs>"
   * @param inherited - the environment whose PKG_CONFIG_PATH the library search extends; defaults to process.env
   */
  getSteps(
    target: string,
    fullReconfigure: boolean,
    jobs: number = processorCount(),
    inherited: NodeJS.ProcessEnv = process.env
  ): BuildStep[] {
    const newTarget = targets[target];
    const prefix = this.config.config.prefix + "/" + newTarget;

    return autotoolsSteps({
      prefix,
      host: target === "windows" ? targets["windows"] : null,
      jobs,
      env: librarySearchEnv(this.config.config.prefix, target, inherited),
      reconfigure: fullReconfigure,
      distclean: true,
    });
  }

  /**
   * Get the install prefix directory for the given target (native by default).
   */
  getInstallPrefix(target = "native"): string {
    return this.config.config.prefix + "/" + targets[target];
  }
}

/**
 * Extract the scope (org) from a scoped package name.
 * e.g., "@metaverse-systems/libecs-cpp" → "@metaverse-systems"
 * Returns undefined if the name is not scoped.
 */
export function extractScope(packageName: string): string | undefined {
  if (packageName.startsWith("@")) {
    const slashIndex = packageName.indexOf("/");
    if (slashIndex > 0) {
      return packageName.substring(0, slashIndex);
    }
  }
  return undefined;
}

/**
 * Returns the appropriate strip tool name for the given build target.
 * @internal Exported for unit testing
 */
export function getStripTool(target: string): string {
  if (target === "native") {
    return "strip";
  }
  return targets[target] + "-strip";
}

export default Build;
