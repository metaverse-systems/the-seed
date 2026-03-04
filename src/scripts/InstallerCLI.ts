import inquirer from "inquirer";
import Config from "../Config";
import Installer from "../Installer";
import Signing from "../Signing";
import { ScriptArgsType } from "../types";

/**
 * Resolve the signing scope from --scope flag, interactive prompt, or auto-select.
 * Returns the scope name or null if no scopes are configured.
 */
async function resolveScope(
  signing: Signing,
  scopeFlag: string | undefined
): Promise<string | null> {
  if (scopeFlag) {
    const scopes = signing.getScopes();
    if (!scopes.includes(scopeFlag)) {
      console.error(
        `Error: Scope '${scopeFlag}' not found. Available scopes: ${scopes.join(", ") || "(none)"}`
      );
      return null;
    }
    return scopeFlag;
  }

  const scopes = signing.getScopes();
  if (scopes.length === 0) {
    return null;
  }
  if (scopes.length === 1) {
    return scopes[0];
  }

  const answer = await inquirer.prompt([
    {
      type: "list",
      name: "scope",
      message: "Which scope should be used for signing?",
      choices: scopes,
    },
  ]);
  return answer.scope;
}

const InstallerCLI = async (scriptConfig: ScriptArgsType) => {
  const command = scriptConfig.args[3];

  const getFlagValue = (flag: string): string | undefined => {
    const idx = scriptConfig.args.indexOf(flag);
    if (idx !== -1 && idx + 1 < scriptConfig.args.length) {
      return scriptConfig.args[idx + 1];
    }
    return undefined;
  };

  const printUsage = () => {
    console.log("Usage: the-seed installer <target> [options]");
    console.log("");
    console.log("Available targets:");
    console.log("  help      - Show this help message");
    console.log("  windows   - Generate a Windows MSI installer from dist/ files");
    console.log("");
    console.log("Options:");
    console.log("  --scope <name>  - Scope whose certificate to use for signing");
  };

  // No arguments or help subcommand
  if (!command || command === "help") {
    printUsage();
    return;
  }

  switch (command) {
    case "windows": {
      const config = new Config(scriptConfig.configDir);
      const installer = new Installer(config);
      const msiPath = installer.run(process.cwd());
      if (!msiPath) {
        process.exit(1);
      }

      // Sign the generated MSI
      const signing = new Signing(scriptConfig.configDir);
      const scopeFlag = getFlagValue("--scope");
      const scope = await resolveScope(signing, scopeFlag);

      if (!scope) {
        if (scopeFlag) {
          // resolveScope already printed the error
          process.exit(1);
        }
        console.log("No signing scopes configured — skipping signing.");
        console.log("Run 'the-seed signing create-cert --scope <name>' to enable signing.");
        break;
      }

      const certInfo = signing.getCertInfo(scope);
      if (!certInfo) {
        console.log(`No certificate found for scope '${scope}' — skipping signing.`);
        console.log("Run 'the-seed signing create-cert' to create one.");
        break;
      }

      try {
        console.log(`Signing ${msiPath} with scope '${scope}'...`);
        const result = await signing.signFile(msiPath, { scope });
        console.log(`Signed: ${result.signatureType} (${result.fingerprint})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Error signing MSI: " + message);
        process.exit(1);
      }
      break;
    }
    default:
      printUsage();
      break;
  }
};

export default InstallerCLI;
