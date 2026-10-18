import fs from "fs";
import os from "os";
import path from "path";
import { ConfigType } from "./types";

export class ConfigError extends Error {
  readonly path: string;

  constructor(message: string, errorPath: string) {
    super(message);
    this.name = "ConfigError";
    this.path = errorPath;
  }
}

const reasons: { [code: string]: string } = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
  EMFILE: "too many open files"
};

const describeError = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code) {
    return (reasons[code] || code.toLowerCase()) + " (" + code + ")";
  }
  return String((error as Error)?.message ?? error).split("\n")[0];
};

class Config {
  configDir: string;
  configFile: string;
  configPath: string;
  config: ConfigType = {
    prefix: path.join(os.homedir(), "the-seed"),
    scopes: {}
  };

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), "the-seed");
    this.configFile = "config.json";
    this.configPath = path.join(this.configDir, this.configFile);
    this.loadConfig();
  }

  loadConfig = () => {
    this.makeConfigDir();
    // if file does not exist, create it
    if (!fs.existsSync(this.configPath)) {
      this.saveConfig();
    }
    let text: string;
    try {
      text = fs.readFileSync(this.configPath).toString();
    } catch (error) {
      throw new ConfigError("Cannot read " + this.configPath + ": " + describeError(error), this.configPath);
    }
    this.config = JSON.parse(text);
  };

  saveConfig = () => {
    this.makeConfigDir();
    const tempPath = path.join(this.configDir, "." + this.configFile + "." + process.pid + ".tmp");
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.config, null, 2));
      fs.renameSync(tempPath, this.configPath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw new ConfigError("Cannot write " + this.configPath + ": " + describeError(error), this.configPath);
    }
  };

  private makeConfigDir = () => {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
    } catch (error) {
      throw new ConfigError("Cannot create configuration directory " + this.configDir + ": " + describeError(error), this.configDir);
    }
  };

  getQuestions = () => {
    return [
      {
        name: "prefix",
        message: "Installation prefix?",
        default: this.config.prefix
      }
    ];
  };

  parseAnswers = (answers: { prefix: string }) => {
    this.config.prefix = answers.prefix;
  };
}

export default Config;
