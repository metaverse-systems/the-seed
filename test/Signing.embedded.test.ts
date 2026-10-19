import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Signing from "../src/Signing";
import * as x509 from "@peculiar/x509";
import { buildSignatureContainer } from "../src/CmsBuilder";
import { readSignedData } from "../src/CmsReader";
import { checkMachO } from "./helpers/MachOChecker";
import { CfbPackage, loadReference, parsePackage, storedDigest } from "./helpers/CfbChecker";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { makeUniversal } from "./helpers/Universal";

/**
 * Create a temporary directory for test isolation.
 */
const createdDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signing-embedded-test-"));
  createdDirs.push(dir);
  return dir;
}

// Removes every directory the file created, including the signing configuration directories
// that the groups keep for their whole run.
afterAll(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write a minimal config.json with a scope containing author info.
 */
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
  const full = { prefix: "/tmp/seed-test-prefix", scopes };
  fs.writeFileSync(configPath, JSON.stringify(full, null, 2));
}

/**
 * Get path to test fixture in binaries directory.
 */
function fixturePath(name: string): string {
  return path.join(__dirname, "fixtures", "binaries", name);
}

/**
 * Get path to a genuine Mac sample (built by a real linker) in the fixtures.
 */
function genuinePath(name: string): string {
  return path.join(__dirname, "fixtures", "binaries", "genuine", name);
}

/**
 * Copy a genuine Mac sample to a temp directory for safe mutation.
 */
function copyGenuine(name: string, destDir: string): string {
  const dest = path.join(destDir, name);
  fs.copyFileSync(genuinePath(name), dest);
  return dest;
}

const msiReference = loadReference(path.join(__dirname, "fixtures", "binaries", "genuine", "msi-reference.txt"));

/**
 * Copy an installer sample to a temp directory for safe mutation.
 */
// The name of what a call throws: the addon's TypeError comes from outside
// the Jest realm, so `toThrow(TypeError)` does not recognise it
function thrownName(call: () => unknown): string | null {
  try {
    call();
  } catch (err) {
    return (err as Error).name;
  }
  return null;
}

function copyMsi(name: string, destDir: string, as?: string): string {
  const dest = path.join(destDir, as || name);
  fs.copyFileSync(genuinePath(name), dest);
  return dest;
}

/**
 * Load the compiled addon directly, for the calls that have no wrapper.
 */
function loadAddon(): Record<string, (...args: unknown[]) => unknown> {
  return require("../native/build/Release/dependency_lister.node");
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Run the independent Python checker of libthe-seed on a file. Returns null,
 * after reporting the skipped check, when python3 or the checker is missing
 * (an error when THE_SEED_REQUIRE_TOOLS=1).
 */
function runPythonChecker(file: string): { status: number | null; output: string } | null {
  const checker = path.join(__dirname, "..", "..", "libthe-seed", "tests", "fixtures", "check_pages.py");
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  if (!optionalExternalCheck("libthe-seed check_pages.py", hasPython && fs.existsSync(checker), hasPython ? "libthe-seed/tests/fixtures/check_pages.py not found" : "python3 not found")) {
    return null;
  }
  const run = spawnSync("python3", [checker, file], { encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

/**
 * Copy a fixture to a temp directory for safe mutation.
 */
function copyFixture(name: string, destDir: string): string {
  const src = fixturePath(name);
  const dest = path.join(destDir, name);
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * Set up a signing instance with a test cert.
 */
async function setupSigning(): Promise<{ signing: Signing; configDir: string; scope: string }> {
  const configDir = createTempDir();
  const scope = "@test";
  writeConfig(configDir, { scope, name: "Test User", email: "test@test.com" });
  const signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope });
  return { signing, configDir, scope };
}

// ── Format Detection Tests ──────────────────────────────────

describe("detectBinaryFormat", () => {
  let signing: Signing;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
  });

  it("detects PE format for tiny.exe", () => {
    const result = signing.detectBinaryFormat(fixturePath("tiny.exe"));
    expect(result.format).toBe("pe");
    expect(result.subFormat).toBe("pe32+");
  });

  it("detects Mach-O format for x86_64 binary", () => {
    const result = signing.detectBinaryFormat(fixturePath("tiny-macho-x86_64"));
    expect(result.format).toBe("macho");
    expect(["macho64", "macho32"]).toContain(result.subFormat);
  });

  it("detects Mach-O format for arm64 binary", () => {
    const result = signing.detectBinaryFormat(fixturePath("tiny-macho-arm64"));
    expect(result.format).toBe("macho");
    expect(["macho64", "macho32"]).toContain(result.subFormat);
  });

  it("detects fat format for universal binary", () => {
    const result = signing.detectBinaryFormat(fixturePath("tiny-macho-universal"));
    expect(result.format).toBe("macho");
    expect(result.subFormat).toBe("fat");
  });

  it("detects other format for plain text", () => {
    const result = signing.detectBinaryFormat(fixturePath("plain.txt"));
    expect(result.format).toBe("other");
    expect(result.subFormat).toBeNull();
  });

  it("detects MSI format for tiny.msi", () => {
    const result = signing.detectBinaryFormat(fixturePath("tiny.msi"));
    expect(result.format).toBe("msi");
    expect(result.subFormat).toBeNull();
  });
});

describe("getSigningStrategy", () => {
  let signing: Signing;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
  });

  it("returns embedded for PE files", () => {
    const strategy = signing.getSigningStrategy(fixturePath("tiny.exe"));
    expect(strategy).toBe("embedded");
  });

  it("returns embedded for Mach-O files", () => {
    const strategy = signing.getSigningStrategy(fixturePath("tiny-macho-x86_64"));
    expect(strategy).toBe("embedded");
  });

  it("returns detached for plain files", () => {
    const strategy = signing.getSigningStrategy(fixturePath("plain.txt"));
    expect(strategy).toBe("detached");
  });

  it("returns detached when --detached flag is set", () => {
    const strategy = signing.getSigningStrategy(fixturePath("tiny.exe"), { detached: true });
    expect(strategy).toBe("detached");
  });

  it("returns detached for Mach-O when --detached flag is set", () => {
    const strategy = signing.getSigningStrategy(fixturePath("tiny-macho-x86_64"), { detached: true });
    expect(strategy).toBe("detached");
  });

  it("returns embedded for MSI files", () => {
    const strategy = signing.getSigningStrategy(fixturePath("tiny.msi"));
    expect(strategy).toBe("embedded");
  });

  it("returns detached for MSI when --detached flag is set", () => {
    const strategy = signing.getSigningStrategy(fixturePath("tiny.msi"), { detached: true });
    expect(strategy).toBe("detached");
  });
});

// ── PE Embedded Signing Tests ────────────────────────────────

