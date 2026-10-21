/**
 * The hint sentences the tool prints. Each is one sentence, and any command line in it is written
 * inside double quotes exactly as the user would type it.
 */

/** Tells the user how to add the first scope. */
export function addScopeHint(): string {
  return "Add one with \"the-seed scopes add\".";
}

/** Tells the user how to give a scope's author a name. */
export function editScopeHint(scope: string): string {
  return `Set the author's name with "the-seed scopes edit" (scope ${scope}).`;
}

/** Tells the user how to create the certificate for a scope. */
export function createCertHint(scope: string): string {
  return `Create one with "the-seed signing create-cert --scope ${scope}".`;
}

/** Tells the user how to replace the certificate of a scope. */
export function replaceCertHint(scope: string): string {
  return `Create a new one with "the-seed signing create-cert --scope ${scope} --force".`;
}

/** Tells the user to choose one of several configured scopes. */
export function chooseScopeHint(scopes: string[]): string {
  return `Several scopes are configured; choose one with --scope <scope>. Configured scopes: ${scopes.join(", ")}.`;
}

/** Tells the user that an existing certificate is replaced only with --force. */
export function forceHint(scope: string): string {
  return `A certificate already exists for scope ${scope}; give --force to replace it.`;
}

/** Tells the user where the scopes are listed. */
export function listScopesHint(): string {
  return "Scopes are listed with \"the-seed scopes list\".";
}

/** Points to the help of the whole tool, a command or a subcommand. */
export function helpHint(command?: string, subcommand?: string): string {
  const words = ["the-seed", "help", command, subcommand].filter((word) => word !== undefined && word !== "");
  return `Run "${words.join(" ")}" for details.`;
}

/** Tells the user to cross-compile for Windows first. */
export function buildWindowsHint(): string {
  return "Cross-compile the project first with \"the-seed build windows\".";
}

/** Tells the user to run a full build. */
export function fullBuildHint(): string {
  return "Run a full build (\"the-seed build native\" or \"the-seed build windows\").";
}

/** Tells the user to sign a file again; the path is filled in when it is known. */
export function resignHint(path?: string): string {
  return `Sign the file again with "the-seed signing sign ${path ?? "<path>"}".`;
}

/** Tells the user how to create a resource pak project. */
export function createPakHint(): string {
  return "Create one with \"the-seed resource-pak create\".";
}

/** Tells the user that an existing resource is replaced only with --force. */
export function replaceResourceHint(): string {
  return "Give --force to replace it.";
}
