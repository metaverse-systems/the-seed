import fs from "fs";
import Config from "./Config";
import { spawnSync } from "child_process";
import { targets } from "./Build";
import { BuildStep } from "./types";
import { autotoolsSteps } from "./AutotoolsSteps";
import { runStep, stepText } from "./StepRunner";
import { processorCount } from "./BuildScheduler";
import { librarySearchEnv } from "./LibrarySearch";
import { REQUIRED_VERSIONS } from "./RequiredVersions";

const libEcsRepo = "https://github.com/metaverse-systems/libecs-cpp.git";
const libTheSeedRepo = "https://github.com/metaverse-systems/libthe-seed.git";

export const requiredLibEcsVersion = REQUIRED_VERSIONS["ecs-cpp"];
export const requiredLibTheSeedVersion = REQUIRED_VERSIONS["the-seed"];

export const checkLib = (config: Config, library: string, target: string, minVersion?: string) => {
  const options = {
    env: { ...process.env, ...librarySearchEnv(config.config.prefix, target) },
    encoding: "utf8" as const,
  };
  const pkgConfig = (args: string[]) => spawnSync("pkg-config", args, options);

  const lookup = pkgConfig(["--cflags", "--libs", library]);
  if (lookup.error || lookup.status !== 0) {
    return false;
  }
  if (!String(lookup.stdout ?? "").includes(library)) {
    console.error("pkg-config did not find " + library);
    return false;
  }
  if (minVersion) {
    const check = pkgConfig(["--atleast-version=" + minVersion, library]);
    if (check.error || check.status !== 0) {
      let found = "unknown version";
      const version = pkgConfig(["--modversion", library]);
      if (!version.error && version.status === 0) {
        found = String(version.stdout ?? "").trim() || found;
      }
      console.error(library + " " + found + " is older than the required " + minVersion);
      return false;
    }
  }
  return true;
};

export const checkLibEcs = (config: Config, target: string) => {
  return checkLib(config, "ecs-cpp", target, requiredLibEcsVersion);
};

export const checkLibTheSeed = (config: Config, target: string) => {
  return checkLib(config, "the-seed", target, requiredLibTheSeedVersion);
};

export const installLibEcs = async (config: Config, target: string) => {
  if (await installLib(config, libEcsRepo, "libecs-cpp", target)) {
    return true;
  }
  console.error("Failed to build libecs-cpp");
  return false;
};

export const installLibTheSeed = async (config: Config, target: string) => {
  if (await installLib(config, libTheSeedRepo, "libthe-seed", target)) {
    return true;
  }
  console.error("Failed to build libthe-seed");
  return false;
};

/**
 * The steps that fetch and install one library: clone it, or update the
 * existing clone, then autogen, configure, compile and install inside it.
 */
const getLibrarySteps = (name: string, repo: string, installDir: string, prefix: string, target: string, jobs: number, search: Record<string, string>): BuildStep[] => {
  return [
    fs.existsSync(installDir)
      ? { label: `update ${name}`, program: "git", args: ["-C", installDir, "pull", "--ff-only"] }
      : { label: `clone ${name}`, program: "git", args: ["clone", repo, installDir] },
    ...autotoolsSteps({
      prefix,
      host: target !== "native" ? targets[target] : null,
      jobs,
      env: search,
      reconfigure: true,
      distclean: false,
      cwd: installDir,
      labelPrefix: name,
    }),
  ];
};

/** How runInstallSteps runs its steps and where it reports. */
export interface InstallStepsOptions {
  /** The directory the steps' relative working directories resolve against */
  baseDir: string;
  /** Receives each step's output as it arrives; the tool's own streams when omitted */
  output?: { stdout(chunk: Buffer): void; stderr(chunk: Buffer): void };
  /** Receives each progress line; console.log when omitted */
  log?: (line: string) => void;
  /** Stops the running step and starts no other */
  signal?: AbortSignal;
  /** Called before each step; `index` is 0-based */
  onStepStart?(step: BuildStep, index: number, total: number): void;
}

