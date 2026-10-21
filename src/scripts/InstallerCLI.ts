import Config from "../Config";
import Installer from "../Installer";
import Signing from "../Signing";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { HandlerResult } from "../cli/ExitStatus";
import { addScopeHint, createCertHint } from "../cli/Hints";
import { chooseScope } from "../cli/ScopeChoice";

const InstallerCLI = async (parsed: ParsedCommand, context: CliContext): Promise<HandlerResult> => {
  const signing = new Signing(context.configDir);
  const requested = parsed.options.scope as string | undefined;

  // The scope is chosen before anything is generated. With no scopes configured the installer is
  // still generated, unsigned.
  let scope: string | null = null;
  if (requested !== undefined || signing.getScopes().length > 0) {
    scope = await chooseScope(signing, requested, context.interactive);
  }

  const config = new Config(context.configDir);
  const installer = new Installer(config);
  const built = await installer.run(context.cwd);
  if (!built.ok) {
    // run has printed the message; the status says whether something was missing (2) or failed (1)
    return { status: built.status };
  }
  const msiPath = built.msiPath;

  if (!scope) {
    console.log("No signing scopes configured — skipping signing.");
    console.log(addScopeHint());
    return;
  }

  const certInfo = signing.getCertInfo(scope);
  if (!certInfo) {
    console.log(`No certificate found for scope '${scope}' — skipping signing.`);
    console.log(createCertHint(scope));
    return;
  }

  try {
    console.log(`Signing ${msiPath} with scope '${scope}'...`);
    const result = await signing.signFile(msiPath, { scope });
    console.log(`Signed: ${result.signatureType} (${result.fingerprint})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error signing MSI: " + message);
    return { status: 1 };
  }
};

export default InstallerCLI;
