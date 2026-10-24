import fs from "fs";
import os from "os";
import path from "path";
import Config, { ConfigError } from "../src/Config";
import Signing from "../src/Signing";
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

describe("Config with a damaged file", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = createTempDir();
    file = path.join(root, "config.json");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(text: string): void {
    fs.writeFileSync(file, text);
  }

  function load(): ConfigError {
    let caught: unknown;
    try {
      new Config(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.message).not.toContain("\n");
    expect(error.message).toContain(file);
    expect(error.path).toBe(file);
    return error;
  }

  it("fills a missing scopes list with an empty one", () => {
    const text = JSON.stringify({ prefix: path.join(root, "p") });
    write(text);
    const config = new Config(root);
    expect(config.config.scopes).toEqual({});
    expect(config.config.prefix).toBe(path.join(root, "p"));
    expect(fs.readFileSync(file).toString()).toBe(text);
  });

  it("fills a missing prefix with the default", () => {
    const text = JSON.stringify({ scopes: { "@a": { authorName: "A" } } });
    write(text);
    const config = new Config(root);
    expect(config.config.prefix).toBe(path.join(os.homedir(), "the-seed"));
    expect(config.config.scopes).toEqual({ "@a": { authorName: "A" } });
    expect(fs.readFileSync(file).toString()).toBe(text);
  });

  // Message format: '<path>: "prefix" must be a non-empty text value, got <type>'
  // with <type> one of number, boolean, array, null, object, string, or "empty text".
  const badPrefixes: Array<[string, unknown, string]> = [
    ["number", 3, "got number"],
    ["empty text", "", "got empty text"],
    ["null", null, "got null"],
    ["array", ["x"], "got array"],
  ];
  for (const [title, value, got] of badPrefixes) {
    it(`rejects a prefix that is not a non-empty text value (${title})`, () => {
      const text = JSON.stringify({ prefix: value, scopes: {} });
      write(text);
      const error = load();
      expect(error.message).toContain("\"prefix\" must be a non-empty text value");
      expect(error.message).toContain(got);
      expect(fs.readFileSync(file).toString()).toBe(text);
    });
  }

  // Message format: '<path>: "scopes" must be an object of named scopes, got <type>',
  // or 'got <type> for "<name>"' for a bad member.
  const badScopes: Array<[string, unknown, string]> = [
    ["array", [], "got array"],
    ["string", "x", "got string"],
    ["null", null, "got null"],
    ["member", { "@a": 3 }, "got number for \"@a\""],
  ];
  for (const [title, value, got] of badScopes) {
    it(`rejects scopes that are not an object of named scopes (${title})`, () => {
      const text = JSON.stringify({ prefix: path.join(root, "p"), scopes: value });
      write(text);
      const error = load();
      expect(error.message).toContain("\"scopes\" must be an object of named scopes");
      expect(error.message).toContain(got);
      expect(fs.readFileSync(file).toString()).toBe(text);
    });
  }

  // Message format: "<path> is not valid JSON: <parser message>".
  for (const [title, text] of [["garbage", "{ not json"], ["an empty file", ""]]) {
    it(`rejects a file that is not valid JSON (${title})`, () => {
      write(text);
      const error = load();
      expect(error.message).toContain("is not valid JSON");
      expect(fs.readFileSync(file).toString()).toBe(text);
    });
  }

  // Message format: "<path> must hold a JSON object, got <type>".
  for (const [text, got] of [["[]", "array"], ["null", "null"], ["\"x\"", "string"], ["3", "number"]]) {
    it(`rejects valid JSON that is not an object (${text})`, () => {
      write(text);
      const error = load();
      expect(error.message).toContain("must hold a JSON object");
      expect(error.message).toContain("got " + got);
      expect(fs.readFileSync(file).toString()).toBe(text);
    });
  }

  it("does not rewrite the file when filling defaults", () => {
    const text = "{\"other\":1}";
    write(text);
    const past = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(file, past, past);
    const before = fs.statSync(file).mtimeMs;
    const writeSpy = jest.spyOn(fs, "writeFileSync");
    const renameSpy = jest.spyOn(fs, "renameSync");
    try {
      new Config(root);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readFileSync(file).toString()).toBe(text);
  });

  it("keeps unknown entries when saving", () => {
    write(JSON.stringify({ prefix: path.join(root, "p"), scopes: {}, extra: { a: [1, 2] }, note: "kept" }));
    const config = new Config(root);
    expect((config.config as unknown as Record<string, unknown>).extra).toEqual({ a: [1, 2] });
    config.config.prefix = path.join(root, "q");
    config.saveConfig();
    expect(JSON.parse(fs.readFileSync(file).toString())).toEqual({
      prefix: path.join(root, "q"),
      scopes: {},
      extra: { a: [1, 2] },
      note: "kept",
    });
  });
});