describe("signFileAuthenticode", () => {
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

  it("signs a PE file with embedded Authenticode signature", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    const result = await signing.signFileAuthenticode(peFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
    expect(result.fingerprint).toMatch(/^SHA256:/);
    expect(result.warnings).toEqual(expect.any(Array));
  });

  it("removes stale .sig file when embedding", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    // Create a stale .sig file
    fs.writeFileSync(peFile + ".sig", "stale sig data");

    const result = await signing.signFileAuthenticode(peFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(fs.existsSync(peFile + ".sig")).toBe(false);
    expect(result.warnings).toContain("Removed stale .sig file");
  });

  it("signs and verifies a PE file whose size is not 8-byte aligned", async () => {
    // Copy the fixture and append extra bytes to make it non-8-byte-aligned.
    // This reproduces the bug where EmbedSignature adds alignment padding
    // that isn't included in the signing digest but IS included during
    // verification, causing a digest mismatch.
    const peFile = copyFixture("tiny.exe", tempDir);
    // tiny.exe is 1024 bytes (aligned). Append 3 bytes → 1027 (1027 % 8 = 3).
    const fd = fs.openSync(peFile, "a");
    fs.writeSync(fd, Buffer.from([0xAA, 0xBB, 0xCC]));
    fs.closeSync(fd);
    expect(fs.statSync(peFile).size % 8).not.toBe(0);

    const result = await signing.signFileAuthenticode(peFile, scope);
    expect(result.signatureType).toBe("embedded");

    const verifyResult = await signing.verifyFileAuthenticode(peFile);
    expect(verifyResult.status).toBe("VALID");
  });
});

// ── Mach-O Embedded Signing Tests ────────────────────────────

describe("signFileMachO", () => {
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

  // The older stub files in binaries/ are byte-swapped (big-endian) images that
  // the library now declines, so these three cases use the genuine samples.
  it("signs a Mach-O file with embedded code signature", async () => {
    const machoFile = copyGenuine("tiny-macho-x86_64", tempDir);
    const result = await signing.signFileMachO(machoFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
    expect(result.fingerprint).toMatch(/^SHA256:/);
  });

  it("signs an arm64 Mach-O file", async () => {
    const machoFile = copyGenuine("tiny-macho-arm64", tempDir);
    const result = await signing.signFileMachO(machoFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
  });
});

// ── Mach-O signing of genuine samples (real addon) ──────────

describe("signFileMachO on genuine samples", () => {
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

  /** Check a signed file with both independent checkers. */
  function expectConsistent(file: string, sliceCount: number) {
    const report = checkMachO(fs.readFileSync(file));
    expect(report.problems).toEqual([]);
    expect(report.slices).toHaveLength(sliceCount);
    for (const slice of report.slices) {
      expect(slice.signatureCommands).toBe(1);
      expect(slice.pagesChecked).toBeGreaterThan(0);
      expect(slice.pagesMismatched).toBe(0);
    }
    const python = runPythonChecker(file);
    if (python !== null) {
      expect(python.output).toContain("result ok");
      expect(python.status).toBe(0);
    }
    return report;
  }

  it("the checker accepts the linker's own ad-hoc signatures", () => {
    expectConsistent(genuinePath("tiny-macho-arm64-adhoc"), 1);
    expectConsistent(genuinePath("tiny-macho-x86_64-adhoc"), 1);
    expectConsistent(genuinePath("tiny-macho-universal-adhoc"), 2);
  });

  it("signs a thin arm64 program so that every page hash is correct", async () => {
    const file = copyGenuine("tiny-macho-arm64", tempDir);
    const result = await signing.signFileMachO(file, scope);

    expect(result.signatureType).toBe("embedded");
    expectConsistent(file, 1);
  });

  it("signs a thin x86-64 program so that every page hash is correct", async () => {
    const file = copyGenuine("tiny-macho-x86_64", tempDir);
    const result = await signing.signFileMachO(file, scope);

    expect(result.signatureType).toBe("embedded");
    expectConsistent(file, 1);
  });

  it("signs every slice of a universal program and reports each one", async () => {
    const file = copyGenuine("tiny-macho-universal", tempDir);
    const result = await signing.signFileMachO(file, scope);

    expect(result.signatureType).toBe("embedded");
    expectConsistent(file, 2);
    expect(result.warnings).toContain("Signed slice arm64");
    expect(result.warnings).toContain("Signed slice x86_64");
  });

  it.each(["tiny-macho-arm64", "tiny-macho-x86_64", "tiny-macho-universal"])(
    "signing %s again replaces the signature and keeps the length",
    async (name) => {
      const file = copyGenuine(name, tempDir);
      await signing.signFileMachO(file, scope);
      const lengthAfterFirst = fs.statSync(file).size;

      const second = await signing.signFileMachO(file, scope);
      expect(second.warnings).toContain("Replaced existing embedded signature");
      expect(fs.statSync(file).size).toBe(lengthAfterFirst);

      const third = await signing.signFileMachO(file, scope);
      expect(third.warnings).toContain("Replaced existing embedded signature");
      expect(fs.statSync(file).size).toBe(lengthAfterFirst);

      const report = expectConsistent(file, name.includes("universal") ? 2 : 1);
      for (const slice of report.slices) {
        expect(slice.signatureCommands).toBe(1);
      }
    }
  );

  it.each([
    ["tiny-macho-arm64-adhoc", 1],
    ["tiny-macho-x86_64-adhoc", 1],
    ["tiny-macho-universal-adhoc", 2],
  ] as const)("replaces the foreign ad-hoc signature of %s", async (name, sliceCount) => {
    const file = copyGenuine(name, tempDir);
    const before = fs.readFileSync(file);
    const adhoc = checkMachO(before);

    const result = await signing.signFileMachO(file, scope);

    expect(result.warnings).toContain("Replaced existing embedded signature");
    const after = checkMachO(fs.readFileSync(file));
    expectConsistent(file, sliceCount);
    expect(fs.readFileSync(file).equals(before)).toBe(false);
    // The new signature carries a certificate signature, so it is larger.
    expect(after.slices[0].superBlobLength).toBeGreaterThan(adhoc.slices[0].superBlobLength);
  });

  it("refuses the program without room for the signature command and leaves it byte-identical", async () => {
    const file = copyGenuine("tiny-macho-x86_64-nospace", tempDir);
    const before = fs.readFileSync(file);

    await expect(signing.signFileMachO(file, scope)).rejects.toThrow(/no room for the code signature command/);
    await expect(signing.signFileMachO(file, scope)).rejects.toThrow(/-headerpad/);

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(file + ".sig")).toBe(false);
  });

  describe("removed addon exports", () => {
    // The real addon is loaded directly; there is no mock.
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
    const addon = require("../native/build/Release/dependency_lister.node") as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    it("machoComputeCodeDirectory throws and names the replacement", () => {
      expect(() => addon.machoComputeCodeDirectory(copyGenuine("tiny-macho-arm64", tempDir), "id")).toThrow(
        "machoComputeCodeDirectory was removed in libthe-seed 0.6.0: use machoPrepareSignature and machoCompleteSignature"
      );
    });

    it("machoEmbedSignature throws and names the replacement", () => {
      expect(() => addon.machoEmbedSignature(copyGenuine("tiny-macho-arm64", tempDir), Buffer.alloc(8))).toThrow(
        "machoEmbedSignature was removed in libthe-seed 0.6.0: use machoPrepareSignature and machoCompleteSignature"
      );
    });

    it("exposes the three new calls", () => {
      expect(typeof addon.machoPrepareSignature).toBe("function");
      expect(typeof addon.machoCompleteSignature).toBe("function");
      expect(typeof addon.machoStripSignature).toBe("function");
    });
  });
});

// ── signFile() Dispatch Tests ────────────────────────────────

describe("signFile dispatch", () => {
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

  it("dispatches PE to embedded signing", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    const result = await signing.signFile(peFile, { scope });

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
  });

  it("dispatches Mach-O to embedded signing", async () => {
    const machoFile = copyGenuine("tiny-macho-x86_64", tempDir);
    const result = await signing.signFile(machoFile, { scope });

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
  });

  it("uses detached signing when --detached flag is set for PE", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    const result = await signing.signFile(peFile, { scope, detached: true });

    expect(result.signatureType).toBe("detached");
    expect(result.signaturePath).not.toBeNull();
    expect(fs.existsSync(result.signaturePath as string)).toBe(true);
  });

  it("dispatches MSI to embedded signing", async () => {
    const msiFile = copyMsi("tiny.msi", tempDir);
    const result = await signing.signFile(msiFile, { scope });

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
  });

  it("uses detached signing when --detached flag is set for MSI", async () => {
    const msiFile = copyFixture("tiny.msi", tempDir);
    const result = await signing.signFile(msiFile, { scope, detached: true });

    expect(result.signatureType).toBe("detached");
    expect(result.signaturePath).not.toBeNull();
    expect(fs.existsSync(result.signaturePath as string)).toBe(true);
  });
});

