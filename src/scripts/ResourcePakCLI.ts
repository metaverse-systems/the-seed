import Config from "../Config";
import { ScriptArgsType } from "../types";
import ResourcePak from "../ResourcePak";
import inquirer from "inquirer";

const ResourcePakCLI = (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);
  const command = scriptConfig.args[3];
  const name = scriptConfig.args[4];
  
  let rp: ResourcePak;

  switch(command) {
    case "help":
      console.log("Available resource-pak commands:");
      console.log("  create <name>");
      console.log("  add <resource-name> <filename>");
      console.log("  build");
      break;
    case "create":
      rp = new ResourcePak(config);
      inquirer.prompt(rp.askName())
        .then((answers) => {
          rp.createPackage(answers.scopeName, answers.pakName);
        });
      break;
    case "add":
      rp = new ResourcePak(config);
      rp.addResource(name, scriptConfig.args[5]);
      break;
    case "build":
      rp = new ResourcePak(config);
      rp.build();
      break;
  }
};

export default ResourcePakCLI;