/**
 * Tests for the help text rendered from the command registry.
 *
 * Interfaces this file expects: `src/cli/Help.ts` exports `renderTopLevelHelp()`,
 * `renderCommandHelp(command: CommandSpec)` and
 * `renderSubcommandHelp(command: CommandSpec, subcommand: SubcommandSpec)`, taking the registry's
 * spec objects; `src/cli/Commands.ts` exports `COMMANDS: CommandSpec[]`; `src/cli/ExitStatus.ts`
 * exports `EXIT_STATUSES: Array<{ status: string; meaning: string }>`. A meaning that does not
 * fit on a line may continue on following lines that are indented deeper than the entry; the
 * continuation is joined with single spaces before it is compared.
 */
import { COMMANDS } from "../src/cli/Commands";
import { renderTopLevelHelp, renderCommandHelp, renderSubcommandHelp } from "../src/cli/Help";
import { EXIT_STATUSES } from "../src/cli/ExitStatus";
import type { CommandSpec, SubcommandSpec } from "../src/cli/CommandSpec";

const MAX_LINE = 100;

interface Entry {
  /** The first line of the entry without its indentation */
  head: string;
  /** The entry with its continuation lines joined by single spaces */
  text: string;
}

/** The entries of a section such as "Commands:", entries being lines indented by exactly two spaces. */
function section(text: string, title: string): Entry[] | null {
  const lines = text.split("\n");
  const start = lines.indexOf(`${title}:`);
  if (start === -1) return null;
  const entries: Entry[] = [];
  for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) {
    const line = lines[i];
    if (/^ {2}\S/.test(line)) {
      entries.push({ head: line.slice(2), text: line.trim().replace(/\s+/g, " ") });
    } else if (entries.length > 0) {
      entries[entries.length - 1].text += ` ${line.trim()}`;
    }
  }
  return entries;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

function allHelpTexts(): Array<{ label: string; text: string }> {
  const texts = [{ label: "the-seed", text: renderTopLevelHelp() }];
  for (const command of COMMANDS) {
    texts.push({ label: command.name, text: renderCommandHelp(command) });
    for (const sub of command.subcommands) {
      texts.push({ label: `${command.name} ${sub.name}`, text: renderSubcommandHelp(command, sub) });
    }
  }
  return texts;
}

function optionNamesIn(entries: Entry[]): string[] {
  return entries.map((entry) => {
    const usage = entry.head.split(/\s{2,}/)[0];
    const match = usage.match(/--[a-z][a-z-]*/);
    if (!match) throw new Error(`No option name in "${entry.head}"`);
    return match[0];
  });
}

function stripMarks(token: string): string {
  return token.replace(/[<>[\].]/g, "");
}

describe("top-level help", () => {
  const text = renderTopLevelHelp();

  it("starts with the usage line", () => {
    expect(text.split("\n")[0]).toBe("Usage: the-seed <command> [<subcommand>] [arguments] [options]");
  });

  it("lists every registry command once with its summary", () => {
    const entries = section(text, "Commands");
    expect(entries).not.toBeNull();
    const listed = (entries ?? []).map((entry) => words(entry.head)[0]);
    expect(listed.slice().sort()).toEqual(COMMANDS.map((command) => command.name).sort());
    for (const command of COMMANDS) {
      const entry = (entries ?? []).find((candidate) => words(candidate.head)[0] === command.name);
      expect(entry).toBeDefined();
      expect(entry?.head).toMatch(new RegExp(`^${command.name} {2,}\\S`));
      expect(entry?.text).toBe(`${command.name} ${command.summary}`.replace(/\s+/g, " ").trim());
    }
  });

  it("lists the exit statuses of the table, in order", () => {
    const entries = section(text, "Exit statuses");
    expect(entries).not.toBeNull();
    const listed = (entries ?? []).map((entry) => entry.text);
    const expected = EXIT_STATUSES.map((row) => `${row.status} ${row.meaning}`.replace(/\s+/g, " ").trim());
    expect(listed).toEqual(expected);
  });

  it("ends with the two closing lines", () => {
    const lines = text.trimEnd().split("\n");
    expect(lines.slice(-2)).toEqual([
      "Run \"the-seed help <command>\" for a command's subcommands and options.",
      "Set THE_SEED_DEBUG=1 to print the full details of an unexpected error.",
    ]);
  });
});

describe("command help", () => {
  const withSubcommands = COMMANDS.filter((command) => command.subcommands.length > 0);

  it.each(withSubcommands.map((command) => [command.name, command] as const))(
    "%s lists exactly the registry's subcommands with their summaries",
    (_name, command: CommandSpec) => {
      const text = renderCommandHelp(command);
      expect(text.split("\n")[0].startsWith(`Usage: the-seed ${command.name}`)).toBe(true);
      const entries = section(text, "Subcommands");
      expect(entries).not.toBeNull();
      expect((entries ?? []).map((entry) => words(entry.head)[0])).toEqual(
        command.subcommands.map((sub) => sub.name)
      );
      for (const sub of command.subcommands) {
        expect(text).toContain(sub.summary);
      }
      expect(text).toContain(`Run "the-seed help ${command.name} <subcommand>" for one subcommand's details.`);
    }
  );

  it.each(COMMANDS.filter((command) => command.root).map((command) => [command.name, command] as const))(
    "%s, which has no subcommands, shows its arguments and options directly",
    (_name, command: CommandSpec) => {
      const text = renderCommandHelp(command);
      expect(text.split("\n")[0].startsWith(`Usage: the-seed ${command.name}`)).toBe(true);
      expect(section(text, "Subcommands")).toBeNull();
      const root = command.root as SubcommandSpec;
      const options = section(text, "Options");
      expect(options).not.toBeNull();
      expect(optionNamesIn(options ?? []).sort()).toEqual(
        [...root.options.map((option) => option.name), "--help"].sort()
      );
    }
  );

  it("does not mention scopes in the help of config", () => {
    const config = COMMANDS.find((command) => command.name === "config") as CommandSpec;
    const texts = [renderCommandHelp(config), ...config.subcommands.map((sub) => renderSubcommandHelp(config, sub))];
    for (const text of texts) {
      expect(text).not.toMatch(/scopes/i);
    }
  });
});