// ── MSI Embedded Signing Tests ──────────────────────────────

describe("signFileMsi", () => {
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

  it("signs an MSI file with embedded Authenticode signature", async () => {
    const msiFile = copyMsi("tiny.msi", tempDir);
    const result = await signing.signFileMsi(msiFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
    expect(result.fingerprint).toMatch(/^SHA256:/);
    expect(result.warnings).toEqual(expect.any(Array));
  });

  it("removes stale .sig file when embedding", async () => {
    const msiFile = copyMsi("tiny.msi", tempDir);
    fs.writeFileSync(msiFile + ".sig", "stale sig data");

    const result = await signing.signFileMsi(msiFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(fs.existsSync(msiFile + ".sig")).toBe(false);
    expect(result.warnings).toContain("Removed stale .sig file");
  });

  it("signs and verifies an MSI file round-trip", async () => {
    const msiFile = copyMsi("tiny.msi", tempDir);
    const signResult = await signing.signFileMsi(msiFile, scope);
    expect(signResult.signatureType).toBe("embedded");

    const verifyResult = await signing.verifyFileMsi(msiFile);
    expect(verifyResult.status).toBe("VALID");
    expect(verifyResult.trust.state).toBe("trusted");
    expect(verifyResult.signatureType).toBe("embedded");
  });

  it("re-signs an already-signed MSI file", async () => {
    const msiFile = copyMsi("tiny.msi", tempDir);
    await signing.signFileMsi(msiFile, scope);
    const result = await signing.signFileMsi(msiFile, scope);

    expect(result.signatureType).toBe("embedded");
    const verifyResult = await signing.verifyFileMsi(msiFile);
    expect(verifyResult.status).toBe("VALID");
  });
});

// ── Installers signed through the real addon ────────────────

describe("installer samples and the independent checker", () => {
  const samples = [
    "tiny.msi",
    "tiny-v4.msi",
    "tiny-osslsig-small.msi",
    "tiny-osslsig-large.msi",
    "tiny-osslsig-dse.msi",
    "nested.msi",
    "legacy-the-seed-0.6.0.msi",
  ];

  it.each(samples)("%s is the recorded sample", (name) => {
    expect(sha256File(genuinePath(name))).toBe(msiReference.sample.get(name));
  });

  it.each(samples.filter((name) => !name.startsWith("legacy")))(
    "%s: fingerprint, entry count and signature size equal the recorded values",
    (name) => {
      const pkg = parsePackage(fs.readFileSync(genuinePath(name)));
      expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get(name));
      const entries = msiReference.entries.get(name)!;
      expect(pkg.countEntries()).toBe(entries.count);
      const found = pkg.findSignature();
      expect(found === null ? null : found.size).toBe(entries.signatureSize);
    }
  );

  it.each(["tiny-osslsig-small.msi", "tiny-osslsig-large.msi", "tiny-osslsig-dse.msi"])(
    "%s: the digest held in the signature is the recorded one",
    (name) => {
      const pkg = parsePackage(fs.readFileSync(genuinePath(name)));
      expect(storedDigest(pkg.signatureBytes() as Buffer)).toBe(msiReference.storedDigest.get(name));
    }
  );

  it("legacy-the-seed-0.6.0.msi: the fingerprint is the recorded one and the signature is not reachable by search", () => {
    // The recorded entry count is that of a reader that searches (it does not see the entry); the walk
    // of the whole tree sees the misplaced signature entry as a twentieth.
    const name = "legacy-the-seed-0.6.0.msi";
    const pkg = parsePackage(fs.readFileSync(genuinePath(name)));
    expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get(name));
    expect(pkg.countEntries()).toBe((msiReference.entries.get(name) as { count: number }).count + 1);
    expect(pkg.findSignature()).toBeNull();
  });
});

