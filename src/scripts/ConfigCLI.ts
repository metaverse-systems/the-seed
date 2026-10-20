import inquirer from "inquirer";
import Config from "../Config";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const ConfigCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);

  if (parsed.subcommand === "edit") {
    const answers = await inquirer.prompt(config.getQuestions());
    config.parseAnswers(answers);
    await config.saveConfig();
    return;
  }

  console.log(config.configPath);
  console.log(config.config);
};

export default ConfigCLI;
