import type { SigningErrorCode } from "../Signing";
import type { ProjectErrorCode } from "../ProjectError";
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
      "declined to overwrite; a project directory that already exists; a resource name that already exists (without " +
      "--force); a resource file that changed while the pak was written; an unexpected internal error",
  },
  {
    status: "2",
    meaning:
      "Something the command needs is missing or unusable: a file or directory, a project description, scopes, the " +
      "named scope, a certificate (or it has expired or cannot be read), a valid configuration file, the native " +
      "component, a required program such as wixl; the scope author's name (or an email or web address the build " +
      "configuration cannot hold); a resource file; a resource pak project description",
  },
  {
    status: "3",
    meaning: "Usage error, or input the command cannot interpret",
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

/** The exit status the command line ends with for each way the signing library can fail. */
export function signingErrorStatus(code: SigningErrorCode): number {
  switch (code) {
    case "unknown-scope":
    case "author-name-missing":
    case "certificate-missing":
    case "certificate-expired":
    case "certificate-unreadable":
    case "key-mismatch":
    case "unsupported-key":
    case "path-not-found":
    case "manifest-missing":
      return 2;
    case "manifest-malformed":
    case "wrong-target":
      return 3;
    case "scope-required":
    case "invalid-validity":
    case "not-binary":
    case "read-only":
    case "no-binaries":
    case "signing-failed":
    default:
      return 1;
  }
}

/** The exit status the command line ends with for each way creating or changing a project can fail. */
export function projectErrorStatus(code: ProjectErrorCode): number {
  switch (code) {
    case "invalid-name":
      return 3;
    case "unknown-scope":
    case "author-name-missing":
    case "author-detail-unusable":
    case "not-pak-project":
    case "resource-file-missing":
      return 2;
    case "target-exists":
    case "duplicate-resource":
    case "resource-changed":
    case "write-failed":
    default:
      return 1;
  }
}

/** Whether the error, or a class it extends, has the given name (classes are matched by name so that a reloaded module still matches). */
function hasClassName(error: Error, name: string): boolean {
  for (let proto: object | null = Object.getPrototypeOf(error); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === name) return true;
  }
  return error.name === name;
}

/**
 * Turns an error of a class the tool knows into the error the command line reports, with the status
 * of its kind; any other error gives null.
 */
export function toCliError(error: unknown): CliError | null {
  if (!(error instanceof Error)) return null;
  if (error instanceof CliError) return error;
  if (hasClassName(error, "SigningError")) {
    const signing = error as Error & { code: SigningErrorCode; hint?: string };
    return new CliError(signingErrorStatus(signing.code), signing.message, { hint: signing.hint });
  }
  if (hasClassName(error, "ProjectError")) {
    const project = error as Error & { code: ProjectErrorCode; hint?: string };
    return new CliError(projectErrorStatus(project.code), project.message, { hint: project.hint });
  }
  if (hasClassName(error, "ConfigError") || hasClassName(error, "NativeComponentMissingError") || hasClassName(error, "InstallerMetadataError")) {
    return new MissingError(error.message);
  }
  if (hasClassName(error, "DependencyDiscoveryError")) {
    return new FailedError(error.message);
  }
  if (hasClassName(error, "ScopeNameError")) {
    return new CliError(3, error.message);
  }
  return null;
}
