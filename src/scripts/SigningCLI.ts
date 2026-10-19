import path from "path";
import inquirer from "inquirer";
import Signing, { MISSING_FILE_REASON } from "../Signing";
import Config from "../Config";
import { exitStatusOf } from "../Trust";
import { IntegrityResult, MachOSliceResult, ScriptArgsType, TrustResult, VerifyResult, VerifyStatus } from "../types";

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

const FILE_HEADLINES: Record<VerifyStatus, string> = {
  VALID: "VALID ✓",
  UNTRUSTED: "INTACT, NOT TRUSTED ✗",
  INVALID: "INVALID ✗",
  NOT_FULLY_SIGNED: "NOT FULLY SIGNED ✗",
  NOT_CHECKED: "SIGNATURE NOT CHECKED ✗",
  NOT_FOUND: "NO SIGNATURE",
};

/** The words after "Form:" for one signature. */
function describeForm(result: VerifyResult): string {
  if (result.form === "detached") {
    return `detached (${path.basename(result.filePath)}.sig)`;
  }
  if (result.form === "windows-program") {
    return "Windows program (embedded)";
  }
  if (result.form === "installer") {
    return "installer (embedded)";
  }
  if (result.form === "mac-program") {
    const count = result.slices?.length ?? 0;
    return count > 1 ? `Mac program (embedded, ${count} slices)` : "Mac program (embedded)";
  }
  return "none";
}

/** The words after "Integrity:" in a report. */
function describeIntegrity(integrity: IntegrityResult): string {
  switch (integrity.state) {
    case "intact":
      return `intact (${integrity.checked.join(", ")})`;
    case "invalid":
      return `invalid: ${integrity.reason ?? "unknown reason"}`;
    case "not-checked":
      return `not checked: ${integrity.reason ?? "unknown reason"}`;
    default:
      return `no signature: ${integrity.reason ?? "none found"}`;
  }
}

/** The words after "Slice <arch>:" in a report. */
function describeSlice(slice: MachOSliceResult): string {
  switch (slice.state) {
    case "intact":
      return slice.adHoc ? "ad-hoc (no signer)" : `intact (${slice.codeDirectories[0]?.pages ?? 0} pages)`;
    case "invalid":
      return `invalid: ${slice.reason ?? "unknown reason"}`;
    case "not-checked":
      return `not checked: ${slice.reason ?? "unknown reason"}`;
    default:
      return "unsigned";
  }
}

/** The lines of one signature's details (integrity, trust, signer, slices), each starting with the given indent. */
function signatureLines(signing: Signing, result: VerifyResult, indent: string): string[] {
  const lines = [`${indent}Integrity:   ${describeIntegrity(result.integrity)}`, `${indent}Trust:       ${describeTrust(result.trust)}`];
  if (result.signer) {
    const day = (date: Date): string => date.toISOString().slice(0, 10);
    lines.push(`${indent}Signer:      ${signing._formatSubject(result.signer.subject)}`);
    lines.push(`${indent}Issuer:      ${result.signer.issuer || "Unknown"}`);
    lines.push(`${indent}Fingerprint: ${result.signer.fingerprint}`);
    lines.push(`${indent}Valid:       ${day(result.signer.notBefore)} to ${day(result.signer.notAfter)}`);
  }
  if (result.slices) {
    const labels = result.slices.map((slice) => `Slice ${slice.arch}:`);
    const width = Math.max(0, ...labels.map((label) => label.length)) + 1;
    result.slices.forEach((slice, index) => {
      lines.push(`${indent}${labels[index].padEnd(width)}${describeSlice(slice)}`);
    });
  }
  return lines;
}

/** The report for one file, as the lines to print. */
function fileReport(signing: Signing, result: VerifyResult): string[] {
  const lines = [`Verification: ${FILE_HEADLINES[result.status] ?? result.status}`, `  File:        ${result.filePath}`];
  const kinds = result.signatures;
  if (kinds && kinds.length === 2) {
    lines.push(`  Form:        ${describeForm(kinds[0])} and ${describeForm(kinds[1])}`);
  } else {
    lines.push(`  Form:        ${describeForm(result)}`);
  }
  lines.push(...signatureLines(signing, result, "  "));
  if (kinds && kinds.length === 2) {
    for (const kind of kinds) {
      lines.push(`  Signature ${kind.signatureType ?? "embedded"}:`);
      lines.push(...signatureLines(signing, kind, "    "));
    }
  }
  for (const warning of result.warnings) {
    lines.push(`  Warning: ${warning}`);
  }
  lines.push(`  Not checked: ${result.notChecked.join(", ")}`);
  return lines;
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
              console.log(row(word, r.reason === MISSING_FILE_REASON || !r.reason ? r.relativePath : `${r.relativePath} — ${r.reason}`));
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
          for (const line of fileReport(signing, result)) {
            console.log(line);
          }
          exitStatus = exitStatusOf(result.status);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("No .signatures.json")) {
          console.error("Error: " + message);
          process.exit(2);
        } else if (message.includes("malformed") || message.includes("is a signature file;") || message.includes("is a directory manifest;")) {
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
      console.log("  verify        Verify file signature(s): integrity and trust (--cert <file> to trust a given certificate)");
      console.log("  cert-info     Display current certificate details");
      console.log("  export-cert   Export public certificate to a file");
      console.log("\nCommands:");
      console.log("  the-seed signing help          Show this help message");
      console.log("  the-seed signing create-cert   Generate a new signing certificate");
      console.log("  the-seed signing import-cert   Import an existing certificate");
      console.log("  the-seed signing sign          Sign file(s) or directory");
      console.log("  the-seed signing verify [--cert <file>]... <file-or-directory>");
      console.log("                                 Verify file or directory signatures");
      console.log("  the-seed signing cert-info     Show certificate information");
      console.log("  the-seed signing export-cert   Export public certificate");
      console.log("\nverify checks that a file is unchanged since it was signed and that its signer");
      console.log("is one of the certificates of your configured scopes (or of the files named with");
      console.log("--cert). Exit status: 0 valid; 4 intact but not trusted; 1 invalid, not fully");
      console.log("signed, not checked or no signature; 2 not found or other error; 3 usage or");
      console.log("malformed manifest. Certificate chains, revocation, signing time and acceptance");
      console.log("by the platform's own verifier are not checked.");
      break;
  }
};

export default SigningCLI;
