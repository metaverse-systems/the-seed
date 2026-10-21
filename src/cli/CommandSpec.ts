import { UsageError } from "./ExitStatus";
import { validateScopeName } from "../Scopes";

/** The result of reading one value from the command line. */
export type ValueResult = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Reads one value. `label` names what the value is for in a message: an option such as "--jobs",
 * or "<scope>/<name>".
 */
export type ValueParser = (raw: string, label: string) => ValueResult;

/** A positional argument of a subcommand. */
export interface PositionalSpec {
  /** Shown as <name>; also the key of the value in the parsed command */
  name: string;
  /** What the argument is, for the help */
  help: string;
  /** Missing → usage error "<name> is required." */
  required: boolean;
  /** Takes the remaining words (the last positional only) */
  variadic?: boolean;
  /** Fixed set of values; anything else is a usage error listing them */
  values?: string[];
  /** What a value from the fixed set is called in the error message (default: the name) */
  valueNoun?: string;
  /** Checks the form of the value and turns it into what the handler receives */
  parse?: ValueParser;
  /** A file system path: the word "help" in this slot asks for help, and one starting with "-" must be written "./-name" */
  isPath?: boolean;
  /** How the argument is written in a usage line when that differs from <name> */
  usage?: string;
}

/** An option of a subcommand; a flag when it has no `value`. */
export interface OptionSpec {
  /** "--" followed by lowercase words joined by "-" */
  name: string;
  /** Present for options that take a value, as "--name value" or "--name=value" */
  value?: {
    placeholder: string;
    parse: ValueParser;
    /** Sentence for a missing or empty value (default: "<name> needs a value.") */
    missing?: string;
  };
  /** Value options only: absent → usage error "<name> <placeholder> is required." */
  required?: boolean;
  /** Value options only: may be given more than once, the values accumulating in order */
  repeatable?: boolean;
  /** One line for the help */
  help: string;
}

/** What `parseCommandLine` hands to a handler. Every value is already validated. */
export interface ParsedCommand {
  command: string;
  /** The subcommand, or null for a command without subcommands */
  subcommand: string | null;
  /** Keyed by the positional's name; absent when not given */
  positionals: Record<string, unknown>;
  /** Keyed by the option name without its dashes; absent when not given */
  options: Record<string, unknown>;
  /** One-line warnings about the command line, printed before the command runs */
  warnings: string[];
}

/** The outcome of reading a command line. */
export type ParseOutcome =
  | { kind: "help"; text: string }
  | { kind: "run"; parsed: ParsedCommand }
  | { kind: "usage"; error: UsageError };

/** What a handler is given besides the parsed command. */
export interface CliContext {
  configDir: string;
  /** Whether prompts may be shown */
  interactive: boolean;
  cwd: string;
}

/** A word that stands for an option, kept for older command lines; using it gives a warning. */
export interface DeprecatedWord {
  word: string;
  /** The option it stands for, e.g. "--recursive" */
  option: string;
  warning: string;
}

/** A form of a command whose first word is an option rather than a positional. */
export interface LeadingOptionForm {
  /** The only options this form accepts */
  options: string[];
  /** The sentence for any other option */
  message: string;
}

/** One subcommand, or the arguments of a command that has none. */
export interface SubcommandSpec {
  /** Unique within the command; never starts with "-" */
  name: string;
  summary: string;
  positionals: PositionalSpec[];
  /** --help and -h are implicit and not listed */
  options: OptionSpec[];
  /** Prompts when run on a terminal; parsing still completes before any prompt */
  interactive: boolean;
  /** Paragraphs printed after the options in the help */
  notes: string[];
  /** Key of the function that runs it */
  handler: string;
  /** The positionals and options as written in a usage line, when the default order is not the one to show */
  usageTail?: string;
  leadingOptionForm?: LeadingOptionForm;
  deprecatedWords?: DeprecatedWord[];
}

/** A cross-argument rule, run after every argument is read. */
export type ValidateRule = (parsed: ParsedCommand) => { argument: string; message: string } | null;

/** One command of the tool. */
export interface CommandSpec {
  /** Unique */
  name: string;
  /** One line for the top-level help */
  summary: string;
  /** Empty for a command without subcommands */
  subcommands: SubcommandSpec[];
  /** The arguments of a command without subcommands */
  root?: SubcommandSpec;
  /** What the command alone does: print help, or run a subcommand */
  whenEmpty: "help" | { run: string };
  /** Paragraphs printed after the subcommand list in the help */
  notes: string[];
  validate?: ValidateRule;
  /** A subcommand that used to exist and where it went; named in the error for it */
  movedTo?: { subcommand: string; sentence: string };
}

/** A whole number from `min` up to `max` (no upper limit when omitted), written in digits only. */
export function wholeNumber(min: number, max?: number, expected?: string): ValueParser {
  const description =
    expected ?? (max === undefined ? "a positive whole number" : `a whole number from ${min} to ${max}`);
  return (raw, label) => {
    const value = Number(raw);
    const fits = /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(value) && value >= min && (max === undefined || value <= max);
    if (!fits) {
      return { ok: false, message: `Invalid value "${raw}" for ${label}; expected ${description}.` };
    }
    return { ok: true, value };
  };
}

/** A scope name, with or without its "@"; the value is the name with the "@". */
export const scopeName: ValueParser = (raw, label) => {
  const name = raw.startsWith("@") ? raw : `@${raw}`;
  const reason = validateScopeName(name);
  if (reason !== null) {
    return { ok: false, message: `Invalid value "${raw}" for ${label}; ${reason}` };
  }
  return { ok: true, value: name };
};

/** One of a fixed set of words. */
export function oneOf(values: string[]): ValueParser {
  return (raw, label) => {
    if (!values.includes(raw)) {
      return { ok: false, message: `Invalid value "${raw}" for ${label}; expected ${listWords(values)}.` };
    }
    return { ok: true, value: raw };
  };
}

/** Any non-empty text, such as a path. */
export const nonEmpty: ValueParser = (raw) => ({ ok: true, value: raw });

/** Words joined for a sentence: "a", "a or b", "a, b or c". */
export function listWords(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}
