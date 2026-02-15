import Config from "./Config";
import { execSync } from "child_process";
import { BuildStep } from "./types";

export const targets: {
  [key: string]: string;
} = {
  native: "x86_64-linux-gnu",
  windows: "x86_64-w64-mingw32",
};

const execOptions = { stdio: "pipe" as const };

class Build {
  config: Config;
  target = "linux";

  constructor(config: Config) {
    this.config = config;
  }

  autogen = () => {
    const autogen_command = "./autogen.sh";
    try {
      const result = execSync(autogen_command, execOptions).toString();
    } catch (e) {
      console.error(e);
      throw e;
    }

    console.log("Completed " + autogen_command);
  };

  configure = () => {
    const newTarget = targets[this.target];
    const distclean_command = "make distclean";
    try {
      const result = execSync(distclean_command, execOptions).toString();
    } catch (e) {}

    const prefix = this.config.config.prefix + "/" + newTarget;

    const configure_command =
      "PKG_CONFIG_PATH=" +
      prefix +
      "/lib/pkgconfig/ " +
      "./configure --prefix=" +
      prefix +
      (this.target === "windows" ? " --host=" + targets["windows"] : "");

    try {
      const result = execSync(configure_command, execOptions).toString();
    } catch (e) {
      console.error(e);
      throw e;
    }

    console.log("Configure complete");
  };

  reconfigure = (target: string) => {
    this.target = target;
    this.autogen();
    this.configure();
  };

  compile = () => {
    const make_command = "make -j";

    try {
      const result = execSync(make_command).toString();
      console.log(result);
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  install = () => {
    const install_command = "make install";

    try {
      const result = execSync(install_command).toString();
      console.log(result);
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  /**
   * Returns an ordered array of BuildStep objects for the given target and mode.
   * @param target - 'native' or 'windows'
   * @param fullReconfigure - if true, includes autogen/distclean/configure steps; if false, only compile+install
   */
  getSteps = (target: string, fullReconfigure: boolean): BuildStep[] => {
    const newTarget = targets[target];
    const prefix = this.config.config.prefix + "/" + newTarget;

    const steps: BuildStep[] = [];

    if (fullReconfigure) {
      steps.push({
        label: "autogen",
        command: "./autogen.sh",
      });

      steps.push({
        label: "distclean",
        command: "make distclean",
        ignoreExitCode: true,
      });

      const configureCommand =
        "PKG_CONFIG_PATH=" +
        prefix +
        "/lib/pkgconfig/ " +
        "./configure --prefix=" +
        prefix +
        (target === "windows" ? " --host=" + targets["windows"] : "");

      steps.push({
        label: "configure",
        command: configureCommand,
      });
    }

    steps.push({
      label: "compile",
      command: "make -j",
    });

    steps.push({
      label: "install",
      command: "make install",
    });

    return steps;
  };
}

export default Build;
