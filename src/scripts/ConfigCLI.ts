import inquirer from "inquirer";
import Config from "../Config";
import { ScriptArgsType } from "../types";

const ConfigCLI = (scriptConfig: ScriptArgsType): Promise<void> | void => {
  const config = new Config(scriptConfig.configDir);
  const updateConfig = () => {
    return inquirer.prompt(config.getQuestions())
      .then((answers) => config.parseAnswers(answers))
      .then(() => config.saveConfig());
  };

  const command = scriptConfig.args[3] || "list";
  const subcommand = scriptConfig.args[4] || "help";

  switch(command)
  {
    case "list":
      console.log(config.configPath);
      console.log(config.config);
      break;
    case "edit":
      return updateConfig();
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
