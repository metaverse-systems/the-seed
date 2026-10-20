import ConfigCLI from "./ConfigCLI";
import ScopesCLI from "./ScopesCLI";
import TemplateCLI from "./TemplateCLI";
import BuildCLI from "./BuildCLI";
import ResourcePakCLI from "./ResourcePakCLI";
import DependenciesCLI from "./DependenciesCLI";
import PackageCLI from "./PackageCLI";
import SigningCLI from "./SigningCLI";
import InstallerCLI from "./InstallerCLI";
import { parseCommandLine } from "../cli/ParseArgs";
import { findCommand } from "../cli/Commands";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { CliError, FailedError, HandlerResult, UsageError, toCliError } from "../cli/ExitStatus";
import { commandUsage, subcommandUsage } from "../cli/Help";
import { helpHint } from "../cli/Hints";

/** What runCli can be told besides the command line. */
export interface RunContext {
  /** Whether prompts may be shown; by default whether standard input and output are terminals */
  interactive?: boolean;
}

type Handler = (parsed: ParsedCommand, context: CliContext) => Promise<HandlerResult> | HandlerResult;

/** The function that runs each command; it picks the subcommand from the parsed command. */
const HANDLERS: Record<string, Handler> = {
  config: ConfigCLI,
  scopes: ScopesCLI,
  template: TemplateCLI,
  build: BuildCLI,
  dependencies: DependenciesCLI,
  package: PackageCLI,
  "resource-pak": ResourcePakCLI,
  signing: SigningCLI,
  installer: InstallerCLI,
};

/** Gives a usage error raised by a handler the command's usage line and help hint. */
function completeUsageError(error: UsageError, parsed: ParsedCommand): UsageError {
  if (error.command !== "") return error;
  const command = findCommand(parsed.command);
  if (!command) return error;
  const sub = command.root ?? command.subcommands.find((candidate) => candidate.name === parsed.subcommand);
  error.command = parsed.command;
  error.subcommand = command.root ? undefined : parsed.subcommand ?? undefined;
  error.usage = sub ? subcommandUsage(command, sub) : commandUsage(command);
  error.hint = helpHint(error.command, error.subcommand);
  return error;
}

function printError(error: CliError): void {
  if (error instanceof FailedError && error.reported) return;
  console.error(`Error: ${error.message}`);
  if (error instanceof UsageError) {
    console.error(error.usage);
    console.error(error.hint);
  } else if (error.hint) {
    console.error(error.hint);
  }
}

/**
 * Runs the tool: `argv` is the words after the program name. The whole line is read before any
 * work, prompt or file change. This is the only place that sets the process exit status, apart
 * from the status a handler returns.
 */
export async function runCli(argv: string[], configDir: string, context: RunContext = {}): Promise<void> {
  const outcome = parseCommandLine(argv);

  if (outcome.kind === "help") {
    console.log(outcome.text);
    return;
  }
  if (outcome.kind === "usage") {
    printError(outcome.error);
    process.exitCode = outcome.error.status;
    return;
  }

  const parsed = outcome.parsed;
  const handlerContext: CliContext = {
    configDir,
    cwd: process.cwd(),
    interactive: context.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)),
  };

  try {
    for (const warning of parsed.warnings) {
      console.error(`Warning: ${warning}`);
    }
    const result = await HANDLERS[parsed.command](parsed, handlerContext);
    if (result && typeof result.status === "number" && result.status !== 0) {
      process.exitCode = result.status;
    }
  } catch (error) {
    const known = toCliError(error);
    if (known) {
      const shown = known instanceof UsageError ? completeUsageError(known, parsed) : known;
      printError(shown);
      process.exitCode = shown.status;
      return;
    }
    // Any other error is one line and status 1; the stack follows only when asked for.
    const label = parsed.subcommand ? `${parsed.command} ${parsed.subcommand}` : parsed.command;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: Unexpected error in "the-seed ${label}": ${message}`);
    if (process.env.THE_SEED_DEBUG === "1" && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}
