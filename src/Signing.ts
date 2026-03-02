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
} from "./types";

class Signing {
  configDir: string;
  signingDir: string;
  certPath: string;
  keyPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), "the-seed");
    this.signingDir = path.join(this.configDir, "signing");
    this.certPath = path.join(this.signingDir, "cert.pem");
    this.keyPath = path.join(this.signingDir, "key.pem");
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
   * Check if a signing certificate exists in the config directory.
   */
  hasCert(): boolean {
    return fs.existsSync(this.certPath);
  }

  /**
   * Get certificate information. Returns null if no cert exists.
   */
  getCertInfo(): CertInfo | null {
    if (!this.hasCert()) {
      return null;
    }

    const certPem = fs.readFileSync(this.certPath, "utf-8");
    const x509 = new crypto.X509Certificate(certPem);

    const subject = this._parseSubject(x509.subject);
    const issuer = this._parseIssuerString(x509.issuer, x509.subject);
    const fingerprint = "SHA256:" + x509.fingerprint256.replace(/:/g, "").toLowerCase();
    const notBefore = new Date(x509.validFrom);
    const notAfter = new Date(x509.validTo);

    return {
      subject,
      issuer,
      fingerprint,
      keyType: "ECDSA P-256",
      notBefore,
      notAfter,
      isExpired: new Date() > notAfter,
      certPath: this.certPath,
    };
  }

  /**
   * Check if a file is a binary file (eligible for signing).
   */
  async isBinaryFile(filePath: string): Promise<boolean> {
    return isBinary(filePath);
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
   * Read config.json to get subject fields for certificate.
   */
  _getSubjectFromConfig(): CertSubject {
    const config = new Config(this.configDir);
    const configData = config.config;

    if (!configData.name) {
      throw new Error("Required config field 'name' is missing. Run 'the-seed config edit' to set it.");
    }

    return {
      commonName: configData.name,
      email: configData.email || undefined,
      organization: configData.org || undefined,
    };
  }

  /**
   * Generate a self-signed X.509 certificate with ECDSA P-256 key.
   * Reads name, email, and org from config.json for the certificate subject.
   * Stores cert.pem and key.pem in configDir/signing/.
   */
  async createCert(options?: CertOptions): Promise<CertInfo> {
    const subject = this._getSubjectFromConfig();
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

    // Ensure signing directory exists
    if (!fs.existsSync(this.signingDir)) {
      fs.mkdirSync(this.signingDir, { recursive: true });
    }

    // Write certificate and key files
    fs.writeFileSync(this.certPath, certPem, { mode: 0o644 });
    fs.writeFileSync(this.keyPath, keyPem, { mode: 0o600 });
    this._setOwnerOnly(this.keyPath);

    return this.getCertInfo()!;
  }

  /**
   * Sign a single binary file. Produces <filePath>.sig.
   * @throws if no certificate, certificate expired (and force=false), or file is not binary
   */
  async signFile(filePath: string, options?: { force?: boolean }): Promise<SignResult> {
    const certInfo = this.getCertInfo();
    if (!certInfo) {
      throw new Error("No signing certificate found. Run 'the-seed signing create-cert' first.");
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

    // Read certificate and private key
    const certPem = fs.readFileSync(this.certPath, "utf-8");
    const keyPem = fs.readFileSync(this.keyPath, "utf-8");
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
    };
  }

  /**
   * Sign all binary files in a directory. Produces .sig files and .signatures.json manifest.
   * @throws if no certificate or certificate expired (and force=false)
   */
  async signDirectory(dirPath: string, options?: { force?: boolean }): Promise<DirectorySignResult> {
    const certInfo = this.getCertInfo();
    if (!certInfo) {
      throw new Error("No signing certificate found. Run 'the-seed signing create-cert' first.");
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

    // Generate .signatures.json manifest
    const certPem = fs.readFileSync(this.certPath, "utf-8");
    const manifestEntries: SigningManifestEntry[] = signed.map((s) => {
      const sigData: SigFileFormat = JSON.parse(fs.readFileSync(s.signaturePath, "utf-8"));
      return {
        path: path.relative(resolvedDir, s.filePath),
        signatureFile: path.relative(resolvedDir, s.signaturePath),
        algorithm: "SHA256" as const,
        signature: sigData.signature,
      };
    });

    const manifest: SigningManifestFormat = {
      version: 1,
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
   * @throws if no certificate exists
   */
  async exportCert(outputPath: string): Promise<void> {
    if (!this.hasCert()) {
      throw new Error("No signing certificate found.");
    }
    const certPem = fs.readFileSync(this.certPath, "utf-8");
    fs.writeFileSync(outputPath, certPem);
  }

  /**
   * Import an existing PEM certificate and private key.
   * Validates that key matches certificate and key is ECDSA P-256.
   * @throws if cert/key mismatch or unsupported key type
   */
  async importCert(certPath: string, keyPath: string): Promise<CertInfo> {
    // Read and parse certificate
    const certPem = fs.readFileSync(certPath, "utf-8");
    const x509Cert = new crypto.X509Certificate(certPem);

    // Read and parse private key
    const keyPem = fs.readFileSync(keyPath, "utf-8");
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

    // Ensure signing directory exists
    if (!fs.existsSync(this.signingDir)) {
      fs.mkdirSync(this.signingDir, { recursive: true });
    }

    // Copy certificate and key
    fs.writeFileSync(this.certPath, certPem, { mode: 0o644 });
    fs.writeFileSync(this.keyPath, keyPem, { mode: 0o600 });
    this._setOwnerOnly(this.keyPath);

    return this.getCertInfo()!;
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
   * Verify a single file's signature.
   * Extracts embedded certificate from .sig file — no local cert required.
   */
  async verifyFile(filePath: string): Promise<VerifyResult> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const sigPath = resolvedPath + ".sig";
    if (!fs.existsSync(sigPath)) {
      return {
        filePath: resolvedPath,
        status: "NOT_FOUND",
        reason: `No signature file found (${sigPath} does not exist)`,
      };
    }

    let sigData: SigFileFormat;
    try {
      sigData = JSON.parse(fs.readFileSync(sigPath, "utf-8"));
    } catch {
      return {
        filePath: resolvedPath,
        status: "INVALID",
        reason: "Signature file is malformed (invalid JSON)",
      };
    }

    if (sigData.version !== 1 || !sigData.signature || !sigData.certificate) {
      return {
        filePath: resolvedPath,
        status: "INVALID",
        reason: "Signature file has invalid format",
      };
    }

    // Extract public key from embedded certificate
    let x509Cert: crypto.X509Certificate;
    try {
      x509Cert = new crypto.X509Certificate(sigData.certificate);
    } catch {
      return {
        filePath: resolvedPath,
        status: "INVALID",
        reason: "Embedded certificate is invalid",
      };
    }

    const publicKey = x509Cert.publicKey;

    // Verify signature by streaming file
    const verify = crypto.createVerify("SHA256");
    await pipeline(createReadStream(resolvedPath), verify);
    const isValid = verify.verify(publicKey, Buffer.from(sigData.signature, "base64"));

    // Parse signer info from the embedded certificate
    const signerSubject = this._parseSubject(x509Cert.subject);
    const signerIssuer = this._parseIssuerString(x509Cert.issuer, x509Cert.subject);
    const signerFingerprint = "SHA256:" + x509Cert.fingerprint256.replace(/:/g, "").toLowerCase();
    const notBefore = new Date(x509Cert.validFrom);
    const notAfter = new Date(x509Cert.validTo);

    const signer: CertInfo = {
      subject: signerSubject,
      issuer: signerIssuer,
      fingerprint: signerFingerprint,
      keyType: "ECDSA P-256",
      notBefore,
      notAfter,
      isExpired: new Date() > notAfter,
      certPath: "",
    };

    if (isValid) {
      return {
        filePath: resolvedPath,
        status: "VALID",
        signer,
      };
    } else {
      return {
        filePath: resolvedPath,
        status: "INVALID",
        reason: "File content has been modified after signing",
        signer,
      };
    }
  }

  /**
   * Verify all files in a signed directory using .signatures.json manifest.
   */
  async verifyDirectory(dirPath: string): Promise<DirectoryVerifyResult> {
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

    const results: VerifyResult[] = [];
    let passed = 0;
    let failed = 0;
    let notFound = 0;

    for (const entry of manifest.files) {
      const filePath = path.join(resolvedDir, entry.path);
      const result = await this.verifyFile(filePath);
      results.push(result);

      switch (result.status) {
        case "VALID":
          passed++;
          break;
        case "INVALID":
          failed++;
          break;
        case "NOT_FOUND":
          notFound++;
          break;
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
