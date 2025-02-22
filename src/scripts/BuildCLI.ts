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
      break;
    case "native":
    case "windows":
      build.reconfigure(command);
      build.compile();
      build.install();
      break;
    default:
      build.compile();
      build.install();
      break;
  }
};

export default BuildCLI;
