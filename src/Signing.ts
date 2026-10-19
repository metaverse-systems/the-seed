import fs from "fs";
import { createReadStream } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execSync } from "child_process";
import { pipeline } from "stream/promises";
import { isBinaryFile as isBinary } from "isbinaryfile";
import * as x509 from "@peculiar/x509";
import Config from "./Config";
import { NOT_CHECKED_ALWAYS, certificateFingerprint, evaluateTrust, outcomeOf, readCertificates } from "./Trust";
import { MachOSliceInfo, checkMachO } from "./MachOVerifier";
import {
  CertInfo,
  CertOptions,
  CertSubject,
  SignResult,
  DirectorySignResult,
  VerifyResult,
  DirectoryVerifyResult,
  SigFileFormat,
  SigningManifestFormat,
  SigningManifestEntry,
  SignatureType,
  BinaryFormat,
  FormatDetectionResult,
  SignOptions,
  MachOPreparedSignature,
  TrustedCertificates,
  TrustAnchor,
  TrustResult,
  IntegrityResult,
  MachOSliceResult,
  SignatureForm,
  VerifyOptions,
} from "./types";

// Result of reading an installer signature back from the package
interface MsiSignatureCheck {
  state: "none" | "matches" | "mismatch" | "unreadable";
  storedDigest: Buffer;
  computedDigest: Buffer;
  detail: string;
}

// Native addon interface for binary signing operations
interface NativeAddon {
  listDependencies(binaryPaths: string[], searchPaths: string[]): unknown;
  detectBinaryFormat(filePath: string): { format: string; subFormat: string | null };
  peComputeDigest(filePath: string): { digest: Buffer; isPe32Plus: boolean };
  peEmbedSignature(filePath: string, pkcs7Der: Buffer): void;
  peExtractSignature(filePath: string): Buffer | null;
  peHasEmbeddedSignature(filePath: string): boolean;
  peStripSignature(filePath: string): void;
  machoPrepareSignature(filePath: string, identity: string, cmsCapacity: number): MachOPreparedSignature;
  machoCompleteSignature(filePath: string, prepared: MachOPreparedSignature, cmsSignatures: Buffer[]): void;
  machoStripSignature(filePath: string): void;
  machoBuildSuperBlob(codeDirectory: Buffer, cmsSignature: Buffer): Buffer;
  machoExtractSignature(filePath: string): Buffer | null;
  machoHasEmbeddedSignature(filePath: string): boolean;
  machoListSlices(filePath: string): MachOSliceInfo[];
  msiIsMsi(filePath: string): boolean;
  msiComputeDigest(filePath: string): { digest: Buffer };
  msiEmbedSignature(filePath: string, pkcs7Der: Buffer, requireMatchingDigest?: boolean): void;
  msiCheckSignature(filePath: string): MsiSignatureCheck;
  msiStripSignature(filePath: string): boolean;
  msiExtractSignature(filePath: string): Buffer | null;
  msiHasEmbeddedSignature(filePath: string): boolean;
}

function loadNativeAddon(): NativeAddon {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations and is loaded on first use
  return require("../native/build/Release/dependency_lister.node") as NativeAddon;
}