describe("signFileMsi on installer samples (real addon)", () => {
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

  /**
   * Sign a sample and check what the independent checker sees: a package it
   * can parse, the signature found by search, the recorded fingerprint, the
   * same digest held in the signature, and everything but the signature as
   * before.
   */
  async function signAndCheck(name: string): Promise<{ file: string; pkg: CfbPackage; before: CfbPackage }> {
    const file = copyMsi(name, tempDir);
    const before = parsePackage(fs.readFileSync(file));
    const expected = msiReference.fingerprint.get(name) as string;

    const result = await signing.signFileMsi(file, scope);
    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();

    const pkg = parsePackage(fs.readFileSync(file));
    expect(pkg.fingerprint()).toBe(expected);
    const found = pkg.findSignature();
    expect(found).not.toBeNull();
    expect(storedDigest(pkg.read(found as NonNullable<typeof found>))).toBe(expected);
    expect(pkg.findSignatureEx()).toBeNull();
    expect(pkg.listing()).toEqual(before.listing());
    expect(result.warnings.join(" ")).not.toMatch(/windows (accepts|accepted)/i);
    expect(result.warnings).toContain("Installer signature was read back: its fingerprint matches the package");
    expect(result.warnings.filter((warning: string) => /trust/i.test(warning))).toEqual([]);

    const verify = await signing.verifyFileMsi(file);
    expect(verify.status).toBe("VALID");
    return { file, pkg, before };
  }

  it("signs an unsigned version 3 package", async () => {
    const { pkg, before } = await signAndCheck("tiny.msi");
    expect(pkg.version).toBe(3);
    expect(before.findSignature()).toBeNull();
  });

  it("the warnings from signing an installer say only what signing checked and never mention trust", async () => {
    const file = copyMsi("tiny.msi", tempDir);
    const result = await signing.signFileMsi(file, scope);
    expect(result.warnings).toContain("Installer signature was read back: its fingerprint matches the package");
    expect(result.warnings.filter((warning: string) => /trust/i.test(warning))).toEqual([]);
  });

  it("signs an unsigned version 4 package and keeps its version", async () => {
    const { pkg } = await signAndCheck("tiny-v4.msi");
    expect(pkg.version).toBe(4);
    expect(pkg.sectorSize).toBe(4096);
  });

  it("keeps nested storages, class identifiers, state bits and times", async () => {
    const { pkg, before } = await signAndCheck("nested.msi");
    expect(pkg.countEntries()).toBe(before.countEntries() + 1);
  });

  it("re-signs a package signed by osslsigncode (small signature)", async () => {
    const file = copyMsi("tiny-osslsig-small.msi", tempDir);
    const result = await signing.signFileMsi(file, scope);
    expect(result.warnings).toContain("Replaced existing embedded signature");
    const pkg = parsePackage(fs.readFileSync(file));
    expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get("tiny-osslsig-small.msi"));
    expect(storedDigest(pkg.signatureBytes() as Buffer)).toBe(pkg.fingerprint());
    expect((await signing.verifyFileMsi(file)).status).toBe("VALID");
  });

  it("re-signs a package signed by osslsigncode (7,473-byte signature)", async () => {
    const { pkg } = await signAndCheck("tiny-osslsig-large.msi");
    // Our own signature is far smaller, so the package shrinks.
    expect((pkg.findSignature() as { size: number }).size).toBeLessThan(7473);
  });

  it("re-signing a package signed by osslsigncode drops the extended signature stream", async () => {
    const before = parsePackage(fs.readFileSync(genuinePath("tiny-osslsig-dse.msi")));
    expect(before.findSignatureEx()).not.toBeNull();
    const { pkg } = await signAndCheck("tiny-osslsig-dse.msi");
    expect(pkg.findSignatureEx()).toBeNull();
    expect(pkg.countEntries()).toBe(before.countEntries() - 1);
  });

  it("re-signs a package signed by version 0.6.0 of the library and repairs it", async () => {
    const name = "legacy-the-seed-0.6.0.msi";
    const file = copyMsi(name, tempDir);
    expect(parsePackage(fs.readFileSync(file)).findSignature()).toBeNull();

    const result = await signing.signFileMsi(file, scope);
    expect(result.signatureType).toBe("embedded");

    const pkg = parsePackage(fs.readFileSync(file));
    expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get(name));
    expect(pkg.findSignature()).not.toBeNull();
    expect(storedDigest(pkg.signatureBytes() as Buffer)).toBe(pkg.fingerprint());
    expect((await signing.verifyFileMsi(file)).status).toBe("VALID");
  });

  it("re-signing twice keeps the package length and the fingerprint", async () => {
    const file = copyMsi("tiny.msi", tempDir);
    await signing.signFileMsi(file, scope);
    const once = fs.statSync(file).size;
    await signing.signFileMsi(file, scope);
    await signing.signFileMsi(file, scope);
    // A DER ECDSA signature is 70 to 72 bytes, so a new signature may move the stream by one 512-byte sector
    expect(Math.abs(fs.statSync(file).size - once)).toBeLessThanOrEqual(512);
    expect(parsePackage(fs.readFileSync(file)).fingerprint()).toBe(msiReference.fingerprint.get("tiny.msi"));
    expect((await signing.verifyFileMsi(file)).status).toBe("VALID");
  });

  it("dispatches an installer through signFile to embedded signing with the same result", async () => {
    const file = copyMsi("tiny.msi", tempDir);
    const result = await signing.signFile(file, { scope });
    expect(result.signatureType).toBe("embedded");
    expect(parsePackage(fs.readFileSync(file)).fingerprint()).toBe(msiReference.fingerprint.get("tiny.msi"));
  });
});

describe("signature sizes around the 4,096-byte threshold (real addon)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A P-256 certificate with the fixed serial 01 followed by fifteen 0x11 bytes (no sign byte) and a common name of the given length. */
  async function makeSigner(nameLength: number): Promise<{ signing: Signing; scope: string; probe: number }> {
    const webcrypto = crypto.webcrypto as unknown as Crypto;
    x509.cryptoProvider.set(webcrypto);
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01" + "11".repeat(15),
      name: "CN=" + "N".repeat(nameLength),
      notBefore: new Date("2026-01-01T00:00:00Z"),
      notAfter: new Date("2036-01-01T00:00:00Z"),
      keys,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const keyObject = crypto.createPrivateKey({ key: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)), format: "der", type: "pkcs8" });

    const dir = createTempDir();
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key.pem");
    fs.writeFileSync(certPath, certificate.toString("pem"));
    fs.writeFileSync(keyPath, keyObject.export({ type: "pkcs8", format: "pem" }));

    const configDir = createTempDir();
    writeConfig(configDir, { scope: "@test", name: "Test User", email: "test@test.com" });
    const signing = new Signing(configDir);
    await signing.importCert(certPath, keyPath, "@test");

    // The size the container has with the longest P-256 signature (72 bytes)
    const probe = buildSignatureContainer({ kind: "installer", fingerprint: Buffer.alloc(32, 1) }, Buffer.from(certificate.rawData), () => Buffer.alloc(72, 2)).length;
    return { signing, scope: "@test", probe };
  }

  /**
   * A signer whose container is close to `centre` bytes without repeating anything: one certificate with a
   * name of the reference length gives its probe size, the name occurs three times (subject, issuer and
   * the signer's issuer), and a second certificate has the name length that moves the probe to `centre`.
   */
  async function signerNear(centre: number): Promise<{ signing: Signing; scope: string; probe: number }> {
    const referenceLength = 300;
    const reference = await makeSigner(referenceLength);
    return makeSigner(referenceLength + Math.round((centre - reference.probe) / 3));
  }

  it.each([
    ["just below the threshold", 4087, 4080, 4094, true],
    ["just above the threshold", 4112, 4104, 4120, false],
  ])("signs and reads back a signature %s", async (_label, centre, low, high, small) => {
    const { signing, scope, probe } = await signerNear(centre as number);
    expect(probe).toBeGreaterThanOrEqual(low as number);
    expect(probe).toBeLessThanOrEqual(high as number);
    const file = copyMsi("tiny.msi", tempDir);
    await signing.signFileMsi(file, scope);

    const pkg = parsePackage(fs.readFileSync(file));
    const found = pkg.findSignature();
    expect(found).not.toBeNull();
    const stored = found as NonNullable<typeof found>;
    // The probe uses the longest P-256 signature (72 bytes); the real one is at most that and at least 8 bytes shorter
    expect(stored.size).toBeGreaterThanOrEqual(probe - 8);
    expect(stored.size).toBeLessThanOrEqual(probe);
    expect(stored.size < 4096).toBe(small);
    expect(pkg.inMiniStream(stored)).toBe(small);
    expect(storedDigest(pkg.read(stored))).toBe(msiReference.fingerprint.get("tiny.msi"));
    expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get("tiny.msi"));
    expect((await signing.verifyFileMsi(file)).status).toBe("VALID");
  });
});

