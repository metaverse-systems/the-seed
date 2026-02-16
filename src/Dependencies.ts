import Config from "./Config";
import { execSync } from "child_process";
import { targets } from "./Build";
import { BuildStep } from "./types";

const execOptions = { stdio: "pipe" as const, shell: "/bin/bash", env: { ...process.env } };
const libEcsRepo = "https://github.com/metaverse-systems/libecs-cpp.git";
const libTheSeedRepo = "https://github.com/metaverse-systems/libthe-seed.git";

export const checkLib = (config: Config, library: string, target: string) => {
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
    if (result.includes(library)) {
      return true;
    }
    console.error("pkg-config did not find " + library);
  } catch (e) {
    return false;
  }
  return false;
};

export const checkLibEcs = (config: Config, target: string) => {
  return checkLib(config, "ecs-cpp", target);
};

export const checkLibTheSeed = (config: Config, target: string) => {
  return checkLib(config, "the-seed", target);
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
  const cloneCommand = "git clone " + repo;
  try {
    const result = execSync(cloneCommand, execOptions).toString();
  } catch (e) {
    console.error("Failed to clone " + repo);
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

  const libraries: { name: string; repo: string; installDir: string; pkgConfigName: string }[] = [
    { name: "libecs-cpp", repo: libEcsRepo, installDir: "libecs-cpp", pkgConfigName: "ecs-cpp" },
    { name: "libthe-seed", repo: libTheSeedRepo, installDir: "libthe-seed", pkgConfigName: "the-seed" },
  ];

  for (const lib of libraries) {
    // Skip if already installed
    if (checkLib(config, lib.pkgConfigName, target)) {
      continue;
    }

    const hostFlag = target !== "native" ? " --host=" + targetDir : "";

    steps.push({ label: `clone ${lib.name}`, command: `git clone ${lib.repo}` });
    steps.push({ label: `${lib.name} autogen`, command: `cd ${lib.installDir} && ./autogen.sh` });
    steps.push({ label: `${lib.name} configure`, command: `cd ${lib.installDir} && ./configure --prefix=${prefix}${hostFlag}` });
    steps.push({ label: `${lib.name} compile`, command: `cd ${lib.installDir} && make` });
    steps.push({ label: `${lib.name} install`, command: `cd ${lib.installDir} && make install` });
  }

  return steps;
};