class Signing {
  configDir: string;
  signingDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), "the-seed");
    this.signingDir = path.join(this.configDir, "signing");
  }

  /**
   * Get the cert.pem path for a given scope.
   */
  scopeCertPath(scope: string): string {
    return path.join(this.signingDir, scope, "cert.pem");
  }

  /**
   * Get the key.pem path for a given scope.
   */
  scopeKeyPath(scope: string): string {
    return path.join(this.signingDir, scope, "key.pem");
  }

  /**
   * Set file permissions to owner-only (0600).
   * On POSIX systems uses chmodSync; on Windows uses icacls.
   */
  _setOwnerOnly(filePath: string): void {
    if (process.platform === "win32") {
      try {
        const username = os.userInfo().username;
        // Remove inherited permissions, grant owner full control only
        execSync(`icacls "${filePath}" /inheritance:r /grant:r "${username}:(R,W)" /remove "Everyone" /remove "BUILTIN\\Users"`, { stdio: "pipe" });
      } catch {
        // Best-effort: if icacls fails (e.g., non-NTFS), silently continue
      }
    } else {
      fs.chmodSync(filePath, 0o600);
    }
  }

  /**
   * Check if a signing certificate exists for a given scope.
   * Without a scope, checks if any scope has a cert.
   */
  hasCert(scope?: string): boolean {
    if (scope) {
      return fs.existsSync(this.scopeCertPath(scope));
    }
    // Check for any scope with a cert
    if (!fs.existsSync(this.signingDir)) return false;
    const entries = fs.readdirSync(this.signingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && fs.existsSync(path.join(this.signingDir, entry.name, "cert.pem"))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get certificate information for a scope. Returns null if no cert exists.
   */
  getCertInfo(scope: string): CertInfo | null {
    const certFilePath = this.scopeCertPath(scope);
    if (!fs.existsSync(certFilePath)) {
      return null;
    }

    const certPem = fs.readFileSync(certFilePath, "utf-8");
    const x509Cert = new crypto.X509Certificate(certPem);

    return { ...this._buildSignerInfo(x509Cert), certPath: certFilePath };
  }

  /**
   * Check if a file is a binary file (eligible for signing).
   */
  async isBinaryFile(filePath: string): Promise<boolean> {
    return isBinary(filePath);
  }

  /**
   * Detect the binary format of a file by inspecting its magic bytes/headers.
   * Returns "pe", "macho", or "other".
   */
  detectBinaryFormat(filePath: string): FormatDetectionResult {
    try {
      const addon = loadNativeAddon();
      const result = addon.detectBinaryFormat(filePath);
      return {
        format: result.format as BinaryFormat,
        subFormat: result.subFormat as FormatDetectionResult["subFormat"],
      };
    } catch {
      // If native addon fails, fall back to "other"
      return { format: "other", subFormat: null };
    }
  }

  /**
   * Remove the embedded signature of a PE file.
   * Returns true when a signature was removed, false when the file is not a PE
   * file or carries no embedded signature. Errors from the native call propagate.
   */
  removeEmbeddedSignature(filePath: string): boolean {
    if (this.detectBinaryFormat(filePath).format !== "pe") {
      return false;
    }
    const addon = loadNativeAddon();
    if (!addon.peHasEmbeddedSignature(filePath)) {
      return false;
    }
    addon.peStripSignature(filePath);
    return true;
  }

  /**
   * Determine the signing strategy for a file based on format detection
   * and user flags.
   * @returns "embedded" if PE/Mach-O/MSI and not --detached, otherwise "detached"
   */
  getSigningStrategy(filePath: string, options?: SignOptions): SignatureType {
    if (options?.detached) {
      return "detached";
    }
    const detection = this.detectBinaryFormat(filePath);
    if (detection.format === "pe" || detection.format === "macho" || detection.format === "msi") {
      return "embedded";
    }
    return "detached";
  }

  /**
   * Parse X.509 subject string into CertSubject.
   * Node.js X509Certificate.subject returns multiline "KEY=value\n" format.
   */
  _parseSubject(subjectString: string): CertSubject {
    const fields: Record<string, string> = {};
    for (const line of subjectString.split("\n")) {
      const idx = line.indexOf("=");
      if (idx !== -1) {
        const key = line.substring(0, idx).trim();
        const value = line.substring(idx + 1).trim();
        fields[key] = value;
      }
    }

    return {
      commonName: fields["CN"] || "",
      email: fields["emailAddress"] || fields["EMAIL"] || undefined,
      organization: fields["O"] || undefined,
    };
  }

  /**
   * Determine if the certificate is self-signed or issued by a CA.
   */
  _parseIssuerString(issuerString: string, subjectString: string): string {
    if (issuerString === subjectString) {
      return "self-signed";
    }
    // Return the issuer DN
    const fields: string[] = [];
    for (const line of issuerString.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        fields.push(trimmed);
      }
    }
    return fields.join(", ");
  }

  /**
   * Format CertSubject as a string for display.
   */
  _formatSubject(subject: CertSubject): string {
    const parts: string[] = [];
    if (subject.commonName) parts.push(`CN=${subject.commonName}`);
    if (subject.email) parts.push(`EMAIL=${subject.email}`);
    if (subject.organization) parts.push(`O=${subject.organization}`);
    return parts.join(", ");
  }

  /**
   * Load the certificates a signature is trusted against.
   * Without paths these are the certificates of the configured scopes; with paths, only the certificates
   * in those files (PEM or DER), and a file that is missing or holds no certificate is an error.
   * Private keys are never read.
   */
  loadTrust(certificatePaths?: string[]): TrustedCertificates {
    const anchors: TrustAnchor[] = [];
    const warnings: string[] = [];

    if (certificatePaths !== undefined) {
      for (const certPath of certificatePaths) {
        for (const der of readCertificates(certPath)) {
          anchors.push({ source: "supplied", path: certPath, fingerprint: certificateFingerprint(der) });
        }
      }
      return { source: "supplied", anchors, warnings };
    }

    for (const scope of this.getScopes()) {
      const certPath = this.scopeCertPath(scope);
      if (!fs.existsSync(certPath)) {
        continue;
      }
      try {
        const [der] = readCertificates(certPath);
        anchors.push({ source: "scope", scope, fingerprint: certificateFingerprint(der), certPath });
      } catch (err) {
        warnings.push(`certificate of scope ${scope} could not be read; it is not trusted (${(err as Error).message})`);
      }
    }
    return { source: "scopes", anchors, warnings };
  }

  /**
   * Get available scope names from config.
   */
  getScopes(): string[] {
    const config = new Config(this.configDir);
    return Object.keys(config.config.scopes);
  }

  /**
   * Read config.json to get subject fields for certificate from a scope.
   */
  _getSubjectFromConfig(scope: string): CertSubject {
    const config = new Config(this.configDir);
    const configData = config.config;
    const scopeData = configData.scopes[scope];

    if (!scopeData) {
      throw new Error(`Scope '${scope}' not found in config. Run 'the-seed config edit' to set it up.`);
    }

    if (!scopeData.author?.name) {
      throw new Error(`Required author name is missing for scope '${scope}'. Run 'the-seed config edit' to set it.`);
    }

    return {
      commonName: scopeData.author.name,
      email: scopeData.author.email || undefined,
      organization: scope,
    };
  }

  /**
   * Generate a self-signed X.509 certificate with ECDSA P-256 key.
   * Reads name, email, and org from config.json for the certificate subject.
   * Stores cert.pem and key.pem in configDir/signing/.
   */
  async createCert(options?: CertOptions): Promise<CertInfo> {
    if (!options?.scope) {
      throw new Error("A scope must be specified for certificate creation.");
    }
    const scope = options.scope;
    const subject = this._getSubjectFromConfig(scope);
    const validityDays = options?.validityDays || 365;

    // Set the crypto provider for @peculiar/x509 to use Node.js webcrypto
    const webcrypto = crypto.webcrypto as unknown as Crypto;
    x509.cryptoProvider.set(webcrypto);

    // Generate ECDSA P-256 key pair using WebCrypto (required by @peculiar/x509)
    const algorithm: EcKeyGenParams = {
      name: "ECDSA",
      namedCurve: "P-256",
    };
    const keys = await webcrypto.subtle.generateKey(
      algorithm,
      true,
      ["sign", "verify"]
    );

    // Build subject distinguished name
    const dnParts: string[] = [];
    if (subject.commonName) dnParts.push(`CN=${subject.commonName}`);
    if (subject.email) dnParts.push(`E=${subject.email}`);
    if (subject.organization) dnParts.push(`O=${subject.organization}`);
    const dn = dnParts.join(", ");

    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setDate(notAfter.getDate() + validityDays);

    // Create self-signed X.509 certificate
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: crypto.randomBytes(16).toString("hex"),
      name: dn,
      notBefore,
      notAfter,
      keys,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      extensions: [
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature,
          true
        ),
      ],
    });

    // Export PEM strings
    const certPem = cert.toString("pem");

    // Export private key to PEM
    const exportedKey = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(exportedKey).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;

    // Ensure scope signing directory exists
    const scopeDir = path.join(this.signingDir, scope);
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }

    // Write certificate and key files
    const certPath = this.scopeCertPath(scope);
    const keyPath = this.scopeKeyPath(scope);
    fs.writeFileSync(certPath, certPem, { mode: 0o644 });
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    this._setOwnerOnly(keyPath);

    return this.getCertInfo(scope)!;
  }

  /**
   * Sign a PE file by embedding an Authenticode signature.
   * Uses native addon for digest computation and embedding.
   * @throws if file is not a valid PE binary
   */
  async signFileAuthenticode(filePath: string, scope: string): Promise<SignResult> {
    const resolvedPath = path.resolve(filePath);
    const certPath = this.scopeCertPath(scope);
    const keyPath = this.scopeKeyPath(scope);
    const certInfo = this.getCertInfo(scope)!;
    const warnings: string[] = [];

    const addon = loadNativeAddon();

    // Strip existing signature if present
    if (addon.peHasEmbeddedSignature(resolvedPath)) {
      // We re-sign by embedding over — EmbedSignature handles replacement
      warnings.push("Replaced existing embedded signature");
    } else {
      // First-time signing: EmbedSignature pads the file to 8-byte alignment
      // before writing the certificate table. Those padding bytes fall within
      // the Authenticode hash range during verification. Pre-pad here so the
      // signing digest covers the same bytes the verification digest will.
      const stat = fs.statSync(resolvedPath);
      const remainder = stat.size % 8;
      if (remainder !== 0) {
        const pad = 8 - remainder;
        const fd = fs.openSync(resolvedPath, "a");
        try {
          fs.writeSync(fd, Buffer.alloc(pad, 0));
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    // Compute Authenticode digest via native addon
    const digestResult = addon.peComputeDigest(resolvedPath);

    // Build CMS/PKCS#7 Authenticode SignedData
    const certPem = fs.readFileSync(certPath, "utf-8");
    const keyPem = fs.readFileSync(keyPath, "utf-8");
    const privateKey = crypto.createPrivateKey(keyPem);

    // Sign the digest with ECDSA-SHA256
    const sign = crypto.createSign("SHA256");
    sign.update(digestResult.digest);
    const signature = sign.sign(privateKey);

    // Build a minimal CMS SignedData (DER-encoded) wrapping the Authenticode digest
    // For Authenticode, we use SpcIndirectDataContent OID 1.3.6.1.4.1.311.2.1.4
    // Simplified: embed raw signature + cert as PKCS#7 structure
    const pkcs7Der = this._buildAuthenticodeCms(digestResult.digest, signature, certPem);

    // Embed signature into PE file via native addon
    addon.peEmbedSignature(resolvedPath, Buffer.from(pkcs7Der));

    // Clean up stale .sig file if it exists (FR-021)
    const staleSigPath = resolvedPath + ".sig";
    if (fs.existsSync(staleSigPath)) {
      fs.unlinkSync(staleSigPath);
      warnings.push("Removed stale .sig file");
    }

    return {
      filePath: resolvedPath,
      signaturePath: null,
      fingerprint: certInfo.fingerprint,
      signatureType: "embedded",
      warnings,
    };
  }

  /**
   * Sign a Mach-O file by embedding a code signature.
   * Handles single-arch and universal (fat) binaries.
   * @throws if file is not a valid Mach-O binary
   */
  async signFileMachO(filePath: string, scope: string): Promise<SignResult> {
    const resolvedPath = path.resolve(filePath);
    const certPath = this.scopeCertPath(scope);
    const keyPath = this.scopeKeyPath(scope);
    const certInfo = this.getCertInfo(scope)!;
    const warnings: string[] = [];

    const addon = loadNativeAddon();

    // Check for existing signature
    if (addon.machoHasEmbeddedSignature(resolvedPath)) {
      warnings.push("Replaced existing embedded signature");
    }

    // Use cert CN as code signing identity
    const identity = certInfo.subject.commonName || "the-seed";

    const keyPem = fs.readFileSync(keyPath, "utf-8");
    const certPem = fs.readFileSync(certPath, "utf-8");
    const privateKey = crypto.createPrivateKey(keyPem);

    // Reserve room for the CMS of any slice, then let the library compute the
    // CodeDirectory of every slice for the file as it will be after signing
    const capacity = this._cmsCapacityFor(certPem, privateKey);
    const prepared = addon.machoPrepareSignature(resolvedPath, identity, capacity);

    // Sign each raw CodeDirectory with ECDSA-SHA256 and wrap it in a detached CMS
    // (RFC 5652, eContent absent)
    const cmsSignatures = prepared.slices.map((slice) => {
      const sign = crypto.createSign("SHA256");
      sign.update(slice.codeDirectory);
      const signature = sign.sign(privateKey);
      return Buffer.from(this._buildMachOCms(slice.codeDirectory, signature, certPem));
    });

    // The file is replaced here, once, with every slice signed
    addon.machoCompleteSignature(resolvedPath, prepared, cmsSignatures);

    if (prepared.slices.length > 1) {
      for (const slice of prepared.slices) {
        warnings.push(`Signed slice ${this._machoArchName(slice.cpuType)}`);
      }
    }

    // Clean up stale .sig file if it exists
    const staleSigPath = resolvedPath + ".sig";
    if (fs.existsSync(staleSigPath)) {
      fs.unlinkSync(staleSigPath);
      warnings.push("Removed stale .sig file");
    }

    return {
      filePath: resolvedPath,
      signaturePath: null,
      fingerprint: certInfo.fingerprint,
      signatureType: "embedded",
      warnings,
    };
  }

  /**
   * Sign an MSI file by embedding an Authenticode signature.
   * MSI files use OLE Compound Document format; the signature is stored
   * in the \x05DigitalSignature stream.
   * Uses native addon for digest computation and embedding.
   * @throws if file is not a valid MSI/CFBF
   */
  async signFileMsi(filePath: string, scope: string): Promise<SignResult> {
    const resolvedPath = path.resolve(filePath);
    const certPath = this.scopeCertPath(scope);
    const keyPath = this.scopeKeyPath(scope);
    const certInfo = this.getCertInfo(scope)!;
    const warnings: string[] = [];

    const addon = loadNativeAddon();

    // Check for an existing signature; the check also reports a stored signature
    // that cannot be read (written by an earlier version), which is replaced too
    if (addon.msiCheckSignature(resolvedPath).state !== "none") {
      warnings.push("Replaced existing embedded signature");
    }

    // Compute MSI Authenticode digest via native addon
    const digestResult = addon.msiComputeDigest(resolvedPath);

    // Build CMS/PKCS#7 Authenticode SignedData for MSI
    const certPem = fs.readFileSync(certPath, "utf-8");
    const keyPem = fs.readFileSync(keyPath, "utf-8");
    const privateKey = crypto.createPrivateKey(keyPem);

    // Sign the digest with ECDSA-SHA256
    const sign = crypto.createSign("SHA256");
    sign.update(digestResult.digest);
    const signature = sign.sign(privateKey);

    // Build CMS blob with SpcSipInfo for MSI
    const pkcs7Der = this._buildMsiCms(digestResult.digest, signature, certPem);

    // Embed signature into MSI file via native addon
    // The library refuses a blob whose fingerprint differs from the package's
    addon.msiEmbedSignature(resolvedPath, Buffer.from(pkcs7Der), true);

    // Read the signature back from the finished file
    const check = addon.msiCheckSignature(resolvedPath);
    if (check.state !== "matches") {
      throw new Error(
        `Installer signature was written but does not read back (${check.detail || check.state})`
      );
    }
    warnings.push(
      "Installer fingerprint and structure were verified by reading the signature back; certificate trust is not checked"
    );

    // Clean up stale .sig file if it exists
    const staleSigPath = resolvedPath + ".sig";
    if (fs.existsSync(staleSigPath)) {
      fs.unlinkSync(staleSigPath);
      warnings.push("Removed stale .sig file");
    }

    return {
      filePath: resolvedPath,
      signaturePath: null,
      fingerprint: certInfo.fingerprint,
      signatureType: "embedded",
      warnings,
    };
  }

  /**
   * Build a minimal CMS/PKCS#7 SignedData for Authenticode.
   * Uses SpcIndirectDataContent (1.3.6.1.4.1.311.2.1.4) as eContentType.
   */
  _buildAuthenticodeCms(digest: Buffer, signature: Buffer, certPem: string): Buffer {
    // Parse the X.509 certificate to get its DER encoding
    const x509Cert = new x509.X509Certificate(certPem);
    const certDer = Buffer.from(x509Cert.rawData);

    // OIDs
    const oidSignedData = Buffer.from([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02]); // 1.2.840.113549.1.7.2
    const oidSpcIndirectData = Buffer.from([0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04]); // 1.3.6.1.4.1.311.2.1.4
    const oidSha256 = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]); // 2.16.840.1.101.3.4.2.1
    const oidEcdsaSha256 = Buffer.from([0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2

    // Build SpcIndirectDataContent
    //   SpcAttributeTypeAndOptionalValue: OID for SPC_PE_IMAGE_DATAOBJ (1.3.6.1.4.1.311.2.1.15)
    //   DigestInfo: algorithm SHA-256 + digest value
    const oidSpcPeImage = Buffer.from([0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0F]); // 1.3.6.1.4.1.311.2.1.15

    // SpcPeImageData (minimal: flags=0, no file link)
    const spcPeImageData = this._asn1Sequence([
      Buffer.from([0x03, 0x01, 0x00]), // BIT STRING, flags = 0
      Buffer.concat([Buffer.from([0xA0, 0x02]), Buffer.from([0xA2, 0x00])]), // [0] EXPLICIT -> [2] IMPLICIT empty
    ]);

    const spcAttributeTypeAndValue = this._asn1Sequence([
      oidSpcPeImage,
      spcPeImageData,
    ]);

    const digestInfo = this._asn1Sequence([
      this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])]), // AlgorithmIdentifier
      Buffer.concat([Buffer.from([0x04, digest.length]), digest]), // OCTET STRING
    ]);

    const spcIndirectDataContent = this._asn1Sequence([
      spcAttributeTypeAndValue,
      digestInfo,
    ]);

    // Build SignerInfo
    const issuerAndSerialNumber = this._buildIssuerAndSerialNumber(x509Cert);
    const signerInfo = this._asn1Sequence([
      Buffer.from([0x02, 0x01, 0x01]), // version 1
      issuerAndSerialNumber,
      this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])]), // digestAlgorithm
      this._asn1Sequence([oidEcdsaSha256, Buffer.from([0x05, 0x00])]), // signatureAlgorithm
      Buffer.concat([Buffer.from([0x04, signature.length]), signature]), // signature OCTET STRING
    ]);

    // Build SignedData
    const signedData = this._asn1Sequence([
      Buffer.from([0x02, 0x01, 0x01]), // version 1
      this._asn1Set([this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])])]), // digestAlgorithms
      this._asn1Sequence([oidSpcIndirectData, this._asn1Explicit(0, spcIndirectDataContent)]), // contentInfo
      this._asn1Implicit(0, this._asn1Set([certDer])), // certificates [0] IMPLICIT
      this._asn1Set([signerInfo]), // signerInfos
    ]);

    // ContentInfo wrapper
    const contentInfo = this._asn1Sequence([
      oidSignedData,
      this._asn1Explicit(0, signedData),
    ]);

    return contentInfo;
  }

  /** Name of a Mach-O CPU type as printed by lipo, or its hex value */
  _machoArchName(cpuType: number): string {
    switch (cpuType >>> 0) {
      case 0x0100000c:
        return "arm64";
      case 0x01000007:
        return "x86_64";
      default:
        return "0x" + (cpuType >>> 0).toString(16);
    }
  }

  /**
   * Upper bound, in bytes, of the DER CMS that _buildMachOCms produces for this
   * key and certificate. The CMS does not contain the CodeDirectory, so it is
   * built once from a placeholder and an all-zero signature of the longest
   * length the key can give, plus 16 bytes for the length encodings. Falls back
   * to 8192 when no bound can be established.
   */
  _cmsCapacityFor(certPem: string, privateKey: crypto.KeyObject): number {
    const fallback = 8192;
    try {
      let maxSignature = 0;
      const details = privateKey.asymmetricKeyDetails;
      if (privateKey.asymmetricKeyType === "ec") {
        const curve = details?.namedCurve;
        const bits: Record<string, number> = {
          prime256v1: 256,
          secp256k1: 256,
          secp384r1: 384,
          secp521r1: 521,
        };
        const orderBits = curve ? bits[curve] : undefined;
        if (orderBits) {
          maxSignature = 2 * Math.ceil(orderBits / 8) + 9;
        }
      } else if (privateKey.asymmetricKeyType === "rsa" && details?.modulusLength) {
        maxSignature = Math.ceil(details.modulusLength / 8);
      }
      if (maxSignature === 0) {
        return fallback;
      }
      const placeholder = this._buildMachOCms(Buffer.alloc(0), Buffer.alloc(maxSignature), certPem);
      return placeholder.length + 16;
    } catch {
      return fallback;
    }
  }

  /**
   * Build a minimal CMS SignedData for Mach-O code signing.
   * Uses id-data (1.2.840.113549.1.7.1) as eContentType, detached (no eContent).
   */
  _buildMachOCms(codeDirectory: Buffer, signature: Buffer, certPem: string): Buffer {
    const x509Cert = new x509.X509Certificate(certPem);
    const certDer = Buffer.from(x509Cert.rawData);

    const oidSignedData = Buffer.from([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02]); // 1.2.840.113549.1.7.2
    const oidData = Buffer.from([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x01]); // 1.2.840.113549.1.7.1
    const oidSha256 = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]); // 2.16.840.1.101.3.4.2.1
    const oidEcdsaSha256 = Buffer.from([0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2

    const issuerAndSerialNumber = this._buildIssuerAndSerialNumber(x509Cert);
    const signerInfo = this._asn1Sequence([
      Buffer.from([0x02, 0x01, 0x01]), // version 1
      issuerAndSerialNumber,
      this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])]), // digestAlgorithm
      this._asn1Sequence([oidEcdsaSha256, Buffer.from([0x05, 0x00])]), // signatureAlgorithm
      Buffer.concat([Buffer.from([0x04]), this._asn1EncodeLength(signature.length), signature]), // signature OCTET STRING
    ]);

    // Detached SignedData — no eContent in contentInfo
    const signedData = this._asn1Sequence([
      Buffer.from([0x02, 0x01, 0x01]), // version 1
      this._asn1Set([this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])])]), // digestAlgorithms
      this._asn1Sequence([oidData]), // contentInfo (detached: just OID, no content)
      this._asn1Implicit(0, this._asn1Set([certDer])), // certificates [0] IMPLICIT
      this._asn1Set([signerInfo]), // signerInfos
    ]);

    const contentInfo = this._asn1Sequence([
      oidSignedData,
      this._asn1Explicit(0, signedData),
    ]);

    return contentInfo;
  }

  /**
   * Build a minimal CMS/PKCS#7 SignedData for MSI Authenticode.
   * Uses SpcIndirectDataContent (1.3.6.1.4.1.311.2.1.4) as eContentType
   * with SpcSipInfo (1.3.6.1.4.1.311.2.1.30) as the data type.
   * The SIP class GUID for MSI is {000C10F1-0000-0000-C000-000000000046}.
   */
  _buildMsiCms(digest: Buffer, signature: Buffer, certPem: string): Buffer {
    const x509Cert = new x509.X509Certificate(certPem);
    const certDer = Buffer.from(x509Cert.rawData);

    // OIDs
    const oidSignedData = Buffer.from([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02]); // 1.2.840.113549.1.7.2
    const oidSpcIndirectData = Buffer.from([0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04]); // 1.3.6.1.4.1.311.2.1.4
    const oidSha256 = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]); // 2.16.840.1.101.3.4.2.1
    const oidEcdsaSha256 = Buffer.from([0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2
    const oidSpcSipInfo = Buffer.from([0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x1E]); // 1.3.6.1.4.1.311.2.1.30

    // MSI SIP class GUID: {000C10F1-0000-0000-C000-000000000046}
    // Encoded in binary (mixed-endian Microsoft GUID format)
    const msiSipGuid = Buffer.from([
      0xF1, 0x10, 0x0C, 0x00,  // Data1 LE
      0x00, 0x00,                // Data2 LE
      0x00, 0x00,                // Data3 LE
      0xC0, 0x00,                // Data4[0..1]
      0x00, 0x00, 0x00, 0x00, 0x00, 0x46, // Data4[2..7]
    ]);

    // Build SpcSipInfo SEQUENCE: { a INTEGER, uuid OCTET STRING, b-f INTEGERs }
    const spcSipInfoValue = this._asn1Sequence([
      Buffer.from([0x02, 0x03, 0x01, 0x00, 0x00]), // INTEGER 65536 (0x010000)
      Buffer.concat([Buffer.from([0x04, msiSipGuid.length]), msiSipGuid]), // OCTET STRING (GUID)
      Buffer.from([0x02, 0x01, 0x00]), // INTEGER 0
      Buffer.from([0x02, 0x01, 0x00]), // INTEGER 0
      Buffer.from([0x02, 0x01, 0x00]), // INTEGER 0
      Buffer.from([0x02, 0x01, 0x00]), // INTEGER 0
    ]);

    const spcAttributeTypeAndValue = this._asn1Sequence([
      oidSpcSipInfo,
      spcSipInfoValue,
    ]);

    const digestInfo = this._asn1Sequence([
      this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])]), // AlgorithmIdentifier
      Buffer.concat([Buffer.from([0x04, digest.length]), digest]), // OCTET STRING
    ]);

    const spcIndirectDataContent = this._asn1Sequence([
      spcAttributeTypeAndValue,
      digestInfo,
    ]);

    // Build SignerInfo
    const issuerAndSerialNumber = this._buildIssuerAndSerialNumber(x509Cert);
    const signerInfo = this._asn1Sequence([
      Buffer.from([0x02, 0x01, 0x01]), // version 1
      issuerAndSerialNumber,
      this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])]), // digestAlgorithm
      this._asn1Sequence([oidEcdsaSha256, Buffer.from([0x05, 0x00])]), // signatureAlgorithm
      Buffer.concat([Buffer.from([0x04, signature.length]), signature]), // signature OCTET STRING
    ]);

    // Build SignedData
    const signedData = this._asn1Sequence([
      Buffer.from([0x02, 0x01, 0x01]), // version 1
      this._asn1Set([this._asn1Sequence([oidSha256, Buffer.from([0x05, 0x00])])]), // digestAlgorithms
      this._asn1Sequence([oidSpcIndirectData, this._asn1Explicit(0, spcIndirectDataContent)]), // contentInfo
      this._asn1Implicit(0, this._asn1Set([certDer])), // certificates [0] IMPLICIT
      this._asn1Set([signerInfo]), // signerInfos
    ]);

    // ContentInfo wrapper
    const contentInfo = this._asn1Sequence([
      oidSignedData,
      this._asn1Explicit(0, signedData),
    ]);

    return contentInfo;
  }

  /**
   * Build IssuerAndSerialNumber from an X.509 certificate for CMS SignerInfo.
   */
  _buildIssuerAndSerialNumber(cert: x509.X509Certificate): Buffer {
    // Parse from the certificate's TBS to extract issuer and serial
    const rawData = Buffer.from(cert.rawData);
    // Extract serial number from cert
    const serialHex = cert.serialNumber;
    const serialBytes = Buffer.from(serialHex, "hex");
    const serialAsn1 = Buffer.concat([
      Buffer.from([0x02, serialBytes.length]),
      serialBytes,
    ]);

    // Extract issuer Name from the TBS certificate
    // The issuer is the same as subject for self-signed certs
    const issuerDer = this._extractIssuerFromCert(rawData);

    return this._asn1Sequence([issuerDer, serialAsn1]);
  }

  /**
   * Extract the issuer Name DER from a certificate's raw DER encoding.
   */
  _extractIssuerFromCert(certDer: Buffer): Buffer {
    // Parse outer SEQUENCE
    let offset = 0;
    if (certDer[offset] !== 0x30) throw new Error("Not a valid certificate");
    offset++;
    const { length: outerLen, bytesRead: outerLenBytes } = this._asn1ReadLength(certDer, offset);
    offset += outerLenBytes;

    // TBSCertificate SEQUENCE
    if (certDer[offset] !== 0x30) throw new Error("Not a valid TBSCertificate");
    offset++;
    const { length: tbsLen, bytesRead: tbsLenBytes } = this._asn1ReadLength(certDer, offset);
    offset += tbsLenBytes;

    // version [0] EXPLICIT (optional)
    if (certDer[offset] === 0xA0) {
      offset++;
      const { length: vLen, bytesRead: vLenBytes } = this._asn1ReadLength(certDer, offset);
      offset += vLenBytes + vLen;
    }

    // serialNumber INTEGER
    if (certDer[offset] !== 0x02) throw new Error("Expected INTEGER for serial");
    offset++;
    const { length: serialLen, bytesRead: serialLenBytes } = this._asn1ReadLength(certDer, offset);
    offset += serialLenBytes + serialLen;

    // signature AlgorithmIdentifier SEQUENCE
    if (certDer[offset] !== 0x30) throw new Error("Expected SEQUENCE for algorithm");
    offset++;
    const { length: algLen, bytesRead: algLenBytes } = this._asn1ReadLength(certDer, offset);
    offset += algLenBytes + algLen;

    // issuer Name SEQUENCE
    const issuerStart = offset;
    if (certDer[offset] !== 0x30) throw new Error("Expected SEQUENCE for issuer");
    offset++;
    const { length: issuerContentLen, bytesRead: issuerLenBytes } = this._asn1ReadLength(certDer, offset);
    offset += issuerLenBytes + issuerContentLen;
    const issuerEnd = offset;

    return certDer.subarray(issuerStart, issuerEnd);
  }

  /** Read ASN.1 length field, returning the length value and how many bytes the length field occupies */
  _asn1ReadLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
    const first = buf[offset];
    if (first < 0x80) {
      return { length: first, bytesRead: 1 };
    }
    const numBytes = first & 0x7F;
    let length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | buf[offset + 1 + i];
    }
    return { length, bytesRead: 1 + numBytes };
  }

  /** Encode ASN.1 length */
  _asn1EncodeLength(length: number): Buffer {
    if (length < 0x80) {
      return Buffer.from([length]);
    }
    const bytes: number[] = [];
    let temp = length;
    while (temp > 0) {
      bytes.unshift(temp & 0xFF);
      temp >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  }

  /** Build ASN.1 SEQUENCE */
  _asn1Sequence(items: Buffer[]): Buffer {
    const content = Buffer.concat(items);
    return Buffer.concat([Buffer.from([0x30]), this._asn1EncodeLength(content.length), content]);
  }

  /** Build ASN.1 SET */
  _asn1Set(items: Buffer[]): Buffer {
    const content = Buffer.concat(items);
    return Buffer.concat([Buffer.from([0x31]), this._asn1EncodeLength(content.length), content]);
  }

  /** Build ASN.1 EXPLICIT tagged value */
  _asn1Explicit(tag: number, value: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0xA0 | tag]), this._asn1EncodeLength(value.length), value]);
  }

  /** Build ASN.1 IMPLICIT tagged wrapper (replaces outer tag of content) */
  _asn1Implicit(tag: number, value: Buffer): Buffer {
    // Replace the outer tag byte of value with the implicit tag
    const result = Buffer.alloc(value.length);
    value.copy(result);
    result[0] = 0xA0 | tag;
    return result;
  }

  /**
   * Sign a single binary file. Detects format and dispatches to
   * signFileAuthenticode/signFileMachO/existing detached signing.
   * @param scope - The scope whose certificate to use for signing
   * @throws if no certificate, certificate expired (and force=false), or file is not binary
   */
  async signFile(filePath: string, options?: SignOptions): Promise<SignResult> {
    if (!options?.scope) {
      throw new Error("A scope must be specified for signing.");
    }
    const scope = options.scope;
    const certPath = this.scopeCertPath(scope);
    const keyPath = this.scopeKeyPath(scope);
    const certInfo = this.getCertInfo(scope);
    if (!certInfo) {
      throw new Error(`No signing certificate found for scope '${scope}'. Run 'the-seed signing create-cert' first.`);
    }
    if (certInfo.isExpired && !options?.force) {
      throw new Error("Signing certificate is expired. Use --force to sign anyway.");
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const binary = await this.isBinaryFile(resolvedPath);
    if (!binary) {
      throw new Error(`File is not binary: ${resolvedPath}`);
    }

    // Check write permission (FR-013)
    try {
      fs.accessSync(resolvedPath, fs.constants.W_OK);
    } catch {
      throw new Error(`Cannot sign read-only file: ${resolvedPath}. Set write permission (chmod +w) before signing.`);
    }

    // Detect format and determine signing strategy
    const strategy = this.getSigningStrategy(resolvedPath, options);

    if (strategy === "embedded") {
      const detection = this.detectBinaryFormat(resolvedPath);
      if (detection.format === "pe") {
        return this.signFileAuthenticode(resolvedPath, scope);
      } else if (detection.format === "macho") {
        return this.signFileMachO(resolvedPath, scope);
      } else if (detection.format === "msi") {
        return this.signFileMsi(resolvedPath, scope);
      }
    }

    // Detached signing (original behavior)
    const certPem = fs.readFileSync(certPath, "utf-8");
    const keyPem = fs.readFileSync(keyPath, "utf-8");
    const privateKey = crypto.createPrivateKey(keyPem);

    // Stream file through crypto.createSign
    const sign = crypto.createSign("SHA256");
    await pipeline(createReadStream(resolvedPath), sign);
    const signature = sign.sign(privateKey);

    // Create .sig file
    const sigData: SigFileFormat = {
      version: 1,
      algorithm: "SHA256",
      curve: "P-256",
      signature: signature.toString("base64"),
      certificate: certPem,
    };

    const signaturePath = resolvedPath + ".sig";
    fs.writeFileSync(signaturePath, JSON.stringify(sigData, null, 2));

    return {
      filePath: resolvedPath,
      signaturePath,
      fingerprint: certInfo.fingerprint,
      signatureType: "detached",
      warnings: [],
    };
  }

  /**
   * Sign all binary files in a directory. Produces .sig files and .signatures.json manifest.
   * Uses format-aware signing per file (v2 manifest with signatureType per entry).
   * @param scope - The scope whose certificate to use for signing
   * @throws if no certificate or certificate expired (and force=false)
   */
  async signDirectory(dirPath: string, options?: SignOptions): Promise<DirectorySignResult> {
    if (!options?.scope) {
      throw new Error("A scope must be specified for signing.");
    }
    const scope = options.scope;
    const certPath = this.scopeCertPath(scope);
    const certInfo = this.getCertInfo(scope);
    if (!certInfo) {
      throw new Error(`No signing certificate found for scope '${scope}'. Run 'the-seed signing create-cert' first.`);
    }
    if (certInfo.isExpired && !options?.force) {
      throw new Error("Signing certificate is expired. Use --force to sign anyway.");
    }

    const resolvedDir = path.resolve(dirPath);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }

    // Recursively find all files
    const allFiles = this._findFilesRecursive(resolvedDir);

    const signed: SignResult[] = [];
    const skipped: string[] = [];

    for (const filePath of allFiles) {
      // Skip .sig files and .signatures.json
      const basename = path.basename(filePath);
      if (basename.endsWith(".sig") || basename === ".signatures.json") {
        continue;
      }

      const binary = await this.isBinaryFile(filePath);
      if (!binary) {
        skipped.push(path.relative(resolvedDir, filePath));
        continue;
      }

      const result = await this.signFile(filePath, options);
      signed.push(result);
    }

    if (signed.length === 0) {
      throw new Error("No binary files found in directory.");
    }

    // Generate v2 .signatures.json manifest
    const certPem = fs.readFileSync(certPath, "utf-8");
    const manifestEntries: SigningManifestEntry[] = signed.map((s) => {
      if (s.signatureType === "embedded") {
        // For embedded signatures, read the embedded signature and base64 encode it
        // Use a SHA-256 hash of the file as the signature field for manifest purposes
        const fileHash = crypto.createHash("sha256").update(fs.readFileSync(s.filePath)).digest("base64");
        return {
          path: path.relative(resolvedDir, s.filePath),
          signatureFile: null,
          algorithm: "SHA256" as const,
          signature: fileHash,
          signatureType: "embedded" as const,
        };
      } else {
        // Detached: read from .sig file
        const sigData: SigFileFormat = JSON.parse(fs.readFileSync(s.signaturePath!, "utf-8"));
        return {
          path: path.relative(resolvedDir, s.filePath),
          signatureFile: path.relative(resolvedDir, s.signaturePath!),
          algorithm: "SHA256" as const,
          signature: sigData.signature,
          signatureType: "detached" as const,
        };
      }
    });

    const manifest: SigningManifestFormat = {
      version: 2,
      signedAt: new Date().toISOString(),
      certificate: certPem,
      certificateFingerprint: certInfo.fingerprint,
      files: manifestEntries,
    };

    const manifestPath = path.join(resolvedDir, ".signatures.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      manifestPath,
      signed,
      skipped,
    };
  }

  /**
   * Export public certificate (without private key) to a file.
   * @throws if no certificate exists for the given scope
   */
  async exportCert(outputPath: string, scope?: string): Promise<void> {
    if (!scope) {
      throw new Error("A scope must be specified for certificate export.");
    }
    if (!this.hasCert(scope)) {
      throw new Error(`No signing certificate found for scope '${scope}'.`);
    }
    const certPem = fs.readFileSync(this.scopeCertPath(scope), "utf-8");
    fs.writeFileSync(outputPath, certPem);
  }

  /**
   * Import an existing PEM certificate and private key for a scope.
   * Validates that key matches certificate and key is ECDSA P-256.
   * @throws if cert/key mismatch or unsupported key type
   */
  async importCert(certInputPath: string, keyInputPath: string, scope?: string): Promise<CertInfo> {
    if (!scope) {
      throw new Error("A scope must be specified for certificate import.");
    }

    // Read and parse certificate
    const certPem = fs.readFileSync(certInputPath, "utf-8");
    const x509Cert = new crypto.X509Certificate(certPem);

    // Read and parse private key
    const keyPem = fs.readFileSync(keyInputPath, "utf-8");
    const privateKey = crypto.createPrivateKey(keyPem);
    // x509Cert.publicKey is already a KeyObject of type 'public'
    const publicKey = x509Cert.publicKey;

    // Validate key type is ECDSA P-256
    if (publicKey.asymmetricKeyType !== "ec") {
      throw new Error("Unsupported key type. Only ECDSA keys are supported.");
    }
    const details = publicKey.asymmetricKeyDetails;
    if (!details || details.namedCurve !== "prime256v1") {
      throw new Error("Unsupported curve. Only P-256 (prime256v1) is supported.");
    }

    // Validate key matches certificate by signing and verifying test data
    const testData = Buffer.from("key-match-test");
    const sign = crypto.createSign("SHA256");
    sign.update(testData);
    const testSig = sign.sign(privateKey);

    const verify = crypto.createVerify("SHA256");
    verify.update(testData);
    if (!verify.verify(publicKey, testSig)) {
      throw new Error("Certificate and key do not match.");
    }

    // Ensure scope signing directory exists
    const scopeDir = path.join(this.signingDir, scope);
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }

    // Copy certificate and key
    const certPath = this.scopeCertPath(scope);
    const keyPath = this.scopeKeyPath(scope);
    fs.writeFileSync(certPath, certPem, { mode: 0o644 });
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    this._setOwnerOnly(keyPath);

    return this.getCertInfo(scope)!;
  }

  /**
   * Recursively find all files in a directory.
   */
  _findFilesRecursive(dirPath: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...this._findFilesRecursive(fullPath));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  }

  /**
   * Assemble a file verification result: the integrity found by the form's check, trust evaluated against the
   * given certificates when a signer is known, and the status derived from the two.
   * `signerDer` is undefined when the signer is not known (nothing readable), null for a signature without a signer.
   */
  _buildVerifyResult(
    filePath: string,
    form: SignatureForm,
    signatureType: SignatureType,
    integrity: IntegrityResult,
    signerDer: Buffer | null | undefined,
    trust: TrustedCertificates,
    extra: { slices?: MachOSliceResult[]; warnings?: string[]; notChecked?: string[] } = {}
  ): VerifyResult {
    let trustResult: TrustResult = { state: "not-applicable" };
    if (integrity.state === "intact" || (integrity.state === "invalid" && signerDer !== undefined)) {
      trustResult = evaluateTrust(signerDer ?? null, trust);
    }
    const status = outcomeOf(integrity, trustResult);
    const result: VerifyResult = {
      filePath,
      status,
      form,
      signatureType,
      integrity,
      trust: trustResult,
      warnings: [...trust.warnings, ...(extra.warnings ?? [])],
      notChecked: [...NOT_CHECKED_ALWAYS, ...(extra.notChecked ?? [])],
    };
    if (status === "UNTRUSTED") {
      result.reason = trustResult.message;
    } else if (status !== "VALID") {
      result.reason = integrity.reason;
    }
    if (signerDer) {
      result.signer = this._buildSignerInfo(new crypto.X509Certificate(signerDer));
    }
    if (extra.slices !== undefined) {
      result.slices = extra.slices;
    }
    return result;
  }

  /** A result for a file that has no signature of the form asked for. */
  _buildNotFoundResult(filePath: string, reason: string, trust: TrustedCertificates): VerifyResult {
    return {
      filePath,
      status: "NOT_FOUND",
      reason,
      integrity: { state: "none", reason, checked: [] },
      trust: { state: "not-applicable" },
      warnings: [...trust.warnings],
      notChecked: [...NOT_CHECKED_ALWAYS],
    };
  }

  /**
   * Verify a single file's signature.
   * Checks for embedded signature first (PE/Mach-O/MSI), falls back to detached .sig.
   * Warns if both embedded and detached exist (FR-008).
   * Trust is evaluated against options.trust, or the certificates of the configured scopes.
   */
  async verifyFile(filePath: string, options?: VerifyOptions): Promise<VerifyResult> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const resolvedOptions: VerifyOptions = { trust: options?.trust ?? this.loadTrust() };
    const warnings: string[] = [];
    const detection = this.detectBinaryFormat(resolvedPath);

    // Check for embedded signature
    let hasEmbedded = false;
    try {
      const addon = loadNativeAddon();
      if (detection.format === "pe") {
        hasEmbedded = addon.peHasEmbeddedSignature(resolvedPath);
      } else if (detection.format === "macho") {
        // Any signed slice makes the signature embedded; a program whose slices are all unsigned has none
        hasEmbedded = addon.machoListSlices(resolvedPath).some((slice) => slice.isSigned);
      } else if (detection.format === "msi") {
        hasEmbedded = addon.msiHasEmbeddedSignature(resolvedPath);
      }
    } catch {
      // Native addon not available, fall through to detached
    }

    const sigPath = resolvedPath + ".sig";
    const hasDetached = fs.existsSync(sigPath);

    // Warn if both exist (FR-008)
    if (hasEmbedded && hasDetached) {
      warnings.push("Both embedded and detached signatures found; verifying embedded");
    }

    // Prefer embedded if present
    if (hasEmbedded) {
      let result: VerifyResult | undefined;
      if (detection.format === "pe") {
        result = await this.verifyFileAuthenticode(resolvedPath, resolvedOptions);
      } else if (detection.format === "macho") {
        result = await this.verifyFileMachO(resolvedPath, resolvedOptions);
      } else if (detection.format === "msi") {
        result = await this.verifyFileMsi(resolvedPath, resolvedOptions);
      }
      if (result !== undefined) {
        result.warnings = [...result.warnings, ...warnings];
        return result;
      }
    }

    // Fall back to detached .sig verification
    return this._verifyFileDetached(resolvedPath, resolvedOptions);
  }

  /**
   * Verify a detached .sig file (original behavior).
   */
  async _verifyFileDetached(resolvedPath: string, options?: VerifyOptions): Promise<VerifyResult> {
    const trust = options?.trust ?? this.loadTrust();
    const sigPath = resolvedPath + ".sig";
    if (!fs.existsSync(sigPath)) {
      return this._buildNotFoundResult(resolvedPath, `No signature file found (${sigPath} does not exist)`, trust);
    }

    const damaged = (reason: string): VerifyResult =>
      this._buildVerifyResult(resolvedPath, "detached", "detached", { state: "invalid", reason, checked: [] }, undefined, trust);

    let sigData: SigFileFormat;
    try {
      sigData = JSON.parse(fs.readFileSync(sigPath, "utf-8"));
    } catch {
      return damaged("Signature file is malformed (invalid JSON)");
    }

    if (sigData.version !== 1 || !sigData.signature || !sigData.certificate) {
      return damaged("Signature file has invalid format");
    }

    // Extract public key from embedded certificate
    let x509Cert: crypto.X509Certificate;
    try {
      x509Cert = new crypto.X509Certificate(sigData.certificate);
    } catch {
      return damaged("Embedded certificate is invalid");
    }

    const publicKey = x509Cert.publicKey;

    // Verify signature by streaming file
    const verify = crypto.createVerify("SHA256");
    await pipeline(createReadStream(resolvedPath), verify);
    const isValid = verify.verify(publicKey, Buffer.from(sigData.signature, "base64"));

    const integrity: IntegrityResult = isValid
      ? { state: "intact", checked: ["signature over the whole file"] }
      : { state: "invalid", reason: "File content has been modified after signing", checked: ["signature over the whole file"] };
    return this._buildVerifyResult(resolvedPath, "detached", "detached", integrity, x509Cert.raw, trust);
  }

  /**
   * Verify an embedded Authenticode signature in a PE file.
   */
  async verifyFileAuthenticode(filePath: string, options?: VerifyOptions): Promise<VerifyResult> {
    const resolvedPath = path.resolve(filePath);
    const trust = options?.trust ?? this.loadTrust();
    const failed = (reason: string, signerDer?: Buffer): VerifyResult =>
      this._buildVerifyResult(resolvedPath, "windows-program", "embedded", { state: "invalid", reason, checked: [] }, signerDer, trust);

    try {
      const addon = loadNativeAddon();

      // Extract embedded signature
      const pkcs7Der = addon.peExtractSignature(resolvedPath);
      if (!pkcs7Der) {
        return this._buildNotFoundResult(resolvedPath, "No embedded Authenticode signature found", trust);
      }

      // Parse CMS to extract certificate and signature
      const cmsInfo = this._parseCmsSignedData(pkcs7Der);
      if (!cmsInfo) {
        return failed("Embedded Authenticode signature has invalid CMS structure");
      }

      // Recompute the Authenticode digest
      const digestResult = addon.peComputeDigest(resolvedPath);

      // Verify the ECDSA signature over the digest
      const x509Cert = new crypto.X509Certificate(cmsInfo.certPem);
      const publicKey = x509Cert.publicKey;

      const verify = crypto.createVerify("SHA256");
      verify.update(digestResult.digest);
      const isValid = verify.verify(publicKey, cmsInfo.signature);

      const checked = ["signature over the program's fingerprint"];
      const integrity: IntegrityResult = isValid
        ? { state: "intact", checked }
        : { state: "invalid", reason: "Embedded signature invalid: digest mismatch — file may have been modified after signing", checked };
      return this._buildVerifyResult(resolvedPath, "windows-program", "embedded", integrity, x509Cert.raw, trust);
    } catch (err) {
      return failed(`Failed to verify Authenticode signature: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Verify the embedded code signature of a Mach-O file, thin or universal: every slice is checked
   * (see MachOVerifier) and reported, and trust is evaluated for the one signer all slices share.
   */
  async verifyFileMachO(filePath: string, options?: VerifyOptions): Promise<VerifyResult> {
    const resolvedPath = path.resolve(filePath);
    const trust = options?.trust ?? this.loadTrust();

    try {
      const addon = loadNativeAddon();
      const slices = addon.machoListSlices(resolvedPath);
      const check = checkMachO(fs.readFileSync(resolvedPath), slices);
      if (check.integrity.state === "none") {
        return this._buildNotFoundResult(resolvedPath, "No embedded Mach-O code signature found", trust);
      }

      // An intact ad-hoc program has no signer (null); with damage found, the signer is known only if every slice agreed on one
      const signerDer = check.integrity.state === "intact" ? (check.signerCertificate ?? null) : check.signerCertificate;
      return this._buildVerifyResult(resolvedPath, "mac-program", "embedded", check.integrity, signerDer, trust, {
        slices: check.slices,
        warnings: check.warnings,
        notChecked: check.notChecked,
      });
    } catch (err) {
      const reason = `Failed to verify Mach-O signature: ${err instanceof Error ? err.message : String(err)}`;
      return this._buildVerifyResult(resolvedPath, "mac-program", "embedded", { state: "invalid", reason, checked: [] }, undefined, trust);
    }
  }

  /**
   * Verify an embedded Authenticode signature in an MSI file.
   */
  async verifyFileMsi(filePath: string, options?: VerifyOptions): Promise<VerifyResult> {
    const resolvedPath = path.resolve(filePath);
    const trust = options?.trust ?? this.loadTrust();
    const failed = (reason: string): VerifyResult =>
      this._buildVerifyResult(resolvedPath, "installer", "embedded", { state: "invalid", reason, checked: [] }, undefined, trust);

    try {
      const addon = loadNativeAddon();

      // Read the signature back and compare its fingerprint with the package
      const check = addon.msiCheckSignature(resolvedPath);
      if (check.state === "none") {
        return this._buildNotFoundResult(resolvedPath, "No embedded MSI Authenticode signature found", trust);
      }
      if (check.state === "mismatch") {
        return failed("signature present but does not match the package contents; the package may have been modified after signing");
      }
      if (check.state === "unreadable") {
        return failed(`signature present but could not be read (${check.detail})`);
      }

      // Extract embedded signature from \x05DigitalSignature stream
      const pkcs7Der = addon.msiExtractSignature(resolvedPath);
      if (!pkcs7Der) {
        return this._buildNotFoundResult(resolvedPath, "No embedded MSI Authenticode signature found", trust);
      }

      // Parse CMS to extract certificate and signature
      const cmsInfo = this._parseCmsSignedData(pkcs7Der);
      if (!cmsInfo) {
        return failed("Embedded MSI Authenticode signature has invalid CMS structure");
      }

      // Recompute the MSI Authenticode digest
      const digestResult = addon.msiComputeDigest(resolvedPath);

      // Verify the ECDSA signature over the digest
      const x509Cert = new crypto.X509Certificate(cmsInfo.certPem);
      const publicKey = x509Cert.publicKey;

      const verify = crypto.createVerify("SHA256");
      verify.update(digestResult.digest);
      const isValid = verify.verify(publicKey, cmsInfo.signature);

      const checked = ["the package's fingerprint against the signed one", "signature over the package's fingerprint"];
      const integrity: IntegrityResult = isValid
        ? { state: "intact", checked }
        : { state: "invalid", reason: "Embedded MSI signature invalid: digest mismatch — file may have been modified after signing", checked };
      return this._buildVerifyResult(resolvedPath, "installer", "embedded", integrity, x509Cert.raw, trust);
    } catch (err) {
      return failed(`Failed to verify MSI Authenticode signature: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Parse a CMS/PKCS#7 SignedData blob to extract the certificate and signature.
   * Returns null if parsing fails.
   */
  _parseCmsSignedData(der: Buffer): { certPem: string; signature: Buffer } | null {
    try {
      // Basic ASN.1 DER parsing for CMS ContentInfo → SignedData
      let offset = 0;

      // Outer SEQUENCE (ContentInfo)
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: ciLen, bytesRead: ciLenBytes } = this._asn1ReadLength(der, offset);
      offset += ciLenBytes;

      // OID (should be signedData 1.2.840.113549.1.7.2)
      if (der[offset] !== 0x06) return null;
      const oidLen = der[offset + 1];
      offset += 2 + oidLen;

      // [0] EXPLICIT containing SignedData
      if ((der[offset] & 0xF0) !== 0xA0) return null;
      offset++;
      const { length: sdWrapLen, bytesRead: sdWrapLenBytes } = this._asn1ReadLength(der, offset);
      offset += sdWrapLenBytes;

      // SignedData SEQUENCE
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: sdLen, bytesRead: sdLenBytes } = this._asn1ReadLength(der, offset);
      offset += sdLenBytes;

      // version INTEGER
      if (der[offset] !== 0x02) return null;
      offset += 2 + der[offset + 1];

      // digestAlgorithms SET
      if (der[offset] !== 0x31) return null;
      offset++;
      const { length: daLen, bytesRead: daLenBytes } = this._asn1ReadLength(der, offset);
      offset += daLenBytes + daLen;

      // contentInfo SEQUENCE
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: encapLen, bytesRead: encapLenBytes } = this._asn1ReadLength(der, offset);
      offset += encapLenBytes + encapLen;

      // certificates [0] IMPLICIT
      if ((der[offset] & 0xF0) !== 0xA0) return null;
      offset++;
      const { length: certsLen, bytesRead: certsLenBytes } = this._asn1ReadLength(der, offset);
      offset += certsLenBytes;

      // First certificate within the SET wrapper
      const certSetStart = offset;
      // The first element should be a SET containing the cert
      if (der[offset] === 0x31) {
        offset++;
        const { bytesRead: setLenBytes } = this._asn1ReadLength(der, offset);
        offset += setLenBytes;
      }

      // Certificate SEQUENCE
      const certStart = offset;
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: certLen, bytesRead: certLenBytes } = this._asn1ReadLength(der, offset);
      offset += certLenBytes;
      const certEnd = offset + certLen;

      const certDer = der.subarray(certStart, certEnd);
      const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

      // Skip to signerInfos SET (after certificates)
      offset = certSetStart + certsLen;

      // signerInfos SET
      if (der[offset] !== 0x31) return null;
      offset++;
      const { length: siSetLen, bytesRead: siSetLenBytes } = this._asn1ReadLength(der, offset);
      offset += siSetLenBytes;

      // SignerInfo SEQUENCE
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: siLen, bytesRead: siLenBytes } = this._asn1ReadLength(der, offset);
      offset += siLenBytes;

      // version INTEGER
      if (der[offset] !== 0x02) return null;
      offset += 2 + der[offset + 1];

      // issuerAndSerialNumber SEQUENCE
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: isnLen, bytesRead: isnLenBytes } = this._asn1ReadLength(der, offset);
      offset += isnLenBytes + isnLen;

      // digestAlgorithm SEQUENCE
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: daAlgLen, bytesRead: daAlgLenBytes } = this._asn1ReadLength(der, offset);
      offset += daAlgLenBytes + daAlgLen;

      // signatureAlgorithm SEQUENCE
      if (der[offset] !== 0x30) return null;
      offset++;
      const { length: saLen, bytesRead: saLenBytes } = this._asn1ReadLength(der, offset);
      offset += saLenBytes + saLen;

      // signature OCTET STRING
      if (der[offset] !== 0x04) return null;
      offset++;
      const { length: sigLen, bytesRead: sigLenBytes } = this._asn1ReadLength(der, offset);
      offset += sigLenBytes;
      const signature = der.subarray(offset, offset + sigLen);

      return { certPem, signature: Buffer.from(signature) };
    } catch {
      return null;
    }
  }

  /**
   * Build CertInfo (signer info) from an X.509 certificate.
   */
  _buildSignerInfo(x509Cert: crypto.X509Certificate): CertInfo {
    const signerSubject = this._parseSubject(x509Cert.subject);
    const signerIssuer = this._parseIssuerString(x509Cert.issuer, x509Cert.subject);
    const signerFingerprint = "SHA256:" + x509Cert.fingerprint256.replace(/:/g, "").toLowerCase();
    const notBefore = new Date(x509Cert.validFrom);
    const notAfter = new Date(x509Cert.validTo);
    const now = new Date();

    return {
      subject: signerSubject,
      issuer: signerIssuer,
      fingerprint: signerFingerprint,
      keyType: this._keyTypeOf(x509Cert),
      notBefore,
      notAfter,
      isExpired: now > notAfter,
      isNotYetValid: now < notBefore,
      certPath: "",
    };
  }

  /**
   * Describe the public key of a certificate: "ECDSA P-256", "ECDSA P-384", "RSA 2048", ...
   */
  _keyTypeOf(x509Cert: crypto.X509Certificate): string {
    const key = x509Cert.publicKey;
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType === "ec") {
      const curves: Record<string, string> = { prime256v1: "P-256", secp256r1: "P-256", secp384r1: "P-384", secp521r1: "P-521" };
      const curve = details?.namedCurve ?? "";
      return "ECDSA " + (curves[curve] ?? curve);
    }
    if (key.asymmetricKeyType === "rsa") {
      return "RSA " + String(details?.modulusLength ?? "");
    }
    return String(key.asymmetricKeyType);
  }

  /**
   * Verify all files in a signed directory using .signatures.json manifest.
   * Handles both v1 (detached only) and v2 (mixed) manifests.
   */
  async verifyDirectory(dirPath: string, options?: VerifyOptions): Promise<DirectoryVerifyResult> {
    const resolvedDir = path.resolve(dirPath);
    const manifestPath = path.join(resolvedDir, ".signatures.json");

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No .signatures.json manifest found in ${resolvedDir}`);
    }

    let manifest: SigningManifestFormat;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      throw new Error("Manifest file .signatures.json is malformed");
    }

    const resolvedOptions: VerifyOptions = { trust: options?.trust ?? this.loadTrust() };
    const results: VerifyResult[] = [];
    let passed = 0;
    let failed = 0;
    let notFound = 0;

    for (const entry of manifest.files) {
      const filePath = path.join(resolvedDir, entry.path);

      // For v2 manifests, use signatureType to determine verification method
      // For v1 manifests (no signatureType field), default to detached
      const sigType = (entry as SigningManifestEntry).signatureType || "detached";

      let result: VerifyResult;
      if (sigType === "embedded") {
        result = await this.verifyFile(filePath, resolvedOptions);
      } else {
        result = await this._verifyFileDetached(filePath, resolvedOptions);
      }
      results.push(result);

      switch (result.status) {
        case "VALID":
          passed++;
          break;
        case "NOT_FOUND":
          notFound++;
          break;
        default:
          failed++;
      }
    }

    return {
      results,
      passed,
      failed,
      notFound,
      overallPass: failed === 0 && notFound === 0,
    };
  }
}

export default Signing;
