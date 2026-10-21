import inquirer from "inquirer";
import Config from "../Config";
import Signing from "../Signing";
import Template from "../Template";
import { chooseScope } from "../cli/ScopeChoice";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const TemplateCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const template = new Template(config);
  template.type = parsed.subcommand as string;

  const given = parsed.positionals.name as { scope: string; name: string } | undefined;
  if (given) {
    // A scope that is not configured is refused before anything is written.
    const scope = await chooseScope(new Signing(context.configDir), given.scope, false);
    template.createPackage(scope, given.name);
    return;
  }

  const answers = await inquirer.prompt(template.askName());
  template.createPackage(answers.scopeName, answers.templateName);
};

export default TemplateCLI;
