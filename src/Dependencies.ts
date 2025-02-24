import Config from "./Config";
const { execSync } = require("child_process");
import { targets } from "./Build";

const execOptions = { stdio: "pipe", shell: "/bin/bash", env: { ...process.env } };
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
  const targetDir = targets[target];
  const prefix = config.config.prefix + "/" + targetDir;
  const cloneCommand = "git clone " + libEcsRepo;
  try {
    const result = execSync(cloneCommand, execOptions).toString();
  } catch (e) {
    console.error("Failed to clone libecs-cpp");
  }
  const buildCommand =
    "cd ecs-cpp && ./autogen.sh && ./configure --prefix=" +
    prefix +
    target != "native" ? " --host=" + targetDir : "" +
    " && make && make install";
  try {
    const result = execSync(buildCommand, execOptions).toString();
  } catch (e) {
    console.error("Failed to build libecs-cpp");
    console.error(e);
    return false;
  }
  return true;
};

export const installLibTheSeed = (config: Config, target: string) => {
  const targetDir = targets[target];
  const prefix = config.config.prefix + "/" + targetDir;
  const cloneCommand = "git clone " + libTheSeedRepo;
  try {
    const result = execSync(cloneCommand, execOptions).toString();
  } catch (e) {
    console.error("Failed to clone libthe-seed");
  }
  const env = {
    ...process.env,
    PKG_CONFIG_PATH: `${prefix}/lib/pkgconfig/`
  };

  let buildCommand = "cd libthe-seed";
  buildCommand += " && ./autogen.sh";
  buildCommand += " && PKG_CONFIG_PATH=" + prefix + "/lib/pkgconfig/";
  buildCommand += " ./configure --prefix=" + prefix;
  if(target != "native") {
    buildCommand += " --host=" + targetDir;
  }
  buildCommand += " && make && make install";
  try {
    const result = execSync(
      buildCommand,
      { stdio: "inherit", env, shell: "/bin/bash" }
    );
  } catch (e) {
    console.error("Failed to build libthe-seed");
    console.error(e);
    return false;
  }
  return true;
};
