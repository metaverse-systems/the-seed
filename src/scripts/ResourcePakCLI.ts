import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
import Signing from "../Signing";
import { chooseScope } from "../cli/ScopeChoice";
import ResourcePak from "../ResourcePak";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";

const ResourcePakCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const rp = new ResourcePak(config);

  switch (parsed.subcommand) {
    case "create": {
      const given = parsed.positionals.name as { scope: string; name: string } | undefined;
      let scope: string;
      let name: string;
      if (given) {
        // A scope that is not configured is refused before anything is written.
        scope = await chooseScope(new Signing(context.configDir), given.scope, false);
        name = given.name;
      } else {
        const answers = await inquirer.prompt(rp.askName());
        scope = answers.scopeName;
        name = answers.pakName;
      }
      rp.createPackage(scope, name, context.cwd);
      console.log(`Created resource pak ${scope}/${name} in ./${name}`);
      break;
    }
    case "add": {
      const entry = rp.addResource(
        parsed.positionals["resource-name"] as string,
        parsed.positionals.filename as string,
        context.cwd,
        {
          force: parsed.options.force === true,
          attributes: parsed.options.attribute as Array<[string, string]> | undefined
        }
      );
      const pak = rp.readProject(context.cwd).name;
      console.log(`Added ${entry.name} (${entry.filename}, ${entry.size} bytes) to ${pak}`);
      break;
    }
    case "build": {
      const pak = rp.build(context.cwd);
      const count = rp.readProject(context.cwd).resources.length;
      console.log(`Built ${pak} (${count} resources, ${fs.statSync(pak).size} bytes)`);
      break;
    }
  }
};

export default ResourcePakCLI;
