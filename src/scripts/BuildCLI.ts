import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
import Build from "../Build";
import { ScriptArgsType } from "../types";

const BuildCLI = (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);

  const command = scriptConfig.args[3];

  const build = new Build(config);

  switch(command)
  {
    case "help":
      console.log("Available build targets:");
      console.log("  native");
      console.log("  windows");
      console.log("  wasm");
      break;
    case "native":
    case "windows":
    case "wasm":
      build.reconfigure(command);
      build.compile();
      break;
    default:
console.log("default");
      build.compile();
      break;
  }
};

export default BuildCLI;
