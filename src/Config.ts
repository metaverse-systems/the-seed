import fs from "fs";
import os from "os";
import { ConfigType } from "./types";

class Config {
  configDir: string;
  configFile: string;
  config: ConfigType = {
    prefix: os.homedir() + "/the-seed",
    scopes: {}
  };

  constructor(configDir: string) {
    this.configDir = configDir;
    this.configFile = "/config.json";
    this.loadConfig();
  }

  loadConfig = () => {
    try {
      this.config = JSON.parse(fs.readFileSync(this.configDir + this.configFile).toString());
    } catch (err) {
    }
  };

  saveConfig = () => {
    fs.writeFileSync(this.configDir + this.configFile, JSON.stringify(this.config, null, 2));
  };

  getQuestions = () => {
    return [
      {
        name: "prefix",
        message: "Installation prefix?",
        default: this.config["prefix"]
      }
    ];
  };

  parseAnswers = (answers: { [index:string]: any }) => {
    Object.keys(answers).forEach((k) => {
      this.config[k] = answers[k];
    });
  };
}

export default Config;
