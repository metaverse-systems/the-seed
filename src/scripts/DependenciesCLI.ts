import { checkLibEcs, checkLibTheSeed, installLibEcs, installLibTheSeed } from "../Dependencies";
import Config from "../Config";
import { ScriptArgsType } from "../types";

const DependenciesCLI = (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);

  const command = scriptConfig.args[3];
  const target = scriptConfig.args[4] ? scriptConfig.args[4] : "native";

  switch (command) {
    case "help":
      console.log("\nUsage: the-seed dependencies <command>");
      console.log("\nAvailable commands:");
      console.log("  help       - Show this help message");
      console.log("  check      - Check if dependencies are installed");
      break;
    case "check":
      if (checkLibEcs(config, target)) {
        console.log("libecs-cpp is installed.");
      } else {
        console.log("libecs-cpp is not installed.");
      }
      if (checkLibTheSeed(config, target)) {
        console.log("libthe-seed is installed.");
      } else {
        console.log("libthe-seed is not installed.");
      }
      break;
    case "install":
      if (!checkLibEcs(config, target)) {
        console.log("Installing libecs-cpp...");
        if (installLibEcs(config, target)) {
          console.log("libecs-cpp installed successfully.");
        } else {
          console.error("Failed to install libecs-cpp.");
        }
      }
      if (!checkLibTheSeed(config, target)) {
        console.log("Installing libthe-seed...");
        if (installLibTheSeed(config, target)) {
          console.log("libthe-seed installed successfully.");
        } else {
          console.error("Failed to install libthe-seed.");
        }
      }
      break;
    default:
      console.log(
        "Invalid command. Use 'the-seed dependencies help' for usage information."
      );
      break;
  }
  return true;
};

export default DependenciesCLI;