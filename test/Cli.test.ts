/*
 * The command line as a whole, run in-process through `runCli(args, configDir)`: the first group
 * runs it directly with the console and the exit status observed; the groups `help` and
 * `usage errors before work` run it through `runTheSeed` with scratch homes and working
 * directories. The groups `help` and `usage errors before work` are table-driven over the
 * registry (`COMMANDS` in `src/cli/Commands.ts`), so a new command is covered without editing
 * them.
 *
 * Choices where the contracts leave a detail open:
 * - "Nothing created, changed or deleted" is a `snapshotTree` of the scratch home and of the
 *   scratch working directory before and after.
 * - The arguments around the unknown option are valid samples: `sample` for a positional (the
 *   first listed value for one with a fixed set, `@s/hello` for the template name) and `sample`
 *   for the value of a required option. An unknown option in the middle sits between the first
 *   two words of the sample arguments (for one word or none it is the same as first or last).
 * - The group `scopes list` writes a configuration file with the wanted scopes into a scratch home
 *   and passes it as `home`; scopes carry an author with a name, an email and an empty url. The
 *   note for no scopes is compared as the whole of standard error, one line.
 * - A command line that is a command and its subcommand shows the label `<command> <subcommand>`
 *   in the sentence; a command without subcommands shows `<command>`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runCli } from "../src/scripts/Cli";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { runTheSeed, snapshotTree } from "./helpers/RunCli";
import { COMMANDS } from "../src/cli/Commands";
import { renderTopLevelHelp, renderCommandHelp, renderSubcommandHelp } from "../src/cli/Help";
import type { CommandSpec, SubcommandSpec } from "../src/cli/CommandSpec";

const mockPrompt = jest.fn();
jest.mock("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

describe("runCli on first use", () => {
  let home: string;
  let configDir: string;
  let originalHome: string | undefined;
  let originalExitCode: typeof process.exitCode;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  const argv = (...rest: string[]) => rest;
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
    await runCli(argv("config", "edit"), configDir);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "config.json")).toString())).toEqual({ prefix, scopes: {} });
  });

  it("config list on an empty home prints the path and the defaults", async () => {
    await runCli(argv("config", "list"), configDir);
    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls[0][0]).toBe(path.join(configDir, "config.json"));
    expect(logSpy.mock.calls[1][0]).toEqual({ prefix: path.join(os.homedir(), "the-seed"), scopes: {} });
    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(true);
  });

  // Help is printed without reading the configuration, so only the command that lists scopes creates it.
  const sections: Array<[string, string[], boolean]> = [
    ["scopes list", ["scopes", "list"], true],
    ["template", ["template"], false],
    ["resource-pak", ["resource-pak", "help"], false],
    ["dependencies help", ["dependencies", "help"], false],
  ];
  for (const [title, rest, createsConfig] of sections) {
    it(`${title} on an empty home ${createsConfig ? "creates the configuration" : "prints help without creating it"} and does not throw`, async () => {
      await expect(runCli(argv(...rest), configDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();
      expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(createsConfig);
    });
  }

  it("dependencies check with an unknown target says so and exits 3 without a stack trace", async () => {
    await expect(runCli(argv("dependencies", "check", "macos"), configDir)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(3);
    expect(errorSpy.mock.calls.map((call) => String(call[0]))).toContain(
      "Error: Unrecognized target \"macos\"; expected native or windows."
    );
  });

  it("signing help on an empty home works", async () => {
    await runCli(argv("signing", "help"), configDir);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("build native outside a project on an empty home fails at autogen without a stack trace", async () => {
    const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-project-"));
    const originalCwd = process.cwd();
    process.chdir(emptyProject);
    try {
      await expect(runCli(argv("build", "native"), configDir)).resolves.toBeUndefined();
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

  it("an unwritable home exits 2 with the message and no stack trace", async () => {
    if (!optionalExternalCheck("unwritable-home", process.getuid?.() !== 0, "running as root, permissions are not enforced")) {
      return;
    }
    fs.chmodSync(home, 0o500);
    await runCli(argv("config", "list"), configDir);
    expect(process.exitCode).toBe(2);
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
    await runCli(argv("help"), configDir);
    await runCli(argv("build", "help"), configDir);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logged()).toContain("build");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("a malformed prefix exits 2 with the one-line message and no stack trace", async () => {
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "config.json");
    const text = JSON.stringify({ prefix: 3, scopes: {} });
    fs.writeFileSync(file, text);
    await runCli(argv("config", "list"), configDir);
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain(file);
    expect(message).toContain("\"prefix\"");
    expect(message).not.toContain("\n");
    expect(message).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(fs.readFileSync(file).toString()).toBe(text);
  });
});

interface Form {
  command: CommandSpec;
  sub: SubcommandSpec;
  /** The words naming the command and, when it has one, the subcommand */
  words: string[];
  /** The label shown in messages and in the help hint */
  label: string;
}