/** How runInstallSteps ended. */
export type InstallStepsResult =
  | { status: "completed" }
  | { status: "failed"; step: string; message: string }
  | { status: "cancelled" };

/** The tool's own standard output and standard error. */
const ownOutput = {
  stdout: (chunk: Buffer) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk: Buffer) => {
    process.stderr.write(chunk);
  },
};

/**
 * Runs install steps in order, each preceded by `==> <label>: <command>`, passing their output on as it
 * arrives without keeping it. Stops at the first step that fails, naming it; an aborted signal stops the
 * running step (and its process group) and starts no other. A failing step marked ignoreExitCode is
 * logged as ignored and the run carries on.
 */
export const runInstallSteps = async (steps: BuildStep[], options: InstallStepsOptions): Promise<InstallStepsResult> => {
  const log = options.log ?? ((line: string) => console.log(line));
  const output = options.output ?? ownOutput;

  for (let index = 0; index < steps.length; index++) {
    if (options.signal?.aborted) {
      return { status: "cancelled" };
    }
    const step = steps[index];
    options.onStepStart?.(step, index, steps.length);
    const text = stepText(step);
    log(`==> ${step.label}: ${text}`);

    const outcome = await runStep(step, {
      baseDir: options.baseDir,
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
};

/**
 * Fetches, builds and installs one library into the target's prefix, showing
 * its output as it arrives. Stops at the first step that does not complete and
 * resolves false; resolves true when every step completed.
 */
export const installLib = async (
  config: Config,
  repo: string,
  installDir: string,
  target: string,
  options: { jobs?: number } = {}
) => {
  const prefix = config.config.prefix + "/" + targets[target];
  const steps = getLibrarySteps(installDir, repo, installDir, prefix, target, options.jobs ?? processorCount(), librarySearchEnv(config.config.prefix, target, process.env));

  let current: BuildStep | null = null;
  const result = await runInstallSteps(steps, {
    baseDir: process.cwd(),
    output: ownOutput,
    onStepStart: (step) => {
      current = step;
    },
  });

  switch (result.status) {
    case "completed":
      return true;
    case "failed":
      console.error(`Failed at ${result.step}: ${result.message}`);
      return false;
    case "cancelled": {
      // No signal is passed, so this only arises when the step runner reports the step as interrupted
      const step = current as BuildStep | null;
      if (step !== null) {
        console.error(`Failed at ${step.label}: ${stepText(step)} was interrupted`);
      }
      return false;
    }
  }
};

/**
 * Returns an ordered array of BuildStep objects for installing missing libraries.
 * Checks which libraries are missing and generates clone + build steps for each.
 * Order: libecs-cpp first, then libthe-seed (compile-time dependency).
 */
export const getInstallSteps = (config: Config, target: string, jobs: number = processorCount(), inherited: NodeJS.ProcessEnv = process.env): BuildStep[] => {
  const targetDir = targets[target];
  const prefix = config.config.prefix + "/" + targetDir;
  const steps: BuildStep[] = [];

  const libraries: { name: string; repo: string; installDir: string; pkgConfigName: string; minVersion: string }[] = [
    { name: "libecs-cpp", repo: libEcsRepo, installDir: "libecs-cpp", pkgConfigName: "ecs-cpp", minVersion: requiredLibEcsVersion },
    { name: "libthe-seed", repo: libTheSeedRepo, installDir: "libthe-seed", pkgConfigName: "the-seed", minVersion: requiredLibTheSeedVersion },
  ];

  for (const lib of libraries) {
    // Skip if already installed at the required version or newer
    if (checkLib(config, lib.pkgConfigName, target, lib.minVersion)) {
      continue;
    }

    steps.push(...getLibrarySteps(lib.name, lib.repo, lib.installDir, prefix, target, jobs, librarySearchEnv(config.config.prefix, target, inherited)));
  }

  return steps;
};