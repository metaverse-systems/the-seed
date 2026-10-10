import { BuildRequest } from "./types";

/** The outcome of parsing the arguments of `the-seed build`. */
export type BuildArgsResult =
  | { ok: true; request: BuildRequest }
  | { ok: false; argument: string; message: string };

/** One accepted option after the build target. Adding a flag means adding an entry. */
interface OptionSpec {
  /** The option as typed, e.g. "--parallel" */
  name: string;
  /** Takes a value, as "--name V" or "--name=V" */
  takesValue: boolean;
  /** Placeholder for the value in usage text */
  valueName?: string;
  /** May be given more than once with the same effect as once */
  repeatable: boolean;
  /** Applies the option to the request; returns an error message for an invalid value */
  apply: (request: BuildRequest, value?: string) => string | null;
  /** Only valid together with a recursive build; checked after all arguments are read */
  requiresRecursive: boolean;
  /** One-line description for the help text */
  help: string;
}

const OPTIONS: OptionSpec[] = [
  {
    name: "--recursive",
    takesValue: false,
    repeatable: true,
    apply: (request) => {
      request.recursive = true;
      return null;
    },
    requiresRecursive: false,
    help: "Build every buildable dependency first, then this project",
  },
  {
    name: "--parallel",
    takesValue: true,
    valueName: "N",
    repeatable: false,
    apply: (request, value) => {
      if (value === undefined || value === "") {
        return "--parallel requires a positive whole number.";
      }
      const parallel = Number(value);
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parallel)) {
        return `Invalid value "${value}" for --parallel; expected a positive whole number.`;
      }
      request.parallel = parallel;
      return null;
    },
    requiresRecursive: true,
    help: "With --recursive, build up to N independent projects at once (default 1)",
  },
  {
    name: "--release",
    takesValue: false,
    repeatable: true,
    apply: (request) => {
      request.release = true;
      return null;
    },
    requiresRecursive: false,
    help: "Strip debug symbols after install, before signing",
  },
];

const TARGETS = ["native", "windows"];

/** The deprecated spelling of --recursive, still accepted with a notice. */
export const DEPRECATED_RECURSIVE_WORD = "recursive";

function optionUsage(option: OptionSpec): string {
  return option.takesValue ? `${option.name} ${option.valueName ?? "VALUE"}` : option.name;
}

/** The valid options, for error messages and help text. */
export const VALID_OPTIONS_LINE = `Valid options: ${OPTIONS.map(optionUsage).join(", ")}`;

/** Usage and description of each option, in table order, for the help text. */
export function optionHelp(): Array<{ usage: string; help: string }> {
  return OPTIONS.map((option) => ({ usage: optionUsage(option), help: option.help }));
}

function fail(argument: string, message: string): BuildArgsResult {
  return { ok: false, argument, message };
}

/**
 * Parses the words after `build` without side effects. Everything is
 * validated here, so the caller can reject bad input before doing any work.
 */
export function parseBuildArgs(args: string[]): BuildArgsResult {
  const request: BuildRequest = {
    mode: "incremental",
    recursive: false,
    release: false,
    parallel: 1,
    deprecatedBareWord: false,
  };

  const targetArg = args[0];
  if (targetArg === undefined) {
    return { ok: true, request };
  }
  if (targetArg === "help") {
    request.mode = "help";
    return { ok: true, request };
  }
  if (targetArg.startsWith("-")) {
    return fail(targetArg, "A build target is required: native or windows.");
  }
  if (!TARGETS.includes(targetArg)) {
    return fail(targetArg, `Unrecognized build target "${targetArg}"; expected native or windows.`);
  }
  request.mode = "full";
  request.target = targetArg as "native" | "windows";

  const seen = new Set<OptionSpec>();
  const rest = args.slice(1);

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === DEPRECATED_RECURSIVE_WORD) {
      request.recursive = true;
      request.deprecatedBareWord = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      return fail(arg, `Unrecognized argument "${arg}".`);
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const option = OPTIONS.find((candidate) => candidate.name === name);
    if (!option || (equals !== -1 && !option.takesValue)) {
      return fail(arg, `Unrecognized option "${arg}".`);
    }

    if (seen.has(option) && !option.repeatable) {
      return fail(arg, `${option.name} was given more than once.`);
    }
    seen.add(option);

    let value: string | undefined;
    let valueArg = option.name;
    if (option.takesValue) {
      if (equals !== -1) {
        value = arg.slice(equals + 1);
        valueArg = arg;
      } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        // A following word that looks like another option is not taken as the value.
        i++;
        value = rest[i];
        valueArg = value;
      }
    }

    const error = option.apply(request, value);
    if (error !== null) {
      return fail(value === undefined || value === "" ? option.name : valueArg, error);
    }
  }

  // Checked last so the options may come in any order.
  for (const option of seen) {
    if (option.requiresRecursive && !request.recursive) {
      return fail(option.name, `${option.name} applies only to recursive builds; add --recursive.`);
    }
  }

  return { ok: true, request };
}
