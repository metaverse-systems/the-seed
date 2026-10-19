import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { SigningManifestFormat } from "../src/types";
import { EARLIER_FORM_NOTICE_MAC, EARLIER_FORM_NOTICE_WINDOWS } from "../src/Trust";
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

async function setupSigning(scope = "@test"): Promise<{ signing: Signing; configDir: string; scope: string }> {
  const configDir = createTempDir();
  configDirs.push(configDir);
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

  it("checks both signatures when a file has an embedded and a detached one", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    // Sign with embedded
    await signing.signFile(peFile, { scope });
    // A .sig file that is not a signature: the detached check fails
    fs.writeFileSync(peFile + ".sig", "fake detached sig");

    const result = await signing.verifyFile(peFile);
    // The detached signature is malformed, so the file is invalid; both kinds are in `signatures`, embedded first
    expect(result.status).toBe("INVALID");
    const signatures = expectPresent(result.signatures, "signatures");
    expect(signatures).toHaveLength(2);
    expect(signatures[0].signatureType).toBe("embedded");
    expect(signatures[0].status).toBe("VALID");
    expect(signatures[1].signatureType).toBe("detached");
    expect(signatures[1].status).toBe("INVALID");
    expect(result.warnings.some((w: string) => /both/i.test(w))).toBe(true);
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

// A file in no known program format that signFile still treats as binary (it refuses plain text, so a text file cannot carry a detached signature)
const OPAQUE_DATA = Buffer.from([0x6f, 0x70, 0x61, 0x71, 0x75, 0x65, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x00, 0xff, 0xfe, 0x0a]);

// ── both signatures and other edge cases ─────────────────────
//
// Wording these tests fix:
//   - the stale detached signature reason contains "stale detached signature"
//   - the warning for a file with both kinds contains the word "both"
//   - the native component reason contains "native component"
//   - the errors for a signature file and a manifest are
//     "<absolute path> is a signature file; verify <absolute path without .sig> instead" and
//     "<absolute path> is a directory manifest; verify the directory <absolute directory> instead"

describe("verifyFile with both kinds of signature and other edge cases", () => {
  let A: { signing: Signing; configDir: string; scope: string };
  let B: { signing: Signing; configDir: string; scope: string };
  let tempDir: string;
  let savedHome: string | undefined;
  const addonPath = path.join(__dirname, "..", "native", "build", "Release", "dependency_lister.node");

  beforeAll(async () => {
    savedHome = process.env.HOME;
    process.env.HOME = createTempDir();
    configDirs.push(process.env.HOME);
    A = await setupSigning("@ta");
    B = await setupSigning("@tb");
  });

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    jest.dontMock(addonPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    for (const dir of configDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an embedded signature and a detached one made afterwards are both checked and the file is valid", async () => {
    const file = copyFixture("tiny.exe", tempDir);
    await A.signing.signFile(file, { scope: "@ta" });
    await A.signing.signFile(file, { scope: "@ta", detached: true });
    expect(fs.existsSync(file + ".sig")).toBe(true);

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("VALID");
    const signatures = expectPresent(result.signatures, "signatures");
    expect(signatures.map((entry) => [entry.signatureType, entry.status])).toEqual([
      ["embedded", "VALID"],
      ["detached", "VALID"],
    ]);
    expect(result.warnings.some((w: string) => /both/i.test(w))).toBe(true);
  });

  it("a stale detached signature put back after signing in place makes the file invalid and is named as stale", async () => {
    const file = copyFixture("tiny.exe", tempDir);
    await A.signing.signFile(file, { scope: "@ta", detached: true });
    const kept = fs.readFileSync(file + ".sig");
    // Signing in place removes a .sig beside the file; the old one is then put back
    await A.signing.signFile(file, { scope: "@ta" });
    fs.writeFileSync(file + ".sig", kept);

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("INVALID");
    expect(result.reason).toMatch(/stale detached signature/i);
    const signatures = expectPresent(result.signatures, "signatures");
    expect(signatures.map((entry) => [entry.signatureType, entry.status])).toEqual([
      ["embedded", "VALID"],
      ["detached", "INVALID"],
    ]);
  });

  it("an intact embedded signature from A with a detached one from B is intact but not trusted in A", async () => {
    const file = copyFixture("tiny.exe", tempDir);
    await A.signing.signFile(file, { scope: "@ta" });
    await B.signing.signFile(file, { scope: "@tb", detached: true });

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("UNTRUSTED");
    const signatures = expectPresent(result.signatures, "signatures");
    expect(signatures.map((entry) => [entry.signatureType, entry.status])).toEqual([
      ["embedded", "VALID"],
      ["detached", "UNTRUSTED"],
    ]);
  });

  describe("without the native component", () => {
    /** A Signing whose native addon cannot be loaded; the mock stays active until the case ends. */
    function signingWithoutAddon(configDir: string): Signing {
      let created: Signing | undefined;
      jest.isolateModules(() => {
        jest.doMock(addonPath, () => {
          throw new Error("the native component cannot be loaded");
        });
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module instance is needed for each case
        const module = require("../src/Signing") as { default: new (dir: string) => Signing };
        created = new module.default(configDir);
      });
      return expectPresent(created, "Signing without the addon");
    }

    it("a Windows program with an embedded signature is not checked, with the native component named", async () => {
      const file = copyFixture("tiny.exe", tempDir);
      await A.signing.signFile(file, { scope: "@ta" });

      const result = await signingWithoutAddon(A.configDir).verifyFile(file);
      expect(result.status).toBe("NOT_CHECKED");
      expect(result.integrity.state).toBe("not-checked");
      expect(result.reason).toMatch(/native component/i);
    });

    it("a Mac program with an embedded signature is not checked, with the native component named", async () => {
      const file = copyFixture("tiny-macho-arm64", tempDir);
      await A.signing.signFileMachO(file, "@ta");

      const result = await signingWithoutAddon(A.configDir).verifyFile(file);
      expect(result.status).toBe("NOT_CHECKED");
      expect(result.reason).toMatch(/native component/i);
    });

    it("a binary file in no known program format still verifies by its detached signature without the native component", async () => {
      const file = path.join(tempDir, "opaque.dat");
      fs.writeFileSync(file, OPAQUE_DATA);
      await A.signing.signFile(file, { scope: "@ta", detached: true });

      const result = await signingWithoutAddon(A.configDir).verifyFile(file);
      expect(result.status).toBe("VALID");
      expect(result.signatureType).toBe("detached");
    });
  });

  it("refuses a .sig path whose file exists, naming the file to verify instead", async () => {
    const file = path.join(tempDir, "opaque.dat");
    fs.writeFileSync(file, OPAQUE_DATA);
    await A.signing.signFile(file, { scope: "@ta", detached: true });

    await expect(A.signing.verifyFile(file + ".sig")).rejects.toThrow(`${file}.sig is a signature file; verify ${file} instead`);
  });

  it("refuses .signatures.json, naming the directory to verify instead", async () => {
    const manifest = path.join(tempDir, ".signatures.json");
    fs.writeFileSync(manifest, "{}");

    await expect(A.signing.verifyFile(manifest)).rejects.toThrow(`${manifest} is a directory manifest; verify the directory ${tempDir} instead`);
  });
});

// Choices where the contracts leave the shape open:
//   - the outcomes asserted for the earlier-form files are the ones the earlier tool gave for the same files with the same
//     trust inputs: with the fixture certificate supplied, VALID / intact / trusted; with a scope that holds another certificate,
//     UNTRUSTED / intact / untrusted (unknown-signer); the notice is the only warning
//   - the notice texts are compared as whole warning strings, not by matching words
describe("earlier-form signatures", () => {
  const EARLIER = path.join(__dirname, "fixtures", "binaries", "earlier-form");
  const FORMS: Array<{ name: string; notice: string }> = [
    { name: "tiny.exe", notice: EARLIER_FORM_NOTICE_WINDOWS },
    { name: "tiny.msi", notice: EARLIER_FORM_NOTICE_WINDOWS },
    { name: "tiny-macho-universal", notice: EARLIER_FORM_NOTICE_MAC },
  ];
  let A: { signing: Signing; configDir: string; scope: string };
  let dir: string;

  beforeAll(async () => {
    A = await setupSigning("@A");
  });

  beforeEach(() => {
    dir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const configDir of configDirs.splice(0)) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  function earlierCopy(name: string): string {
    const file = path.join(dir, name);
    fs.copyFileSync(path.join(EARLIER, name), file);
    return file;
  }

  it.each(FORMS)("$name with the fixture certificate supplied: VALID, intact, trusted, with the notice for its form", async ({ name, notice }) => {
    const result = await A.signing.verifyFile(earlierCopy(name), { trust: A.signing.loadTrust([path.join(EARLIER, "cert.pem")]) });
    expect(result.status).toBe("VALID");
    expect(result.integrity.state).toBe("intact");
    expect(result.trust.state).toBe("trusted");
    expect(result.warnings).toEqual([notice]);
  });

  it.each(FORMS)("$name with only another scope trusted: UNTRUSTED, intact, with the same notice", async ({ name, notice }) => {
    const result = await A.signing.verifyFile(earlierCopy(name), { trust: A.signing.loadTrust() });
    expect(result.status).toBe("UNTRUSTED");
    expect(result.integrity.state).toBe("intact");
    expect(result.trust.state).toBe("untrusted");
    expect(result.trust.reason).toBe("unknown-signer");
    expect(result.warnings).toEqual([notice]);
  });

  it("the Mac fixture's certificate serial has its top bit set and the signer is still found", async () => {
    const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(EARLIER, "cert.pem")));
    expect(parseInt(certificate.serialNumber.slice(0, 2), 16) & 0x80).not.toBe(0);

    const result = await A.signing.verifyFile(earlierCopy("tiny-macho-universal"), { trust: A.signing.loadTrust([path.join(EARLIER, "cert.pem")]) });
    expect(result.trust.state).toBe("trusted");
    expect(result.signer).toBeDefined();
    expect(result.slices).toHaveLength(2);
    for (const slice of result.slices ?? []) {
      expect(slice.state).toBe("intact");
      expect(slice.signerFingerprint).toBeDefined();
    }
  });

  it.each(["tiny.exe", "tiny.msi", "tiny-macho-universal"])("%s signed now by the tool carries neither notice", async (name) => {
    const original = name === "tiny.exe" ? path.join(__dirname, "fixtures", "binaries", name) : path.join(__dirname, "fixtures", "binaries", "genuine", name);
    const file = path.join(dir, name);
    fs.copyFileSync(original, file);
    await A.signing.signFile(file, { scope: A.scope });

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("VALID");
    expect(result.warnings).not.toContain(EARLIER_FORM_NOTICE_WINDOWS);
    expect(result.warnings).not.toContain(EARLIER_FORM_NOTICE_MAC);
  });
});
