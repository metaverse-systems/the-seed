import { COMMANDS } from "./Commands";
import { CommandSpec, OptionSpec, PositionalSpec, SubcommandSpec } from "./CommandSpec";
import { EXIT_STATUSES } from "./ExitStatus";

const MAX_LINE = 100;

/** The usage line of the whole tool. */
export const TOP_USAGE = "Usage: the-seed <command> [<subcommand>] [arguments] [options]";

/** Whether a positional must be given: it is required itself, or a later one is. */
function mustGive(sub: SubcommandSpec, positional: PositionalSpec): boolean {
  const index = sub.positionals.indexOf(positional);
  return sub.positionals.slice(index).some((candidate) => candidate.required);
}

/** A positional as written in a usage line. */
function positionalUsage(sub: SubcommandSpec, positional: PositionalSpec): string {
  const base = positional.usage ?? `<${positional.name}>${positional.variadic ? "..." : ""}`;
  return mustGive(sub, positional) ? base : `[${base}]`;
}

/** A positional as listed under "Arguments". */
function positionalHead(sub: SubcommandSpec, positional: PositionalSpec): string {
  const base = `<${positional.name}>${positional.variadic ? "..." : ""}`;
  return mustGive(sub, positional) ? base : `[${base}]`;
}

/** An option as listed under "Options", without brackets. */
function optionHead(option: OptionSpec): string {
  return option.value ? `${option.name} <${option.value.placeholder}>` : option.name;
}

/** An option as written in a usage line. */
function optionUsage(option: OptionSpec): string {
  const head = optionHead(option);
  if (option.required) return head;
  return option.repeatable ? `[${head}]...` : `[${head}]`;
}

/** The positionals and options of a subcommand as written in its usage line. */
function usageTail(sub: SubcommandSpec): string {
  if (sub.usageTail !== undefined) return sub.usageTail;
  return [...sub.positionals.map((positional) => positionalUsage(sub, positional)), ...sub.options.map(optionUsage)].join(" ");
}

/** The usage line of a subcommand, or of a command without subcommands. */
export function subcommandUsage(command: CommandSpec, sub: SubcommandSpec): string {
  const name = command.root === sub ? command.name : `${command.name} ${sub.name}`;
  const tail = usageTail(sub);
  return `Usage: the-seed ${name}${tail === "" ? "" : ` ${tail}`}`;
}

/** The usage line of a command: its subcommands, or its own arguments when it has none. */
export function commandUsage(command: CommandSpec): string {
  if (command.root) {
    return subcommandUsage(command, command.root);
  }
  if (command.subcommands.length === 0) {
    return command.name === "help"
      ? "Usage: the-seed help [<command> [<subcommand>]]"
      : `Usage: the-seed ${command.name}`;
  }
  const names = command.subcommands.map((sub) => sub.name).join("|");
  return `Usage: the-seed ${command.name} ${command.whenEmpty === "help" ? `<${names}>` : `[${names}]`}`;
}

/** Breaks text into lines of at most `width` characters at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines;
}

/** Entries of a section: a head and a description beside it, the description wrapped under itself. */
function entries(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([head]) => head.length)) + 2;
  const lines: string[] = [];
  for (const [head, description] of rows) {
    const text = wrap(description, MAX_LINE - 2 - width);
    lines.push(`  ${head.padEnd(width)}${text[0]}`);
    for (const more of text.slice(1)) {
      lines.push(`  ${"".padEnd(width)}${more}`);
    }
  }
  return lines;
}

/** Notes: each is a paragraph, wrapped, except lines that begin with a space, which are kept as written. */
function noteLines(notes: string[]): string[] {
  const lines: string[] = [];
  for (const note of notes) {
    if (lines.length > 0) lines.push("");
    for (const line of note.split("\n")) {
      if (line.startsWith(" ")) lines.push(line);
      else lines.push(...wrap(line, MAX_LINE));
    }
  }
  return lines;
}

/** The help of the whole tool. */
export function renderTopLevelHelp(): string {
  const lines = [TOP_USAGE, "", "Commands:"];
  lines.push(...entries(COMMANDS.map((command): [string, string] => [command.name, command.summary])));
  lines.push("", "Exit statuses:");
  lines.push(...entries(EXIT_STATUSES.map((row): [string, string] => [row.status, row.meaning])));
  lines.push("");
  lines.push("Run \"the-seed help <command>\" for a command's subcommands and options.");
  lines.push("Set THE_SEED_DEBUG=1 to print the full details of an unexpected error.");
  return lines.join("\n");
}

/** The body of the help of a subcommand: summary, arguments, options and notes. */
function subcommandBody(sub: SubcommandSpec): string[] {
  const lines = [`${sub.summary}.`];
  if (sub.positionals.length > 0) {
    lines.push("", "Arguments:");
    lines.push(...entries(sub.positionals.map((positional): [string, string] => [positionalHead(sub, positional), positional.help])));
  }
  const rows = sub.options.map((option): [string, string] => [optionHead(option), option.help]);
  rows.push(["-h, --help", "Show this help"]);
  lines.push("", "Options:", ...entries(rows));
  if (sub.notes.length > 0) {
    lines.push("", ...noteLines(sub.notes));
  }
  return lines;
}

/** The help of one subcommand. */
export function renderSubcommandHelp(command: CommandSpec, sub: SubcommandSpec): string {
  return [subcommandUsage(command, sub), "", ...subcommandBody(sub)].join("\n");
}

/** The help of a command; for a command without subcommands, the whole help. */
export function renderCommandHelp(command: CommandSpec): string {
  if (command.root) {
    return renderSubcommandHelp(command, command.root);
  }
  const lines = [commandUsage(command), "", `${command.summary}.`];
  if (command.subcommands.length > 0) {
    const rows = command.subcommands.map((sub): [string, string] => {
      const tail = usageTail(sub);
      return [tail === "" ? sub.name : `${sub.name} ${tail}`, sub.summary];
    });
    lines.push("", "Subcommands:");
    for (const [head, summary] of rows) {
      lines.push(`  ${head}`, `      ${summary}`);
    }
  }
  if (command.notes.length > 0) {
    lines.push("", ...noteLines(command.notes));
  }
  if (command.subcommands.length > 0) {
    lines.push("", `Run "the-seed help ${command.name} <subcommand>" for one subcommand's details.`);
  }
  return lines.join("\n");
}
