import fs from "fs";
import os from "os";
import path from "path";
import Config, { ConfigError } from "../src/Config";
import { optionalExternalCheck } from "./helpers/ExternalTools";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
}

describe("test Config", () => {
  let configDir: string;
  let prefix: string;
  let config: Config;

  beforeAll(() => {
    configDir = createTempDir();
    prefix = path.join(configDir, "prefix");
    config = new Config(configDir);
  });

  it("write empty config file", () => {
    config.saveConfig();
  });

  it("write updated config file", () => {
    config.config.prefix = prefix;
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

describe("Config on first use", () => {
  let root: string;

  beforeEach(() => {
    root = createTempDir();
  });

  afterEach(() => {
    fs.chmodSync(root, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates the configuration directory and default file on first use", () => {
    const configDir = path.join(root, "a", "b");
    const config = new Config(configDir);
    const file = path.join(configDir, "config.json");
    expect(config.configPath).toBe(file);
    expect(config.configFile).toBe("config.json");
    expect(JSON.parse(fs.readFileSync(file).toString())).toEqual({
      prefix: path.join(os.homedir(), "the-seed"),
      scopes: {}
    });
    expect(config.config.scopes).toEqual({});
  });

  it("writes the default file when the directory exists and the file is missing", () => {
    const config = new Config(root);
    const file = path.join(root, "config.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file).toString()).scopes).toEqual({});
    expect(config.config.prefix).toBe(path.join(os.homedir(), "the-seed"));
  });

  it("reports an unwritable home in one line", () => {
    if (!optionalExternalCheck("unwritable-home", process.getuid?.() !== 0, "running as root, permissions are not enforced")) {
      return;
    }
    fs.chmodSync(root, 0o500);
    const configDir = path.join(root, "the-seed");
    let caught: unknown;
    try {
      new Config(configDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    // Message format: "Cannot create configuration directory <dir>: permission denied (EACCES)".
    expect(error.message).toContain(configDir);
    expect(error.message).toContain("permission denied (EACCES)");
    expect(error.message).not.toContain("\n");
    expect(error.path).toBe(configDir);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("writes through a temporary file and renames it", () => {
    const config = new Config(root);
    const renameSpy = jest.spyOn(fs, "renameSync");
    try {
      config.config.prefix = path.join(root, "p");
      config.saveConfig();
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [from, to] = renameSpy.mock.calls[0] as [string, string];
      expect(to).toBe(path.join(root, "config.json"));
      expect(path.dirname(from)).toBe(root);
      expect(path.basename(from)).toMatch(/^\.config\.json\..+\.tmp$/);
    } finally {
      renameSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(path.join(root, "config.json")).toString()).prefix).toBe(path.join(root, "p"));
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves no partial file when a save fails", () => {
    const config = new Config(root);
    const file = path.join(root, "config.json");
    // Make the rename fail by replacing the target with a non-empty directory.
    fs.rmSync(file);
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, "keep"), "x");
    config.config.prefix = path.join(root, "changed");
    let caught: unknown;
    try {
      config.saveConfig();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain("Cannot write " + file);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readdirSync(file)).toEqual(["keep"]);
    expect(fs.readdirSync(root).filter((name) => /^\.config\.json\..*\.tmp$/.test(name))).toEqual([]);
  });

  it("round trips a saved configuration", () => {
    const config = new Config(root);
    config.config.prefix = path.join(root, "prefix");
    config.saveConfig();
    config.config = { prefix: "", scopes: {} };
    config.loadConfig();
    expect(config.config.prefix).toBe(path.join(root, "prefix"));
  });
});