function forms(): Form[] {
  const result: Form[] = [];
  for (const command of COMMANDS) {
    if (command.root) {
      result.push({ command, sub: command.root, words: [command.name], label: command.name });
    }
    for (const sub of command.subcommands) {
      result.push({ command, sub, words: [command.name, sub.name], label: `${command.name} ${sub.name}` });
    }
  }
  return result;
}

const helpCommands = COMMANDS.filter((command) => command.name !== "help");

/** Valid arguments for the subcommand, as groups that must stay together: a positional, or an option with its value. */
function sampleGroups(sub: SubcommandSpec): string[][] {
  const groups: string[][] = [];
  for (const positional of sub.positionals) {
    if (!positional.required) continue;
    groups.push([positional.values ? positional.values[0] : positional.name === "name" ? "@s/hello" : "sample"]);
  }
  for (const option of sub.options) {
    if (option.required && option.value) groups.push([option.name, "sample"]);
  }
  return groups;
}

describe("help", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-help-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cli-help-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function help(args: string[]) {
    const run = await runTheSeed(args, { home, cwd, interactive: false });
    expect(run.stderr).toBe("");
    expect(run.prompts).toEqual([]);
    expect(run.stdout).not.toContain("the-seed.js");
    return run;
  }

  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("%p prints the top-level help with status 0 and reads no configuration", async (args) => {
    const run = await help(args);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(renderTopLevelHelp() + "\n");
    expect(snapshotTree(home)).toEqual([]);
    expect(snapshotTree(cwd)).toEqual([]);
  });

  describe.each(helpCommands.map((command) => [command.name, command] as const))("%s", (_name, command) => {
    it("prints the command's help for <command> help, --help, -h and help <command>", async () => {
      for (const args of [[command.name, "help"], [command.name, "--help"], [command.name, "-h"], ["help", command.name]]) {
        const run = await help(args);
        expect(run.status).toBe(0);
        expect(run.stdout).toBe(renderCommandHelp(command) + "\n");
      }
      expect(snapshotTree(home)).toEqual([]);
    });

    for (const sub of command.subcommands) {
      it(`prints ${sub.name}'s help for --help, -h, help ${command.name} ${sub.name}${sub.positionals.length === 0 || sub.positionals[0].isPath ? " and the word help" : ""}`, async () => {
        const argLists = [
          [command.name, sub.name, "--help"],
          [command.name, sub.name, "-h"],
          ["help", command.name, sub.name],
        ];
        if (sub.positionals.length === 0 || sub.positionals[0].isPath) {
          argLists.push([command.name, sub.name, "help"]);
        }
        for (const args of argLists) {
          const run = await help(args);
          expect(run.status).toBe(0);
          expect(run.stdout).toBe(renderSubcommandHelp(command, sub) + "\n");
        }
        expect(snapshotTree(home)).toEqual([]);
      });
    }
  });

  it("signing sign --forse -h prints sign's help and does nothing", async () => {
    const signing = COMMANDS.find((command) => command.name === "signing") as CommandSpec;
    const sign = signing.subcommands.find((sub) => sub.name === "sign") as SubcommandSpec;
    const run = await help(["signing", "sign", "--forse", "-h"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(renderSubcommandHelp(signing, sign) + "\n");
    expect(snapshotTree(home)).toEqual([]);
  });

  it("signing frob --help is a usage error naming frob", async () => {
    const run = await runTheSeed(["signing", "frob", "--help"], { home, cwd, interactive: false });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("frob");
    expect(run.stderr.split("\n")[0]).toMatch(/^Error: Unknown subcommand "frob" for "the-seed signing"\.$/);
  });
});

describe("usage errors before work", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-usage-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cli-usage-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function runWithNothingDone(args: string[], interactive: boolean) {
    const before = [snapshotTree(home), snapshotTree(cwd)];
    const run = await runTheSeed(args, { home, cwd, interactive });
    expect(run.prompts).toEqual([]);
    expect([snapshotTree(home), snapshotTree(cwd)]).toEqual(before);
    return run;
  }

  const unknownOptionForms = forms().map((form) => [form.label, form] as const);

  it.each(unknownOptionForms)("%s: an unknown option first, in the middle or last, and -x, is a usage error and nothing is done", async (_label, form) => {
    const groups = sampleGroups(form.sub);
    const samples = groups.flat();
    const middle = groups.length >= 2 ? [...groups[0], "--zz", ...groups.slice(1).flat()] : [...samples, "--zz"];
    const lines: Array<[string, string[]]> = [
      ["--zz", ["--zz", ...samples]],
      ["--zz", middle],
      ["--zz", [...samples, "--zz"]],
      ["-x", [...samples, "-x"]],
    ];
    for (const [word, tail] of lines) {
      const run = await runWithNothingDone([...form.words, ...tail], form.sub.interactive);
      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
      const errorLines = run.stderr.split("\n");
      expect(errorLines[0]).toBe(`Error: Unknown option "${word}" for "the-seed ${form.label}".`);
      expect(errorLines[1]).toMatch(new RegExp(`^Usage: the-seed ${form.label}( |$)`));
      expect(errorLines[2]).toBe(`Run "the-seed help ${form.label}" for details.`);
      expect(errorLines[3]).toBe("");
    }
  });

  it("an unknown command is a usage error with the command list", async () => {
    const run = await runWithNothingDone(["bogus"], false);
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr.split("\n")[0]).toBe(
      "Error: Unknown command \"bogus\". Commands: config, scopes, template, build, dependencies, package, resource-pak, signing, installer, help."
    );
    expect(run.stderr).toContain("Run \"the-seed help\" for details.");
  });

  it.each(["config", "scopes", "dependencies", "resource-pak", "installer", "signing"])(
    "%s bogus is an unknown-subcommand usage error",
    async (command) => {
      const run = await runWithNothingDone([command, "bogus"], false);
      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr.split("\n")[0]).toMatch(new RegExp(`^Error: Unknown subcommand "bogus" for "the-seed ${command}"\\.`));
    }
  );

  it.each(helpCommands.filter((command) => command.name !== "build" && command.name !== "config").map((command) => [command.name, command] as const))(
    "%s alone prints its help with status 0",
    async (_name, command) => {
      const run = await runWithNothingDone([command.name], false);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe(renderCommandHelp(command) + "\n");
    }
  );

  it("config alone lists the configuration, as config list does", async () => {
    const alone = await runTheSeed(["config"], { home, cwd, interactive: false });
    const listed = await runTheSeed(["config", "list"], { home, cwd, interactive: false });
    expect(alone.status).toBe(0);
    expect(alone.stdout).toBe(listed.stdout);
    expect(alone.stdout).toContain("config.json");
    expect(alone.stderr).toBe("");
  });

  it("config scopes list is a usage error that names \"the-seed scopes list\"", async () => {
    const run = await runWithNothingDone(["config", "scopes", "list"], false);
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr.split("\n")[0]).toBe(
      "Error: Unknown subcommand \"scopes\" for \"the-seed config\". Scopes are listed with \"the-seed scopes list\"."
    );
  });

  describe("value options", () => {
    const cases: Array<[string, string[], string, string]> = [
      ["build native", ["build", "native"], "--jobs", "2"],
      ["signing cert-info", ["signing", "cert-info"], "--scope", "@a"],
      ["installer windows", ["installer", "windows"], "--scope", "@a"],
    ];

    it.each(cases)("%s: the option without a value, and given twice, is a usage error", async (_label, words, option, value) => {
      const missing = await runWithNothingDone([...words, option], false);
      expect(missing.status).toBe(3);
      expect(missing.stdout).toBe("");
      expect(missing.stderr.split("\n")[0]).toMatch(new RegExp(`^Error: ${option} (needs a value|requires a positive whole number)\\.$`));

      const twice = await runWithNothingDone([...words, option, value, option, value], false);
      expect(twice.status).toBe(3);
      expect(twice.stdout).toBe("");
      expect(twice.stderr.split("\n")[0]).toBe(`Error: ${option} was given more than once.`);
    });
  });
});

