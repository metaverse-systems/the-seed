/**
 * Tests for the pure command-line parser, driven by the command registry so that a new command
 * or option is covered without editing this file.
 *
 * Interfaces this file expects (the parts the written contracts leave open):
 *
 * - `src/cli/Commands.ts` exports `COMMANDS: CommandSpec[]`, the registry (the command named
 *   `help` is one of its entries and has no subcommands and no `root`).
 * - `src/cli/ParseArgs.ts` exports `parseCommandLine(argv: string[]): ParseOutcome`, where `argv`
 *   holds the words after the program name.
 * - `src/cli/Help.ts` exports `renderTopLevelHelp()`, `renderCommandHelp(command: CommandSpec)` and
 *   `renderSubcommandHelp(command: CommandSpec, subcommand: SubcommandSpec)` (spec objects, not
 *   names). For a command with a `root` (`build`, `package`) the command help is the whole help.
 * - `src/cli/CommandSpec.ts` exports the types `CommandSpec`, `SubcommandSpec`, `OptionSpec`,
 *   `ParseOutcome` and `ParsedCommand` with the fields of the registry description.
 * - `src/cli/ExitStatus.ts` exports `UsageError` with the fields `message`, `argument`, `command`,
 *   `subcommand` (undefined when the error is not about a subcommand), `usage` (the complete usage
 *   line, starting with "Usage: ") and `hint` (the help hint, `helpHint(command, subcommand)`).
 *   For a command with a `root` the subcommand is undefined.
 * - A `run` outcome's `parsed.subcommand` is the subcommand name, or null for a command with a
 *   `root`. `parsed.options` is keyed by the option name without its leading dashes
 *   (`"validity-days"`): a flag is `true` when given and absent otherwise, a value option holds
 *   the parsed value (`parallel` and `jobs` numbers), and a repeatable value option holds an
 *   array in command-line order. `parsed.positionals` is keyed by the positional's name; the
 *   build target is `target`, the path of `signing sign` is `path`, and the `template` word is
 *   `name` holding `{ scope, name }` with the scope normalised to start with "@".
 * - `parsed.warnings` is always present: an array of one-line warnings about the command line
 *   (the deprecated bare word `recursive` gives exactly one, mentioning `"recursive"`).
 * - A value given as a separate word never starts with "-" (such a word is not taken as the value
 *   and the option "needs a value"), so negative numbers are written `--name=-5` here.
 * - While reading the incremental form of `build` (first word starts with "-"), any option other
 *   than `--jobs` is the error "A build target is required: native or windows." with that option
 *   as the argument; it takes precedence over errors in later words.
 */
import fs from "fs";
import { COMMANDS } from "../src/cli/Commands";
import { parseCommandLine } from "../src/cli/ParseArgs";
import { renderTopLevelHelp, renderCommandHelp, renderSubcommandHelp } from "../src/cli/Help";
import { helpHint } from "../src/cli/Hints";
import type { UsageError } from "../src/cli/ExitStatus";
import type {
  CommandSpec,
  SubcommandSpec,
  OptionSpec,
  ParseOutcome,
  ParsedCommand,
} from "../src/cli/CommandSpec";

type Fields = Record<string, unknown>;

const COMMAND_LIST =
  "config, scopes, template, build, dependencies, package, resource-pak, signing, installer, help";

interface Form {
  command: CommandSpec;
  sub: SubcommandSpec;
  /** The words naming the command (and subcommand) */
  words: string[];
  /** The command and subcommand as shown in messages */
  label: string;
  /** The subcommand name, or undefined for a command with a root */
  subName: string | undefined;
}

const COMMANDS_BUT_HELP = COMMANDS.filter((command) => command.name !== "help");

const FORMS: Form[] = COMMANDS_BUT_HELP.flatMap((command): Form[] => {
  if (command.root) {
    return [{ command, sub: command.root, words: [command.name], label: command.name, subName: undefined }];
  }
  return command.subcommands.map((sub) => ({
    command,
    sub,
    words: [command.name, sub.name],
    label: `${command.name} ${sub.name}`,
    subName: sub.name,
  }));
});

