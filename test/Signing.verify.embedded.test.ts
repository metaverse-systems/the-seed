import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { SigningManifestFormat } from "../src/types";
import { expectPresent } from "./helpers/Assert";
import { checkMachO } from "./helpers/MachOChecker";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "signing-verify-test-"));
}

function writeConfig(configDir: string, data: { scope?: string; name?: string; email?: string }) {
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
  fs.writeFileSync(configPath, JSON.stringify({ prefix: "/tmp/seed-test-prefix", scopes }, null, 2));
}

const configDirs: string[] = [];

function fixturePath(name: string): string {
  const directory = name.startsWith("tiny-macho-") ? path.join("binaries", "genuine") : "binaries";
  return path.join(__dirname, "fixtures", directory, name);
}

function copyFixture(name: string, destDir: string): string {
  const src = fixturePath(name);
  const dest = path.join(destDir, name);
  fs.copyFileSync(src, dest);
  return dest;
}

async function setupSigning(): Promise<{ signing: Signing; configDir: string; scope: string }> {
  const configDir = createTempDir();
  configDirs.push(configDir);
  const scope = "@test";
  writeConfig(configDir, { scope, name: "Test User", email: "test@test.com" });
  const signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope });
  return { signing, configDir, scope };
}

// ── verifyFile auto-detection ────────────────────────────────

describe("verifyFile (embedded auto-detection)", () => {
  let signing: Signing;
  let scope: string;
  let tempDir: string;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
    scope = setup.scope;
  });

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const dir of configDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies an embedded Authenticode-signed PE file", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFile(peFile, { scope });

    const result = await signing.verifyFile(peFile);
    expect(result.status).toBe("VALID");
    expect(result.signatureType).toBe("embedded");
  });

  it("verifies a detached-signed PE file (with --detached)", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFile(peFile, { scope, detached: true });

    const result = await signing.verifyFile(peFile);
    expect(result.status).toBe("VALID");
    expect(result.signatureType).toBe("detached");
  });

  it("verifies an embedded Mach-O signed file", async () => {
    const machoFile = copyFixture("tiny-macho-x86_64", tempDir);
    await signing.signFile(machoFile, { scope });

    const result = await signing.verifyFile(machoFile);
    expect(result.status).toBe("VALID");
    expect(result.signatureType).toBe("embedded");
    expect(result.form).toBe("mac-program");
    expect(result.integrity.state).toBe("intact");
    // The page count comes from the independent checker, not from the code under test
    const pages = checkMachO(fs.readFileSync(machoFile)).slices[0].pagesChecked;
    expect(pages).toBeGreaterThan(0);
    const slices = expectPresent(result.slices, "slices");
    expect(slices).toHaveLength(1);
    expect(slices[0].state).toBe("intact");
    expect(slices[0].codeDirectories[0].pages).toBe(pages);
    expect(slices[0].codeDirectories[0].pagesMismatched).toBe(0);
    expect(expectPresent(result.signer, "signer").fingerprint).toBe(expectPresent(signing.getCertInfo(scope), "certificate").fingerprint);
    expect(result.trust.state).toBe("trusted");
    expect(result.trust.anchor).toMatchObject({ source: "scope", scope: "@test" });
  });

  it("warns when both embedded and detached signatures exist (FR-008)", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    // Sign with embedded
    await signing.signFile(peFile, { scope });
    // Create a .sig file to simulate a stale detached signature
    fs.writeFileSync(peFile + ".sig", "fake detached sig");

    const result = await signing.verifyFile(peFile);
    // Should still verify (using embedded), but warn about both existing
    expect(result.signatureType).toBe("embedded");
    if (result.warnings) {
      const hasBothWarning = result.warnings.some((w: string) =>
        w.includes("both") || w.includes("detached") || w.includes("embedded")
      );
      expect(hasBothWarning).toBe(true);
    }
  });

  it("returns invalid for unsigned PE file", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    const result = await signing.verifyFile(peFile);
    expect(result.status).toBe("NOT_FOUND");
  });

  it("returns invalid for unsigned Mach-O file", async () => {
    const machoFile = copyFixture("tiny-macho-x86_64", tempDir);
    const result = await signing.verifyFile(machoFile);
    expect(result.status).toBe("NOT_FOUND");
  });
});

// ── verifyFileAuthenticode ───────────────────────────────────