describe("subcommand help", () => {
  const forms = COMMANDS.flatMap((command) =>
    command.subcommands.map((sub) => [`${command.name} ${sub.name}`, command, sub] as const)
  );

  it("has subcommands to test", () => {
    expect(forms.length).toBeGreaterThan(10);
  });

  it.each(forms)("%s lists exactly its positionals and options plus -h, --help", (_label, command, sub) => {
    const text = renderSubcommandHelp(command, sub);
    expect(text.split("\n")[0].startsWith(`Usage: the-seed ${command.name} ${sub.name}`)).toBe(true);
    expect(text).toContain(sub.summary);

    const args = section(text, "Arguments");
    if (sub.positionals.length === 0) {
      expect(args).toBeNull();
    } else {
      expect((args ?? []).map((entry) => stripMarks(words(entry.head)[0]))).toEqual(
        sub.positionals.map((positional) => positional.name)
      );
    }

    const options = section(text, "Options");
    expect(options).not.toBeNull();
    expect(optionNamesIn(options ?? []).sort()).toEqual([...sub.options.map((option) => option.name), "--help"].sort());
    expect((options ?? []).some((entry) => /^-h, --help {2,}\S/.test(entry.head))).toBe(true);
    for (const option of sub.options) {
      const entry = (options ?? []).find((candidate) => candidate.head.startsWith(option.name));
      expect(entry?.text).toContain(option.help);
    }
  });
});

describe("resource-pak create help", () => {
  const command = COMMANDS.find((candidate) => candidate.name === "resource-pak") as CommandSpec;
  const create = command.subcommands.find((candidate) => candidate.name === "create") as SubcommandSpec;

  it("has the summary for the current directory", () => {
    expect(create.summary).toBe("Create a resource pak project in the current directory");
    expect(renderSubcommandHelp(command, create)).toContain("Create a resource pak project in the current directory");
  });

  it("takes the optional positional [<scope>/<name>]", () => {
    expect(create.positionals).toHaveLength(1);
    expect(create.positionals[0].required).toBe(false);
    const text = renderSubcommandHelp(command, create);
    expect(text.split("\n")[0]).toBe("Usage: the-seed resource-pak create [<scope>/<name>]");
  });

  it("describes the positional", () => {
    const args = section(renderSubcommandHelp(command, create), "Arguments") ?? [];
    expect(args).toHaveLength(1);
    expect(args[0].text).toContain("The resource pak, such as @my-scope/sounds; asked for when not given");
  });

  it("lists create [<scope>/<name>] with its summary in the help of the command", () => {
    const entries = section(renderCommandHelp(command), "Subcommands") ?? [];
    const entry = entries.find((candidate) => candidate.head.startsWith("create"));
    expect(entry?.text).toContain("create [<scope>/<name>]");
    expect(entry?.text).toContain("Create a resource pak project in the current directory");
  });
});

describe("resource-pak add help", () => {
  const command = COMMANDS.find((candidate) => candidate.name === "resource-pak") as CommandSpec;
  const add = command.subcommands.find((candidate) => candidate.name === "add") as SubcommandSpec;

  it("lists --force with its description", () => {
    const options = section(renderSubcommandHelp(command, add), "Options") ?? [];
    const entry = options.find((candidate) => candidate.head.startsWith("--force"));
    expect(entry?.text).toContain("Replace a resource of the same name");
  });

  it("has the usage line with --attribute and --force", () => {
    expect(renderSubcommandHelp(command, add).split("\n")[0]).toBe(
      "Usage: the-seed resource-pak add <resource-name> <filename> [--attribute <key>=<value>]... [--force]");
  });

  it("lists --attribute <key>=<value> with its description", () => {
    const options = section(renderSubcommandHelp(command, add), "Options") ?? [];
    const entry = options.find((candidate) => candidate.head.startsWith("--attribute"));
    expect(entry?.head).toContain("--attribute <key>=<value>");
    expect(entry?.text).toContain("Record an attribute on the resource; give it once per attribute");
  });

  it("lists add with --attribute and --force in the help of the command", () => {
    const entries = section(renderCommandHelp(command), "Subcommands") ?? [];
    const entry = entries.find((candidate) => candidate.head.startsWith("add"));
    expect(entry?.text).toContain("add <resource-name> <filename> [--attribute <key>=<value>]... [--force]");
  });
});

describe("every help text", () => {
  it.each(allHelpTexts().map((help) => [help.label, help.text] as const))(
    "%s has no line over 100 characters and never names the script file",
    (_label, text) => {
      for (const line of text.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(MAX_LINE);
      }
      expect(text).not.toContain("the-seed.js");
      expect(text).not.toContain("Error:");
    }
  );
});
