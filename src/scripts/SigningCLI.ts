import path from "path";
import inquirer from "inquirer";
import Signing from "../Signing";
import Config from "../Config";
import { exitStatusOf } from "../Trust";
import { ScriptArgsType, TrustResult } from "../types";

/**
 * Prompt the user to select a scope. If only one scope exists, auto-selects it.
 * Returns the selected scope name, or null if no scopes are configured.
 */
async function promptForScope(signing: Signing): Promise<string | null> {
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
      message: "Which scope should be used?",
      choices: scopes,
    },
  ]);
  return answer.scope;
}

/** The words after "Trust:" in a report. */
function describeTrust(trust: TrustResult): string {
  if (trust.state === "trusted" && trust.anchor) {
    const anchor = trust.anchor;
    return anchor.source === "scope" ? `trusted: certificate of scope ${anchor.scope}` : `trusted: supplied certificate ${anchor.path}`;
  }
  if (trust.state === "untrusted") {
    return `not trusted: ${trust.message}`;
  }
  return "not applicable";
}

const SigningCLI = async (scriptConfig: ScriptArgsType) => {
  const command = scriptConfig.args[3];
  const signing = new Signing(scriptConfig.configDir);

  // Helper to parse flags from args
  const hasFlag = (flag: string): boolean => scriptConfig.args.includes(flag);
  const getFlagValue = (flag: string): string | undefined => {
    const idx = scriptConfig.args.indexOf(flag);
    if (idx !== -1 && idx + 1 < scriptConfig.args.length) {
      return scriptConfig.args[idx + 1];
    }
    return undefined;
  };
  const getPositional = (): string | undefined => {
    // First arg after the subcommand that doesn't start with --
    for (let i = 4; i < scriptConfig.args.length; i++) {
      if (!scriptConfig.args[i].startsWith("--")) {
        return scriptConfig.args[i];
      }
    }
    return undefined;
  };

  switch (command) {
    case "create-cert": {
      const validityDaysStr = getFlagValue("--validity-days");
      const validityDays = validityDaysStr ? parseInt(validityDaysStr, 10) : 365;
      const force = hasFlag("--force");

      try {
        // Prompt for scope selection
        const scope = await promptForScope(signing);
        if (!scope) {
          console.error("Error: No scopes configured. Run 'the-seed config add-scope' to add one.");
          process.exit(3);
          return;
        }

        // Check if cert already exists for this scope
        if (signing.hasCert(scope) && !force) {
          const { overwrite } = await inquirer.prompt([
            {
              type: "confirm",
              name: "overwrite",
              message: "A signing certificate already exists. Overwrite?",
              default: false,
            },
          ]);
          if (!overwrite) {
            console.log("Aborted. Existing certificate unchanged.");
            process.exit(1);
            return;
          }
        }

        const certInfo = await signing.createCert({ validityDays, scope });
        const subjectStr = signing._formatSubject(certInfo.subject);
        const validFrom = certInfo.notBefore.toISOString().split("T")[0];
        const validTo = certInfo.notAfter.toISOString().split("T")[0];

        console.log("Certificate created successfully.");
        console.log(`  Subject:     ${subjectStr}`);
        console.log(`  Fingerprint: ${certInfo.fingerprint}`);
        console.log(`  Valid:        ${validFrom} to ${validTo}`);
        console.log(`  Stored:       ${certInfo.certPath}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Error: " + message);
        process.exit(2);
      }
      break;
    }
    case "import-cert": {
      const certPathArg = getFlagValue("--cert");
      const keyPathArg = getFlagValue("--key");
      const force = hasFlag("--force");

      if (!certPathArg || !keyPathArg) {
        console.error("Error: Missing required arguments. Usage: the-seed signing import-cert --cert <path> --key <path>");
        process.exit(3);
        return;
      }

      try {
        const resolvedCert = path.resolve(certPathArg);
        const resolvedKey = path.resolve(keyPathArg);

        // Prompt for scope selection
        const scope = await promptForScope(signing);
        if (!scope) {
          console.error("Error: No scopes configured. Run 'the-seed config add-scope' to add one.");
          process.exit(3);
          return;
        }

        // Check if cert already exists for this scope
        if (signing.hasCert(scope) && !force) {
          const { overwrite } = await inquirer.prompt([
            {
              type: "confirm",
              name: "overwrite",
              message: "A signing certificate already exists. Overwrite?",
              default: false,
            },
          ]);
          if (!overwrite) {
            console.log("Aborted. Existing certificate unchanged.");
            process.exit(1);
            return;
          }
        }

        const certInfo = await signing.importCert(resolvedCert, resolvedKey, scope);
        const subjectStr = signing._formatSubject(certInfo.subject);
        const validFrom = certInfo.notBefore.toISOString().split("T")[0];
        const validTo = certInfo.notAfter.toISOString().split("T")[0];

        console.log("Certificate imported successfully.");
        console.log(`  Subject:     ${subjectStr}`);
        console.log(`  Issuer:      ${certInfo.issuer}`);
        console.log(`  Fingerprint: ${certInfo.fingerprint}`);
        console.log(`  Valid:        ${validFrom} to ${validTo}`);
        console.log(`  Stored:       ${certInfo.certPath}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          console.error("Error: " + message);
          process.exit(2);
        } else if (message.includes("mismatch") || message.includes("do not match") || message.includes("Unsupported")) {
          console.error("Error: " + message);
          process.exit(3);
        } else {
          console.error("Error: " + message);
          process.exit(2);
        }
      }
      break;
    }
    case "sign": {
      const targetPath = getPositional();
      const force = hasFlag("--force");
      const detached = hasFlag("--detached");

      if (!targetPath) {
        console.error("Error: Missing path argument. Usage: the-seed signing sign <path>");
        process.exit(3);
        return;
      }

      try {
        const fs = await import("fs");
        const resolvedPath = path.resolve(targetPath);
        const stat = fs.statSync(resolvedPath);

        // Prompt for scope selection
        const scope = await promptForScope(signing);
        if (!scope) {
          console.error("Error: No scopes configured. Run 'the-seed config add-scope' to add one.");
          process.exit(3);
          return;
        }

        if (stat.isDirectory()) {
          const result = await signing.signDirectory(targetPath, { force, scope, detached });
          console.log(`Signing directory: ${targetPath}`);
          for (const signed of result.signed) {
            const relFile = path.relative(resolvedPath, signed.filePath);
            if (signed.signatureType === "embedded") {
              console.log(`  Signed (embedded): ${relFile}`);
            } else {
              const relSig = path.relative(resolvedPath, signed.signaturePath!);
              console.log(`  Signed (detached): ${relFile} → ${relSig}`);
            }
            for (const warning of signed.warnings) {
              console.log(`    Warning: ${warning}`);
            }
          }
          for (const skipped of result.skipped) {
            console.log(`  Skipped (not binary): ${skipped}`);
          }
          console.log("");
          console.log(`  Manifest: ${path.relative(process.cwd(), result.manifestPath)}`);
          console.log(`  Files signed: ${result.signed.length} | Skipped: ${result.skipped.length}`);
        } else {
          const result = await signing.signFile(targetPath, { force, scope, detached });
          console.log(`Signed: ${result.filePath}`);
          if (result.signatureType === "embedded") {
            console.log("  Type:        embedded");
          } else {
            console.log(`  Signature:   ${result.signaturePath}`);
            console.log("  Type:        detached");
          }
          console.log(`  Fingerprint: ${result.fingerprint}`);
          for (const warning of result.warnings) {
            console.log(`  Warning: ${warning}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("No signing certificate")) {
          console.error("Error: " + message);
          process.exit(1);
        } else if (message.includes("expired")) {
          console.error("Error: " + message);
          process.exit(2);
        } else if (message.includes("No binary files")) {
          console.error("Error: " + message);
          process.exit(4);
        } else {
          console.error("Error: " + message);
          process.exit(3);
        }
      }
      break;
    }
    case "verify": {
      const VERIFY_USAGE = "Usage: the-seed signing verify [--cert <file>]... <path>";
      const certFiles: string[] = [];
      let targetPath: string | undefined;
      for (let i = 4; i < scriptConfig.args.length; i++) {
        const arg = scriptConfig.args[i];
        if (arg === "--cert") {
          const value = scriptConfig.args[i + 1];
          if (value === undefined) {
            console.error("Error: --cert needs a file");
            console.error(VERIFY_USAGE);
            process.exit(3);
            return;
          }
          certFiles.push(value);
          i++;
        } else if (arg.startsWith("--")) {
          console.error(`Error: Unknown option ${arg}`);
          console.error(VERIFY_USAGE);
          process.exit(3);
          return;
        } else if (targetPath === undefined) {
          targetPath = arg;
        }
      }

      if (!targetPath) {
        console.error(`Error: Missing path argument. ${VERIFY_USAGE}`);
        process.exit(3);
        return;
      }

      // Supplied certificates are read before the target is examined; an unusable one stops the command.
      let trust;
      try {
        trust = signing.loadTrust(certFiles.length > 0 ? certFiles : undefined);
      } catch (err: unknown) {
        console.error("Error: " + (err instanceof Error ? err.message : String(err)));
        process.exit(2);
        return;
      }

      let exitStatus = 0;
      try {
        const fs = await import("fs");
        const resolvedPath = path.resolve(targetPath);

        if (!fs.existsSync(resolvedPath)) {
          console.error(`Error: File not found: ${resolvedPath}`);
          process.exit(2);
          return;
        }

        const stat = fs.statSync(resolvedPath);

        if (stat.isDirectory()) {
          const result = await signing.verifyDirectory(targetPath, { trust });
          const formLabels: Record<string, string> = {
            detached: "detached",
            "windows-program": "Windows program",
            installer: "installer",
            "mac-program": "Mac program",
          };
          const headlines: Record<string, string> = {
            VALID: "VALID",
            UNTRUSTED: "UNTRUSTED",
            INVALID: "INVALID",
            NOT_FULLY_SIGNED: "NOT FULLY SIGNED",
            NOT_CHECKED: "NOT CHECKED",
            NOT_FOUND: "MISSING",
          };
          const row = (word: string, text: string): string => "  " + word.padEnd(17) + text;
          const manifest = result.manifest;
          console.log(`Verifying directory: ${targetPath}`);
          if (manifest.earlierFormat) {
            console.log(`  Manifest:    .signatures.json, earlier format (version ${manifest.version}); signing the directory again writes the current one`);
          } else {
            console.log(`  Manifest:    .signatures.json, current format (version ${manifest.version}), signed ${manifest.signedAt}`);
          }
          const consistency = manifest.fingerprintConsistent
            ? "fingerprint matches the manifest"
            : `fingerprint does NOT match the manifest's recorded fingerprint ${manifest.recordedFingerprint}`;
          console.log(`  Certificate: ${signing._formatSubject(manifest.certificate.subject)}  ${manifest.certificate.fingerprint}  (${consistency})`);
          console.log(`  Trust:       ${describeTrust(manifest.trust)}`);
          for (const r of result.results) {
            const word = headlines[r.status] ?? r.status;
            if (r.status === "NOT_FOUND") {
              console.log(row(word, r.relativePath));
            } else if (r.status === "VALID" || r.status === "UNTRUSTED") {
              console.log(row(word, `${r.relativePath} (${formLabels[r.form ?? "detached"] ?? r.form}; signer matches the manifest)`));
            } else {
              console.log(row(word, `${r.relativePath} — ${r.reason || "Unknown reason"}`));
            }
          }
          for (const item of result.unlisted) {
            console.log(row("UNLISTED", `${item.relativePath} — ${item.reason}`));
          }
          for (const link of result.links) {
            console.log(row("LINK", `${link.relativePath} -> ${link.target}`));
          }
          for (const item of result.skipped) {
            if (item.present) {
              console.log(row("SKIPPED", `${item.relativePath} — present, not signed; contents not checked`));
            }
          }
          for (const warning of result.warnings) {
            console.log(`  Warning: ${warning}`);
          }
          console.log(`  Not checked: ${result.notChecked.join(", ")}`);
          console.log("");
          const counts = result.counts;
          const verdict = result.status === "VALID" ? "PASS" : result.status === "UNTRUSTED" ? "NOT TRUSTED" : "FAIL";
          console.log(
            `  Result: ${verdict} (valid ${counts.valid}, untrusted ${counts.untrusted}, invalid ${counts.invalid}, not fully signed ${counts.notFullySigned}, ` +
              `not checked ${counts.notChecked}, missing ${counts.missing}, unlisted ${counts.unlisted}; skipped ${counts.skipped})`
          );
          exitStatus = exitStatusOf(result.status);
        } else {
          const result = await signing.verifyFile(targetPath, { trust });
          const headlines: Record<string, string> = {
            VALID: "VALID ✓",
            UNTRUSTED: "INTACT, NOT TRUSTED ✗",
            INVALID: "INVALID ✗",
            NOT_FULLY_SIGNED: "NOT FULLY SIGNED ✗",
            NOT_CHECKED: "SIGNATURE NOT CHECKED ✗",
            NOT_FOUND: "NO SIGNATURE",
          };
          console.log(`Verification: ${headlines[result.status] ?? result.status}`);
          console.log(`  File:        ${result.filePath}`);
          if (result.status !== "VALID" && result.reason) {
            console.log(`  Reason:      ${result.reason}`);
          }
          if (result.trust.state !== "not-applicable") {
            console.log(`  Trust:       ${describeTrust(result.trust)}`);
          }
          if (result.signer) {
            console.log(`  Signer:      ${signing._formatSubject(result.signer.subject)}`);
            console.log(`  Issuer:      ${result.signer.issuer || "Unknown"}`);
            console.log(`  Fingerprint: ${result.signer.fingerprint}`);
          }
          for (const warning of result.warnings) {
            console.log(`  Warning: ${warning}`);
          }
          exitStatus = exitStatusOf(result.status);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("No .signatures.json")) {
          console.error("Error: " + message);
          process.exit(2);
        } else if (message.includes("malformed")) {
          console.error("Error: " + message);
          process.exit(3);
        } else {
          console.error("Error: " + message);
          process.exit(2);
        }
        return;
      }
      if (exitStatus !== 0) {
        process.exit(exitStatus);
      }
      break;
    }
    case "cert-info": {
      const scope = await promptForScope(signing);
      if (!scope) {
        console.log("No scopes configured.");
        console.log("  Run 'the-seed config add-scope' to add a scope.");
        process.exit(1);
        return;
      }

      const certInfo = signing.getCertInfo(scope);
      if (!certInfo) {
        console.log(`No signing certificate found for scope '${scope}'.`);
        console.log("  Run 'the-seed signing create-cert' to generate one.");
        console.log("  Run 'the-seed signing import-cert' to import an existing certificate.");
        process.exit(1);
        return;
      }

      const subjectStr = signing._formatSubject(certInfo.subject);
      const validFrom = certInfo.notBefore.toISOString().split("T")[0];
      const validTo = certInfo.notAfter.toISOString().split("T")[0];
      const status = certInfo.isExpired ? "Expired" : "Active";

      console.log("Signing Certificate:");
      console.log(`  Subject:     ${subjectStr}`);
      console.log(`  Issuer:      ${certInfo.issuer}`);
      console.log(`  Fingerprint: ${certInfo.fingerprint}`);
      console.log(`  Key Type:    ${certInfo.keyType}`);
      console.log(`  Valid:        ${validFrom} to ${validTo}`);
      console.log(`  Status:      ${status}`);
      console.log(`  Location:    ${certInfo.certPath}`);
      break;
    }
    case "export-cert": {
      const outputPath = getFlagValue("--output");

      if (!outputPath) {
        console.error("Error: Missing required argument. Usage: the-seed signing export-cert --output <path>");
        process.exit(2);
        return;
      }

      try {
        const scope = await promptForScope(signing);
        if (!scope) {
          console.error("Error: No scopes configured. Run 'the-seed config add-scope' to add one.");
          process.exit(3);
          return;
        }

        const certInfo = signing.getCertInfo(scope);
        if (!certInfo) {
          console.error(`Error: No signing certificate found for scope '${scope}'.`);
          process.exit(1);
          return;
        }

        const resolvedOutput = path.resolve(outputPath);
        await signing.exportCert(resolvedOutput, scope);

        console.log(`Certificate exported to: ${resolvedOutput}`);
        console.log(`  Fingerprint: ${certInfo.fingerprint}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("No signing certificate")) {
          console.error("Error: " + message);
          process.exit(1);
        } else {
          console.error("Error: " + message);
          process.exit(2);
        }
      }
      break;
    }
    case "help":
    default:
      console.log("\nUsage: the-seed signing <command>");
      console.log("\nAvailable commands:");
      console.log("  create-cert   Generate a self-signed ECDSA P-256 certificate");
      console.log("  import-cert   Import an existing PEM certificate and private key");
      console.log("  sign          Sign one or more binary files");
      console.log("  verify        Verify file signature(s)");
      console.log("  cert-info     Display current certificate details");
      console.log("  export-cert   Export public certificate to a file");
      console.log("\nCommands:");
      console.log("  the-seed signing help          Show this help message");
      console.log("  the-seed signing create-cert   Generate a new signing certificate");
      console.log("  the-seed signing import-cert   Import an existing certificate");
      console.log("  the-seed signing sign          Sign file(s) or directory");
      console.log("  the-seed signing verify        Verify file or directory signatures");
      console.log("  the-seed signing cert-info     Show certificate information");
      console.log("  the-seed signing export-cert   Export public certificate");
      break;
  }
};

export default SigningCLI;
