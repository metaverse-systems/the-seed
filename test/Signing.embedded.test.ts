import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Signing from "../src/Signing";
import { checkMachO } from "./helpers/MachOChecker";
import { CfbPackage, loadReference, parsePackage, storedDigest } from "./helpers/CfbChecker";

/**
 * Create a temporary directory for test isolation.
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "signing-embedded-test-"));
}

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
  const full = { prefix: "", scopes };
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
 * Run the independent Python checker of libthe-seed on a file when the
 * superproject checkout provides it. Returns null when it is not there.
 */
function runPythonChecker(file: string): { status: number | null; output: string } | null {
  const checker = path.join(__dirname, "..", "..", "libthe-seed", "tests", "fixtures", "check_pages.py");
  if (!fs.existsSync(checker)) {
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

describe("_buildMachOCms signature length", () => {
  let signing: Signing;
  let scope: string;
  let certPem: string;

  beforeAll(async () => {
    const setup = await setupSigning();
    signing = setup.signing;
    scope = setup.scope;
    certPem = fs.readFileSync(signing.scopeCertPath(scope), "utf-8");
  });

  /** Read one DER header at offset: tag, content length, header size. */
  function readHeader(buf: Buffer, offset: number): { tag: number; length: number; header: number } {
    const tag = buf[offset];
    const first = buf[offset + 1];
    if (first < 0x80) {
      return { tag, length: first, header: 2 };
    }
    const count = first & 0x7f;
    let length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + buf[offset + 2 + i];
    }
    return { tag, length, header: 2 + count };
  }

  /** Walk the whole DER value and check every length stays inside its parent. */
  function checkNesting(buf: Buffer, start: number, end: number): void {
    let at = start;
    while (at < end) {
      const h = readHeader(buf, at);
      const next = at + h.header + h.length;
      expect(next).toBeLessThanOrEqual(end);
      if (h.tag & 0x20) {
        checkNesting(buf, at + h.header, next);
      }
      at = next;
    }
    expect(at).toBe(end);
  }

  it("writes a 70-byte signature with the one-byte length and a 200-byte one with the long form", () => {
    const cd = Buffer.alloc(32, 7);

    for (const size of [70, 200]) {
      const signature = Buffer.alloc(size, 0xab);
      const cms = signing._buildMachOCms(cd, signature, certPem);

      // The whole value is one well-formed DER tree
      const top = readHeader(cms, 0);
      expect(top.header + top.length).toBe(cms.length);
      checkNesting(cms, 0, cms.length);

      const expectedHeader = size < 128 ? Buffer.from([0x04, size]) : Buffer.from([0x04, 0x81, size]);
      const at = cms.indexOf(Buffer.concat([expectedHeader, signature]));
      expect(at).toBeGreaterThan(0);
      // The signature is the last element of the SignerInfo, so it ends the CMS
      expect(at + expectedHeader.length + size).toBe(cms.length);
    }
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

    const verify = await signing.verifyFileMsi(file);
    expect(verify.status).toBe("VALID");
    return { file, pkg, before };
  }

  it("signs an unsigned version 3 package", async () => {
    const { pkg, before } = await signAndCheck("tiny.msi");
    expect(pkg.version).toBe(3);
    expect(before.findSignature()).toBeNull();
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
    expect(fs.statSync(file).size).toBe(once);
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

  /**
   * A signer whose certificate carries a long name, so that the signature the
   * command builds is about `target` bytes. The size is measured on the
   * container the command builds, not assumed.
   */
  async function signerWithSignatureNear(target: number): Promise<{ signing: Signing; scope: string; size: number }> {
    let length = Math.max(1, Math.floor((target - 700) / 3));
    for (let attempt = 0; attempt < 8; attempt++) {
      const configDir = createTempDir();
      writeConfig(configDir, { scope: "@test", name: "N".repeat(length), email: "test@test.com" });
      const signing = new Signing(configDir);
      await signing.createCert({ validityDays: 365, scope: "@test" });
      const certPem = fs.readFileSync(signing.scopeCertPath("@test"), "utf-8");
      const size = signing._buildMsiCms(Buffer.alloc(32, 1), Buffer.alloc(71, 2), certPem).length;
      if (Math.abs(size - target) <= 4) {
        return { signing, scope: "@test", size };
      }
      length = Math.max(1, length + Math.round((target - size) / 3));
    }
    throw new Error(`could not build a signature near ${target} bytes`);
  }

  it.each([
    ["just below the threshold", 4090, true],
    ["just above the threshold", 4102, false],
  ])("signs and reads back a signature %s", async (_label, target, small) => {
    const { signing, scope } = await signerWithSignatureNear(target as number);
    const file = copyMsi("tiny.msi", tempDir);
    await signing.signFileMsi(file, scope);

    const pkg = parsePackage(fs.readFileSync(file));
    const found = pkg.findSignature();
    expect(found).not.toBeNull();
    const stored = found as NonNullable<typeof found>;
    expect(Math.abs(stored.size - (target as number))).toBeLessThanOrEqual(4);
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
    expect(result.reason).toMatch(/signature present but does not match the package contents/);
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
    // A signature made by another tool holds the right fingerprint, so the package side matches;
    // the signer's certificate and signature are not the-seed's, so the result is not VALID.
    const file = copyMsi("tiny-osslsig-small.msi", tempDir);
    expect((loadAddon().msiCheckSignature(file) as { state: string }).state).toBe("matches");
    const result = await signing.verifyFileMsi(file);
    expect(result.status).not.toBe("VALID");
    expect(result.reason).not.toMatch(/does not match the package contents/);
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
