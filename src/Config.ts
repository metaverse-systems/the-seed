import fs from "fs";
import os from "os";

class Config {
  configDir: string;
  configFile: string;
  config: {
    [index: string]: any;
    prefix?: string;
  } = {
    prefix: "",
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
        default: this.config["prefix"] || os.homedir() + "/the-seed"
      },
      {
        name: "name",
        message: "Your name?"
      },
      {
        name: "email",
        message: "Your e-mail address?"
      },
      {
        name: "url",
        message: "Your website address?"
      },
    ];
  };

  parseAnswers = (answers: { [index:string]: any }) => {
    Object.keys(answers).forEach((k) => {
      this.config[k] = answers[k];
    });
  };
}

export default Config;
