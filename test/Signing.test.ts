import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import Signing from "../src/Signing";
import Config from "../src/Config";
import {
  CertInfo,
  SigFileFormat,
  SigningManifestFormat,
} from "../src/types";

/**
 * Create a temporary directory for test isolation.
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "signing-test-"));
}

/**
 * Write a minimal config.json with a scope containing author info.
 */
function writeConfig(configDir: string, data: { prefix?: string; scope?: string; name?: string; email?: string }) {
  const configPath = path.join(configDir, "config.json");
  const scopeName = data.scope || "@test";
  const scopes: Record<string, { author: { name: string; email: string; url: string } }> = {};
  if (data.name) {
    scopes[scopeName] = {
      author: {
        name: data.name,
        email: data.email || "",
        url: "",
      },
    };
  }
  const full = { prefix: data.prefix || "", scopes };
  fs.writeFileSync(configPath, JSON.stringify(full, null, 2));
}

/**
 * Create a binary file with random bytes.
 */
function writeBinaryFile(filePath: string, size = 256): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, crypto.randomBytes(size));
}

/**
 * Create a text file.
 */
function writeTextFile(filePath: string, content = "Hello, world!\n"): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("Signing", () => {
  let configDir: string;
  let signing: Signing;

  beforeEach(() => {
    configDir = createTempDir();
    writeConfig(configDir, { name: "Test User", email: "test@example.com" });
    signing = new Signing(configDir);
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // ── hasCert ────────────────────────────────────────────────

  describe("hasCert", () => {
    it("returns false when no certificate exists", () => {
      expect(signing.hasCert("@test")).toBe(false);
    });

    it("returns true after certificate is created", async () => {
      await signing.createCert({ scope: "@test" });
      expect(signing.hasCert("@test")).toBe(true);
    });

    it("returns true (any scope) after certificate is created", async () => {
      await signing.createCert({ scope: "@test" });
      expect(signing.hasCert()).toBe(true);
    });
  });

  // ── getCertInfo ────────────────────────────────────────────

  describe("getCertInfo", () => {
    it("returns null when no certificate exists", () => {
      expect(signing.getCertInfo("@test")).toBeNull();
    });

    it("parses all fields from a created cert", async () => {
      await signing.createCert({ validityDays: 90, scope: "@test" });
      const info = signing.getCertInfo("@test");
      expect(info).not.toBeNull();
      const certInfo = info as CertInfo;

      expect(certInfo.subject.commonName).toBe("Test User");
      expect(certInfo.subject.email).toBe("test@example.com");
      expect(certInfo.subject.organization).toBe("@test");
      expect(certInfo.issuer).toBe("self-signed");
      expect(certInfo.fingerprint).toMatch(/^SHA256:[0-9a-f]+$/);
      expect(certInfo.keyType).toBe("ECDSA P-256");
      expect(certInfo.notBefore).toBeInstanceOf(Date);
      expect(certInfo.notAfter).toBeInstanceOf(Date);
      expect(certInfo.isExpired).toBe(false);
      expect(certInfo.certPath).toBe(signing.scopeCertPath("@test"));

      // Validity should be ~90 days
      const diffMs = certInfo.notAfter.getTime() - certInfo.notBefore.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(89);
      expect(diffDays).toBeLessThanOrEqual(91);
    });
  });

  // ── isBinaryFile ───────────────────────────────────────────

  describe("isBinaryFile", () => {
    it("detects a binary file", async () => {
      const binPath = path.join(configDir, "test.bin");
      writeBinaryFile(binPath);
      expect(await signing.isBinaryFile(binPath)).toBe(true);
    });

    it("detects a text file as non-binary", async () => {
      const txtPath = path.join(configDir, "test.txt");
      writeTextFile(txtPath, "This is plain text.\nNothing binary here.\n");
      expect(await signing.isBinaryFile(txtPath)).toBe(false);
    });
  });

  // ── createCert ─────────────────────────────────────────────

  describe("createCert", () => {
    it("creates cert.pem and key.pem", async () => {
      const info = await signing.createCert({ scope: "@test" });

      expect(fs.existsSync(signing.scopeCertPath("@test"))).toBe(true);
      expect(fs.existsSync(signing.scopeKeyPath("@test"))).toBe(true);

      // cert.pem should contain PEM certificate
      const certPem = fs.readFileSync(signing.scopeCertPath("@test"), "utf-8");
      expect(certPem).toContain("-----BEGIN CERTIFICATE-----");
      expect(certPem).toContain("-----END CERTIFICATE-----");

      // key.pem should contain PEM private key
      const keyPem = fs.readFileSync(signing.scopeKeyPath("@test"), "utf-8");
      expect(keyPem).toContain("PRIVATE KEY");
    });

    it("populates subject from scope config", async () => {
      const info = await signing.createCert({ scope: "@test" });
      expect(info.subject.commonName).toBe("Test User");
      expect(info.subject.email).toBe("test@example.com");
      expect(info.subject.organization).toBe("@test");
    });

    it("sets key.pem permissions to 0600 on non-Windows", async () => {
      if (process.platform === "win32") return; // skip on Windows

      await signing.createCert({ scope: "@test" });
      const stat = fs.statSync(signing.scopeKeyPath("@test"));
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("uses custom validity days", async () => {
      const info = await signing.createCert({ validityDays: 30, scope: "@test" });
      const diffMs = info.notAfter.getTime() - info.notBefore.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);
    });

    it("throws when scope is not specified", async () => {
      await expect(signing.createCert()).rejects.toThrow("scope");
    });

    it("throws when scope is not found in config", async () => {
      await expect(signing.createCert({ scope: "@nonexistent" })).rejects.toThrow("not found");
    });

    it("throws when author name is missing in scope", async () => {
      const configPath = path.join(configDir, "config.json");
      const config = { prefix: "", scopes: { "@bad": { author: { name: "", email: "", url: "" } } } };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      const s = new Signing(configDir);
      await expect(s.createCert({ scope: "@bad" })).rejects.toThrow("author name");
    });

    it("returns correct CertInfo fields", async () => {
      const info = await signing.createCert({ scope: "@test" });
      expect(info.fingerprint).toMatch(/^SHA256:/);
      expect(info.keyType).toBe("ECDSA P-256");
      expect(info.isExpired).toBe(false);
      expect(info.certPath).toBe(signing.scopeCertPath("@test"));
    });
  });

  // ── signFile ───────────────────────────────────────────────

  describe("signFile", () => {
    beforeEach(async () => {
      await signing.createCert({ scope: "@test" });
    });

    it("produces a valid .sig file for a binary file", async () => {
      const binPath = path.join(configDir, "test.bin");
      writeBinaryFile(binPath);

      const result = await signing.signFile(binPath, { scope: "@test" });
      expect(result.filePath).toBe(binPath);
      expect(result.signaturePath).toBe(binPath + ".sig");
      expect(result.fingerprint).toMatch(/^SHA256:/);

      // .sig file should be valid JSON with expected fields
      const sigContent = JSON.parse(fs.readFileSync(result.signaturePath, "utf-8")) as SigFileFormat;
      expect(sigContent.version).toBe(1);
      expect(sigContent.algorithm).toBe("SHA256");
      expect(sigContent.curve).toBe("P-256");
      expect(typeof sigContent.signature).toBe("string");
      expect(sigContent.certificate).toContain("-----BEGIN CERTIFICATE-----");
    });

    it("rejects a non-binary (text) file", async () => {
      const txtPath = path.join(configDir, "readme.txt");
      writeTextFile(txtPath, "Hello world\n");

      await expect(signing.signFile(txtPath, { scope: "@test" })).rejects.toThrow();
    });

    it("throws when no certificate exists", async () => {
      // Remove certificate
      fs.rmSync(signing.signingDir, { recursive: true, force: true });
      const s = new Signing(configDir);
      const binPath = path.join(configDir, "test.bin");
      writeBinaryFile(binPath);

      await expect(s.signFile(binPath, { scope: "@test" })).rejects.toThrow("No signing certificate");
    });
  });

  // ── signDirectory ──────────────────────────────────────────

  describe("signDirectory", () => {
    let testDir: string;

    beforeEach(async () => {
      await signing.createCert({ scope: "@test" });
      testDir = path.join(configDir, "build");
      fs.mkdirSync(testDir, { recursive: true });
    });

    it("signs binary files and produces manifest", async () => {
      writeBinaryFile(path.join(testDir, "game.so"));
      writeBinaryFile(path.join(testDir, "engine.dll"));
      writeTextFile(path.join(testDir, "README.md"), "# Build\n");

      const result = await signing.signDirectory(testDir, { scope: "@test" });

      // manifest should exist
      expect(fs.existsSync(result.manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8")) as SigningManifestFormat;
      expect(manifest.version).toBe(1);
      expect(manifest.files.length).toBe(2);
      expect(manifest.certificate).toContain("-----BEGIN CERTIFICATE-----");
      expect(manifest.certificateFingerprint).toMatch(/^SHA256:/);

      // signed files should have .sig
      expect(result.signed.length).toBe(2);
      for (const s of result.signed) {
        expect(fs.existsSync(s.signaturePath)).toBe(true);
      }
    });

    it("skips non-binary files", async () => {
      writeBinaryFile(path.join(testDir, "app.bin"));
      writeTextFile(path.join(testDir, "config.txt"), "key=value\n");
      writeTextFile(path.join(testDir, "notes.md"), "# Notes\n");

      const result = await signing.signDirectory(testDir, { scope: "@test" });

      expect(result.signed.length).toBe(1);
      expect(result.skipped.length).toBe(2);
    });

    it("throws when no binary files found", async () => {
      writeTextFile(path.join(testDir, "readme.md"), "text only\n");
      writeTextFile(path.join(testDir, "config.yaml"), "key: value\n");

      await expect(signing.signDirectory(testDir, { scope: "@test" })).rejects.toThrow("No binary files");
    });
  });

  // ── verifyFile ─────────────────────────────────────────────

  describe("verifyFile", () => {
    let binPath: string;

    beforeEach(async () => {
      await signing.createCert({ scope: "@test" });
      binPath = path.join(configDir, "test.bin");
      writeBinaryFile(binPath);
    });

    it("returns VALID for an unmodified signed file", async () => {
      await signing.signFile(binPath, { scope: "@test" });
      const result = await signing.verifyFile(binPath);

      expect(result.status).toBe("VALID");
      expect(result.filePath).toBe(path.resolve(binPath));
      expect(result.signer).toBeDefined();
      expect(result.signer!.subject.commonName).toBe("Test User");
      expect(result.signer!.fingerprint).toMatch(/^SHA256:/);
    });

    it("returns INVALID when file content is modified", async () => {
      await signing.signFile(binPath, { scope: "@test" });
      // Tamper with the file
      fs.appendFileSync(binPath, Buffer.from([0xff]));
      const result = await signing.verifyFile(binPath);

      expect(result.status).toBe("INVALID");
      expect(result.reason).toBeDefined();
    });

    it("returns NOT_FOUND when no .sig file exists", async () => {
      const result = await signing.verifyFile(binPath);

      expect(result.status).toBe("NOT_FOUND");
      expect(result.reason).toBeDefined();
    });
  });

  // ── verifyDirectory ────────────────────────────────────────

  describe("verifyDirectory", () => {
    let testDir: string;

    beforeEach(async () => {
      await signing.createCert({ scope: "@test" });
      testDir = path.join(configDir, "build");
      fs.mkdirSync(testDir, { recursive: true });
      writeBinaryFile(path.join(testDir, "a.bin"));
      writeBinaryFile(path.join(testDir, "b.bin"));
    });

    it("returns aggregated results for signed directory", async () => {
      await signing.signDirectory(testDir, { scope: "@test" });
      const result = await signing.verifyDirectory(testDir);

      expect(result.overallPass).toBe(true);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.notFound).toBe(0);
      expect(result.results.length).toBe(2);
      for (const r of result.results) {
        expect(r.status).toBe("VALID");
      }
    });

    it("detects tampered files in directory", async () => {
      await signing.signDirectory(testDir, { scope: "@test" });
      // Tamper with one file
      fs.appendFileSync(path.join(testDir, "a.bin"), Buffer.from([0x00]));

      const result = await signing.verifyDirectory(testDir);
      expect(result.overallPass).toBe(false);
      expect(result.failed).toBeGreaterThanOrEqual(1);
    });
  });

  // ── exportCert ─────────────────────────────────────────────

  describe("exportCert", () => {
    it("exports the public certificate without private key", async () => {
      await signing.createCert({ scope: "@test" });
      const outPath = path.join(configDir, "pub.pem");
      await signing.exportCert(outPath, "@test");

      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).toContain("-----BEGIN CERTIFICATE-----");
      expect(content).not.toContain("PRIVATE KEY");
    });

    it("throws when no certificate exists", async () => {
      const outPath = path.join(configDir, "pub.pem");
      await expect(signing.exportCert(outPath, "@test")).rejects.toThrow("No signing certificate");
    });
  });

  // ── importCert ─────────────────────────────────────────────

  describe("importCert", () => {
    let externalDir: string;

    beforeEach(async () => {
      // Create a cert in a separate location to import from
      externalDir = createTempDir();
      writeConfig(externalDir, { name: "External User", email: "ext@example.com", scope: "@external" });
      const extSigning = new Signing(externalDir);
      await extSigning.createCert({ scope: "@external" });
    });

    afterEach(() => {
      fs.rmSync(externalDir, { recursive: true, force: true });
    });

    it("imports certificate and key pair", async () => {
      const extCertPath = path.join(externalDir, "signing", "@external", "cert.pem");
      const extKeyPath = path.join(externalDir, "signing", "@external", "key.pem");

      const info = await signing.importCert(extCertPath, extKeyPath, "@test");

      expect(info.subject.commonName).toBe("External User");
      expect(info.fingerprint).toMatch(/^SHA256:/);
      expect(signing.hasCert("@test")).toBe(true);
    });

    it("validates ECDSA P-256 key type", async () => {
      // Generate an RSA key pair (unsupported) and write it
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });

      // Create a self-signed cert with RSA (we need to write PEM files)
      const certPem = generateSelfSignedRSACert(publicKey, privateKey);
      const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

      const rsaCertPath = path.join(externalDir, "rsa-cert.pem");
      const rsaKeyPath = path.join(externalDir, "rsa-key.pem");
      fs.writeFileSync(rsaCertPath, certPem);
      fs.writeFileSync(rsaKeyPath, keyPem);

      await expect(signing.importCert(rsaCertPath, rsaKeyPath, "@test")).rejects.toThrow("Unsupported");
    });

    it("rejects mismatched certificate and key", async () => {
      // Create two different EC key pairs
      const extCertPath = path.join(externalDir, "signing", "@external", "cert.pem");

      // Generate a different EC key
      const { privateKey: otherKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      const otherKeyPem = otherKey.export({ type: "pkcs8", format: "pem" }) as string;
      const mismatchKeyPath = path.join(externalDir, "other-key.pem");
      fs.writeFileSync(mismatchKeyPath, otherKeyPem);

      await expect(signing.importCert(extCertPath, mismatchKeyPath, "@test")).rejects.toThrow("do not match");
    });
  });

  // ── _formatSubject ─────────────────────────────────────────

  describe("_formatSubject", () => {
    it("formats full subject correctly", () => {
      const result = signing._formatSubject({
        commonName: "John Doe",
        email: "john@example.com",
        organization: "ACME",
      });
      expect(result).toBe("CN=John Doe, EMAIL=john@example.com, O=ACME");
    });

    it("formats subject without optional fields", () => {
      const result = signing._formatSubject({ commonName: "Jane" });
      expect(result).toBe("CN=Jane");
    });
  });
});

/**
 * Helper: generate a self-signed RSA certificate using Node.js crypto.
 */
function generateSelfSignedRSACert(publicKey: crypto.KeyObject, privateKey: crypto.KeyObject): string {
  // Use crypto.X509Certificate isn't available for generation, so use a workaround:
  // create a CSR-like structure. Actually, Node doesn't have cert generation built-in for RSA.
  // We'll use @peculiar/x509 for this in the test.
  const x509 = require("@peculiar/x509");
  const webcrypto = crypto.webcrypto as unknown as Crypto;
  x509.cryptoProvider.set(webcrypto);

  // Export keys to JWK and re-import as CryptoKey
  // This is simpler: just use openssl-style generation
  // Actually, let's use Node's built-in createCertificate-like approach
  // We need to produce a PEM cert. Simplest: use the crypto module's sign to make a self-signed cert.

  // Use a pre-generated self-signed RSA cert for testing (inline)
  // Generate at test time using child_process
  const { execSync } = require("child_process");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsa-cert-"));
  const keyFile = path.join(tmpDir, "key.pem");
  const certFile = path.join(tmpDir, "cert.pem");

  // Write private key to file
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  fs.writeFileSync(keyFile, keyPem);

  // Generate self-signed certificate using openssl
  try {
    execSync(
      `openssl req -new -x509 -key "${keyFile}" -out "${certFile}" -days 1 -subj "/CN=RSA Test" -sha256`,
      { stdio: "pipe" }
    );
    const cert = fs.readFileSync(certFile, "utf-8");
    return cert;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
