import { COMMANDS, findCommand } from "./Commands";
import { CommandSpec, OptionSpec, ParseOutcome, ParsedCommand, SubcommandSpec, listWords } from "./CommandSpec";
import { UsageError } from "./ExitStatus";
import {
  TOP_USAGE,
  commandUsage,
  renderCommandHelp,
  renderSubcommandHelp,
  renderTopLevelHelp,
  subcommandUsage,
} from "./Help";

const isHelpFlag = (word: string): boolean => word === "--help" || word === "-h";

const isOptionWord = (word: string): boolean => word.startsWith("-") && word.length > 1;

/** Thrown inside the parser to end it with an outcome. */
class Outcome {
  constructor(readonly outcome: ParseOutcome) {}
}

function usageOutcome(message: string, argument: string, command?: CommandSpec, sub?: SubcommandSpec): Outcome {
  let usage = TOP_USAGE;
  if (command && sub) usage = subcommandUsage(command, sub);
  else if (command) usage = commandUsage(command);
  const error = new UsageError(message, {
    argument,
    command: command?.name ?? "",
    subcommand: command && sub && command.root !== sub ? sub.name : undefined,
    usage,
  });
  return new Outcome({ kind: "usage", error });
}

function unknownSubcommand(command: CommandSpec, word: string): Outcome {
  let message = `Unknown subcommand "${word}" for "the-seed ${command.name}".`;
  if (command.movedTo && command.movedTo.subcommand === word) {
    message += ` ${command.movedTo.sentence}`;
  }
  return usageOutcome(message, word, command);
}

function unknownCommand(word: string): Outcome {
  const names = COMMANDS.map((command) => command.name).join(", ");
  return usageOutcome(`Unknown command "${word}". Commands: ${names}.`, word);
}

/** Help asked for with `help <command> [<subcommand>]`. */
function helpFor(words: string[]): ParseOutcome {
  if (words.length === 0) {
    return { kind: "help", text: renderTopLevelHelp() };
  }
  const command = findCommand(words[0]);
  if (!command) throw unknownCommand(words[0]);
  if (words.length === 1) {
    return { kind: "help", text: renderCommandHelp(command) };
  }
  if (command.subcommands.length === 0) {
    const helpCommand = findCommand("help") as CommandSpec;
    throw usageOutcome(`Unexpected argument "${words[1]}" for "the-seed help".`, words[1], helpCommand);
  }
  const sub = command.subcommands.find((candidate) => candidate.name === words[1]);
  if (!sub) throw unknownSubcommand(command, words[1]);
  if (words.length > 2) {
    const helpCommand = findCommand("help") as CommandSpec;
    throw usageOutcome(`Unexpected argument "${words[2]}" for "the-seed help".`, words[2], helpCommand);
  }
  return { kind: "help", text: renderSubcommandHelp(command, sub) };
}

