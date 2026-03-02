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

  constructor(configDir?: string) {
    this.configDir = configDir || os.homedir() + "/the-seed";
    this.configFile = "/config.json";
    this.loadConfig();
  }

  loadConfig = () => {
    // if file does not exist, create it
    if (!fs.existsSync(this.configDir + this.configFile)) {
      this.saveConfig();
    }
    this.config = JSON.parse(fs.readFileSync(this.configDir + this.configFile).toString());
  };

  saveConfig = () => {
    fs.writeFileSync(this.configDir + this.configFile, JSON.stringify(this.config, null, 2));
  };

  getQuestions = () => {
    return [
      {
        name: "prefix",
        message: "Installation prefix?",
        default: this.config.prefix
      },
      {
        name: "name",
        message: "Your name (used for code signing certificate CN)?",
        default: this.config.name || ""
      },
      {
        name: "email",
        message: "Your email (used for code signing certificate EMAIL)?",
        default: this.config.email || ""
      },
      {
        name: "org",
        message: "Your organization (used for code signing certificate O)?",
        default: this.config.org || ""
      }
    ];
  };

  parseAnswers = (answers: { prefix: string; name?: string; email?: string; org?: string }) => {
    this.config.prefix = answers.prefix;
    if (answers.name !== undefined) this.config.name = answers.name || undefined;
    if (answers.email !== undefined) this.config.email = answers.email || undefined;
    if (answers.org !== undefined) this.config.org = answers.org || undefined;
  };
}

export default Config;
