import inquirer from "inquirer";
import Config from "../Config";
import ResourcePak from "../ResourcePak";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const ResourcePakCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const rp = new ResourcePak(config);

  switch (parsed.subcommand) {
    case "create": {
      const answers = await inquirer.prompt(rp.askName());
      rp.createPackage(answers.scopeName, answers.pakName);
      break;
    }
    case "add":
      rp.addResource(parsed.positionals["resource-name"] as string, parsed.positionals.filename as string);
      break;
    case "build":
      rp.build();
      break;
  }
};

export default ResourcePakCLI;
