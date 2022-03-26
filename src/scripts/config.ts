#!/usr/bin/env node
import os from "os";
import fs from "fs";
import inquirer from "inquirer";
import Config from "../Config";

const homedir = os.homedir;
const configDir = homedir + "/.config/the-seed";
const prefixDir = homedir + "/the-seed";

if(!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir);
}

const config = new Config(configDir);
inquirer.prompt(config.getQuestions())
.then((answers) => config.parseAnswers(answers))
.then(() => config.saveConfig());
