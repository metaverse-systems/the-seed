import { checkLibEcs, checkLibTheSeed, installLibEcs, installLibTheSeed } from "../Dependencies";
import Config from "../Config";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const DependenciesCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const target = (parsed.positionals.target as string | undefined) ?? "native";

  if (parsed.subcommand === "check") {
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
    return;
  }

  if (!checkLibEcs(config, target)) {
    console.log("Installing libecs-cpp...");
    if (await installLibEcs(config, target)) {
      console.log("libecs-cpp installed successfully.");
    } else {
      console.error("Failed to install libecs-cpp.");
    }
  }
  if (!checkLibTheSeed(config, target)) {
    console.log("Installing libthe-seed...");
    if (await installLibTheSeed(config, target)) {
      console.log("libthe-seed installed successfully.");
    } else {
      console.error("Failed to install libthe-seed.");
    }
  }
};

export default DependenciesCLI;
