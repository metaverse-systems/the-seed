import crypto from "crypto";
import fs from "fs";
import { IntegrityResult, TrustedCertificates, TrustResult, VerifyStatus } from "./types";

/** Statuses from best to worst, as `worst` orders them. */
const SEVERITY: VerifyStatus[] = ["VALID", "UNTRUSTED", "NOT_FOUND", "NOT_CHECKED", "NOT_FULLY_SIGNED", "INVALID"];

/** What a check never covers, whatever the file. */
export const NOT_CHECKED_ALWAYS: readonly string[] = ["certificate chains", "revocation", "signing time", "acceptance by the platform's own verifier"];

const NO_ANCHORS_MESSAGE = "no trusted certificates are available; create one with 'the-seed signing create-cert' or name one with --cert <file>";
const UNKNOWN_SIGNER_MESSAGE = "signer certificate is not one of the trusted certificates";
const NO_SIGNER_MESSAGE = "the signature has no signer (ad-hoc)";

/** SHA-256 fingerprint of a DER certificate in the form the tool prints: "SHA256:<lowercase hex>". */
export function certificateFingerprint(der: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(der).digest("hex");
}

/**
 * Reads every certificate of a file: the CERTIFICATE blocks of a PEM file in file order, or one DER certificate.
 * Throws an Error naming the path when the file is missing, cannot be read or holds no certificate.
 */
export function readCertificates(filePath: string): Buffer[] {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Trusted certificate file ${filePath} does not exist`);
    }
    throw new Error(`Trusted certificate file ${filePath} cannot be read: ${(err as Error).message}`);
  }

  const certificates: Buffer[] = [];
  const text = data.toString("latin1");
  const pattern = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]*?)-----END CERTIFICATE-----/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
    if (der.length > 0 && isCertificate(der)) {
      certificates.push(der);
    }
  }
  if (certificates.length === 0 && !text.includes("-----BEGIN") && isCertificate(data)) {
    certificates.push(Buffer.from(data));
  }
  if (certificates.length === 0) {
    throw new Error(`Trusted certificate file ${filePath} holds no certificate`);
  }
  return certificates;
}

function isCertificate(der: Buffer): boolean {
  try {
    new crypto.X509Certificate(der);
    return true;
  } catch {
    return false;
  }
}

/** Decides whether the signer is one of the trusted certificates; the first matching anchor is reported. */
export function evaluateTrust(signer: Buffer | null, trust: TrustedCertificates): TrustResult {
  if (trust.anchors.length === 0) {
    return { state: "untrusted", reason: "no-trusted-certificates", message: NO_ANCHORS_MESSAGE };
  }
  if (signer === null) {
    return { state: "untrusted", reason: "no-signer", message: NO_SIGNER_MESSAGE };
  }
  const fingerprint = certificateFingerprint(signer);
  for (const anchor of trust.anchors) {
    if (anchor.fingerprint === fingerprint) {
      return { state: "trusted", anchor };
    }
  }
  return { state: "untrusted", reason: "unknown-signer", message: UNKNOWN_SIGNER_MESSAGE };
}

/** The status of one file from its integrity and trust results. */
export function outcomeOf(integrity: IntegrityResult, trust: TrustResult): VerifyStatus {
  switch (integrity.state) {
    case "none":
      return "NOT_FOUND";
    case "not-checked":
      return "NOT_CHECKED";
    case "invalid":
      return integrity.unsignedOnly !== undefined && integrity.unsignedOnly.length > 0 ? "NOT_FULLY_SIGNED" : "INVALID";
    default:
      return trust.state === "trusted" ? "VALID" : "UNTRUSTED";
  }
}

/** The most severe of the given statuses. */
export function worst(statuses: VerifyStatus[]): VerifyStatus {
  let index = 0;
  for (const status of statuses) {
    index = Math.max(index, SEVERITY.indexOf(status));
  }
  return SEVERITY[index];
}

/** Exit status of a single file: 0 for VALID, 4 for UNTRUSTED, 1 otherwise. */
export function exitStatusOf(status: VerifyStatus): 0 | 1 | 4 {
  if (status === "VALID") {
    return 0;
  }
  return status === "UNTRUSTED" ? 4 : 1;
}
