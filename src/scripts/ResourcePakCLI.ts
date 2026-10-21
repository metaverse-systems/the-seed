import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import Config from "../Config";
import Signing from "../Signing";
import { chooseScope } from "../cli/ScopeChoice";
import ResourcePak from "../ResourcePak";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { MissingError } from "../cli/ExitStatus";

/** Stops with a missing-input error unless the directory holds a readable project description. */
function requirePakProject(directory: string): void {
  const description = path.join(directory, "package.json");
  try {
    JSON.parse(fs.readFileSync(description, "utf-8"));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : ` (${(error as Error).message})`;
    throw new MissingError(`No readable package.json in ${directory}${reason}; run this in a resource pak project.`);
  }
}

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
      requirePakProject(context.cwd);
      const filename = parsed.positionals.filename as string;
      if (!fs.existsSync(path.join(context.cwd, filename))) {
        throw new MissingError(`File not found: ${path.resolve(context.cwd, filename)}`);
      }
      rp.addResource(parsed.positionals["resource-name"] as string, filename, context.cwd);
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
