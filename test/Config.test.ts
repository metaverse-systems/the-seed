import fs from "fs";
import os from "os";
import path from "path";
import Config from "../src/Config";

const home = os.homedir();
const prefix = home + "/the-seed";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
}

describe("test Config", () => {
  let configDir: string;
  let config: Config;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);
  });

  it("write empty config file", () => {
    config.saveConfig();
  });

  it("write updated config file", () => {
    config.config["prefix"] = prefix;
    config.saveConfig();
  });

  it("clear config and reload", () => {
    config.config = { prefix: "", scopes: {} };
    config.loadConfig();
    expect(config.config.prefix).toBe(prefix);
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });
});