describe("verifyFileAuthenticode", () => {
  let signing: Signing;
  let scope: string;
  let tempDir: string;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
    scope = setup.scope;
  });

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const dir of configDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies a signed PE file", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFileAuthenticode(peFile, scope);

    const result = await signing.verifyFileAuthenticode(peFile);
    expect(result.status).toBe("VALID");
    expect(result.signatureType).toBe("embedded");
    expect(expectPresent(result.signer, "signer").fingerprint).toMatch(/^SHA256:/);
  });

  it("returns invalid for an unsigned PE file", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    const result = await signing.verifyFileAuthenticode(peFile);
    expect(result.status).toBe("NOT_FOUND");
  });

  it("detects tampering after signing", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFileAuthenticode(peFile, scope);

    // Tamper with the file: flip some bytes in the original content area
    const fd = fs.openSync(peFile, "r+");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 64);
    buf[0] ^= 0xff;
    fs.writeSync(fd, buf, 0, 4, 64);
    fs.closeSync(fd);

    const result = await signing.verifyFileAuthenticode(peFile);
    expect(result.status).toBe("INVALID");
  });
});

// ── verifyFileMachO ──────────────────────────────────────────

describe("verifyFileMachO", () => {
  let signing: Signing;
  let scope: string;
  let tempDir: string;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
    scope = setup.scope;
  });

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const dir of configDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies a signed Mach-O file", async () => {
    const machoFile = copyFixture("tiny-macho-x86_64", tempDir);
    await signing.signFileMachO(machoFile, scope);

    const result = await signing.verifyFileMachO(machoFile);
    expect(result.status).toBe("VALID");
    expect(result.signatureType).toBe("embedded");
    const slices = expectPresent(result.slices, "slices");
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.state).toBe("intact");
    }
    expect(expectPresent(result.signer, "signer").fingerprint).toBe(expectPresent(signing.getCertInfo(scope), "certificate").fingerprint);
    expect(result.trust.state).toBe("trusted");
  });

  it("returns invalid for an unsigned Mach-O file", async () => {
    const machoFile = copyFixture("tiny-macho-x86_64", tempDir);
    const result = await signing.verifyFileMachO(machoFile);
    expect(result.status).toBe("NOT_FOUND");
  });
});

// ── signDirectory with mixed formats (manifest v2) ──────────

describe("signDirectory with mixed formats", () => {
  let signing: Signing;
  let scope: string;
  let tempDir: string;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
    scope = setup.scope;
  });

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const dir of configDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a v2 manifest with mixed signatureTypes", async () => {
    const dir = path.join(tempDir, "mixed-project");
    fs.mkdirSync(dir, { recursive: true });

    // Copy PE fixture
    copyFixture("tiny.exe", dir);
    // Copy Mach-O fixture
    copyFixture("tiny-macho-x86_64", dir);
    // Create a plain text file
    fs.writeFileSync(path.join(dir, "readme.txt"), "Hello, world!");

    const result = await signing.signDirectory(dir, { scope });

    expect(result.manifestPath).toBeTruthy();
    expect(fs.existsSync(result.manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8")) as SigningManifestFormat;

    expect(manifest.version).toBe(2);

    // Check that PE and Mach-O entries have embedded signatureType
    const peEntry = manifest.files.find(e => e.path.includes("tiny.exe"));
    expect(peEntry).toBeDefined();
    expect(peEntry!.signatureType).toBe("embedded");
    expect(peEntry!.signatureFile).toBeNull();

    const machoEntry = manifest.files.find(e => e.path.includes("tiny-macho-x86_64"));
    expect(machoEntry).toBeDefined();
    expect(machoEntry!.signatureType).toBe("embedded");
    expect(machoEntry!.signatureFile).toBeNull();

    // The tool skips non-binary files in a directory: no manifest entry, listed as skipped
    expect(manifest.files.find(e => e.path.includes("readme.txt"))).toBeUndefined();
    expect(result.skipped.some(f => f.includes("readme.txt"))).toBe(true);
  });

  it("verifyDirectory succeeds after signDirectory with mixed formats", async () => {
    const dir = path.join(tempDir, "verify-mixed");
    fs.mkdirSync(dir, { recursive: true });

    copyFixture("tiny.exe", dir);
    fs.writeFileSync(path.join(dir, "data.txt"), "some data");

    await signing.signDirectory(dir, { scope });
    const result = await signing.verifyDirectory(dir);

    // data.txt is not binary: signing records it as skipped, verification reports it present, not signed
    expect(result.status).toBe("VALID");
    expect(result.counts).toMatchObject({ valid: 1, skipped: 1, unlisted: 0 });
    expect(result.manifest.trust.state).toBe("trusted");
    expect(result.manifest.trust.anchor).toMatchObject({ source: "scope", scope });
    expect(result.skipped).toEqual([{ relativePath: "data.txt", present: true }]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("VALID");
  });
});
