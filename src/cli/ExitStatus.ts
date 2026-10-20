import { helpHint } from "./Hints";

/** One row of the table of exit statuses shown in the help and the README. */
export interface ExitStatusRow {
  status: string;
  meaning: string;
}

/** What a command handler may return: nothing, or an exit status of its own. */
export type HandlerResult = void | { status: number };

/** The exit statuses of the tool, in the order they are listed. */
export const EXIT_STATUSES: ExitStatusRow[] = [
  {
    status: "0",
    meaning: "The command did what was asked, including printing help that was asked for and a verification that is valid",
  },
  {
    status: "1",
    meaning:
      "The command ran and the outcome is a failure: a build, packaging, installer, dependency installation or signing " +
      "operation failed; verification found the file invalid, not fully signed, not checked or unsigned; the user " +
      "declined to overwrite; an unexpected internal error",
  },
  {
    status: "2",
    meaning:
      "Something the command needs is missing or unusable: a file or directory, a project description, scopes, the " +
      "named scope, a certificate (or it has expired or cannot be read), a valid configuration file, the native " +
      "component, a required program such as wixl",
  },
  {
    status: "3",
    meaning:
      "Usage error, or input the command cannot interpret (for verification: a malformed manifest, or a signature " +
      "file given in place of a signed file)",
  },
  { status: "4", meaning: "Verification only: intact but not trusted" },
  { status: "128+N", meaning: "A build stopped by signal N (130 after Ctrl+C)" },
];

/** A failure the command line reports as one line, with the exit status it ends the process with. */
export class CliError extends Error {
  status: number;
  hint?: string;
  usage?: string;

  constructor(status: number, message: string, options?: { hint?: string; usage?: string }) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "CliError";
    this.status = status;
    this.hint = options?.hint;
    this.usage = options?.usage;
  }
}

/** The command line is wrong: status 3, nothing has been done. */
export class UsageError extends CliError {
  declare usage: string;
  declare hint: string;
  argument: string;
  command: string;
  subcommand?: string;

  constructor(message: string, details: { argument: string; command: string; subcommand?: string; usage: string }) {
    super(3, message, { hint: helpHint(details.command, details.subcommand), usage: details.usage });
    this.name = "UsageError";
    this.argument = details.argument;
    this.command = details.command;
    this.subcommand = details.subcommand;
  }
}

/** Something the command needs is missing or unusable: status 2. */
export class MissingError extends CliError {
  constructor(message: string, options?: { hint?: string }) {
    super(2, message, options);
    this.name = "MissingError";
  }
}

/** The command ran and failed: status 1. */
export class FailedError extends CliError {
  /** The failure was already printed in full, so nothing more is printed for it */
  reported: boolean;

  constructor(message: string, options?: { hint?: string; reported?: boolean }) {
    super(1, message, options);
    this.name = "FailedError";
    this.reported = options?.reported ?? false;
  }
}