describe("scopes list", () => {
  const author = { name: "Author", email: "a@example.com", url: "" };
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scopes-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const writeScopes = (names: string[]): void => {
    const configDir = path.join(home, "the-seed");
    fs.mkdirSync(configDir, { recursive: true });
    const scopes: Record<string, { author: typeof author }> = {};
    for (const name of names) {
      scopes[name] = { author };
    }
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: configDir, scopes }));
  };

  it("prints one name per line and nothing else for several scopes", async () => {
    writeScopes(["@a", "@b"]);
    const run = await runTheSeed(["scopes", "list"], { home });
    expect(run.stdout).toBe("@a\n@b\n");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("prints the one name for one scope", async () => {
    writeScopes(["@a"]);
    const run = await runTheSeed(["scopes", "list"], { home });
    expect(run.stdout).toBe("@a\n");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("with no scopes prints nothing on standard output and the note with the hint on standard error", async () => {
    writeScopes([]);
    const run = await runTheSeed(["scopes", "list"], { home });
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("No scopes are configured. Add one with \"the-seed scopes add\".\n");
    expect(run.status).toBe(0);
  });

  it("scopes delete with no scopes says there is nothing to delete, with the hint, on standard error and exits 0", async () => {
    writeScopes([]);
    const before = snapshotTree(home);
    const run = await runTheSeed(["scopes", "delete"], { home });
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("There are no scopes to delete.\nAdd one with \"the-seed scopes add\".\n");
    expect(run.status).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(snapshotTree(home)).toEqual(before);
  });

  it("config scopes list is a usage error naming \"the-seed scopes list\"", async () => {
    writeScopes(["@a"]);
    const run = await runTheSeed(["config", "scopes", "list"], { home });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Scopes are listed with \"the-seed scopes list\".");
  });

  it("config help does not mention scopes", async () => {
    const run = await runTheSeed(["config", "--help"], { home });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/scopes/i);
  });
});