describe("the default configuration directory", () => {
  let home: string;
  let originalHome: string | undefined;
  let homeSpy: jest.SpyInstance;

  /** `defaultConfigDir` is read from the module when the case runs, so this file compiles before it is exported. */
  function defaultConfigDir(): string {
    const loaded = jest.requireActual("../src/Config") as { defaultConfigDir?: () => string };
    if (typeof loaded.defaultConfigDir !== "function") {
      throw new Error("defaultConfigDir is not exported from src/Config");
    }
    return loaded.defaultConfigDir();
  }

  beforeEach(() => {
    home = fs.realpathSync(createTempDir());
    originalHome = process.env.HOME;
    process.env.HOME = home;
    // The home directory is read through os.homedir(), which does not follow a changed environment variable here.
    homeSpy = jest.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    homeSpy.mockRestore();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("is, today, the directory a Config and a Signing use without being told (guard on the value)", () => {
    expect(new Config().configDir).toBe(path.join(home, "the-seed"));
    expect(new Signing().configDir).toBe(path.join(home, "the-seed"));
  });

  it("is the-seed in the home directory", () => {
    expect(defaultConfigDir()).toBe(path.join(os.homedir(), "the-seed"));
    expect(defaultConfigDir()).toBe(path.join(home, "the-seed"));
  });

  it("is the directory a Config uses when none is given", () => {
    expect(new Config().configDir).toBe(defaultConfigDir());
    expect(fs.existsSync(path.join(defaultConfigDir(), "config.json"))).toBe(true);
  });

  it("is the default prefix of a Config with no prefix in its file", () => {
    const configDir = path.join(home, "other");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ scopes: {} }));
    expect(new Config(configDir).config.prefix).toBe(defaultConfigDir());
  });

  it("is the directory a Signing uses when none is given", () => {
    expect(new Signing().configDir).toBe(defaultConfigDir());
    expect(new Signing().signingDir).toBe(path.join(defaultConfigDir(), "signing"));
  });
});

describe("the configuration file's location", () => {
  let home: string;
  let originalHome: string | undefined;
  let homeSpy: jest.SpyInstance;

  /** `configFilePath` is read from the module when the case runs, so this file compiles before it is exported. */
  function configFilePath(configDir?: string): string {
    const loaded = jest.requireActual("../src/Config") as { configFilePath?: (configDir?: string) => string };
    if (typeof loaded.configFilePath !== "function") {
      throw new Error("configFilePath is not exported from src/Config");
    }
    return loaded.configFilePath(configDir);
  }

  beforeEach(() => {
    home = fs.realpathSync(createTempDir());
    originalHome = process.env.HOME;
    process.env.HOME = home;
    // The home directory is read through os.homedir(), which does not follow a changed environment variable here.
    homeSpy = jest.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    homeSpy.mockRestore();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("is config.json in the-seed in the home directory by default, and nothing is created", () => {
    expect(configFilePath()).toBe(path.join(home, "the-seed", "config.json"));
    expect(fs.existsSync(path.join(home, "the-seed"))).toBe(false);
    expect(fs.existsSync(path.join(home, "the-seed", "config.json"))).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("is config.json in the directory given, and nothing is created", () => {
    const configDir = path.join(home, "elsewhere");
    expect(configFilePath(configDir)).toBe(path.join(configDir, "config.json"));
    expect(fs.existsSync(configDir)).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("is the path a Config given that directory uses", () => {
    const configDir = path.join(home, "elsewhere");
    expect(new Config(configDir).configPath).toBe(configFilePath(configDir));
  });

  it("is the path a Config uses when none is given", () => {
    expect(new Config().configPath).toBe(configFilePath());
  });
});