/** Reads the words after a subcommand (or after a command that has none). */
function readArguments(command: CommandSpec, sub: SubcommandSpec, words: string[]): ParseOutcome {
  const isRoot = command.root === sub;
  const label = isRoot ? command.name : `${command.name} ${sub.name}`;
  const fail = (message: string, argument: string): Outcome => usageOutcome(message, argument, command, sub);

  const parsed: ParsedCommand = {
    command: command.name,
    subcommand: isRoot ? null : sub.name,
    positionals: {},
    options: {},
    warnings: [],
  };
  const seen = new Set<OptionSpec>();
  // A line that starts with an option and names no target is the form without a target.
  const targets = sub.positionals[0]?.values ?? [];
  const leading =
    sub.leadingOptionForm && words.length > 0 && isOptionWord(words[0]) && !words.some((word) => targets.includes(word))
      ? sub.leadingOptionForm
      : null;
  let positionalCount = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (isOptionWord(word)) {
      const equals = word.indexOf("=");
      const name = equals === -1 ? word : word.slice(0, equals);
      const option = name.startsWith("--") ? sub.options.find((candidate) => candidate.name === name) : undefined;
      if (!option) {
        throw fail(`Unknown option "${word}" for "the-seed ${label}".`, word);
      }
      if (leading && !leading.options.includes(name)) {
        throw fail(leading.message, word);
      }
      const key = option.name.slice(2);

      if (!option.value) {
        if (equals !== -1) {
          throw fail(`Option "${name}" for "the-seed ${label}" does not take a value.`, word);
        }
        parsed.options[key] = true;
        continue;
      }

      if (seen.has(option) && !option.repeatable) {
        throw fail(`${name} was given more than once.`, word);
      }
      seen.add(option);

      let raw: string | undefined;
      let valueArgument = word;
      if (equals !== -1) {
        raw = word.slice(equals + 1);
      } else if (i + 1 < words.length && !words[i + 1].startsWith("-")) {
        i++;
        raw = words[i];
        valueArgument = raw;
      } else if (i + 1 < words.length - 1 && isOptionWord(words[i + 1]) && !isKnownOption(sub, words[i + 1])) {
        // An unknown option with more words after it is reported as unknown; the option
        // that lacks its value is only reported when nothing else on the line is wrong.
        continue;
      }
      if (raw === undefined || raw === "") {
        throw fail(option.value.missing ?? `${name} needs a value.`, name);
      }
      const result = option.value.parse(raw, name);
      if (!result.ok) {
        throw fail(result.message, valueArgument);
      }
      if (option.repeatable) {
        const values = (parsed.options[key] as unknown[] | undefined) ?? [];
        values.push(result.value);
        parsed.options[key] = values;
      } else {
        parsed.options[key] = result.value;
      }
      continue;
    }

    // A positional word.
    if (
      positionalCount === 0 &&
      !leading &&
      word === "help" &&
      (sub.positionals.length === 0 || sub.positionals[0].isPath)
    ) {
      return { kind: "help", text: isRoot ? renderCommandHelp(command) : renderSubcommandHelp(command, sub) };
    }

    const last = sub.positionals[sub.positionals.length - 1];
    const slot = leading
      ? undefined
      : positionalCount < sub.positionals.length
        ? sub.positionals[positionalCount]
        : last && last.variadic
          ? last
          : undefined;
    if (!slot) {
      const deprecated = leading ? undefined : sub.deprecatedWords?.find((candidate) => candidate.word === word);
      if (deprecated) {
        parsed.options[deprecated.option.slice(2)] = true;
        if (!parsed.warnings.includes(deprecated.warning)) parsed.warnings.push(deprecated.warning);
        continue;
      }
      throw fail(`Unexpected argument "${word}" for "the-seed ${label}".`, word);
    }
    positionalCount++;

    if (word === "") {
      throw fail(`<${slot.name}> needs a value.`, `<${slot.name}>`);
    }
    let value: unknown = word;
    if (slot.values && !slot.values.includes(word)) {
      const noun = slot.valueNoun ?? slot.name;
      throw fail(`Unrecognized ${noun} "${word}"; expected ${listWords(slot.values)}.`, word);
    }
    if (slot.parse) {
      const result = slot.parse(word, slot.usage ?? `<${slot.name}>`);
      if (!result.ok) throw fail(result.message, word);
      value = result.value;
    }
    if (slot.variadic) {
      const values = (parsed.positionals[slot.name] as unknown[] | undefined) ?? [];
      values.push(value);
      parsed.positionals[slot.name] = values;
    } else {
      parsed.positionals[slot.name] = value;
    }
  }

  for (const positional of sub.positionals) {
    if (positional.required && parsed.positionals[positional.name] === undefined) {
      throw fail(`<${positional.name}> is required.`, `<${positional.name}>`);
    }
  }
  for (const option of sub.options) {
    if (option.required && option.value && !seen.has(option)) {
      throw fail(`${option.name} <${option.value.placeholder}> is required.`, option.name);
    }
  }
  const problem = command.validate ? command.validate(parsed) : null;
  if (problem) {
    throw fail(problem.message, problem.argument);
  }
  return { kind: "run", parsed };
}

function isKnownOption(sub: SubcommandSpec, word: string): boolean {
  const equals = word.indexOf("=");
  const name = equals === -1 ? word : word.slice(0, equals);
  return sub.options.some((option) => option.name === name);
}

/** Reads the words after a known command. */
function readCommand(command: CommandSpec, rest: string[]): ParseOutcome {
  const helpAsked = rest.some(isHelpFlag);
  const commandHelp: ParseOutcome = { kind: "help", text: renderCommandHelp(command) };

  if (command.root) {
    if (helpAsked || rest[0] === "help") return commandHelp;
    if (rest.length === 0 && command.whenEmpty === "help") return commandHelp;
    return readArguments(command, command.root, rest);
  }

  if (command.subcommands.length === 0) {
    return commandHelp;
  }

  const first = rest[0];
  if (first === undefined) {
    if (command.whenEmpty === "help") return commandHelp;
    const name = command.whenEmpty.run;
    const sub = command.subcommands.find((candidate) => candidate.name === name) as SubcommandSpec;
    return readArguments(command, sub, []);
  }
  if (first === "help" || isHelpFlag(first)) return commandHelp;

  const sub = command.subcommands.find((candidate) => candidate.name === first);
  if (!sub) {
    if (isOptionWord(first)) {
      if (helpAsked) return commandHelp;
      throw usageOutcome(`Unknown option "${first}" for "the-seed ${command.name}".`, first, command);
    }
    throw unknownSubcommand(command, first);
  }
  if (helpAsked) {
    return { kind: "help", text: renderSubcommandHelp(command, sub) };
  }
  return readArguments(command, sub, rest.slice(1));
}

/**
 * Reads a whole command line (the words after the program name) without reading any file, the
 * configuration or the environment. The outcome is the help to print, the command to run with
 * every value already validated, or the usage error to report.
 */
export function parseCommandLine(argv: string[]): ParseOutcome {
  try {
    if (argv.length === 0 || isHelpFlag(argv[0])) {
      return { kind: "help", text: renderTopLevelHelp() };
    }
    if (argv[0] === "help") {
      return helpFor(argv.slice(1));
    }
    const command = findCommand(argv[0]);
    if (!command) {
      if (isOptionWord(argv[0])) {
        throw usageOutcome(`Unknown option "${argv[0]}" for "the-seed".`, argv[0]);
      }
      throw unknownCommand(argv[0]);
    }
    return readCommand(command, argv.slice(1));
  } catch (thrown) {
    if (thrown instanceof Outcome) {
      return thrown.outcome;
    }
    throw thrown;
  }
}
