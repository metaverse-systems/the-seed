import fs from "fs";
import Config from "./Config";
import { execSync } from "child_process";
import { targets } from "./Build";
import { BuildStep } from "./types";
import { runStep, stepText } from "./StepRunner";

const execOptions = { stdio: "pipe" as const, shell: "/bin/bash", env: { ...process.env } };
const libEcsRepo = "https://github.com/metaverse-systems/libecs-cpp.git";
const libTheSeedRepo = "https://github.com/metaverse-systems/libthe-seed.git";

export const requiredLibEcsVersion = "2.1.0";
export const requiredLibTheSeedVersion = "0.8.0";

export const checkLib = (config: Config, library: string, target: string, minVersion?: string) => {
  const targetPrefix = targets[target];
  const prefix = config.config.prefix + "/" + targetPrefix;
  const pkgConfigCommand =
    "PKG_CONFIG_PATH=" +
    prefix +
    "/lib/pkgconfig/ " +
    "pkg-config --cflags --libs " +
    library;
  try {
    const result = execSync(pkgConfigCommand, execOptions).toString();
    if (!result.includes(library)) {
      console.error("pkg-config did not find " + library);
      return false;
    }
  } catch (e) {
    return false;
  }
  if (minVersion) {
    const pkgConfigPath = "PKG_CONFIG_PATH=" + prefix + "/lib/pkgconfig/ ";
    try {
      execSync(pkgConfigPath + "pkg-config --atleast-version=" + minVersion + " " + library, execOptions);
    } catch (e) {
      let found = "unknown version";
      try {
        found = execSync(pkgConfigPath + "pkg-config --modversion " + library, execOptions).toString().trim();
      } catch (versionError) {
        // keep the placeholder
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
const getLibrarySteps = (name: string, repo: string, installDir: string, prefix: string, target: string): BuildStep[] => {
  const hostArgs = target !== "native" ? ["--host=" + targets[target]] : [];
  return [
    fs.existsSync(installDir)
      ? { label: `update ${name}`, program: "git", args: ["-C", installDir, "pull", "--ff-only"] }
      : { label: `clone ${name}`, program: "git", args: ["clone", repo, installDir] },
    { label: `${name} autogen`, program: "./autogen.sh", args: [], cwd: installDir },
    { label: `${name} configure`, program: "./configure", args: [`--prefix=${prefix}`, ...hostArgs], cwd: installDir },
    { label: `${name} compile`, program: "make", args: [], cwd: installDir },
    { label: `${name} install`, program: "make", args: ["install"], cwd: installDir },
  ];
};

/**
 * Fetches, builds and installs one library into the target's prefix, showing
 * its output as it arrives. Stops at the first step that does not complete and
 * resolves false; resolves true when every step completed.
 */
export const installLib = async (config: Config, repo: string, installDir: string, target: string) => {
  const prefix = config.config.prefix + "/" + targets[target];
  const output = {
    stdout: (chunk: Buffer) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk: Buffer) => {
      process.stderr.write(chunk);
    },
  };

  for (const step of getLibrarySteps(installDir, repo, installDir, prefix, target)) {
    const text = stepText(step);
    console.log(`==> ${step.label}: ${text}`);

    const outcome = await runStep(step, {
      baseDir: process.cwd(),
      output: { mode: "stream", output },
    });

    let message: string | undefined;
    switch (outcome.status) {
      case "failed":
        message = outcome.exitCode === null ? `${text} was ended by ${outcome.signal}` : `${text} exited with status ${outcome.exitCode}`;
        break;
      case "notFound":
        message = outcome.message;
        break;
      case "interrupted":
        message = `${text} was interrupted`;
        break;
    }
    if (message !== undefined) {
      console.error(`Failed at ${step.label}: ${message}`);
      return false;
    }
  }
  return true;
};

/**
 * Returns an ordered array of BuildStep objects for installing missing libraries.
 * Checks which libraries are missing and generates clone + build steps for each.
 * Order: libecs-cpp first, then libthe-seed (compile-time dependency).
 */
export const getInstallSteps = (config: Config, target: string): BuildStep[] => {
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

    steps.push(...getLibrarySteps(lib.name, lib.repo, lib.installDir, prefix, target));
  }

  return steps;
};