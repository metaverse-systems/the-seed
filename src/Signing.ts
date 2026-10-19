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
import { buildSignatureContainer, containerCapacity } from "./CmsBuilder";
import { EARLIER_FORM_NOTICE_WINDOWS, NOT_CHECKED_ALWAYS, certificateFingerprint, evaluateTrust, outcomeOf, readCertificates, worst } from "./Trust";
import { MachOSliceInfo, checkMachO } from "./MachOVerifier";
import { CmsDamaged, CmsUnsupported, OID, findSignerCertificate, readSignedData, readSpcDigest, verifySignerSignature } from "./CmsReader";
import {
  CertInfo,
  CertOptions,
  CertSubject,
  SignResult,
  DirectorySignResult,
  VerifyResult,
  DirectoryVerifyResult,
  DirectoryFileResult,
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
  VerifyStatus,
} from "./types";

/** Raised when a scope's key cannot be used for signing; no file has been changed. */
export class UnsupportedSigningKey extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSigningKey";
  }
}

/** The reason given for a listed file that is not in the directory. */
export const MISSING_FILE_REASON = "the file is missing";

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
   * The scope's private key, checked to be an ECDSA P-256 key matching the scope's certificate. Signing calls this
   * first, so a key the tool cannot sign with is refused before any file is changed.
   * @throws UnsupportedSigningKey when the key cannot be read, is not ECDSA P-256 or does not match the certificate
   */
  loadSigningKey(scope: string): crypto.KeyObject {
    const keyPath = this.scopeKeyPath(scope);
    const refuse = (what: string): never => {
      throw new UnsupportedSigningKey(`Cannot sign with scope '${scope}': ${what} No file was changed.`);
    };
    let key: crypto.KeyObject;
    try {
      key = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf-8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return refuse(`its key file ${keyPath} cannot be read (${reason}); only ECDSA P-256 keys are supported.`);
    }

    const curveNames: Record<string, string> = { prime256v1: "P-256", secp384r1: "P-384", secp521r1: "P-521" };
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
      let kind: string;
      switch (key.asymmetricKeyType) {
        case "rsa":
          kind = `RSA (${key.asymmetricKeyDetails?.modulusLength}-bit)`;
          break;
        case "ec":
          kind = `ECDSA ${curveNames[curve ?? ""] ?? curve}`;
          break;
        case "ed25519":
          kind = "Ed25519";
          break;
        case "ed448":
          kind = "Ed448";
          break;
        case "dsa":
          kind = "DSA";
          break;
        default:
          kind = String(key.asymmetricKeyType) === "dh" ? "DH" : String(key.asymmetricKeyType);
      }
      return refuse(`its key is ${kind}; only ECDSA P-256 keys are supported.`);
    }

    const certificate = new crypto.X509Certificate(fs.readFileSync(this.scopeCertPath(scope)));
    const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
    const certSpki = certificate.publicKey.export({ type: "spki", format: "der" });
    if (!Buffer.from(spki).equals(Buffer.from(certSpki))) {
      return refuse(
        "its key (ECDSA P-256) does not match the scope's certificate; only an ECDSA P-256 key matching the certificate is supported.",
      );
    }
    return key;
  }

  /**
   * Sign a PE file by embedding an Authenticode signature in the standard container (CMS SignedData with signed
   * attributes and a program-image data record) that other Authenticode verifiers accept. The container is built by
   * buildSignatureContainer; the native addon computes the digest and embeds the result, replacing any earlier
   * signature. Works for any certificate the scope holds.
   * @param key - The scope's signing key when the caller already loaded it; otherwise loadSigningKey is used
   * @throws if file is not a valid PE binary, or UnsupportedSigningKey before any change
   */
  async signFileAuthenticode(filePath: string, scope: string, key?: crypto.KeyObject): Promise<SignResult> {
    const resolvedPath = path.resolve(filePath);
    const certPath = this.scopeCertPath(scope);
    const privateKey = key ?? this.loadSigningKey(scope);
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

    // Build the standard-form container over the file's Authenticode digest
    const certPem = fs.readFileSync(certPath, "utf-8");
    const certDer = Buffer.from(new x509.X509Certificate(certPem).rawData);
    const pkcs7Der = buildSignatureContainer(
      { kind: "windows-program", fingerprint: Buffer.from(digestResult.digest) },
      certDer,
      (data) => crypto.sign("sha256", data, privateKey),
    );

    // Embed signature into PE file via native addon
    addon.peEmbedSignature(resolvedPath, Buffer.from(pkcs7Der));

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
   * Sign a Mach-O file by embedding a code signature whose container is a standard CMS SignedData with signed
   * attributes over each slice's code directory, built by buildSignatureContainer. Handles single-arch and
   * universal (fat) binaries; each slice is signed on its own.
   * @param key - The scope's signing key when the caller already loaded it; otherwise loadSigningKey is used
   * @throws if file is not a valid Mach-O binary, or UnsupportedSigningKey before any change
   */
  async signFileMachO(filePath: string, scope: string, key?: crypto.KeyObject): Promise<SignResult> {
    const resolvedPath = path.resolve(filePath);
    const certPath = this.scopeCertPath(scope);
    const privateKey = key ?? this.loadSigningKey(scope);
    const certInfo = this.getCertInfo(scope)!;
    const warnings: string[] = [];

    const addon = loadNativeAddon();

    // Check for existing signature
    if (addon.machoHasEmbeddedSignature(resolvedPath)) {
      warnings.push("Replaced existing embedded signature");
    }

    // Use cert CN as code signing identity
    const identity = certInfo.subject.commonName || "the-seed";

    const certPem = fs.readFileSync(certPath, "utf-8");

    // Reserve room for the container of any slice, then let the library compute
    // the CodeDirectory of every slice for the file as it will be after signing
    const certDer = Buffer.from(new x509.X509Certificate(certPem).rawData);
    const capacity = containerCapacity(certDer);
    const prepared = addon.machoPrepareSignature(resolvedPath, identity, capacity);

    // One standard-form container per slice, over that slice's CodeDirectory
    const cmsSignatures = prepared.slices.map((slice) => {
      const container = buildSignatureContainer(
        { kind: "mac-program", codeDirectory: Buffer.from(slice.codeDirectory) },
        certDer,
        (data) => crypto.sign("sha256", data, privateKey),
      );
      if (container.length > capacity) {
        throw new Error(
          `${resolvedPath}: the signature container (${container.length} bytes) does not fit the room reserved for it (${capacity} bytes)`
        );
      }
      return container;
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
   * Sign an MSI file by embedding an Authenticode signature in the standard container (CMS SignedData with signed
   * attributes and an installer data record), built by buildSignatureContainer. MSI files use the OLE Compound
   * Document format; the signature is stored in the \x05DigitalSignature stream by the native addon, which also
   * computes the package fingerprint. The stored signature is read back and its fingerprint compared.
   * @param key - The scope's signing key when the caller already loaded it; otherwise loadSigningKey is used
   * @throws if file is not a valid MSI/CFBF, or UnsupportedSigningKey before any change
   */
  async signFileMsi(filePath: string, scope: string, key?: crypto.KeyObject): Promise<SignResult> {
    const resolvedPath = path.resolve(filePath);
    const certPath = this.scopeCertPath(scope);
    const privateKey = key ?? this.loadSigningKey(scope);
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

    const certPem = fs.readFileSync(certPath, "utf-8");

    // Build the standard-form container over the package's fingerprint
    const certDer = Buffer.from(new x509.X509Certificate(certPem).rawData);
    const pkcs7Der = buildSignatureContainer(
      { kind: "installer", fingerprint: Buffer.from(digestResult.digest) },
      certDer,
      (data) => crypto.sign("sha256", data, privateKey),
    );

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
    warnings.push("Installer signature was read back: its fingerprint matches the package");

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
   * Sign a single binary file. Loads and checks the scope's key first, then detects the format and dispatches to
   * signFileAuthenticode, signFileMsi or signFileMachO (embedded, standard container) or writes a detached .sig file.
   * @param options.scope - The scope whose certificate to use for signing
   * @throws if no certificate, certificate expired (and force=false), file is not binary, or UnsupportedSigningKey
   * (nothing is changed in that case)
   */
  async signFile(filePath: string, options?: SignOptions): Promise<SignResult> {
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
    const privateKey = this.loadSigningKey(scope);

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const binary = await this.isBinaryFile(resolvedPath);
    if (!binary) {
      throw new Error(`File is not binary: ${resolvedPath}`);
    }

    // Check write permission
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
        return this.signFileAuthenticode(resolvedPath, scope, privateKey);
      } else if (detection.format === "macho") {
        return this.signFileMachO(resolvedPath, scope, privateKey);
      } else if (detection.format === "msi") {
        return this.signFileMsi(resolvedPath, scope, privateKey);
      }
    }

    // Detached signing (original behavior)
    const certPem = fs.readFileSync(certPath, "utf-8");

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
   * Sign all binary files in a directory. Produces .sig files and the .signatures.json manifest.
   * Uses format-aware signing per file (v2 manifest with signatureType per entry; embedded files carry standard
   * containers) and records the files judged not binary and left unsigned in the manifest's `skipped` list, so that
   * verification can account for them.
   * @param options.scope - The scope whose certificate to use for signing
   * @throws if no certificate or certificate expired (and force=false), or UnsupportedSigningKey before any file is
   * changed
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
    this.loadSigningKey(scope);

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
      skipped: [...skipped],
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
    const signer = signerDer ? this._buildSignerInfo(new crypto.X509Certificate(signerDer)) : undefined;
    const validityWarnings: string[] = [];
    if (signer?.isExpired) {
      validityWarnings.push(
        `signer certificate expired on ${signer.notAfter.toISOString().slice(0, 10)}; the signing time is not established because timestamps are not checked`
      );
    }
    if (signer?.isNotYetValid) {
      validityWarnings.push(`signer certificate is not valid until ${signer.notBefore.toISOString().slice(0, 10)}`);
    }
    const result: VerifyResult = {
      filePath,
      status,
      form,
      signatureType,
      integrity,
      trust: trustResult,
      warnings: [...trust.warnings, ...validityWarnings, ...(extra.warnings ?? [])],
      notChecked: [...NOT_CHECKED_ALWAYS, ...(extra.notChecked ?? [])],
    };
    if (status === "UNTRUSTED") {
      result.reason = trustResult.message;
    } else if (status !== "VALID") {
      result.reason = integrity.reason;
    }
    if (signer) {
      result.signer = signer;
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
   * The embedded signature of the file's own form (Windows program, installer, Mac program) and the detached
   * `<file>.sig` are each checked when present. With both, both results are kept in `signatures` ([embedded,
   * detached]) and the top level is the worse one, the embedded one on a tie.
   * Trust is evaluated against options.trust, or the certificates of the configured scopes.
   * Throws for a path that does not exist, a `.sig` file whose file exists and a directory manifest.
   */
  async verifyFile(filePath: string, options?: VerifyOptions): Promise<VerifyResult> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    if (path.basename(resolvedPath) === ".signatures.json") {
      throw new Error(`${resolvedPath} is a directory manifest; verify the directory ${path.dirname(resolvedPath)} instead`);
    }
    if (resolvedPath.endsWith(".sig") && fs.existsSync(resolvedPath.slice(0, -4))) {
      throw new Error(`${resolvedPath} is a signature file; verify ${resolvedPath.slice(0, -4)} instead`);
    }

    const resolvedOptions: VerifyOptions = { trust: options?.trust ?? this.loadTrust() };
    const trust = resolvedOptions.trust as TrustedCertificates;

    // The native component is loaded once; without it embedded signatures cannot be checked
    let addon: NativeAddon | undefined;
    try {
      addon = loadNativeAddon();
    } catch {
      addon = undefined;
    }

    let embedded: VerifyResult | undefined;
    if (addon !== undefined) {
      let format = "other";
      let hasEmbedded = false;
      try {
        format = addon.detectBinaryFormat(resolvedPath).format;
      } catch {
        // Unreadable by the native component: fall through to the detached check
      }
      try {
        if (format === "pe") {
          hasEmbedded = addon.peHasEmbeddedSignature(resolvedPath);
        } else if (format === "macho") {
          // Any signed slice makes the signature embedded; a program whose slices are all unsigned has none
          hasEmbedded = addon.machoListSlices(resolvedPath).some((slice) => slice.isSigned);
        } else if (format === "msi") {
          hasEmbedded = addon.msiHasEmbeddedSignature(resolvedPath);
        }
      } catch {
        // A program or installer whose structure cannot be read may hold a damaged signature: the form's own
        // verifier reports it as invalid with the native component's reason, rather than as unsigned
        hasEmbedded = true;
      }
      if (hasEmbedded) {
        if (format === "pe") {
          embedded = await this.verifyFileAuthenticode(resolvedPath, resolvedOptions);
        } else if (format === "macho") {
          embedded = await this.verifyFileMachO(resolvedPath, resolvedOptions);
        } else {
          embedded = await this.verifyFileMsi(resolvedPath, resolvedOptions);
        }
      }
    } else {
      const form = this._embeddedFormFromMagic(resolvedPath);
      if (form !== undefined) {
        const reason = "the native component is needed to check embedded signatures (run 'npm run build-addon')";
        embedded = this._buildVerifyResult(resolvedPath, form, "embedded", { state: "not-checked", reason, checked: [] }, undefined, trust);
      }
    }
    if (embedded?.status === "NOT_FOUND") {
      embedded = undefined;
    }

    if (embedded === undefined) {
      return this._verifyFileDetached(resolvedPath, resolvedOptions);
    }
    if (!fs.existsSync(resolvedPath + ".sig")) {
      return embedded;
    }

    // Both kinds are present: both are checked and the worse decides
    const detached = await this._verifyFileDetached(resolvedPath, resolvedOptions);
    if (embedded.integrity.state === "intact" && detached.integrity.state === "invalid" && detached.integrity.checked.length > 0) {
      const reason = "stale detached signature: the file changed after it was made (it was probably signed again in place)";
      detached.integrity = { ...detached.integrity, reason };
      detached.reason = reason;
    }
    const decided = worst([embedded.status, detached.status]) === embedded.status ? embedded : detached;
    const combined: VerifyResult = { ...decided };
    combined.signatures = [embedded, detached];
    combined.warnings = [
      ...new Set([...embedded.warnings, ...detached.warnings]),
      "Both an embedded and a detached signature are present; both were checked",
    ];
    combined.notChecked = [...new Set([...embedded.notChecked, ...detached.notChecked])];
    return combined;
  }

  /** The embedded form a file's first bytes announce (Windows program, Mac program, installer), without the native component. */
  _embeddedFormFromMagic(filePath: string): SignatureForm | undefined {
    const head = Buffer.alloc(8);
    let length = 0;
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        length = fs.readSync(fd, head, 0, 8, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
    if (length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
      return "windows-program";
    }
    if (length >= 8 && head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      return "installer";
    }
    if (length >= 4) {
      const magic = head.readUInt32BE(0);
      if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) {
        return "mac-program";
      }
    }
    return undefined;
  }

  /**
   * Verify a detached .sig file: the signature over the whole file (integrity) and its certificate against the
   * trusted certificates (trust).
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
   * Verify an embedded Authenticode signature in a PE file: the fingerprint and the signature with the signer's key
   * (integrity), and the signer against the trusted certificates (trust).
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

      const digestResult = addon.peComputeDigest(resolvedPath);
      return this._verifyAuthenticodeSignature(resolvedPath, "windows-program", pkcs7Der, digestResult.digest, trust, false);
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
   * Verify an embedded Authenticode signature in an MSI file: the fingerprint against the package and the signature
   * with the signer's key (integrity), and the signer against the trusted certificates (trust).
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
      if (check.state === "unreadable") {
        return failed(`signature present but could not be read (${check.detail})`);
      }

      // Extract embedded signature from \x05DigitalSignature stream
      const pkcs7Der = addon.msiExtractSignature(resolvedPath);
      if (!pkcs7Der) {
        return this._buildNotFoundResult(resolvedPath, "No embedded MSI Authenticode signature found", trust);
      }

      const digestResult = addon.msiComputeDigest(resolvedPath);
      const extended = fs.readFileSync(resolvedPath).includes(Buffer.from("\u0005MsiDigitalSignatureEx", "utf16le"));
      return this._verifyAuthenticodeSignature(resolvedPath, "installer", pkcs7Der, digestResult.digest, trust, extended);
    } catch (err) {
      return failed(`Failed to verify MSI Authenticode signature: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Check the signature of a Windows program or installer held in `pkcs7Der` against the fingerprint the
   * native component computed for the file. The stored fingerprint is compared first, so a changed file is
   * reported as changed whatever the signature's form; then the signature itself is checked, in the tool's
   * form (over the fingerprint), or the standard form with or without signed attributes.
   * `extendedStream` is set for an installer that holds an extended signature stream, which is not checked.
   */
  _verifyAuthenticodeSignature(
    resolvedPath: string,
    form: SignatureForm,
    pkcs7Der: Buffer,
    computed: Buffer,
    trust: TrustedCertificates,
    extendedStream: boolean
  ): VerifyResult {
    const what = form === "installer" ? "package" : "program";
    const build = (integrity: IntegrityResult, signerDer?: Buffer): VerifyResult =>
      this._buildVerifyResult(resolvedPath, form, "embedded", integrity, signerDer, trust);

    let info;
    let stored: { algorithm: string; digest: Buffer };
    try {
      info = readSignedData(pkcs7Der);
      if (info.contentType !== OID.spcIndirectData || info.content === undefined) {
        return build({ state: "not-checked", reason: "the signature is not of the Authenticode kind this tool checks", checked: [] });
      }
      stored = readSpcDigest(info.content);
    } catch (err) {
      if (err instanceof CmsUnsupported) {
        return build({ state: "not-checked", reason: err.message, checked: [] });
      }
      if (err instanceof CmsDamaged) {
        return build({ state: "invalid", reason: "signature data is damaged", checked: [] });
      }
      throw err;
    }
    const signer = info.signers[0];
    const certificate = findSignerCertificate(info, signer);
    const signerDer = certificate ?? undefined;
    const warnings = signer.hasNestedSignature ? ["The file holds a second, nested signature, which is not checked"] : [];
    const withWarnings = (result: VerifyResult): VerifyResult => {
      result.warnings = [...result.warnings, ...warnings];
      return result;
    };

    if (stored.algorithm !== OID.sha256) {
      return withWarnings(build({ state: "not-checked", reason: "the signature fingerprints the file with an algorithm other than SHA-256, which is not checked", checked: [] }, signerDer));
    }
    if (!stored.digest.equals(computed)) {
      if (extendedStream) {
        return withWarnings(
          build({ state: "not-checked", reason: "the installer holds an extended signature stream (MsiDigitalSignatureEx), which is not supported", checked: [] }, signerDer)
        );
      }
      const reason = "the file was changed after signing: its fingerprint differs from the one in the signature";
      return withWarnings(build({ state: "invalid", reason, checked: [`the ${what}'s fingerprint against the signed one`] }, signerDer));
    }

    const checked = [`the ${what}'s fingerprint against the signed one`, `signature over the ${what}'s fingerprint`];
    if (certificate === null) {
      return withWarnings(build({ state: "invalid", reason: "the signer's certificate is not in the signature", checked: [checked[0]] }));
    }
    if (signer.signedAttributes?.contentType !== undefined && signer.signedAttributes.contentType !== OID.spcIndirectData) {
      return withWarnings(build({ state: "invalid", reason: "the signed content type is not the one an Authenticode signature holds", checked: [checked[0]] }, certificate));
    }

    // Without signed attributes the tool's own form signs the fingerprint itself and the standard form signs the content
    let outcome = verifySignerSignature(signer, certificate, signer.signedAttributes === undefined ? computed : info.content);
    if (outcome === "verified" && signer.signedAttributes === undefined) {
      // Only the tool's earlier form signs the fingerprint itself; other verifiers reject it
      warnings.push(EARLIER_FORM_NOTICE_WINDOWS);
    }
    if (outcome === "failed" && signer.signedAttributes === undefined) {
      outcome = verifySignerSignature(signer, certificate, info.content);
    }
    if (outcome === "unsupported") {
      return withWarnings(build({ state: "not-checked", reason: `unsupported signature algorithm ${signer.signatureAlgorithm}`, checked: [checked[0]] }, certificate));
    }
    if (outcome === "failed") {
      return withWarnings(build({ state: "invalid", reason: `the signature over the ${what}'s fingerprint does not verify`, checked }, certificate));
    }
    return withWarnings(build({ state: "intact", checked }, certificate));
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
   * Verify a signed directory against its .signatures.json manifest.
   * The manifest's certificate must be consistent with its recorded fingerprint and is checked against the trusted
   * certificates; every listed file must verify and be signed by that certificate; entries whose path leads outside
   * the directory are refused without opening anything; files and links the manifest does not account for fail the directory.
   * @throws if there is no manifest, or it is malformed
   */
  async verifyDirectory(dirPath: string, options?: VerifyOptions): Promise<DirectoryVerifyResult> {
    const resolvedDir = path.resolve(dirPath);
    const manifestPath = path.join(resolvedDir, ".signatures.json");

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No .signatures.json manifest found in ${resolvedDir}`);
    }

    const malformed = (detail: string): Error => new Error(`Manifest file .signatures.json is malformed: ${detail}`);
    let manifest: SigningManifestFormat;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      throw malformed(`not valid JSON (${(err as Error).message})`);
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw malformed("it is not a JSON object");
    }
    if (manifest.version !== 1 && manifest.version !== 2) {
      throw malformed(`unsupported version ${JSON.stringify(manifest.version)}`);
    }
    if (!Array.isArray(manifest.files)) {
      throw malformed("it has no list of files");
    }
    for (const entry of manifest.files) {
      if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || entry.path === "") {
        throw malformed("a file entry has no path");
      }
    }
    if (manifest.skipped !== undefined && (!Array.isArray(manifest.skipped) || manifest.skipped.some((name) => typeof name !== "string"))) {
      throw malformed("the list of skipped files is not a list of paths");
    }
    if (typeof manifest.certificate !== "string") {
      throw malformed("it has no certificate");
    }
    let manifestCert: crypto.X509Certificate;
    try {
      manifestCert = new crypto.X509Certificate(manifest.certificate);
    } catch (err) {
      throw malformed(`its certificate cannot be read (${(err as Error).message})`);
    }

    const trust = options?.trust ?? this.loadTrust();
    const certInfo = this._buildSignerInfo(manifestCert);
    const recordedFingerprint = typeof manifest.certificateFingerprint === "string" ? manifest.certificateFingerprint : "";
    const fingerprintConsistent = recordedFingerprint === certInfo.fingerprint;
    const manifestTrust = evaluateTrust(manifestCert.raw, trust);
    const earlierFormat = manifest.version === 1;

    const warnings: string[] = [...trust.warnings];
    if (earlierFormat) {
      warnings.push("manifest is in the earlier format (version 1); signing the directory again writes the current one");
    }
    if (certInfo.isExpired) {
      warnings.push(`manifest certificate expired on ${certInfo.notAfter.toISOString().slice(0, 10)}; the signing time is not established because timestamps are not checked`);
    }
    if (certInfo.isNotYetValid) {
      warnings.push(`manifest certificate is not valid until ${certInfo.notBefore.toISOString().slice(0, 10)}`);
    }

    // Each entry is verified with the manifest's certificate as the only trusted one, which checks the signer against it
    const manifestOnly: TrustedCertificates = {
      source: "supplied",
      anchors: [{ source: "supplied", path: manifestPath, fingerprint: certInfo.fingerprint }],
      warnings: [],
    };

    const realDir = fs.realpathSync(resolvedDir);
    const results: DirectoryFileResult[] = [];
    const listed = new Set<string>();
    for (const entry of manifest.files) {
      const relativePath = entry.path;
      const normalized = this._normalizeRelative(relativePath);
      listed.add(normalized);
      if (entry.signatureFile) {
        listed.add(this._normalizeRelative(entry.signatureFile));
      }
      listed.add(normalized + ".sig");
      const result = await this._verifyManifestEntry(resolvedDir, realDir, entry, manifestOnly, manifestTrust);
      for (const warning of result.warnings) {
        warnings.push(`${relativePath}: ${warning}`);
      }
      results.push(result);
    }

    // Recorded skipped files
    const skippedPaths = new Set<string>();
    const skipped: Array<{ relativePath: string; present: boolean }> = [];
    for (const name of manifest.skipped ?? []) {
      const normalized = this._normalizeRelative(name);
      skippedPaths.add(normalized);
      let present = false;
      if (!this._leadsOutside(name)) {
        try {
          present = fs.lstatSync(path.join(resolvedDir, name)).isFile();
        } catch {
          present = false;
        }
      }
      skipped.push({ relativePath: name, present });
      if (!present) {
        warnings.push(`${name} is recorded as skipped when the directory was signed but is no longer present`);
      }
    }

    // Everything in the directory that the manifest does not account for
    const unlisted: DirectoryVerifyResult["unlisted"] = [];
    const links: DirectoryVerifyResult["links"] = [];
    const recordsSkipped = manifest.skipped !== undefined;
    let hintNeeded = false;
    const walk = async (relativeDir: string): Promise<void> => {
      const entries = fs.readdirSync(path.join(resolvedDir, relativeDir), { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of entries) {
        const relative = relativeDir === "" ? dirent.name : relativeDir + "/" + dirent.name;
        const full = path.join(resolvedDir, relative);
        if (dirent.isDirectory()) {
          await walk(relative);
        } else if (dirent.isFile()) {
          if (relative === ".signatures.json" || listed.has(relative) || skippedPaths.has(relative)) {
            continue;
          }
          if (!recordsSkipped && !(await this.isBinaryFile(full))) {
            hintNeeded = true;
            unlisted.push({ relativePath: relative, kind: "file", reason: "not in the manifest; sign the directory again to record files that are not signed" });
          } else {
            unlisted.push({ relativePath: relative, kind: "file", reason: "not in the manifest" });
          }
        } else if (dirent.isSymbolicLink()) {
          let target: string | undefined;
          try {
            const real = fs.realpathSync(full);
            const inside = path.relative(realDir, real);
            if (inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside)) {
              const normalized = this._normalizeRelative(inside);
              if (listed.has(normalized)) {
                target = normalized;
              }
            }
          } catch {
            target = undefined;
          }
          if (target !== undefined) {
            links.push({ relativePath: relative, target });
          } else {
            unlisted.push({ relativePath: relative, kind: "link", reason: "not checked (link or special file)" });
          }
        } else {
          unlisted.push({ relativePath: relative, kind: "other", reason: "not checked (link or special file)" });
        }
      }
    };
    await walk("");
    if (hintNeeded) {
      warnings.push("this manifest does not record files that were not signed; sign the directory again to record them");
    }

    const counts = {
      valid: 0,
      untrusted: 0,
      invalid: 0,
      notFullySigned: 0,
      notChecked: 0,
      missing: 0,
      unlisted: unlisted.length,
      skipped: skipped.filter((item) => item.present).length,
    };
    for (const result of results) {
      switch (result.status) {
        case "VALID":
          counts.valid++;
          break;
        case "UNTRUSTED":
          counts.untrusted++;
          break;
        case "NOT_FULLY_SIGNED":
          counts.notFullySigned++;
          break;
        case "NOT_CHECKED":
          counts.notChecked++;
          break;
        case "NOT_FOUND":
          counts.missing++;
          break;
        default:
          counts.invalid++;
      }
    }

    const statuses: VerifyStatus[] = results.map((result) => result.status);
    if (!fingerprintConsistent || unlisted.length > 0) {
      statuses.push("INVALID");
    }
    if (manifestTrust.state !== "trusted") {
      statuses.push("UNTRUSTED");
    }

    return {
      directory: resolvedDir,
      manifest: {
        path: manifestPath,
        version: manifest.version,
        earlierFormat,
        signedAt: String(manifest.signedAt ?? ""),
        certificate: certInfo,
        recordedFingerprint,
        fingerprintConsistent,
        trust: manifestTrust,
      },
      results,
      unlisted,
      skipped,
      links,
      counts,
      status: worst(statuses),
      warnings,
      notChecked: [...NOT_CHECKED_ALWAYS],
    };
  }

  /** A relative path with "/" separators and no "." parts, for comparing paths from the manifest with the walk. */
  _normalizeRelative(relative: string): string {
    return path.normalize(relative).split(path.sep).join("/");
  }

  /** Whether a manifest path is absolute, holds a NUL, or climbs out of the directory by its own text. */
  _leadsOutside(relative: string): boolean {
    if (relative.includes("\0") || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
      return true;
    }
    const normalized = path.normalize(relative);
    return normalized === ".." || normalized.startsWith(".." + path.sep) || normalized.startsWith("../");
  }

  /** Whether a file that exists resolves, after following links, to a place outside the directory. */
  _resolvesOutside(realDir: string, filePath: string): boolean {
    const inside = path.relative(realDir, fs.realpathSync(filePath));
    return inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside);
  }

  /** Verify one manifest entry and relate the outcome to the manifest. Nothing outside the directory is opened. */
  async _verifyManifestEntry(
    resolvedDir: string,
    realDir: string,
    entry: SigningManifestEntry,
    manifestOnly: TrustedCertificates,
    manifestTrust: TrustResult
  ): Promise<DirectoryFileResult> {
    const relativePath = entry.path;
    const filePath = path.join(resolvedDir, relativePath);
    const fail = (status: VerifyStatus, reason: string, integrityState: "invalid" | "none" = "invalid"): DirectoryFileResult => ({
      filePath,
      relativePath,
      status,
      reason,
      integrity: { state: integrityState, reason, checked: [] },
      trust: { state: "not-applicable" },
      warnings: [],
      notChecked: [...NOT_CHECKED_ALWAYS],
      signerMatchesManifest: null,
      recordedValueMatches: null,
    });

    const outside = "path leads outside the directory";
    if (this._leadsOutside(relativePath)) {
      return fail("INVALID", outside);
    }
    const sigPath = filePath + ".sig";
    try {
      if (!fs.existsSync(filePath)) {
        return fail("NOT_FOUND", MISSING_FILE_REASON, "none");
      }
      if (this._resolvesOutside(realDir, filePath) || (fs.existsSync(sigPath) && this._resolvesOutside(realDir, sigPath))) {
        return fail("INVALID", outside);
      }
    } catch {
      return fail("INVALID", outside);
    }

    const embedded = entry.signatureType === "embedded";
    try {
      return await this._checkManifestEntry(filePath, sigPath, entry, embedded, manifestOnly, manifestTrust, fail);
    } catch (err) {
      return fail("INVALID", `the entry could not be verified (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** The checks of one manifest entry whose path has been found to stay inside the directory. */
  async _checkManifestEntry(
    filePath: string,
    sigPath: string,
    entry: SigningManifestEntry,
    embedded: boolean,
    manifestOnly: TrustedCertificates,
    manifestTrust: TrustResult,
    fail: (status: VerifyStatus, reason: string, integrityState?: "invalid" | "none") => DirectoryFileResult
  ): Promise<DirectoryFileResult> {
    const relativePath = entry.path;
    const verified = embedded ? await this.verifyFile(filePath, { trust: manifestOnly }) : await this._verifyFileDetached(filePath, { trust: manifestOnly });

    // The signer against the manifest's certificate
    let signerMatchesManifest: boolean | null = null;
    if (verified.signer) {
      signerMatchesManifest = verified.trust.state === "trusted";
    }

    // The value the manifest recorded for the file
    let recordedValueMatches: boolean | null = null;
    let recordedReason = "";
    if (embedded) {
      const fingerprint = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("base64");
      recordedValueMatches = fingerprint === entry.signature;
      recordedReason = "the file differs from the fingerprint recorded in the manifest";
    } else if (fs.existsSync(sigPath)) {
      try {
        const sigData: SigFileFormat = JSON.parse(fs.readFileSync(sigPath, "utf-8"));
        recordedValueMatches = sigData.signature === entry.signature;
        recordedReason = "the detached signature differs from the one recorded in the manifest";
      } catch {
        recordedValueMatches = null;
      }
    }

    const result: DirectoryFileResult = { ...verified, relativePath, signerMatchesManifest, recordedValueMatches };
    if (verified.status === "NOT_FOUND" && !embedded) {
      return fail("NOT_FOUND", `the signature file ${entry.signatureFile ?? path.basename(sigPath)} is missing`, "none");
    }
    if (verified.status === "NOT_FOUND") {
      const reason = `no signature found, although the manifest lists one (${verified.reason ?? "none present"})`;
      return { ...result, status: "INVALID", reason, integrity: { state: "invalid", reason, checked: [] } };
    }

    let reason: string | undefined;
    if (verified.integrity.state === "intact") {
      if (signerMatchesManifest === false) {
        reason = "signer does not match the manifest's certificate";
      } else if (recordedValueMatches === false) {
        reason = recordedReason;
      }
    }
    if (reason !== undefined) {
      return { ...result, status: "INVALID", reason };
    }
    // The file's trust is that of the manifest's certificate
    if (verified.integrity.state === "intact" || signerMatchesManifest !== null) {
      result.trust = signerMatchesManifest === false ? result.trust : manifestTrust;
      result.status = outcomeOf(verified.integrity, result.trust);
      if (result.status === "UNTRUSTED") {
        result.reason = manifestTrust.message;
      } else if (result.status === "VALID") {
        delete result.reason;
      }
    }
    return result;
  }
}

export default Signing;
