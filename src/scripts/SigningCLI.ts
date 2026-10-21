import path from "path";
import inquirer from "inquirer";
import Signing, { MISSING_FILE_REASON } from "../Signing";
import { exitStatusOf } from "../Trust";
import { CertInfo, IntegrityResult, MachOSliceResult, TrustResult, VerifyResult, VerifyStatus } from "../types";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { FailedError, HandlerResult, MissingError, UsageError } from "../cli/ExitStatus";
import { chooseScope } from "../cli/ScopeChoice";
import { createCertHint, forceHint } from "../cli/Hints";

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

/** Stops with the "--force" usage error when a certificate exists and may not be replaced without asking. */
async function confirmReplace(signing: Signing, scope: string, parsed: ParsedCommand, context: CliContext): Promise<boolean> {
  if (!signing.hasCert(scope) || parsed.options.force === true) {
    return true;
  }
  if (!context.interactive) {
    throw new UsageError(forceHint(scope), { argument: "--force", command: "", usage: "" });
  }
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
    return false;
  }
  return true;
}

/** Prints the details printed after a certificate is created or imported. */
function printStored(signing: Signing, heading: string, certInfo: CertInfo, withIssuer: boolean): void {
  const validFrom = certInfo.notBefore.toISOString().split("T")[0];
  const validTo = certInfo.notAfter.toISOString().split("T")[0];
  console.log(heading);
  console.log(`  Subject:     ${signing._formatSubject(certInfo.subject)}`);
  if (withIssuer) {
    console.log(`  Issuer:      ${certInfo.issuer}`);
  }
  console.log(`  Fingerprint: ${certInfo.fingerprint}`);
  console.log(`  Valid:        ${validFrom} to ${validTo}`);
  console.log(`  Stored:       ${certInfo.certPath}`);
}

async function verifyCommand(signing: Signing, parsed: ParsedCommand): Promise<HandlerResult> {
  const targetPath = parsed.positionals.path as string;
  const certFiles = (parsed.options.cert as string[] | undefined) ?? [];

  // Supplied certificates are read before the target is examined; an unusable one stops the command.
  const trust = signing.loadTrust(certFiles.length > 0 ? certFiles : undefined);

  let exitStatus = 0;
  {
    const fs = await import("fs");
    const resolvedPath = path.resolve(targetPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new MissingError(`File not found: ${resolvedPath}`);
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
  }
  if (exitStatus !== 0) {
    return { status: exitStatus };
  }
}

const SigningCLI = async (parsed: ParsedCommand, context: CliContext): Promise<HandlerResult> => {
  const signing = new Signing(context.configDir);
  const requestedScope = parsed.options.scope as string | undefined;

  switch (parsed.subcommand) {
    case "create-cert": {
      const validityDays = (parsed.options["validity-days"] as number | undefined) ?? 365;

      const scope = await chooseScope(signing, requestedScope, context.interactive);
      if (!(await confirmReplace(signing, scope, parsed, context))) {
        throw new FailedError("Aborted. Existing certificate unchanged.", { reported: true });
      }

      const certInfo = await signing.createCert({ validityDays, scope });
      printStored(signing, "Certificate created successfully.", certInfo, false);
      break;
    }
    case "import-cert": {
      const resolvedCert = path.resolve(parsed.options.cert as string);
      const resolvedKey = path.resolve(parsed.options.key as string);

      const scope = await chooseScope(signing, requestedScope, context.interactive);
      if (!(await confirmReplace(signing, scope, parsed, context))) {
        throw new FailedError("Aborted. Existing certificate unchanged.", { reported: true });
      }

      const certInfo = await signing.importCert(resolvedCert, resolvedKey, scope);
      printStored(signing, "Certificate imported successfully.", certInfo, true);
      break;
    }
    case "sign": {
      const targetPath = parsed.positionals.path as string;
      const force = parsed.options.force === true;
      const detached = parsed.options.detached === true;

      const scope = await chooseScope(signing, requestedScope, context.interactive);

      {
        const fs = await import("fs");
        const resolvedPath = path.resolve(targetPath);
        if (!fs.existsSync(resolvedPath)) {
          throw new MissingError(`File not found: ${resolvedPath}`);
        }
        const stat = fs.statSync(resolvedPath);

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
          console.log(`  Manifest: ${path.relative(context.cwd, result.manifestPath)}`);
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
      }
      break;
    }
    case "verify":
      return verifyCommand(signing, parsed);
    case "cert-info": {
      const scope = await chooseScope(signing, requestedScope, context.interactive);

      const certInfo = signing.getCertInfo(scope);
      if (!certInfo) {
        throw new MissingError(`No signing certificate found for scope '${scope}'.`, {
          hint: `${createCertHint(scope)} To use an existing certificate, import it with "the-seed signing import-cert --cert <file> --key <file> --scope ${scope}".`,
        });
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
      const outputPath = parsed.options.output as string;

      const scope = await chooseScope(signing, requestedScope, context.interactive);

      const certInfo = signing.getCertInfo(scope);
      if (!certInfo) {
        throw new MissingError(`No signing certificate found for scope '${scope}'.`, { hint: createCertHint(scope) });
      }

      const resolvedOutput = path.resolve(outputPath);
      await signing.exportCert(resolvedOutput, scope);

      console.log(`Certificate exported to: ${resolvedOutput}`);
      console.log(`  Fingerprint: ${certInfo.fingerprint}`);
      break;
    }
  }
};

export default SigningCLI;
