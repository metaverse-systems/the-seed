import inquirer from "inquirer";
import Config from "../Config";
import Scopes from "../Scopes";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { addScopeHint } from "../cli/Hints";

const ScopesCLI = async (parsed: ParsedCommand, context: CliContext): Promise<void> => {
  const config = new Config(context.configDir);
  const scopes = new Scopes(config);

  switch (parsed.subcommand) {
    case "list":
    {
      const names = Object.keys(config.config.scopes);
      if (names.length === 0) {
        console.error(`No scopes are configured. ${addScopeHint()}`);
        break;
      }
      for (const name of names) {
        console.log(name);
      }
      break;
    }
    case "edit": {
      if (Object.keys(config.config.scopes).length === 0) {
        console.error("There are no scopes to edit.");
        console.error(addScopeHint());
        break;
      }
      const { scopeName } = await inquirer.prompt(scopes.askWhichScope());
      const editAnswers = await inquirer.prompt(scopes.askEditScope(config.config.scopes[scopeName].author));
      editAnswers.scopeName = scopeName;
      scopes.createOrEditScope(editAnswers);
      await config.saveConfig();
      break;
    }
    case "add": {
      const answers = await inquirer.prompt(scopes.askNewScope());
      scopes.createOrEditScope(answers);
      await config.saveConfig();
      break;
    }
    case "delete": {
      if (Object.keys(config.config.scopes).length === 0) {
        console.error("There are no scopes to delete.");
        console.error(addScopeHint());
        break;
      }
      const { scopeName } = await inquirer.prompt(scopes.askWhichScope());
      scopes.deleteScope(scopeName);
      await config.saveConfig();
      break;
    }
  }
};

export default ScopesCLI;
