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
      console.log("\nUsage: the-seed build <target>");
      console.log("\nAvailable build targets:");
      console.log("  native   - Builds for the current Linux environment");
      console.log("  windows  - Cross-compiles for Windows using MinGW");
      console.log("\nCommands:");
      console.log("  the-seed build help       - Show this help message");
      console.log("  the-seed build native     - Build for Linux");
      console.log("  the-seed build windows    - Build for Windows (MinGW)");
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
