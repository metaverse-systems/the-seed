import fs from "fs";
import os from "os";
import Config from "../src/Config";

const home = os.homedir();
const prefix = home + "/the-seed";
const configDir = "./ConfigTestDir";

describe("test Config", () => {
  beforeAll(() => {
    fs.mkdirSync(configDir);
  });

  const config = new Config(configDir);

  it("write empty config file", () => {
    config.saveConfig();
  });

  it("write updated config file", () => {
    config.config["prefix"] = prefix;
    config.saveConfig();
  });

  it("clear config and reload", () => {
    config.config = {};
    config.loadConfig();
    expect(config.config.prefix).toBe(prefix);
  });

  afterAll(() => {
    fs.rmdirSync(configDir, { recursive: true });
  });
});
