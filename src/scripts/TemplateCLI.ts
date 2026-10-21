import inquirer from "inquirer";
import Config from "../Config";
import Signing from "../Signing";
import Template from "../Template";
import { chooseScope } from "../cli/ScopeChoice";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const createProject = (template: Template, scope: string, name: string, context: CliContext): void => {
  template.createPackage(scope, name, context.cwd);
  console.log(`Created ${template.type} ${scope}/${name} in ./${name}`);
};

const TemplateCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const template = new Template(config);
  template.type = parsed.subcommand as Template["type"];

  const given = parsed.positionals.name as { scope: string; name: string } | undefined;
  if (given) {
    // A scope that is not configured is refused before anything is written.
    const scope = await chooseScope(new Signing(context.configDir), given.scope, false);
    createProject(template, scope, given.name, context);
    return;
  }

  const answers = await inquirer.prompt(template.askName());
  createProject(template, answers.scopeName, answers.templateName, context);
};

export default TemplateCLI;
