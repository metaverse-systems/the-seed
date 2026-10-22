import type { BuildStep } from "./types";

/**
 * What the autotools steps of a build or a library install depend on.
 */
export interface AutotoolsStepOptions {
  /** The `--prefix` value. */
  prefix: string;
  /** The `--host` value, or null for none. Each caller computes it. */
  host: string | null;
  /** The job count of the compile step (`make -j<jobs>`). */
  jobs: number;
  /** The environment of the configure step. */
  env: Record<string, string>;
  /** Include the autogen and configure steps. */
  reconfigure: boolean;
  /** Include `make distclean` (its exit status ignored) between autogen and configure. */
  distclean: boolean;
  /** The working directory of every step, or none. */
  cwd?: string;
  /** Put "<labelPrefix> " before each label, or none. */
  labelPrefix?: string;
}

/**
 * The steps that build and install an autotools project: autogen, an optional
 * distclean, configure (when reconfiguring), then compile and install.
 * @param options - the prefix, host, job count, environment and the variations of the list
 * @returns the steps in the order they run
 */
export function autotoolsSteps(options: AutotoolsStepOptions): BuildStep[] {
  const label = (name: string): string => options.labelPrefix ? `${options.labelPrefix} ${name}` : name;
  const withCwd = (step: BuildStep): BuildStep => options.cwd !== undefined ? { ...step, cwd: options.cwd } : step;

  const steps: BuildStep[] = [];

  if (options.reconfigure) {
    steps.push(withCwd({ label: label("autogen"), program: "./autogen.sh", args: [] }));

    if (options.distclean) {
      steps.push(withCwd({ label: label("distclean"), program: "make", args: ["distclean"], ignoreExitCode: true }));
    }

    steps.push(withCwd({
      label: label("configure"),
      program: "./configure",
      args: [
        "--prefix=" + options.prefix,
        ...(options.host !== null ? ["--host=" + options.host] : []),
      ],
      env: options.env,
    }));
  }

  steps.push(withCwd({ label: label("compile"), program: "make", args: [`-j${options.jobs}`] }));
  steps.push(withCwd({ label: label("install"), program: "make", args: ["install"] }));

  return steps;
}
