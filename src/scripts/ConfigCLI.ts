import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
import { ScriptConfigType } from "../types";

const ConfigCLI = (scriptConfig: ScriptConfigType) => {
  const config = new Config(scriptConfig.configDir);
  const updateConfig = () => {
    inquirer.prompt(config.getQuestions())
    .then((answers) => config.parseAnswers(answers))
    .then(() => config.saveConfig());
  };

  const command = scriptConfig.args[3] || "list";

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
      const subcommand = scriptConfig.args[3] || "list";
      console.log("scopes " + subcommand);
      break;
  }
};

export default ConfigCLI;
