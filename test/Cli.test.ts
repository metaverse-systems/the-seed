import fs from "fs";
import os from "os";
import path from "path";
import { runCli } from "../src/scripts/Cli";
import { optionalExternalCheck } from "./helpers/ExternalTools";

const mockPrompt = jest.fn();
jest.mock("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

const binName = "the-seed";

describe("runCli on first use", () => {
  let home: string;
  let configDir: string;
  let originalHome: string | undefined;
  let originalExitCode: typeof process.exitCode;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  const argv = (...rest: string[]) => ["node", binName, ...rest];
  const logged = () => logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    configDir = path.join(home, "the-seed");
    originalHome = process.env.HOME;
    originalExitCode = process.exitCode;
    process.env.HOME = home;
    process.exitCode = undefined;
    mockPrompt.mockReset();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.env.HOME = originalHome;
    process.exitCode = originalExitCode;
    fs.chmodSync(home, 0o755);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("config edit on an empty home creates the file with the chosen prefix and empty scopes", async () => {
    const prefix = path.join(home, "chosen");
    mockPrompt.mockResolvedValue({ prefix });
    await runCli(argv("config", "edit"), configDir, binName);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "config.json")).toString())).toEqual({ prefix, scopes: {} });
  });

  it("config list on an empty home prints the path and the defaults", async () => {
    await runCli(argv("config", "list"), configDir, binName);
    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls[0][0]).toBe(path.join(configDir, "config.json"));
    expect(logSpy.mock.calls[1][0]).toEqual({ prefix: path.join(os.homedir(), "the-seed"), scopes: {} });
    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(true);
  });

  const sections: Array<[string, string[]]> = [
    ["scopes list", ["scopes", "list"]],
    ["template", ["template"]],
    ["resource-pak", ["resource-pak", "help"]],
    ["dependencies help", ["dependencies", "help"]],
  ];
  for (const [title, rest] of sections) {
    it(`${title} on an empty home creates the configuration and does not throw`, async () => {
      await expect(runCli(argv(...rest), configDir, binName)).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();
      expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(true);
    });
  }

  it("signing help on an empty home works", async () => {
    await runCli(argv("signing", "help"), configDir, binName);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("build native outside a project on an empty home fails at autogen without a stack trace", async () => {
    const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-project-"));
    const originalCwd = process.cwd();
    process.chdir(emptyProject);
    try {
      await expect(runCli(argv("build", "native"), configDir, binName)).resolves.toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(emptyProject, { recursive: true, force: true });
    }
    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(true);
    expect(process.exitCode).toBe(1);
    const messages = errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(messages).toContain("autogen");
    expect(messages).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  });

  it("an unwritable home exits 1 with the message and no stack trace", async () => {
    if (!optionalExternalCheck("unwritable-home", process.getuid?.() !== 0, "running as root, permissions are not enforced")) {
      return;
    }
    fs.chmodSync(home, 0o500);
    await runCli(argv("config", "list"), configDir, binName);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain(configDir);
    expect(message).not.toContain("\n");
    expect(message).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("help and build help work with an unwritable home", async () => {
    if (!optionalExternalCheck("unwritable-home", process.getuid?.() !== 0, "running as root, permissions are not enforced")) {
      return;
    }
    fs.chmodSync(home, 0o500);
    await runCli(argv("help"), configDir, binName);
    await runCli(argv("build", "help"), configDir, binName);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logged()).toContain("build");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("a malformed prefix exits 1 with the one-line message and no stack trace", async () => {
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "config.json");
    const text = JSON.stringify({ prefix: 3, scopes: {} });
    fs.writeFileSync(file, text);
    await runCli(argv("config", "list"), configDir, binName);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain(file);
    expect(message).toContain("\"prefix\"");
    expect(message).not.toContain("\n");
    expect(message).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(fs.readFileSync(file).toString()).toBe(text);
  });
});
