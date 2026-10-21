import inquirer from "inquirer";
import Signing from "../Signing";
import { MissingError, UsageError } from "./ExitStatus";
import { addScopeHint, chooseScopeHint } from "./Hints";

/**
 * Chooses the scope a command uses. A requested scope (with or without its "@") must be
 * configured. Without one, the only configured scope is used; with several, the user is asked
 * when prompting is allowed and told to use --scope otherwise. Returns the scope with its "@".
 */
export async function chooseScope(signing: Signing, requested: string | undefined, interactive: boolean): Promise<string> {
  const scopes = signing.getScopes();

  if (requested !== undefined) {
    const scope = requested.startsWith("@") ? requested : `@${requested}`;
    if (scopes.includes(scope)) {
      return scope;
    }
    if (scopes.length === 0) {
      throw new MissingError(`Scope "${scope}" is not configured. No scopes are configured.`, { hint: addScopeHint() });
    }
    throw new MissingError(`Scope "${scope}" is not configured. Configured scopes: ${scopes.join(", ")}.`);
  }

  if (scopes.length === 0) {
    throw new MissingError("No scopes are configured.", { hint: addScopeHint() });
  }
  if (scopes.length === 1) {
    return scopes[0];
  }
  if (!interactive) {
    // The command and its usage line are filled in by runCli, which knows the command line.
    throw new UsageError(chooseScopeHint(scopes), { argument: "--scope", command: "", usage: "" });
  }
  const answer = await inquirer.prompt([
    {
      type: "list",
      name: "scope",
      message: "Which scope should be used?",
      choices: scopes,
    },
  ]);
  return answer.scope;
}
