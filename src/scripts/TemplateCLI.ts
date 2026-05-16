import inquirer from "inquirer";
import Config from "../Config";
import Template from "../Template";
import { ScriptArgsType } from "../types";

const TemplateCLI = (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);

  const command = scriptConfig.args[3] || "help";

  const template = new Template(config);

  let packageName = "";
  let scope = "";
  let name = "";

  switch (command) {
    case "help":
      console.log("Available template(s):");
      console.log("  component");
      console.log("  system");
      console.log("  program");
      break;
    case "component":
    case "system":
    case "program":
      template.type = command;
      packageName = scriptConfig.args[4];
      if (packageName) {
        const [scopeName, templateName] = packageName.split("/");
        scope = scopeName;
        name = templateName;
      }
      if(scope && name) {
        template.createPackage(scope, name);
        break;
      }
      inquirer.prompt(template.askName()).then((answers) => {
        template.createPackage(answers.scopeName, answers.templateName);
      });
      break;
  }
};

export default TemplateCLI;