function expectRun(outcome: ParseOutcome): ParsedCommand {
  if (outcome.kind !== "run") {
    throw new Error(`Expected a run outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome.parsed;
}

function expectHelp(outcome: ParseOutcome): string {
  if (outcome.kind !== "help") {
    throw new Error(`Expected a help outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome.text;
}

function expectUsage(outcome: ParseOutcome): UsageError {
  if (outcome.kind !== "usage") {
    throw new Error(`Expected a usage error, got ${JSON.stringify(outcome)}`);
  }
  return outcome.error;
}

function options(parsed: ParsedCommand): Fields {
  return parsed.options as unknown as Fields;
}

function positionals(parsed: ParsedCommand): Fields {
  return parsed.positionals as unknown as Fields;
}

function helpFor(form: Form): string {
  return form.command.root ? renderCommandHelp(form.command) : renderSubcommandHelp(form.command, form.sub);
}

function key(option: OptionSpec): string {
  return option.name.replace(/^--/, "");
}

/** A valid value for a value option. */
function sampleValue(option: OptionSpec): string {
  switch (option.name) {
    case "--validity-days":
      return "30";
    case "--jobs":
    case "--parallel":
      return "2";
    case "--scope":
      return "@a";
    default:
      return "file.pem";
  }
}

/** Arguments that a value option needs to be accepted beside it. */
function companions(option: OptionSpec): string[] {
  return option.name === "--parallel" ? ["--recursive"] : [];
}

function samplePositional(positional: SubcommandSpec["positionals"][number]): string {
  if (positional.values && positional.values.length > 0) return positional.values[0];
  if (positional.parse) return "@s/hello";
  return "x";
}

/** Every positional filled in, then the required options. */
function baseArgs(form: Form, skip?: OptionSpec): string[] {
  const args = form.sub.positionals.map(samplePositional);
  for (const option of form.sub.options) {
    if (option.required && option !== skip && option.value) {
      args.push(option.name, sampleValue(option));
    }
  }
  return args;
}

function parse(...words: string[]): ParseOutcome {
  return parseCommandLine(words);
}

function permutations(words: string[]): string[][] {
  if (words.length <= 1) return [words];
  return words.flatMap((word, i) =>
    permutations([...words.slice(0, i), ...words.slice(i + 1)]).map((rest) => [word, ...rest])
  );
}

describe("registry", () => {
  it("has every command of the tool, once", () => {
    expect(COMMANDS.map((command) => command.name).sort()).toEqual(COMMAND_LIST.split(", ").sort());
  });

  it("never lists --help or -h as an option and no option starts with a single dash", () => {
    for (const form of FORMS) {
      for (const option of form.sub.options) {
        expect(option.name).toMatch(/^--[a-z]+(-[a-z]+)*$/);
      }
    }
  });
});

describe("parseCommandLine", () => {
  describe("a command run alone", () => {
    it.each(COMMANDS_BUT_HELP.map((command) => [command.name, command] as const))(
      "%s gives its whenEmpty outcome",
      (_name, command) => {
        const outcome = parse(command.name);
        if (command.whenEmpty === "help") {
          expect(expectHelp(outcome)).toBe(renderCommandHelp(command));
        } else {
          const parsed = expectRun(outcome);
          expect(parsed.command).toBe(command.name);
          expect(parsed.subcommand).toBe(command.subcommands.length > 0 ? command.whenEmpty.run : null);
        }
      }
    );

    it("runs `config` as `config list` and `build` as the incremental build", () => {
      const config = expectRun(parse("config"));
      expect(config.command).toBe("config");
      expect(config.subcommand).toBe("list");
      const build = expectRun(parse("build"));
      expect(build.command).toBe("build");
      expect(build.subcommand).toBeNull();
      expect(positionals(build)).not.toHaveProperty("target");
    });

    it("gives help for every other command", () => {
      for (const command of COMMANDS_BUT_HELP) {
        if (command.name === "config" || command.name === "build") continue;
        expect(command.whenEmpty).toBe("help");
      }
    });
  });

  describe("requested help", () => {
    it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("%p gives the top-level help", (args) => {
      expect(expectHelp(parseCommandLine(args))).toBe(renderTopLevelHelp());
    });

    it("gives a command's help for `<command> --help|-h|help` and `help <command>`", () => {
      for (const command of COMMANDS_BUT_HELP) {
        const expected = renderCommandHelp(command);
        expect(expectHelp(parse(command.name, "--help"))).toBe(expected);
        expect(expectHelp(parse(command.name, "-h"))).toBe(expected);
        expect(expectHelp(parse(command.name, "help"))).toBe(expected);
        expect(expectHelp(parse("help", command.name))).toBe(expected);
      }
    });

    it("gives a subcommand's help for `--help`, `-h` and `help <command> <subcommand>`", () => {
      for (const form of FORMS) {
        if (form.subName === undefined) continue;
        const expected = renderSubcommandHelp(form.command, form.sub);
        expect(expectHelp(parseCommandLine([...form.words, "--help"]))).toBe(expected);
        expect(expectHelp(parseCommandLine([...form.words, "-h"]))).toBe(expected);
        expect(expectHelp(parseCommandLine(["help", ...form.words]))).toBe(expected);
      }
    });

    it("gives a subcommand's help for the word `help` where the first positional is a path or absent", () => {
      for (const form of FORMS) {
        if (form.subName === undefined) continue;
        const allowed = form.sub.positionals.length === 0 || form.sub.positionals[0].isPath;
        if (!allowed) continue;
        expect(expectHelp(parseCommandLine([...form.words, "help"]))).toBe(
          renderSubcommandHelp(form.command, form.sub)
        );
      }
    });

    it("lets help win over every other error on the line", () => {
      for (const form of FORMS) {
        for (const flag of ["--help", "-h"]) {
          expect(expectHelp(parseCommandLine([...form.words, "--zz", ...baseArgs(form), flag]))).toBe(
            helpFor(form)
          );
        }
      }
      expect(expectHelp(parse("signing", "sign", "--forse", "--help"))).toBe(
        renderSubcommandHelp(commandNamed("signing"), subNamed("signing", "sign"))
      );
      expect(expectHelp(parse("build", "native", "--jobs", "0", "-h"))).toBe(
        renderCommandHelp(commandNamed("build"))
      );
    });

    it("makes `signing sign help` help and `signing sign ./help` a run with that path", () => {
      expect(expectHelp(parse("signing", "sign", "help"))).toBe(
        renderSubcommandHelp(commandNamed("signing"), subNamed("signing", "sign"))
      );
      const parsed = expectRun(parse("signing", "sign", "./help"));
      expect(positionals(parsed).path).toBe("./help");
    });

    it("gives a usage error naming the unknown word for `signing frob --help` and `help frob`", () => {
      const sub = expectUsage(parse("signing", "frob", "--help"));
      expect(sub.message).toBe("Unknown subcommand \"frob\" for \"the-seed signing\".");
      expect(sub.argument).toBe("frob");
      expect(sub.command).toBe("signing");
      const top = expectUsage(parse("help", "frob"));
      expect(top.message).toContain("\"frob\"");
      expect(top.argument).toBe("frob");
    });
  });

  describe("unknown commands, subcommands and options", () => {
    it("rejects an unknown command", () => {
      const error = expectUsage(parse("bogus"));
      expect(error.message).toBe(`Unknown command "bogus". Commands: ${COMMAND_LIST}.`);
      expect(error.argument).toBe("bogus");
      expect(error.usage).toBe("Usage: the-seed <command> [<subcommand>] [arguments] [options]");
      expect(error.hint).toBe(helpHint());
    });

    it("rejects an option before the command", () => {
      const error = expectUsage(parse("--zz"));
      expect(error.argument).toBe("--zz");
      expect(error.message).toContain("\"--zz\"");
    });

    it.each(COMMANDS_BUT_HELP.filter((command) => command.subcommands.length > 0).map((c) => c.name))(
      "rejects an unknown subcommand of %s",
      (name) => {
        const error = expectUsage(parse(name, "frob"));
        expect(error.message.startsWith(`Unknown subcommand "frob" for "the-seed ${name}".`)).toBe(true);
        expect(error.argument).toBe("frob");
        expect(error.command).toBe(name);
        expect(error.usage.startsWith(`Usage: the-seed ${name} `)).toBe(true);
        expect(error.hint).toBe(helpHint(name));
      }
    );

    it("names `the-seed scopes list` for `config scopes list`", () => {
      const error = expectUsage(parse("config", "scopes", "list"));
      expect(error.message).toBe(
        "Unknown subcommand \"scopes\" for \"the-seed config\". Scopes are listed with \"the-seed scopes list\"."
      );
      expect(error.usage).toBe("Usage: the-seed config [list|edit]");
      expect(error.hint).toBe(helpHint("config"));
    });

    it.each(["--zz", "-x"])("rejects %s first, in the middle and last for every subcommand", (word) => {
      for (const form of FORMS) {
        const base = baseArgs(form);
        const middle = Math.floor(base.length / 2);
        const lines = [
          [...form.words, word, ...base],
          [...form.words, ...base.slice(0, middle), word, ...base.slice(middle)],
          [...form.words, ...base, word],
        ];
        for (const line of lines) {
          const error = expectUsage(parseCommandLine(line));
          expect(error.message).toBe(`Unknown option "${word}" for "the-seed ${form.label}".`);
          expect(error.argument).toBe(word);
          expect(error.command).toBe(form.command.name);
          expect(error.subcommand).toBe(form.subName);
          expect(error.usage.startsWith(`Usage: the-seed ${form.label}`)).toBe(true);
          expect(error.hint).toBe(helpHint(form.command.name, form.subName));
        }
      }
    });

    it("accepts the base arguments of every subcommand", () => {
      for (const form of FORMS) {
        const parsed = expectRun(parseCommandLine([...form.words, ...baseArgs(form)]));
        expect(parsed.command).toBe(form.command.name);
        expect(parsed.subcommand).toBe(form.subName ?? null);
      }
    });
  });

  describe("value options", () => {
    const valueForms = FORMS.flatMap((form) =>
      form.sub.options.filter((option) => option.value).map((option) => [form.label, option.name, form, option] as const)
    );

    it("has value options to test", () => {
      expect(valueForms.length).toBeGreaterThan(0);
    });

    it.each(valueForms)("%s %s without a value as the last word or before another option", (_l, _n, form, option) => {
      const base = [...companions(option), ...baseArgs(form, option)];
      const expected =
        option.name === "--jobs" || option.name === "--parallel"
          ? `${option.name} requires a positive whole number.`
          : `${option.name} needs a value.`;
      for (const line of [
        [...form.words, ...base, option.name],
        [...form.words, ...base, option.name, "--zz"],
      ]) {
        const error = expectUsage(parseCommandLine(line));
        expect(error.message).toBe(expected);
        expect(error.argument).toBe(option.name);
      }
    });

    it.each(valueForms)("%s %s given twice, with --name=value, and with --name=", (_l, _n, form, option) => {
      const base = [...companions(option), ...baseArgs(form, option)];
      const value = sampleValue(option);
      const once = parseCommandLine([...form.words, ...base, option.name, value]);
      expect(expectRun(once).command).toBe(form.command.name);

      const inline = expectRun(parseCommandLine([...form.words, ...base, `${option.name}=${value}`]));
      expect(options(inline)[key(option)]).toBeDefined();
      expect(options(inline)[key(option)]).toEqual(options(expectRun(once))[key(option)]);

      const twice = parseCommandLine([...form.words, ...base, option.name, value, option.name, value]);
      if (option.repeatable) {
        const single = options(expectRun(once))[key(option)] as unknown[];
        expect(options(expectRun(twice))[key(option)]).toEqual([...single, ...single]);
      } else {
        expect(expectUsage(twice).message).toBe(`${option.name} was given more than once.`);
        const mixed = parseCommandLine([...form.words, ...base, option.name, value, `${option.name}=${value}`]);
        expect(expectUsage(mixed).message).toBe(`${option.name} was given more than once.`);
      }

      const empty = expectUsage(parseCommandLine([...form.words, ...base, `${option.name}=`]));
      expect(empty.message).toContain(option.name);
      expect(empty.argument.startsWith(option.name)).toBe(true);
    });

    it("rejects `--scope=` with the needs-a-value sentence", () => {
      const error = expectUsage(parse("signing", "cert-info", "--scope="));
      expect(error.message).toBe("--scope needs a value.");
    });

    it("takes a scope written with or without the @", () => {
      expect(options(expectRun(parse("signing", "cert-info", "--scope", "a"))).scope).toBe("@a");
      expect(options(expectRun(parse("signing", "cert-info", "--scope=@a"))).scope).toBe("@a");
    });

    it("rejects a scope name that is not valid", () => {
      for (const value of ["a/b", "a b"]) {
        const error = expectUsage(parse("signing", "cert-info", `--scope=${value}`));
        expect(error.message).toContain(`Invalid value "${value}" for --scope;`);
      }
    });

    it("does not take a following option as the value", () => {
      const error = expectUsage(parse("signing", "sign", "x", "--scope", "--force"));
      expect(error.message).toBe("--scope needs a value.");
    });

    it("keeps every --cert of `signing verify` in order", () => {
      const parsed = expectRun(parse("signing", "verify", "--cert", "a", "--cert", "b", "x"));
      expect(options(parsed).cert).toEqual(["a", "b"]);
      expect(positionals(parsed).path).toBe("x");
    });

    it("has --cert of `signing verify` as the only repeatable value option", () => {
      const repeatable = FORMS.flatMap((form) =>
        form.sub.options
          .filter((option) => option.value && option.repeatable)
          .map((option) => `${form.label} ${option.name}`)
      );
      expect(repeatable).toEqual(["signing verify --cert"]);
    });
  });

  describe("flags", () => {
    const flagForms = FORMS.flatMap((form) =>
      form.sub.options.filter((option) => !option.value).map((option) => [form.label, option.name, form, option] as const)
    );

    it.each(flagForms)("%s %s refuses a value and accepts a repeat", (_l, _n, form, option) => {
      const base = [...companions(option), ...baseArgs(form)];
      const error = expectUsage(parseCommandLine([...form.words, ...base, `${option.name}=x`]));
      expect(error.message).toBe(`Option "${option.name}" for "the-seed ${form.label}" does not take a value.`);
      expect(error.argument).toBe(`${option.name}=x`);

      const once = expectRun(parseCommandLine([...form.words, ...base, option.name]));
      const twice = expectRun(parseCommandLine([...form.words, ...base, option.name, option.name]));
      expect(options(once)[key(option)]).toBe(true);
      expect(options(twice)).toEqual(options(once));
    });
  });

  describe("positionals and required options", () => {
    it("rejects an extra positional", () => {
      for (const form of FORMS) {
        const last = form.sub.positionals[form.sub.positionals.length - 1];
        if (last && last.variadic) continue;
        const error = expectUsage(parseCommandLine([...form.words, ...baseArgs(form), "extraword"]));
        expect(error.message).toBe(`Unexpected argument "extraword" for "the-seed ${form.label}".`);
        expect(error.argument).toBe("extraword");
      }
    });

    it("rejects a missing required positional, naming it", () => {
      for (const form of FORMS) {
        form.sub.positionals.forEach((positional, index) => {
          if (!positional.required) return;
          const present = form.sub.positionals.slice(0, index).map(samplePositional);
          const required = form.sub.options
            .filter((option) => option.required && option.value)
            .flatMap((option) => [option.name, sampleValue(option)]);
          const error = expectUsage(parseCommandLine([...form.words, ...present, ...required]));
          expect(error.message).toBe(`<${positional.name}> is required.`);
        });
      }
    });

    it("rejects a missing required option, naming it and its placeholder", () => {
      for (const form of FORMS) {
        for (const option of form.sub.options) {
          if (!option.required || !option.value) continue;
          const error = expectUsage(parseCommandLine([...form.words, ...baseArgs(form, option)]));
          expect(error.message).toBe(`${option.name} <${option.value.placeholder}> is required.`);
        }
      }
    });

    it("requires --cert and --key of import-cert and --output of export-cert", () => {
      expect(expectUsage(parse("signing", "import-cert")).message).toContain("--cert");
      expect(expectUsage(parse("signing", "import-cert", "--cert", "c.pem")).message).toContain("--key");
      expect(expectUsage(parse("signing", "export-cert")).message).toContain("--output");
      expect(expectUsage(parse("signing", "sign")).message).toBe("<path> is required.");
    });
  });

  describe("--validity-days", () => {
    const message = (value: string): string =>
      `Invalid value "${value}" for --validity-days; expected a whole number of days from 1 to 3650.`;

    it.each(["abc", "12abc", "0", "-5", "1.5", "3651"])("rejects %p", (value) => {
      const error = expectUsage(parse("signing", "create-cert", `--validity-days=${value}`));
      expect(error.message).toBe(message(value));
      expect(error.message).toContain("1 to 3650");
    });

    it.each(["abc", "12abc", "0", "1.5", "3651"])("rejects %p as a separate word", (value) => {
      expect(expectUsage(parse("signing", "create-cert", "--validity-days", value)).message).toBe(message(value));
    });

    it("rejects -5 as a separate word", () => {
      expect(parse("signing", "create-cert", "--validity-days", "-5").kind).toBe("usage");
    });

    it("rejects an empty value", () => {
      expect(expectUsage(parse("signing", "create-cert", "--validity-days=")).message).toBe(
        "--validity-days needs a value."
      );
      expect(parse("signing", "create-cert", "--validity-days", "").kind).toBe("usage");
      expect(expectUsage(parse("signing", "create-cert", "--validity-days", "--force")).message).toBe(
        "--validity-days needs a value."
      );
    });

    it.each([
      ["1", 1],
      ["3650", 3650],
      ["365", 365],
    ])("accepts %s", (value, days) => {
      expect(options(expectRun(parse("signing", "create-cert", "--validity-days", value)))["validity-days"]).toBe(days);
      expect(options(expectRun(parse("signing", "create-cert", `--validity-days=${value}`)))["validity-days"]).toBe(days);
    });

    it("leaves the option absent when not given", () => {
      expect(options(expectRun(parse("signing", "create-cert")))).not.toHaveProperty("validity-days");
    });
  });

  describe("template names", () => {
    it.each(["component", "system", "program"])("accepts @s/hello and s/hello for %s", (kind) => {
      for (const word of ["@s/hello", "s/hello"]) {
        const parsed = expectRun(parse("template", kind, word));
        expect(parsed.subcommand).toBe(kind);
        expect(positionals(parsed).name).toEqual({ scope: "@s", name: "hello" });
      }
    });

    it("leaves the name absent when none is given", () => {
      expect(positionals(expectRun(parse("template", "component")))).not.toHaveProperty("name");
    });

    it.each(["@s", "@s/", "@s/a/b", "@s/a b"])("rejects %p", (word) => {
      const error = expectUsage(parse("template", "component", word));
      expect(error.message).toBe(
        `Invalid value "${word}" for <scope>/<name>; expected a scope and a name such as @my-scope/hello.`
      );
      expect(error.argument).toBe(word);
    });
  });

  describe("project names", () => {
    const FORM =
      "A project name must start with a lowercase letter and contain only lowercase letters, digits, " +
      "\".\", \"_\" and \"-\" (such as hello-world).";
    const KINDS = ["component", "system", "program"];

    const formRefusals = ["3d-mesh", "-x", ".x", "_x", "Hello", "p\u00e4k"];
    const reservedRefusals: Array<[string, string]> = [
      ["class", "class"], ["and", "and"], ["co_await", "co_await"],
    ];
    const underscoreRefusals: Array<[string, string]> = [["a--b", "a__b"], ["a.-b", "a__b"], ["a__b", "a__b"]];
    const generatedRefusals = ["ecs", "std", "main"];

    function refused(kind: string, name: string, reason: string): void {
      const word = `@s/${name}`;
      const error = expectUsage(parse("template", kind, word));
      expect(error.message).toBe(`Invalid value "${word}" for <scope>/<name>; ${reason}`);
      expect(error.argument).toBe(word);
      expect(error.command).toBe("template");
      expect(error.subcommand).toBe(kind);
    }

    it.each(KINDS)("refuses a name with the wrong form for %s", (kind) => {
      for (const name of formRefusals) {
        refused(kind, name, FORM);
      }
    });

    it.each(KINDS)("refuses a reserved word for %s, naming the kind", (kind) => {
      for (const [name, identifier] of reservedRefusals) {
        refused(kind, name,
          `"${name}" cannot be used as the name of a ${kind}: its C++ name "${identifier}" is a reserved word.`);
      }
    });

    it.each(KINDS)("refuses two underscores in a row for %s, naming the kind", (kind) => {
      for (const [name, identifier] of underscoreRefusals) {
        refused(kind, name,
          `"${name}" cannot be used as the name of a ${kind}: its C++ name "${identifier}" has two underscores in a row.`);
      }
    });

    it.each(KINDS)("refuses a name the generated code uses for %s, naming the kind", (kind) => {
      for (const name of generatedRefusals) {
        refused(kind, name,
          `"${name}" cannot be used as the name of a ${kind}: the generated code already uses the name "${name}".`);
      }
    });

    it.each(KINDS)("accepts hello-world, mesh.loader, a_b and x1 for %s with the name as given", (kind) => {
      for (const name of ["hello-world", "mesh.loader", "a_b", "x1"]) {
        const parsed = expectRun(parse("template", kind, `@s/${name}`));
        expect(positionals(parsed).name).toEqual({ scope: "@s", name });
      }
    });

    it("keeps the scope forms: a scope without its @ is accepted, an invalid scope is refused with the form message", () => {
      expect(positionals(expectRun(parse("template", "system", "s/mesh.loader"))).name)
        .toEqual({ scope: "@s", name: "mesh.loader" });
      expect(expectUsage(parse("template", "system", "@a b/hello")).message).toBe(
        "Invalid value \"@a b/hello\" for <scope>/<name>; expected a scope and a name such as @my-scope/hello."
      );
    });
  });

  describe("resource-pak create names", () => {
    // The positional is keyed `name` like the one of `template` and holds `{ scope, name }`; it is
    // optional, and the name follows the resource pak rule (form only, no identifier rules).
    const FORM =
      "A project name must start with a lowercase letter and contain only lowercase letters, digits, " +
      "\".\", \"_\" and \"-\" (such as hello-world).";

    it("accepts @s/sounds and s/sounds with the scope normalised", () => {
      for (const word of ["@s/sounds", "s/sounds"]) {
        const parsed = expectRun(parse("resource-pak", "create", word));
        expect(parsed.subcommand).toBe("create");
        expect(positionals(parsed).name).toEqual({ scope: "@s", name: "sounds" });
      }
    });

    it("leaves the name absent when none is given", () => {
      expect(positionals(expectRun(parse("resource-pak", "create")))).not.toHaveProperty("name");
    });

    it.each(["@s", "@s/", "@s/a/b", "@s/a b", "@a b/sounds"])("rejects the form %p like template does", (word) => {
      const error = expectUsage(parse("resource-pak", "create", word));
      expect(error.message).toBe(
        `Invalid value "${word}" for <scope>/<name>; expected a scope and a name such as @my-scope/hello.`
      );
      expect(error.argument).toBe(word);
      expect(error.command).toBe("resource-pak");
      expect(error.subcommand).toBe("create");
    });

    it.each(["3d", "Hello", "-x", ".x", "_x", "p\u00e4k"])("rejects the name %p with the form sentence", (name) => {
      const word = `@s/${name}`;
      const error = expectUsage(parse("resource-pak", "create", word));
      expect(error.message).toBe(`Invalid value "${word}" for <scope>/<name>; ${FORM}`);
      expect(error.argument).toBe(word);
    });

    it.each(["class", "ecs", "std", "and", "a--b", "a__b", "mesh.loader", "hello-world", "x1"])(
      "accepts %p: the identifier rules of code projects do not apply", (name) => {
        const parsed = expectRun(parse("resource-pak", "create", `@s/${name}`));
        expect(positionals(parsed).name).toEqual({ scope: "@s", name });
      });

    it("rejects an extra word after a valid name", () => {
      const error = expectUsage(parse("resource-pak", "create", "@s/sounds", "b"));
      expect(error.message).toBe("Unexpected argument \"b\" for \"the-seed resource-pak create\".");
    });
  });

  describe("targets", () => {
    it.each(["native", "windows"])("accepts %s for build and dependencies", (target) => {
      expect(positionals(expectRun(parse("build", target))).target).toBe(target);
      for (const sub of ["check", "install"]) {
        const parsed = expectRun(parse("dependencies", sub, target));
        expect(Object.values(positionals(parsed))).toContain(target);
      }
    });

    it("refuses mac for build and dependencies, listing the targets", () => {
      expect(expectUsage(parse("build", "mac")).message).toBe(
        "Unrecognized build target \"mac\"; expected native or windows."
      );
      for (const sub of ["check", "install"]) {
        const error = expectUsage(parse("dependencies", sub, "mac"));
        expect(error.message).toMatch(/^Unrecognized .*target "mac"; expected native or windows\.$/);
        expect(error.argument).toBe("mac");
      }
    });

    it("lets `dependencies check` run without a target", () => {
      const parsed = expectRun(parse("dependencies", "check"));
      expect(Object.keys(positionals(parsed))).toEqual([]);
    });
  });

  describe("purity", () => {
    it("reads no file, configuration or environment: it works with HOME pointing nowhere", () => {
      const home = process.env.HOME;
      const spies = ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "mkdirSync", "writeFileSync"].map(
        (name): jest.SpyInstance => jest.spyOn(fs, name as "readFileSync")
      );
      process.env.HOME = "/nonexistent/home/for/parse/test";
      try {
        const results = FORMS.map((form) => parseCommandLine([...form.words, ...baseArgs(form)]).kind);
        expect(results.every((kind) => kind === "run")).toBe(true);
        expect(parse("bogus").kind).toBe("usage");
        expect(parse("--help").kind).toBe("help");
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        if (home === undefined) delete process.env.HOME;
        else process.env.HOME = home;
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});

function commandNamed(name: string): CommandSpec {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`No command ${name} in the registry`);
  return command;
}

function subNamed(commandName: string, name: string): SubcommandSpec {
  const sub = commandNamed(commandName).subcommands.find((candidate) => candidate.name === name);
  if (!sub) throw new Error(`No subcommand ${commandName} ${name} in the registry`);
  return sub;
}

/* ------------------------------------------------------------------------------------------
 * The cases of the earlier build-arguments parser, through the one parser. Outcomes are the
 * same except for the wording of unknown options and arguments, which now names the command
 * ("Unknown option ... for "the-seed build"."), and the --parallel/--jobs values that start
 * with "-" (written with "=" here, see the header).
 * ---------------------------------------------------------------------------------------- */

interface BuildView {
  mode: "incremental" | "full" | "help";
  target?: string;
  recursive: boolean;
  release: boolean;
  parallel: number;
  jobs?: number;
  deprecatedBareWord: boolean;
}

function buildView(outcome: ParseOutcome): BuildView {
  if (outcome.kind === "help") {
    return { mode: "help", recursive: false, release: false, parallel: 1, deprecatedBareWord: false };
  }
  const parsed = expectRun(outcome);
  expect(parsed.command).toBe("build");
  const opts = options(parsed);
  const target = positionals(parsed).target as string | undefined;
  const view: BuildView = {
    mode: target === undefined ? "incremental" : "full",
    recursive: opts.recursive === true,
    release: opts.release === true,
    parallel: (opts.parallel as number | undefined) ?? 1,
    deprecatedBareWord: parsed.warnings.length > 0,
  };
  if (target !== undefined) view.target = target;
  if (opts.jobs !== undefined) view.jobs = opts.jobs as number;
  return view;
}

function build(...args: string[]): BuildView {
  return buildView(parseCommandLine(["build", ...args]));
}

function reject(...args: string[]): { argument: string; message: string } {
  const error = expectUsage(parseCommandLine(["build", ...args]));
  expect(error.command).toBe("build");
  expect(error.hint).toBe(helpHint("build"));
  return { argument: error.argument, message: error.message };
}

describe("build arguments", () => {
  describe("target slot", () => {
    it("gives an incremental build with no arguments", () => {
      const view = build();
      expect(view.mode).toBe("incremental");
      expect(view.target).toBeUndefined();
      expect(view.recursive).toBe(false);
      expect(view.release).toBe(false);
      expect(view.parallel).toBe(1);
      expect(view.deprecatedBareWord).toBe(false);
    });

    it("gives help for 'help' and ignores later arguments", () => {
      expect(build("help").mode).toBe("help");
      expect(build("help", "anything").mode).toBe("help");
      expect(build("help", "--bogus").mode).toBe("help");
    });

    it.each(["native", "windows"])("gives a full non-recursive build for %s", (target) => {
      expect(build(target)).toEqual({
        mode: "full",
        target,
        recursive: false,
        release: false,
        parallel: 1,
        deprecatedBareWord: false,
      });
    });
  });

  describe("--recursive and --release", () => {
    it.each(["native", "windows"])("accepts every ordering after %s", (target) => {
      for (const words of [["--recursive"], ["--release"], ["--recursive", "--release"]]) {
        for (const order of permutations(words)) {
          expect(build(target, ...order)).toEqual({
            mode: "full",
            target,
            recursive: words.includes("--recursive"),
            release: words.includes("--release"),
            parallel: 1,
            deprecatedBareWord: false,
          });
        }
      }
    });

    it("accepts --recursive and --release given twice as if given once", () => {
      expect(build("native", "--recursive", "--recursive")).toEqual(build("native", "--recursive"));
      expect(build("native", "--release", "--release")).toEqual(build("native", "--release"));
    });
  });

  describe("rejections", () => {
    it("rejects an unknown dashed option", () => {
      expect(reject("native", "--recursve")).toEqual({
        argument: "--recursve",
        message: "Unknown option \"--recursve\" for \"the-seed build\".",
      });
    });

    it("rejects an unknown bare word", () => {
      expect(reject("native", "recursve")).toEqual({
        argument: "recursve",
        message: "Unexpected argument \"recursve\" for \"the-seed build\".",
      });
    });

    it("rejects an unknown word anywhere after the target", () => {
      expect(reject("windows", "--recursive", "--release", "extra").message).toBe(
        "Unexpected argument \"extra\" for \"the-seed build\"."
      );
      expect(reject("windows", "--release", "-r").message).toBe("Unknown option \"-r\" for \"the-seed build\".");
    });

    it("rejects --parallel without a recursive build", () => {
      for (const args of [
        ["native", "--parallel", "4"],
        ["native", "--parallel=4", "--release"],
      ]) {
        expect(reject(...args)).toEqual({
          argument: "--parallel",
          message: "--parallel applies only to recursive builds; add --recursive.",
        });
      }
    });

    it.each([
      [["native", "--recursive", "--parallel"]],
      [["native", "--recursive", "--parallel", "--release"]],
      [["native", "--parallel", "--recursive"]],
      [["native", "--recursive", "--parallel="]],
    ])("rejects a missing --parallel value in %p", (args) => {
      expect(reject(...args)).toEqual({
        argument: "--parallel",
        message: "--parallel requires a positive whole number.",
      });
    });

    it.each(["0", "1.5", "x", "4x", "+3", "007x", String(Number.MAX_SAFE_INTEGER + 2), "99999999999999999999"])(
      "rejects the --parallel value %p",
      (value) => {
        expect(reject("native", "--recursive", "--parallel", value)).toEqual({
          argument: value,
          message: `Invalid value "${value}" for --parallel; expected a positive whole number.`,
        });
      }
    );

    it("rejects the --parallel value -2 written with =", () => {
      expect(reject("native", "--recursive", "--parallel=-2")).toEqual({
        argument: "--parallel=-2",
        message: "Invalid value \"-2\" for --parallel; expected a positive whole number.",
      });
    });

    it("rejects an invalid inline --parallel value", () => {
      expect(reject("native", "--recursive", "--parallel=0")).toEqual({
        argument: "--parallel=0",
        message: "Invalid value \"0\" for --parallel; expected a positive whole number.",
      });
    });

    it("rejects --parallel given more than once", () => {
      for (const args of [
        ["native", "--recursive", "--parallel", "2", "--parallel", "3"],
        ["native", "--recursive", "--parallel", "2", "--parallel=3"],
        ["native", "--recursive", "--parallel=2", "--parallel=2"],
      ]) {
        expect(reject(...args).message).toBe("--parallel was given more than once.");
      }
    });

    it.each(["--recursive", "--release"])("rejects %s in the target slot", (arg) => {
      expect(reject(arg)).toEqual({
        argument: arg,
        message: "A build target is required: native or windows.",
      });
    });

    it("rejects --parallel with a value in the target slot", () => {
      expect(reject("--parallel", "2")).toEqual({
        argument: "--parallel",
        message: "A build target is required: native or windows.",
      });
    });

    it("rejects an unknown target", () => {
      expect(reject("foo")).toEqual({
        argument: "foo",
        message: "Unrecognized build target \"foo\"; expected native or windows.",
      });
    });
  });

  describe("--parallel", () => {
    it.each(["native", "windows"])("accepts --parallel 4 and --parallel=4 in every position after %s", (target) => {
      for (const parallelWords of [["--parallel", "4"], ["--parallel=4"]]) {
        const token = parallelWords.join(" ");
        for (const words of [
          ["--recursive", token],
          ["--recursive", token, "--release"],
        ]) {
          for (const order of permutations(words)) {
            const args = order.flatMap((word) => (word === token ? parallelWords : [word]));
            expect(build(target, ...args)).toEqual({
              mode: "full",
              target,
              recursive: true,
              release: words.includes("--release"),
              parallel: 4,
              deprecatedBareWord: false,
            });
          }
        }
      }
    });

    it("accepts large but safe values", () => {
      expect(build("native", "--recursive", "--parallel", "64").parallel).toBe(64);
      expect(build("native", "--recursive", `--parallel=${Number.MAX_SAFE_INTEGER}`).parallel).toBe(
        Number.MAX_SAFE_INTEGER
      );
    });
  });

  describe("deprecated bare word", () => {
    it.each([
      [["native", "recursive"], ["native", "--recursive"]],
      [["native", "recursive", "--release"], ["native", "--recursive", "--release"]],
      [["windows", "--release", "recursive"], ["windows", "--release", "--recursive"]],
      [["native", "recursive", "--recursive"], ["native", "--recursive"]],
      [["native", "recursive", "recursive"], ["native", "--recursive"]],
      [["native", "recursive", "--parallel", "2"], ["native", "--recursive", "--parallel", "2"]],
    ])("treats %p like %p and flags the deprecated word", (bare, dashed) => {
      const bareView = build(...bare);
      const dashedView = build(...dashed);
      expect(bareView.recursive).toBe(true);
      expect(bareView.deprecatedBareWord).toBe(true);
      expect(dashedView.deprecatedBareWord).toBe(false);
      expect({ ...bareView, deprecatedBareWord: false }).toEqual(dashedView);
    });

    it("gives one warning that names the word", () => {
      const parsed = expectRun(parse("build", "native", "recursive", "recursive"));
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]).toContain("\"recursive\"");
      expect(expectRun(parse("build", "native", "--recursive")).warnings).toEqual([]);
    });
  });

  describe("--jobs", () => {
    it.each(["native", "windows"])("accepts --jobs 4 and --jobs=4 after %s", (target) => {
      for (const words of [["--jobs", "4"], ["--jobs=4"]]) {
        expect(build(target, ...words)).toEqual({
          mode: "full",
          target,
          recursive: false,
          release: false,
          parallel: 1,
          jobs: 4,
          deprecatedBareWord: false,
        });
      }
    });

    it("leaves jobs absent when not given", () => {
      expect(build("native")).not.toHaveProperty("jobs");
      expect(build()).not.toHaveProperty("jobs");
    });

    it("accepts --jobs in every position among the other options", () => {
      const words = ["--recursive", "--release", "--parallel 2", "--jobs 3"];
      for (const order of permutations(words)) {
        expect(build("native", ...order.flatMap((word) => word.split(" ")))).toEqual({
          mode: "full",
          target: "native",
          recursive: true,
          release: true,
          parallel: 2,
          jobs: 3,
          deprecatedBareWord: false,
        });
      }
    });

    it("accepts --jobs without --recursive", () => {
      expect(build("native", "--jobs", "2", "--release").jobs).toBe(2);
    });

    it.each([
      [["native", "--jobs"]],
      [["native", "--jobs="]],
      [["native", "--jobs", "--release"]],
      [["native", "--recursive", "--jobs"]],
    ])("rejects a missing --jobs value in %p", (args) => {
      expect(reject(...args)).toEqual({
        argument: "--jobs",
        message: "--jobs requires a positive whole number.",
      });
    });

    it.each(["0", "1.5", "abc", "01", String(Number.MAX_SAFE_INTEGER + 2), "99999999999999999999"])(
      "rejects the --jobs value %p",
      (value) => {
        expect(reject("native", "--jobs", value)).toEqual({
          argument: value,
          message: `Invalid value "${value}" for --jobs; expected a positive whole number.`,
        });
        expect(reject("native", `--jobs=${value}`).message).toBe(
          `Invalid value "${value}" for --jobs; expected a positive whole number.`
        );
      }
    );

    it("rejects the --jobs value -1 written with =", () => {
      expect(reject("native", "--jobs=-1").message).toBe(
        "Invalid value \"-1\" for --jobs; expected a positive whole number."
      );
    });

    it("rejects --jobs given more than once", () => {
      for (const args of [
        ["native", "--jobs", "2", "--jobs", "3"],
        ["native", "--jobs", "2", "--jobs=3"],
        ["native", "--jobs=2", "--jobs=2"],
      ]) {
        expect(reject(...args).message).toBe("--jobs was given more than once.");
      }
    });

    it("accepts a value above the processor count", () => {
      expect(build("native", "--jobs", "64").jobs).toBe(64);
      expect(build("native", `--jobs=${Number.MAX_SAFE_INTEGER}`).jobs).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("incremental form with --jobs", () => {
    it("gives an incremental build with the job count", () => {
      for (const args of [["--jobs", "4"], ["--jobs=4"]]) {
        expect(build(...args)).toEqual({
          mode: "incremental",
          recursive: false,
          release: false,
          parallel: 1,
          jobs: 4,
          deprecatedBareWord: false,
        });
      }
    });

    it("rejects a bad or missing value before anything else", () => {
      expect(reject("--jobs").message).toBe("--jobs requires a positive whole number.");
      expect(reject("--jobs=").message).toBe("--jobs requires a positive whole number.");
      expect(reject("--jobs", "0").message).toBe("Invalid value \"0\" for --jobs; expected a positive whole number.");
      expect(reject("--jobs", "2", "--jobs", "3").message).toBe("--jobs was given more than once.");
    });

    it.each([
      [["--release"]],
      [["--recursive"]],
      [["--parallel", "2"]],
      [["--release", "--jobs", "4"]],
      [["--jobs", "4", "--release"]],
      [["--jobs", "4", "--recursive"]],
    ])("keeps the target-required error for %p", (args) => {
      expect(reject(...args).message).toBe("A build target is required: native or windows.");
    });
  });
});
