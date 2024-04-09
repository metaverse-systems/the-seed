import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
import { ScriptArgsType } from "../types";

const ConfigCLI = (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);
  const updateConfig = () => {
    inquirer.prompt(config.getQuestions())
      .then((answers) => config.parseAnswers(answers))
      .then(() => config.saveConfig());
  };

  const command = scriptConfig.args[3] || "list";
  const subcommand = scriptConfig.args[4] || "help";

  switch(command)
  {
    case "list":
      if(!fs.existsSync(scriptConfig.configDir + config.configFile)) {
        console.log(scriptConfig.configDir + config.configFile + " not found. Run '" + scriptConfig.binName + " config edit' to create it.");
        break;
      }
      console.log(scriptConfig.configDir + config.configFile);
      console.log(config.config);
      break;
    case "edit":
      updateConfig();
      break;
    case "scopes":
      console.log(scriptConfig.binName + " " + command + " " + subcommand);

      switch(subcommand)
      {
        case "help":
          console.log("Scopes commands:");
          console.log("  " + scriptConfig.binName + " " + command + " list");
          break;
        case "list":
          console.log(Object.keys(config.config.scopes));
          break;
      }
      break;
  }
};

export default ConfigCLI;
