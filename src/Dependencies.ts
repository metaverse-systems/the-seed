import fs from "fs";
import Config from "./Config";
import { execSync } from "child_process";
import { targets } from "./Build";
import { BuildStep } from "./types";

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

export const installLibEcs = (config: Config, target: string) => {
  if(installLib(config, libEcsRepo, "libecs-cpp", target)) {
    return true;
  }
  console.error("Failed to build libecs-cpp");
  return false;
};

export const installLibTheSeed = (config: Config, target: string) => {
  if(installLib(config, libTheSeedRepo, "libthe-seed", target)) {
    return true;
  }
  console.error("Failed to build libthe-seed");
  return false;
};

export const installLib = (config: Config, repo: string, installDir: string, target: string) => {
  const targetDir = targets[target];
  const prefix = config.config.prefix + "/" + targetDir;
  if (fs.existsSync(installDir)) {
    try {
      execSync("git -C " + installDir + " pull --ff-only", execOptions);
    } catch (e) {
      console.error("Failed to update " + installDir);
      return false;
    }
  } else {
    try {
      execSync("git clone " + repo, execOptions);
    } catch (e) {
      console.error("Failed to clone " + repo);
    }
  }
  const buildCommand =
    "cd " + installDir + " && ./autogen.sh && ./configure --prefix=" +
    prefix + (target != "native" ? " --host=" + targetDir : "") +
    " && make && make install";
  try {
    const result = execSync(buildCommand, execOptions).toString();
  } catch (e) {
    return false;
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

    if (fs.existsSync(lib.installDir)) {
      steps.push({ label: `update ${lib.name}`, program: "git", args: ["-C", lib.installDir, "pull", "--ff-only"] });
    } else {
      steps.push({ label: `clone ${lib.name}`, program: "git", args: ["clone", lib.repo, lib.installDir] });
    }
    const hostArgs = target !== "native" ? ["--host=" + targetDir] : [];
    steps.push({ label: `${lib.name} autogen`, program: "./autogen.sh", args: [], cwd: lib.installDir });
    steps.push({ label: `${lib.name} configure`, program: "./configure", args: [`--prefix=${prefix}`, ...hostArgs], cwd: lib.installDir });
    steps.push({ label: `${lib.name} compile`, program: "make", args: [], cwd: lib.installDir });
    steps.push({ label: `${lib.name} install`, program: "make", args: ["install"], cwd: lib.installDir });
  }

  return steps;
};