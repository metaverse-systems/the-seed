import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import * as x509 from "@peculiar/x509";
import Signing from "../src/Signing";
import * as SigningModule from "../src/Signing";
import { expectPresent } from "./helpers/Assert";
import { fileDigest, nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";
import { signingErrorClass, signingErrorOf } from "./helpers/SigningErrors";
import * as Index from "../src/index";
import { addScopeHint, createCertHint, editScopeHint, replaceCertHint } from "../src/cli/Hints";
import {
  CertInfo,
  SigFileFormat,
  SigningManifestFormat,
} from "../src/types";
import { defined } from "./helpers/Defined";

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
  const full = { prefix: data.prefix || "/tmp/seed-test-prefix", scopes };
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
      await signing.createCert({ scope: "@test" });

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
      const config = { prefix: "/tmp/seed-test-prefix", scopes: { "@bad": { author: { name: "", email: "", url: "" } } } };
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
      const sigContent = JSON.parse(fs.readFileSync(expectPresent(result.signaturePath, "signaturePath"), "utf-8")) as SigFileFormat;
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
      expect(manifest.version).toBe(2);
      expect(manifest.files.length).toBe(2);
      expect(manifest.certificate).toContain("-----BEGIN CERTIFICATE-----");
      expect(manifest.certificateFingerprint).toMatch(/^SHA256:/);

      // signed files should have .sig
      expect(result.signed.length).toBe(2);
      for (const s of result.signed) {
        expect(fs.existsSync(expectPresent(s.signaturePath, "signaturePath"))).toBe(true);
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
      expect(defined(result.signer, "signer").subject.commonName).toBe("Test User");
      expect(defined(result.signer, "signer").fingerprint).toMatch(/^SHA256:/);
      expect(result.trust.state).toBe("trusted");
      expect(result.integrity.state).toBe("intact");
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

      expect(result.status).toBe("VALID");
      expect(result.counts.valid).toBe(2);
      expect(result.results.length).toBe(2);
      for (const r of result.results) {
        expect(r.status).toBe("VALID");
        expect(r.signerMatchesManifest).toBe(true);
      }
    });

    it("detects tampered files in directory", async () => {
      await signing.signDirectory(testDir, { scope: "@test" });
      // Tamper with one file
      fs.appendFileSync(path.join(testDir, "a.bin"), Buffer.from([0x00]));

      const result = await signing.verifyDirectory(testDir);
      expect(result.status).toBe("INVALID");
      expect(result.counts.invalid).toBe(1);
      const tampered = result.results.find((r) => r.relativePath === "a.bin");
      expect(tampered?.status).toBe("INVALID");
      // the reason names the file as modified
      expect(tampered?.reason).toMatch(/modified/i);
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
      const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });

      // Create a self-signed cert with RSA (we need to write PEM files)
      const certPem = generateSelfSignedRSACert(privateKey);
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
function generateSelfSignedRSACert(privateKey: crypto.KeyObject): string {
  // Use crypto.X509Certificate isn't available for generation, so use a workaround:
  // create a CSR-like structure. Actually, Node doesn't have cert generation built-in for RSA.
  // We'll use @peculiar/x509 for this in the test.
  const webcrypto = crypto.webcrypto as unknown as Crypto;
  x509.cryptoProvider.set(webcrypto);

  // Export keys to JWK and re-import as CryptoKey
  // This is simpler: just use openssl-style generation
  // Actually, let's use Node's built-in createCertificate-like approach
  // We need to produce a PEM cert. Simplest: use the crypto module's sign to make a self-signed cert.

  // Use a pre-generated self-signed RSA cert for testing (inline)
  // Generate at test time using child_process
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

// ── without the native component ─────────────────────────────

describe("Signing without the native component", () => {
  type SigningModule = typeof import("../src/Signing");
  type ComponentModule = typeof import("../src/NativeComponent");

  const fixtures = path.join(__dirname, "fixtures", "binaries");
  let configDir: string;
  let workDir: string;
  let signing: Signing;
  let missing: ComponentModule;

  /** Loads Signing and the component module in one registry in which the component is unavailable. */
  function loadWithout(): { Signing: SigningModule["default"]; component: ComponentModule } {
    return withoutNativeComponent(() => ({
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
      Signing: (require("../src/Signing") as SigningModule).default,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the same registry must supply the error class
      component: require("../src/NativeComponent") as ComponentModule,
    }));
  }

  function copyOf(source: string, name: string): string {
    const target = path.join(workDir, name);
    fs.copyFileSync(source, target);
    return target;
  }

  function expectNoSignature(file: string): void {
    expect(fs.existsSync(file + ".sig")).toBe(false);
  }

  beforeEach(async () => {
    configDir = createTempDir();
    workDir = createTempDir();
    writeConfig(configDir, { name: "Test User", email: "test@example.com" });
    const real = new Signing(configDir);
    await real.createCert({ scope: "@test" });
    const loaded = loadWithout();
    signing = new loaded.Signing(configDir);
    missing = loaded.component;
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe("detectBinaryFormat", () => {
    it("answers other for a text file without needing the component", () => {
      const file = path.join(workDir, "notes.txt");
      writeTextFile(file, "plain text\n");
      expect(signing.detectBinaryFormat(file)).toEqual({ format: "other", subFormat: null });
    });

    it("answers other for a Linux program without needing the component", () => {
      const file = copyOf("/bin/true", "linux-program");
      expect(signing.detectBinaryFormat(file)).toEqual({ format: "other", subFormat: null });
    });

    it("throws the missing component error for a Windows program", () => {
      const file = copyOf(path.join(fixtures, "tiny.exe"), "tiny.exe");
      expect(() => signing.detectBinaryFormat(file)).toThrow(missing.NativeComponentMissingError);
      expect(() => signing.detectBinaryFormat(file)).toThrow(missing.nativeComponentMessage());
    });
  });

  describe("signFile", () => {
    it.each([
      ["tiny.exe", path.join(fixtures, "tiny.exe")],
      ["tiny-macho-arm64", path.join(fixtures, "genuine", "tiny-macho-arm64")],
      ["tiny.msi", path.join(fixtures, "tiny.msi")],
    ])("refuses %s with the missing component message and changes nothing", async (name, source) => {
      const file = copyOf(source, name);
      const before = fileDigest(file);

      let thrown: unknown;
      try {
        await signing.signFile(file, { scope: "@test" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(missing.NativeComponentMissingError);
      expect((thrown as Error).message).toBe(missing.nativeComponentMessage());
      expect(fileDigest(file)).toBe(before);
      expectNoSignature(file);
    });

    it("still signs a Windows program detached", async () => {
      const file = copyOf(path.join(fixtures, "tiny.exe"), "tiny.exe");
      const before = fileDigest(file);

      const result = await signing.signFile(file, { scope: "@test", detached: true });

      expect(result.signatureType).toBe("detached");
      expect(fs.existsSync(file + ".sig")).toBe(true);
      expect(fileDigest(file)).toBe(before);
    });

    it("still signs a Linux program detached", async () => {
      const file = copyOf("/bin/true", "linux-program");

      const result = await signing.signFile(file, { scope: "@test" });

      expect(result.signatureType).toBe("detached");
      expect(fs.existsSync(file + ".sig")).toBe(true);
    });
  });

  describe("removeEmbeddedSignature", () => {
    it("refuses a Windows program with the missing component message and changes nothing", () => {
      const file = copyOf(path.join(fixtures, "tiny.exe"), "tiny.exe");
      const before = fileDigest(file);

      expect(() => signing.removeEmbeddedSignature(file)).toThrow(missing.NativeComponentMissingError);
      expect(() => signing.removeEmbeddedSignature(file)).toThrow(missing.nativeComponentMessage());
      expect(fileDigest(file)).toBe(before);
    });
  });
});

// Interfaces fixed here where the contracts leave them open:
//   - an invalid `validityDays` is a `SigningError` with code `invalid-validity` whose message contains
//     the value as `String(value)`, and nothing is written under the signing directory
//   - `undefined` selects the default; `0` is invalid (it is not replaced by the default)
describe("createCert validity days", () => {
  let dir: string;
  let signing: Signing;

  beforeEach(() => {
    dir = createTempDir();
    writeConfig(dir, { name: "Test User", email: "test@example.com" });
    signing = new Signing(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const days = (info: CertInfo): number => Math.round((info.notAfter.getTime() - info.notBefore.getTime()) / (1000 * 60 * 60 * 24));

  it.each([NaN, 0, -5, 1.5, 3651, Infinity])("refuses %p and writes nothing", async (value) => {
    const error = await signingErrorOf(() => signing.createCert({ scope: "@test", validityDays: value }));
    expect(error.code).toBe("invalid-validity");
    expect(error.message).toContain(String(value));
    expect(fs.existsSync(signing.scopeCertPath("@test"))).toBe(false);
    expect(fs.existsSync(signing.scopeKeyPath("@test"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "signing"))).toBe(false);
  });

  it("uses 365 days when the validity is not given", async () => {
    expect(days(await signing.createCert({ scope: "@test" }))).toBe(365);
    expect(days(await signing.createCert({ scope: "@test", validityDays: undefined }))).toBe(365);
  });

  it.each([1, 3650])("accepts %p days", async (value) => {
    expect(days(await signing.createCert({ scope: "@test", validityDays: value }))).toBe(value);
  });

  it("exports the validity limits from the package index", () => {
    const exported = Index as unknown as { DEFAULT_VALIDITY_DAYS?: number; MAX_VALIDITY_DAYS?: number };
    expect(exported.DEFAULT_VALIDITY_DAYS).toBe(365);
    expect(exported.MAX_VALIDITY_DAYS).toBe(3650);
  });
});

describe("validity constants", () => {
  // Looked up on the module so that this file compiles whether or not the exports exist.
  const constants = SigningModule as unknown as { DEFAULT_VALIDITY_DAYS?: number; MAX_VALIDITY_DAYS?: number };

  it("exports the default validity of 365 days", () => {
    expect(constants.DEFAULT_VALIDITY_DAYS).toBe(365);
  });

  it("exports the largest validity of 3650 days", () => {
    expect(constants.MAX_VALIDITY_DAYS).toBe(3650);
  });
});

// Every failure the library reports in the situations below is a SigningError whose `code` names the
// situation. The message keeps its wording; the hint, where there is one, is in `hint` and not in the
// message. Choices where the interface is open:
//   - an unreadable, unparsable or missing certificate or key file given to importCert, a certificate
//     file given to loadTrust, and a scope certificate that cannot be parsed are `certificate-unreadable`
//   - `UnsupportedSigningKey` (a scope key that cannot sign) has code `unsupported-key`, and so does
//     importCert for a key that is not ECDSA P-256
//   - hints are compared with the functions of src/cli/Hints.ts
describe("SigningError", () => {
  let dir: string;
  let signing: Signing;

  beforeEach(() => {
    dir = createTempDir();
    writeConfig(dir, { name: "Test User", email: "test@example.com" });
    signing = new Signing(dir);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is exported from the module and from the package index, with its code type", () => {
    expect(signingErrorClass()).toBeDefined();
    expect((Index as unknown as { SigningError?: unknown }).SigningError).toBe(signingErrorClass());
  });

  it("is an Error with a code and an optional hint", async () => {
    const error = await signingErrorOf(() => signing.createCert({ scope: "@nope" }));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SigningError");
    expect(typeof error.code).toBe("string");
  });

  describe("scope-required", () => {
    it.each([
      ["createCert", (s: Signing) => s.createCert({})],
      ["signFile", (s: Signing) => s.signFile("x", {} as never)],
      ["signDirectory", (s: Signing) => s.signDirectory("x", {} as never)],
      ["exportCert", (s: Signing) => s.exportCert("out.pem", "")],
      ["importCert", (s: Signing) => s.importCert("c.pem", "k.pem", "")],
    ])("%s without a scope", async (_name, call) => {
      const error = await signingErrorOf(() => call(signing));
      expect(error.code).toBe("scope-required");
      expect(error.message).toMatch(/^A scope must be specified for /);
    });
  });

  describe("unknown-scope and author-name-missing", () => {
    it("createCert for a scope that is not configured", async () => {
      const error = await signingErrorOf(() => signing.createCert({ scope: "@nope" }));
      expect(error.code).toBe("unknown-scope");
      expect(error.message).toBe("Scope '@nope' not found in config.");
      expect(error.hint).toBe(addScopeHint());
    });

    it("createCert for a scope whose author has no name", async () => {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ prefix: "/tmp/seed-test-prefix", scopes: { "@noname": { author: { name: "", email: "", url: "" } } } })
      );
      const error = await signingErrorOf(() => new Signing(dir).createCert({ scope: "@noname" }));
      expect(error.code).toBe("author-name-missing");
      expect(error.message).toBe("Required author name is missing for scope '@noname'.");
      expect(error.hint).toBe(editScopeHint("@noname"));
    });
  });

  describe("certificate-missing, certificate-expired and certificate-unreadable", () => {
    it.each([
      ["signFile", (s: Signing, d: string) => s.signFile(path.join(d, "a.bin"), { scope: "@test" })],
      ["signDirectory", (s: Signing, d: string) => s.signDirectory(d, { scope: "@test" })],
    ])("%s without a certificate", async (_name, call) => {
      writeBinaryFile(path.join(dir, "a.bin"));
      const error = await signingErrorOf(() => call(signing, dir));
      expect(error.code).toBe("certificate-missing");
      expect(error.message).toBe("No signing certificate found for scope '@test'.");
      expect(error.hint).toBe(createCertHint("@test"));
    });

    it("exportCert without a certificate", async () => {
      const error = await signingErrorOf(() => signing.exportCert(path.join(dir, "out.pem"), "@test"));
      expect(error.code).toBe("certificate-missing");
      expect(error.message).toBe("No signing certificate found for scope '@test'.");
    });

    it.each([
      ["signFile", (s: Signing, d: string) => s.signFile(path.join(d, "a.bin"), { scope: "@test" })],
      ["signDirectory", (s: Signing, d: string) => s.signDirectory(d, { scope: "@test" })],
    ])("%s with an expired certificate and no force", async (_name, call) => {
      await signing.createCert({ scope: "@test" });
      writeBinaryFile(path.join(dir, "a.bin"));
      const info = expectPresent(signing.getCertInfo("@test"), "certificate");
      jest.spyOn(signing, "getCertInfo").mockReturnValue({ ...info, isExpired: true });
      const error = await signingErrorOf(() => call(signing, dir));
      expect(error.code).toBe("certificate-expired");
      expect(error.message).toMatch(/^Signing certificate is expired/);
      expect(error.message).not.toContain("the-seed");
      expect(error.hint).toBe(replaceCertHint("@test"));
    });

    it("a scope certificate that cannot be parsed", async () => {
      await signing.createCert({ scope: "@test" });
      fs.writeFileSync(signing.scopeCertPath("@test"), "not a certificate\n");
      writeBinaryFile(path.join(dir, "a.bin"));
      const error = await signingErrorOf(() => signing.signFile(path.join(dir, "a.bin"), { scope: "@test" }));
      expect(error.code).toBe("certificate-unreadable");
    });

    it("loadTrust with a certificate file that does not exist", async () => {
      const error = await signingErrorOf(() => signing.loadTrust([path.join(dir, "missing.pem")]));
      expect(error.code).toBe("certificate-unreadable");
    });

    it("loadTrust with a file that holds no certificate", async () => {
      const file = path.join(dir, "empty.pem");
      fs.writeFileSync(file, "nothing here\n");
      const error = await signingErrorOf(() => signing.loadTrust([file]));
      expect(error.code).toBe("certificate-unreadable");
    });

    it("importCert with a certificate file that does not exist", async () => {
      const error = await signingErrorOf(() => signing.importCert(path.join(dir, "no.pem"), path.join(dir, "no-key.pem"), "@test"));
      expect(error.code).toBe("certificate-unreadable");
    });

    it("importCert with a certificate file that is not a certificate", async () => {
      const bad = path.join(dir, "bad.pem");
      fs.writeFileSync(bad, "garbage\n");
      const error = await signingErrorOf(() => signing.importCert(bad, bad, "@test"));
      expect(error.code).toBe("certificate-unreadable");
    });
  });

  describe("key-mismatch and unsupported-key", () => {
    let external: string;
    let certPath: string;

    beforeEach(async () => {
      external = createTempDir();
      writeConfig(external, { name: "External User", scope: "@external" });
      await new Signing(external).createCert({ scope: "@external" });
      certPath = path.join(external, "signing", "@external", "cert.pem");
    });

    afterEach(() => {
      fs.rmSync(external, { recursive: true, force: true });
    });

    it("importCert with a key that does not match the certificate", async () => {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const keyFile = path.join(external, "other-key.pem");
      fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
      const error = await signingErrorOf(() => signing.importCert(certPath, keyFile, "@test"));
      expect(error.code).toBe("key-mismatch");
      expect(error.message).toBe("Certificate and key do not match.");
    });

    it("importCert with an RSA key", async () => {
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const rsaCert = path.join(external, "rsa-cert.pem");
      const rsaKey = path.join(external, "rsa-key.pem");
      fs.writeFileSync(rsaCert, generateSelfSignedRSACert(privateKey));
      fs.writeFileSync(rsaKey, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
      const error = await signingErrorOf(() => signing.importCert(rsaCert, rsaKey, "@test"));
      expect(error.code).toBe("unsupported-key");
      expect(error.message).toBe("Unsupported key type. Only ECDSA keys are supported.");
    });

    it("signFile with a scope key that cannot sign is an UnsupportedSigningKey and a SigningError", async () => {
      await signing.createCert({ scope: "@test" });
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      fs.writeFileSync(signing.scopeKeyPath("@test"), privateKey.export({ type: "pkcs8", format: "pem" }) as string);
      writeBinaryFile(path.join(dir, "a.bin"));
      const error = await signingErrorOf(() => signing.signFile(path.join(dir, "a.bin"), { scope: "@test" }));
      expect(error.code).toBe("unsupported-key");
      expect(error).toBeInstanceOf(SigningModule.UnsupportedSigningKey);
    });
  });

  describe("path-not-found, not-binary, read-only and no-binaries", () => {
    beforeEach(async () => {
      await signing.createCert({ scope: "@test" });
    });

    it("signFile of a path that does not exist", async () => {
      const missing = path.join(dir, "missing.bin");
      const error = await signingErrorOf(() => signing.signFile(missing, { scope: "@test" }));
      expect(error.code).toBe("path-not-found");
      expect(error.message).toBe(`File not found: ${missing}`);
    });

    it("signDirectory of a directory that does not exist", async () => {
      const missing = path.join(dir, "missing-dir");
      const error = await signingErrorOf(() => signing.signDirectory(missing, { scope: "@test" }));
      expect(error.code).toBe("path-not-found");
      expect(error.message).toBe(`Directory not found: ${missing}`);
    });

    it("verifyFile of a path that does not exist", async () => {
      const missing = path.join(dir, "missing.bin");
      const error = await signingErrorOf(() => signing.verifyFile(missing));
      expect(error.code).toBe("path-not-found");
    });

    it("signFile of a text file", async () => {
      const text = path.join(dir, "readme.txt");
      writeTextFile(text);
      const error = await signingErrorOf(() => signing.signFile(text, { scope: "@test" }));
      expect(error.code).toBe("not-binary");
      expect(error.message).toBe(`File is not binary: ${text}`);
    });

    it("signFile of a read-only file", async () => {
      if (process.getuid?.() === 0) {
        return;
      }
      const file = path.join(dir, "ro.bin");
      writeBinaryFile(file);
      fs.chmodSync(file, 0o444);
      const error = await signingErrorOf(() => signing.signFile(file, { scope: "@test" }));
      expect(error.code).toBe("read-only");
      expect(error.message).toMatch(/^Cannot sign read-only file: /);
    });

    it("signDirectory of a directory with no binary files", async () => {
      const empty = path.join(dir, "texts");
      writeTextFile(path.join(empty, "a.txt"));
      const error = await signingErrorOf(() => signing.signDirectory(empty, { scope: "@test" }));
      expect(error.code).toBe("no-binaries");
      expect(error.message).toBe("No binary files found in directory.");
    });
  });

  describe("manifest-missing, manifest-malformed and wrong-target", () => {
    it("verifyDirectory of a directory without a manifest", async () => {
      const error = await signingErrorOf(() => signing.verifyDirectory(dir));
      expect(error.code).toBe("manifest-missing");
      expect(error.message).toBe(`No .signatures.json manifest found in ${dir}`);
    });

    it.each([
      ["not JSON", "this is not json"],
      ["a JSON array", "[]"],
      ["an unsupported version", JSON.stringify({ version: 9, files: [], certificate: "x" })],
      ["no list of files", JSON.stringify({ version: 2, certificate: "x" })],
    ])("verifyDirectory with a manifest that is %s", async (_name, text) => {
      fs.writeFileSync(path.join(dir, ".signatures.json"), text);
      const error = await signingErrorOf(() => signing.verifyDirectory(dir));
      expect(error.code).toBe("manifest-malformed");
      expect(error.message).toMatch(/^Manifest file \.signatures\.json is malformed: /);
    });

    it("verifyFile of the manifest itself", async () => {
      const manifest = path.join(dir, ".signatures.json");
      fs.writeFileSync(manifest, "{}");
      const error = await signingErrorOf(() => signing.verifyFile(manifest));
      expect(error.code).toBe("wrong-target");
      expect(error.message).toContain("is a directory manifest;");
    });

    it("verifyFile of a signature file whose signed file exists", async () => {
      writeBinaryFile(path.join(dir, "a.bin"));
      fs.writeFileSync(path.join(dir, "a.bin.sig"), "{}");
      const error = await signingErrorOf(() => signing.verifyFile(path.join(dir, "a.bin.sig")));
      expect(error.code).toBe("wrong-target");
      expect(error.message).toContain("is a signature file;");
    });
  });
});