describe("tampered and mismatched installers are never reported signed (real addon)", () => {
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

  it("verify reports NOT_FOUND for a package without a signature", async () => {
    const file = copyMsi("tiny.msi", tempDir);
    const result = await signing.verifyFileMsi(file);
    expect(result.status).toBe("NOT_FOUND");
  });

  it("verify reports VALID for a package signed and unchanged (state: matches)", async () => {
    const file = copyMsi("tiny.msi", tempDir);
    await signing.signFileMsi(file, scope);
    const result = await signing.verifyFileMsi(file);
    expect(result.status).toBe("VALID");
    expect(result.trust.state).toBe("trusted");
    expect(result.signatureType).toBe("embedded");
    const check = loadAddon().msiCheckSignature(file) as { state: string; storedDigest: Buffer; computedDigest: Buffer };
    expect(check.state).toBe("matches");
    expect(check.storedDigest.toString("hex")).toBe(msiReference.fingerprint.get("tiny.msi"));
    expect(check.computedDigest.toString("hex")).toBe(msiReference.fingerprint.get("tiny.msi"));
  });

  it("verify reports INVALID (does not match) for a package changed after signing (state: mismatch)", async () => {
    const file = copyMsi("tiny.msi", tempDir);
    await signing.signFileMsi(file, scope);

    const pkg = parsePackage(fs.readFileSync(file));
    const victim = pkg
      .children(0)
      .find((c) => c.type === 2 && c.size >= 8 && c.name !== "\u0005DigitalSignature") as NonNullable<
      ReturnType<CfbPackage["find"]>
    >;
    const bytes = fs.readFileSync(file);
    bytes[pkg.fileOffsetOf(victim, 0)] ^= 0xff;
    fs.writeFileSync(file, bytes);
    expect(parsePackage(bytes).fingerprint()).not.toBe(msiReference.fingerprint.get("tiny.msi"));

    const result = await signing.verifyFileMsi(file);
    expect(result.status).toBe("INVALID");
    expect(result.reason).toMatch(/the file was changed after signing: its fingerprint differs from the one in the signature/);
    expect((loadAddon().msiCheckSignature(file) as { state: string }).state).toBe("mismatch");
  });

  it("verify reports INVALID (could not be read) for a package signed by version 0.6.0 (state: unreadable)", async () => {
    const file = copyMsi("legacy-the-seed-0.6.0.msi", tempDir);
    const result = await signing.verifyFileMsi(file);
    expect(result.status).toBe("INVALID");
    expect(result.reason).toMatch(/signature present but could not be read \(.+\)/);
    expect((loadAddon().msiCheckSignature(file) as { state: string }).state).toBe("unreadable");
  });

  it("verify reports the state of every osslsigncode sample the same way: matches the contents, then a certificate check", async () => {
    // A signature made by another tool holds the right fingerprint, so the package side matches and the
    // file is intact; its signer is not one the configuration trusts, so the result is UNTRUSTED, and
    // trusting that signer's certificate (read out by openssl, an independent tool) makes it VALID.
    // The sample with an extended signature stream cannot be compared by this tool and is not checked.
    for (const name of ["tiny-osslsig-small.msi", "tiny-osslsig-large.msi"]) {
      const file = copyMsi(name, tempDir);
      expect((loadAddon().msiCheckSignature(file) as { state: string }).state).toBe("matches");
      const result = await signing.verifyFileMsi(file);
      expect(result.status).toBe("UNTRUSTED");
      expect(result.integrity.state).toBe("intact");
      expect(result.signer?.subject.commonName).toBe("sample-check");
      expect(result.reason).not.toMatch(/does not match the package contents/);

      if (optionalExternalCheck("openssl pkcs7 -print_certs", spawnSync("openssl", ["version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).status === 0, "openssl not found")) {
        const certFile = path.join(tempDir, name + ".cert.pem");
        const signatureFile = path.join(tempDir, name + ".p7");
        fs.writeFileSync(signatureFile, loadAddon().msiExtractSignature(file) as Buffer);
        const printed = spawnSync("openssl", ["pkcs7", "-inform", "DER", "-in", signatureFile, "-print_certs"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tempDir, LC_ALL: "C", TZ: "UTC" },
        });
        expect(printed.status).toBe(0);
        fs.writeFileSync(certFile, printed.stdout);
        const trusted = await signing.verifyFileMsi(file, { trust: signing.loadTrust([certFile]) });
        expect(trusted.status).toBe("VALID");
        expect(trusted.trust.state).toBe("trusted");
      }
    }

    const dse = await signing.verifyFileMsi(copyMsi("tiny-osslsig-dse.msi", tempDir));
    expect(dse.status).toBe("NOT_CHECKED");
    expect(dse.integrity.state).toBe("not-checked");
  });

  it("a signature made for another package is refused and the file stays as it was", () => {
    const other = parsePackage(fs.readFileSync(genuinePath("tiny-osslsig-small.msi")));
    const blob = other.signatureBytes() as Buffer;
    const file = copyMsi("nested.msi", tempDir);
    const before = sha256File(file);

    expect(() => loadAddon().msiEmbedSignature(file, blob, true)).toThrow();

    expect(sha256File(file)).toBe(before);
    expect(parsePackage(fs.readFileSync(file)).findSignature()).toBeNull();
    expect(fs.readdirSync(tempDir)).toEqual(["nested.msi"]);
  });

  it("a signature made for the package itself is accepted when the digest must match", () => {
    const other = parsePackage(fs.readFileSync(genuinePath("tiny-osslsig-small.msi")));
    const blob = other.signatureBytes() as Buffer;
    const file = copyMsi("tiny.msi", tempDir);

    loadAddon().msiEmbedSignature(file, blob, true);

    const pkg = parsePackage(fs.readFileSync(file));
    expect(pkg.signatureBytes()).toEqual(blob);
    expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get("tiny.msi"));
    expect((loadAddon().msiCheckSignature(file) as { state: string }).state).toBe("matches");
  });

  it("the old two-argument call still embeds whatever signature it is given", () => {
    const other = parsePackage(fs.readFileSync(genuinePath("tiny-osslsig-small.msi")));
    const blob = other.signatureBytes() as Buffer;
    const file = copyMsi("nested.msi", tempDir);

    loadAddon().msiEmbedSignature(file, blob);

    expect(parsePackage(fs.readFileSync(file)).signatureBytes()).toEqual(blob);
    expect((loadAddon().msiCheckSignature(file) as { state: string }).state).toBe("mismatch");
  });

  it("signFileMsi on a damaged path rejects with the library's text and creates nothing", async () => {
    const file = path.join(tempDir, "missing.msi");
    await expect(signing.signFileMsi(file, scope)).rejects.toThrow();
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});

describe("signatures made by other tools (real addon, openssl and osslsigncode)", () => {
  // Wording these tests fix:
  //   - a Windows program or installer whose stored fingerprint differs from the file's:
  //       reason contains "the file was changed after signing: its fingerprint differs from the one in the signature"
  //   - an installer with an extended signature stream (\u0005MsiDigitalSignatureEx):
  //       NOT_CHECKED, integrity.reason contains "extended signature stream"
  //   - a signature whose container the verifier cannot read keeps "could not be read" (installer, from the library)
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

  const haveTools = (): boolean => spawnSync("openssl", ["version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).status === 0 && spawnSync("osslsigncode", ["--version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).status === 0;

  /** Runs a tool with an explicit environment, in the scratch directory. */
  function run(command: string, args: string[]): void {
    const result = spawnSync(command, args, {
      cwd: tempDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tempDir, LC_ALL: "C", TZ: "UTC" },
    });
    if (result.status !== 0) {
      throw new Error(command + " " + args.join(" ") + " failed: " + result.stdout + result.stderr);
    }
  }

  /** An ECDSA certificate and key made by openssl; `plain` leaves out the extensions, which makes the certificate shorter. */
  function makeCertificate(name: string, plain: boolean): { cert: string; key: string } {
    const key = path.join(tempDir, name + "-key.pem");
    const cert = path.join(tempDir, name + "-cert.pem");
    run("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    const extensions = plain ? [] : ["-addext", "keyUsage=digitalSignature", "-addext", "extendedKeyUsage=codeSigning"];
    run("openssl", ["req", "-new", "-x509", "-key", key, "-subj", "/CN=" + name, "-days", "30", "-out", cert, ...extensions]);
    return { cert, key };
  }

  function signExe(certsFile: string, key: string, out: string): void {
    run("osslsigncode", ["sign", "-certs", certsFile, "-key", key, "-h", "sha256", "-in", fixturePath("tiny.exe"), "-out", out]);
  }

  it("a Windows program signed by osslsigncode is intact but not trusted, and valid once its certificate is trusted", async () => {
    if (!optionalExternalCheck("osslsigncode and openssl", haveTools(), "openssl or osslsigncode not found")) {
      return;
    }
    const signer = makeCertificate("other-tool", false);
    const out = path.join(tempDir, "signed.exe");
    signExe(signer.cert, signer.key, out);

    const result = await signing.verifyFile(out);
    expect(result.status).toBe("UNTRUSTED");
    expect(result.form).toBe("windows-program");
    expect(result.integrity.state).toBe("intact");
    expect(result.trust.state).toBe("untrusted");
    expect(result.signer?.subject.commonName).toBe("other-tool");

    const trusted = await signing.verifyFile(out, { trust: signing.loadTrust([signer.cert]) });
    expect(trusted.status).toBe("VALID");
    expect(trusted.trust.state).toBe("trusted");
    expect(trusted.trust.anchor?.source).toBe("supplied");
  });

  it("names the signer the signer record names when another certificate comes first in the container", async () => {
    if (!optionalExternalCheck("osslsigncode and openssl", haveTools(), "openssl or osslsigncode not found")) {
      return;
    }
    const signer = makeCertificate("other-tool", false);
    // The container's certificate list is a DER SET OF, which osslsigncode orders by encoding. The extra
    // certificate has a short name and no extensions, so it is shorter than the signer's and comes first.
    const extra = makeCertificate("x", true);
    const chain = path.join(tempDir, "chain.pem");
    fs.writeFileSync(chain, fs.readFileSync(extra.cert, "utf-8") + fs.readFileSync(signer.cert, "utf-8"));
    const out = path.join(tempDir, "signed.exe");
    signExe(chain, signer.key, out);

    const extraDer = Buffer.from(new crypto.X509Certificate(fs.readFileSync(extra.cert)).raw);
    const listed = readSignedData(loadAddon().peExtractSignature(out) as Buffer).certificates;
    expect(listed).toHaveLength(2);
    expect(listed[0].equals(extraDer)).toBe(true);

    const result = await signing.verifyFile(out);
    expect(result.status).toBe("UNTRUSTED");
    expect(result.integrity.state).toBe("intact");
    expect(result.signer?.subject.commonName).toBe("other-tool");

    expect((await signing.verifyFile(out, { trust: signing.loadTrust([signer.cert]) })).status).toBe("VALID");
    // The first certificate in the container is not the signer, so trusting it does not trust the file
    expect((await signing.verifyFile(out, { trust: signing.loadTrust([extra.cert]) })).status).toBe("UNTRUSTED");
  });

  it("a byte changed in a program signed by osslsigncode is invalid: the file was changed after signing", async () => {
    if (!optionalExternalCheck("osslsigncode and openssl", haveTools(), "openssl or osslsigncode not found")) {
      return;
    }
    const signer = makeCertificate("other-tool", false);
    const out = path.join(tempDir, "signed.exe");
    signExe(signer.cert, signer.key, out);
    const bytes = fs.readFileSync(out);
    // The last byte of the original program is covered by the fingerprint
    bytes[fs.statSync(fixturePath("tiny.exe")).size - 1] ^= 0xff;
    fs.writeFileSync(out, bytes);

    const result = await signing.verifyFile(out);
    expect(result.status).toBe("INVALID");
    expect(result.integrity.state).toBe("invalid");
    expect(result.integrity.reason).toContain("the file was changed after signing: its fingerprint differs from the one in the signature");
    expect(result.signer?.subject.commonName).toBe("other-tool");
  });

  it("the installer with an extended signature stream is not checked, rather than reported as changed", async () => {
    const result = await signing.verifyFile(copyMsi("tiny-osslsig-dse.msi", tempDir));
    expect(result.status).toBe("NOT_CHECKED");
    expect(result.form).toBe("installer");
    expect(result.integrity.state).toBe("not-checked");
    expect(result.integrity.reason).toContain("extended signature stream");
    expect(result.trust.state).toBe("not-applicable");
  });

  it("the installer signed by version 0.6.0 stays invalid: it could not be read", async () => {
    // Through the installer verifier directly, as the earlier case did: verifyFile does not take this file as signed
    const result = await signing.verifyFileMsi(copyMsi("legacy-the-seed-0.6.0.msi", tempDir));
    expect(result.status).toBe("INVALID");
    expect(result.integrity.reason).toMatch(/could not be read/);
  });

  it("a program and an installer signed by this tool are still valid and trusted", async () => {
    const exe = copyFixture("tiny.exe", tempDir);
    await signing.signFile(exe, { scope });
    const msi = copyMsi("tiny.msi", tempDir);
    await signing.signFile(msi, { scope });
    for (const file of [exe, msi]) {
      const result = await signing.verifyFile(file);
      expect(result.status).toBe("VALID");
      expect(result.integrity.state).toBe("intact");
      expect(result.trust.state).toBe("trusted");
    }
  });
});

describe("addon calls for installers: strip, check and argument validation (real addon)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("msiStripSignature removes the signature and the extended stream and reports it", () => {
    const file = copyMsi("tiny-osslsig-dse.msi", tempDir);
    const addon = loadAddon();
    expect(addon.msiStripSignature(file)).toBe(true);
    const pkg = parsePackage(fs.readFileSync(file));
    expect(pkg.findSignature()).toBeNull();
    expect(pkg.findSignatureEx()).toBeNull();
    expect(pkg.fingerprint()).toBe(msiReference.fingerprint.get("tiny-osslsig-dse.msi"));
    expect(addon.msiStripSignature(file)).toBe(false);
    expect((addon.msiCheckSignature(file) as { state: string }).state).toBe("none");
  });

  it("msiCheckSignature returns the four fields", () => {
    const file = copyMsi("tiny-osslsig-large.msi", tempDir);
    const check = loadAddon().msiCheckSignature(file) as Record<string, unknown>;
    expect(Object.keys(check).sort()).toEqual(["computedDigest", "detail", "state", "storedDigest"]);
    expect(check.state).toBe("matches");
    expect(Buffer.isBuffer(check.storedDigest)).toBe(true);
    expect(Buffer.isBuffer(check.computedDigest)).toBe(true);
    expect(typeof check.detail).toBe("string");
  });

  it("msiCheckSignature and msiStripSignature reject a non-string path with a TypeError", () => {
    const addon = loadAddon();
    expect(typeof addon.msiCheckSignature).toBe("function");
    expect(typeof addon.msiStripSignature).toBe("function");
    expect(thrownName(() => addon.msiCheckSignature(42))).toBe("TypeError");
    expect(thrownName(() => addon.msiStripSignature(42))).toBe("TypeError");
    expect(thrownName(() => addon.msiCheckSignature())).toBe("TypeError");
  });

  it("a non-boolean third argument to msiEmbedSignature is a TypeError and the file is untouched", () => {
    const blob = parsePackage(fs.readFileSync(genuinePath("tiny-osslsig-small.msi"))).signatureBytes() as Buffer;
    const file = copyMsi("tiny.msi", tempDir);
    const before = sha256File(file);
    const addon = loadAddon();
    expect(typeof addon.msiCheckSignature).toBe("function");
    for (const bad of ["yes", 1, {}, null]) {
      expect(thrownName(() => addon.msiEmbedSignature(file, blob, bad))).toBe("TypeError");
    }
    expect(sha256File(file)).toBe(before);
  });

  it("msiEmbedSignature still rejects a non-buffer signature", () => {
    const file = copyMsi("tiny.msi", tempDir);
    expect(() => loadAddon().msiEmbedSignature(file, "not a buffer", true)).toThrow();
  });
});

// ── PE signature removal ─────────────────────────────────────

describe("PE signature removal (real addon)", () => {
  let signing: Signing;
  let scope: string;
  let tempDir: string;

  // Offset of the 4-byte CheckSum field of the 1,024-byte tiny.exe fixture:
  // e_lfanew (0x40) + PE signature and COFF header (24) + 64 into the optional header
  const checkSumOffset = 0x40 + 24 + 64;

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

  it("the addon exports peStripSignature", () => {
    expect(typeof loadAddon().peStripSignature).toBe("function");
  });

  it("peStripSignature returns a signed PE to its unsigned bytes", async () => {
    const original = fs.readFileSync(fixturePath("tiny.exe"));
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFileAuthenticode(peFile, scope);
    const addon = loadAddon();
    expect(addon.peHasEmbeddedSignature(peFile)).toBe(true);
    expect(fs.statSync(peFile).size).toBeGreaterThan(original.length);

    expect(addon.peStripSignature(peFile)).toBeUndefined();

    const after = fs.readFileSync(peFile);
    expect(after.length).toBe(original.length);
    // Only the CheckSum field may differ: the library recalculates it
    const mask = (buf: Buffer) => {
      const copy = Buffer.from(buf);
      copy.fill(0, checkSumOffset, checkSumOffset + 4);
      return copy;
    };
    expect(mask(after).equals(mask(original))).toBe(true);
    expect(addon.peHasEmbeddedSignature(peFile)).toBe(false);
  });

  it("peStripSignature rejects a missing or non-string path", () => {
    const addon = loadAddon();
    expect(thrownName(() => addon.peStripSignature())).toBe("TypeError");
    expect(thrownName(() => addon.peStripSignature(42))).toBe("TypeError");
  });

  it("removeEmbeddedSignature removes the signature of a signed PE and returns true", async () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFileAuthenticode(peFile, scope);
    expect(signing.removeEmbeddedSignature(peFile)).toBe(true);
    expect(loadAddon().peHasEmbeddedSignature(peFile)).toBe(false);
  });

  it("removeEmbeddedSignature on a read-only signed PE fails and leaves it unchanged", async () => {
    // The library refuses read-only files, which is why the strip step makes files writable first.
    // Root can write to any file, so the refusal cannot be observed there.
    const ranAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!optionalExternalCheck("non-root user", !ranAsRoot, "running as root, where read-only files are writable")) {
      return;
    }
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFileAuthenticode(peFile, scope);
    const before = fs.readFileSync(peFile);
    fs.chmodSync(peFile, 0o444);

    expect(() => signing.removeEmbeddedSignature(peFile)).toThrow();

    expect(fs.readFileSync(peFile).equals(before)).toBe(true);
    expect((fs.statSync(peFile).mode & 0o777)).toBe(0o444);
  });

  it("removeEmbeddedSignature returns false for an unsigned PE and for an ELF file", () => {
    const peFile = copyFixture("tiny.exe", tempDir);
    const peBefore = fs.readFileSync(peFile);
    expect(signing.removeEmbeddedSignature(peFile)).toBe(false);
    expect(fs.readFileSync(peFile).equals(peBefore)).toBe(true);

    // A minimal ELF header: the format check must come first because
    // peHasEmbeddedSignature throws for anything that is not a PE
    const elfFile = path.join(tempDir, "tiny.elf");
    const header = Buffer.alloc(64);
    header.write("\x7fELF", 0, "latin1");
    header[4] = 2;
    header[5] = 1;
    header.writeUInt16LE(2, 16);
    fs.writeFileSync(elfFile, header);
    expect(signing.removeEmbeddedSignature(elfFile)).toBe(false);
    expect(fs.readFileSync(elfFile).equals(header)).toBe(true);
  });

  it("removeEmbeddedSignature then strip then sign gives one embedded signature", async () => {
    const strip = spawnSync("x86_64-w64-mingw32-strip", ["--version"]);
    if (!optionalExternalCheck("x86_64-w64-mingw32-strip", strip.status === 0, "x86_64-w64-mingw32-strip not found")) {
      return;
    }
    const peFile = copyFixture("tiny.exe", tempDir);
    await signing.signFileAuthenticode(peFile, scope);

    expect(signing.removeEmbeddedSignature(peFile)).toBe(true);
    const run = spawnSync("x86_64-w64-mingw32-strip", ["--strip-unneeded", peFile], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(signing.detectBinaryFormat(peFile).format).toBe("pe");

    const result = await signing.signFile(peFile, { scope });
    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
    expect(fs.existsSync(peFile + ".sig")).toBe(false);
    const verify = await signing.verifyFile(peFile);
    expect(verify.status).toBe("VALID");
    expect(loadAddon().peHasEmbeddedSignature(peFile)).toBe(true);
  });
});

