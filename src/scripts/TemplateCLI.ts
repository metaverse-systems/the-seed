import inquirer from "inquirer";
import Config from "../Config";
import Template from "../Template";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const TemplateCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const template = new Template(config);
  template.type = parsed.subcommand as string;

  const given = parsed.positionals.name as { scope: string; name: string } | undefined;
  if (given) {
    template.createPackage(given.scope, given.name);
    return;
  }

  const answers = await inquirer.prompt(template.askName());
  template.createPackage(answers.scopeName, answers.templateName);
};

export default TemplateCLI;
