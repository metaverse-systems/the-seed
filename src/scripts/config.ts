#!/usr/bin/env node
import os from "os";
import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";
const args = process.argv;

const homedir = os.homedir;
const configDir = homedir + "/.config/the-seed";
const prefixDir = homedir + "/the-seed";

if(!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir);
}

const config = new Config(configDir);
const updateConfig = () => {
  inquirer.prompt(config.getQuestions())
  .then((answers) => config.parseAnswers(answers))
  .then(() => config.saveConfig());
};

if(args.length < 3) {
  console.log(configDir + "/.config/the-seed/config.json");
  console.log(config.config);
  process.exit();
}

if(args[2] == "edit") {
  updateConfig();
}