// ── Slice table (real addon) ─────────────────────────────────

describe("machoListSlices (real addon)", () => {
  interface SliceInfo {
    cpuType: number;
    cpuSubtype: number;
    offset: number;
    size: number;
    isSigned: boolean;
    signatureOffset: number;
    signatureSize: number;
    supported: boolean;
    unsupportedReason: string;
  }

  let signing: Signing;
  let scope: string;
  let tempDir: string;
  const addon = loadAddon();
  const listSlices = (file: string): SliceInfo[] => addon.machoListSlices(file) as SliceInfo[];

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

  /** The slice table of a universal file, read here from its big-endian header (32-bit or 64-bit table). */
  function tableOf(file: string): Array<{ cpuType: number; cpuSubtype: number; offset: number; size: number }> {
    const data = fs.readFileSync(file);
    const magic = data.readUInt32BE(0);
    const count = data.readUInt32BE(4);
    const wide = magic === 0xcafebabf;
    const entries = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * (wide ? 32 : 20);
      entries.push({
        cpuType: data.readUInt32BE(at),
        cpuSubtype: data.readUInt32BE(at + 4),
        offset: wide ? Number(data.readBigUInt64BE(at + 8)) : data.readUInt32BE(at + 8),
        size: wide ? Number(data.readBigUInt64BE(at + 16)) : data.readUInt32BE(at + 12),
      });
    }
    return entries;
  }

  it("is exported by the addon", () => {
    expect(typeof addon.machoListSlices).toBe("function");
  });

  it("gives one supported unsigned entry at offset 0 for a thin program", () => {
    const file = copyGenuine("tiny-macho-arm64", tempDir);
    const slices = listSlices(file);
    expect(slices).toHaveLength(1);
    expect(slices[0].offset).toBe(0);
    expect(slices[0].size).toBe(fs.statSync(file).size);
    expect(slices[0].cpuType).toBe(0x0100000c);
    expect(slices[0].supported).toBe(true);
    expect(slices[0].isSigned).toBe(false);
  });

  it("reports a signature inside the slice after the program is signed", async () => {
    const file = copyGenuine("tiny-macho-arm64", tempDir);
    await signing.signFileMachO(file, scope);
    const slices = listSlices(file);
    expect(slices).toHaveLength(1);
    expect(slices[0].isSigned).toBe(true);
    expect(slices[0].signatureSize).toBeGreaterThan(0);
    // The signature offset is relative to the slice
    expect(slices[0].signatureOffset).toBeGreaterThan(0);
    expect(slices[0].signatureOffset + slices[0].signatureSize).toBeLessThanOrEqual(slices[0].size);
    expect(fs.readFileSync(file).readUInt32BE(slices[0].offset + slices[0].signatureOffset)).toBe(0xfade0cc0);
  });

  it("lists the slices of the universal program in table order with the offsets and sizes of its table", () => {
    const file = genuinePath("tiny-macho-universal");
    const expected = tableOf(file);
    expect(expected.length).toBe(2);
    const slices = listSlices(file);
    expect(slices.map((s) => [s.cpuType, s.cpuSubtype, s.offset, s.size])).toEqual(expected.map((e) => [e.cpuType, e.cpuSubtype, e.offset, e.size]));
    for (const slice of slices) {
      expect(slice.supported).toBe(true);
      expect(slice.isSigned).toBe(false);
    }
  });

  it("reports both slices signed after the universal program is signed", async () => {
    const file = copyGenuine("tiny-macho-universal", tempDir);
    await signing.signFileMachO(file, scope);
    const slices = listSlices(file);
    expect(slices).toHaveLength(2);
    for (const slice of slices) {
      expect(slice.isSigned).toBe(true);
      expect(slice.signatureOffset + slice.signatureSize).toBeLessThanOrEqual(slice.size);
    }
  });

  it("reports a 32-bit slice as not supported, with a reason, and still lists the others", () => {
    const thin = fs.readFileSync(genuinePath("tiny-macho-arm64"));
    // A 32-bit Mach-O header with no load commands: i386, little-endian
    const small = Buffer.alloc(28);
    small.writeUInt32LE(0xfeedface, 0);
    small.writeUInt32LE(7, 4);
    small.writeUInt32LE(3, 8);
    small.writeUInt32LE(2, 12);
    const file = path.join(tempDir, "mixed");
    fs.writeFileSync(
      file,
      makeUniversal([
        { cpuType: 0x0100000c, cpuSubtype: 0, bytes: thin },
        { cpuType: 7, cpuSubtype: 3, bytes: small },
      ])
    );
    const slices = listSlices(file);
    expect(slices).toHaveLength(2);
    expect(slices[0].supported).toBe(true);
    expect(slices[1].cpuType).toBe(7);
    expect(slices[1].supported).toBe(false);
    expect(slices[1].unsupportedReason.length).toBeGreaterThan(0);
  });

  it("throws an Error with the library's message for a text file", () => {
    const file = fixturePath("plain.txt");
    let libraryMessage = "";
    try {
      addon.machoExtractSignature(file);
    } catch (err) {
      libraryMessage = (err as Error).message;
    }
    expect(libraryMessage.length).toBeGreaterThan(0);
    let caught: Error | null = null;
    try {
      listSlices(file);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("Error");
    expect((caught as Error).message).toContain(libraryMessage);
  });

  it("throws a TypeError when called with no argument or with a number", () => {
    // Calling a missing export is also a TypeError, so the export must exist for this case to mean anything
    expect(typeof addon.machoListSlices).toBe("function");
    expect(thrownName(() => addon.machoListSlices())).toBe("TypeError");
    expect(thrownName(() => addon.machoListSlices(42))).toBe("TypeError");
  });
});
