import Config from "./Config";
const { execSync } = require('child_process');

const targets: {
  [key:string]: string;
} = {
  "native": "x86_64-linux-gnu",
  "windows": "x86_64-w64-mingw32",
  "wasm": "wasm32-unknown-emscripten",
};

const execOptions = {stdio : 'pipe' };

class Build {
  config: Config;
  target: string = "linux";

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
  }

  configure = () => {
    const newTarget = targets[this.target];
    const distclean_command = "make distclean";
    try {
      const result = execSync(distclean_command, execOptions).toString();
    } catch (e) {
    }

    const prefix = this.config.config.prefix + "/" + newTarget;

    const configure_command = "PKG_CONFIG_PATH=" + prefix + "/lib/pkgconfig/ " +
        (this.target === "wasm" ? "emconfigure " : "") + 
        "./configure --prefix=" + prefix + 
        (this.target === "windows" ? " --host=" + targets["windows"] : "");

    try {
      const result = execSync(configure_command, execOptions).toString();
    } catch (e) {
      console.error(e);
      throw e;
    }

    console.log("Configure complete");
  }

  reconfigure = (target: string) => {
    this.target = target;
    this.autogen();
    this.configure();
  }

  compile = () => {
    const make_command = this.target === "wasm" ?
        "emmake make" :
        "make -j";

    try {
      const result = execSync(make_command).toString();
      console.log(result);
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  install = () => {
    const install_command = "make install";

   try {
      const result = execSync(install_command).toString();
      console.log(result);
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

export default Build;
