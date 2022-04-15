import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
import Scopes from "../Scopes";
import { ScriptArgsType } from "../types";

const ScopesCLI = (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);
  const scopes = new Scopes(config);

  const command = scriptConfig.args[3] || "help";

  switch(command)
  {
    case "help":
      console.log("Scopes commands:");
      console.log("  " + scriptConfig.binName + " scopes help");
      console.log("     -- This screen");
      console.log("  " + scriptConfig.binName + " scopes list");
      console.log("     -- List existing scopes");
      console.log("  " + scriptConfig.binName + " scopes edit");
      console.log("     -- Edit an existing scope");
      console.log("  " + scriptConfig.binName + " scopes add");
      console.log("     -- Create a new scope");
      console.log("  " + scriptConfig.binName + " scopes delete");
      console.log("     -- Delete a scope");
      break;
    case "list":
      console.log(Object.keys(config.config.scopes));
      break;
    case "edit":
      if(Object.keys(config.config.scopes).length === 0) {
        console.log("There are no scopes to edit.");
        break;
      }
      inquirer.prompt(scopes.askWhichScope())
      .then((answers) => {
        const { scopeName } = answers;
        inquirer.prompt(scopes.askEditScope(config.config.scopes[scopeName].author))
        .then((editAnswers) => {
          editAnswers.scopeName = scopeName;
          scopes.createOrEditScope(editAnswers);
        })
        .then(() => config.saveConfig());
      });
      break;
    case "add":
      inquirer.prompt(scopes.askNewScope())
      .then((answers) => scopes.createOrEditScope(answers))
      .then(() => config.saveConfig());
      break;
    case "delete":
      if(Object.keys(config.config.scopes).length === 0) {
        console.log("There are no scopes to edit.");
        break;
      }
      inquirer.prompt(scopes.askWhichScope())
      .then((answers) => {
        const { scopeName } = answers;
        scopes.deleteScope(scopeName);
      })
      .then(() => config.saveConfig());
      break;
  }
};

export default ScopesCLI;
