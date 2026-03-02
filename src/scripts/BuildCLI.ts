import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
import Build from "../Build";
import { ScriptArgsType } from "../types";
import { buildRecursive } from "../RecursiveBuild";

const BuildCLI = async (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);

  const command = scriptConfig.args[3];
  const modifier = scriptConfig.args[4];

  const build = new Build(config);

  switch(command)
  {
    case "help":
      console.log("\nUsage: the-seed build <target> [recursive]");
      console.log("\nAvailable build targets:");
      console.log("  native   - Builds for the current Linux environment");
      console.log("  windows  - Cross-compiles for Windows using MinGW");
      console.log("\nOptions:");
      console.log("  recursive - Build all transitive dependencies first, then the current project");
      console.log("\nCommands:");
      console.log("  the-seed build help                - Show this help message");
      console.log("  the-seed build native              - Build for Linux");
      console.log("  the-seed build native recursive    - Build all deps + project for Linux");
      console.log("  the-seed build windows             - Build for Windows (MinGW)");
      console.log("  the-seed build windows recursive   - Build all deps + project for Windows");
      break;
    case "native":
    case "windows":
      if (modifier === "recursive") {
        const result = await buildRecursive({
          target: command,
          fullReconfigure: true,
          projectDir: process.cwd(),
        });
        if (!result.success && !result.cancelled) {
          process.exitCode = 1;
        }
      } else {
        build.reconfigure(command);
        build.compile();
        build.install();
      }
      break;
    default:
      build.compile();
      build.install();
      break;
  }
};

export default BuildCLI;
