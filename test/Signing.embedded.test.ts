import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Signing from "../src/Signing";
import { checkMachO } from "./helpers/MachOChecker";

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
    const msiFile = copyFixture("tiny.msi", tempDir);
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
    const msiFile = copyFixture("tiny.msi", tempDir);
    const result = await signing.signFileMsi(msiFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
    expect(result.fingerprint).toMatch(/^SHA256:/);
    expect(result.warnings).toEqual(expect.any(Array));
  });

  it("removes stale .sig file when embedding", async () => {
    const msiFile = copyFixture("tiny.msi", tempDir);
    fs.writeFileSync(msiFile + ".sig", "stale sig data");

    const result = await signing.signFileMsi(msiFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(fs.existsSync(msiFile + ".sig")).toBe(false);
    expect(result.warnings).toContain("Removed stale .sig file");
  });

  it("signs and verifies an MSI file round-trip", async () => {
    const msiFile = copyFixture("tiny.msi", tempDir);
    const signResult = await signing.signFileMsi(msiFile, scope);
    expect(signResult.signatureType).toBe("embedded");

    const verifyResult = await signing.verifyFileMsi(msiFile);
    expect(verifyResult.status).toBe("VALID");
    expect(verifyResult.signatureType).toBe("embedded");
  });

  it("re-signs an already-signed MSI file", async () => {
    const msiFile = copyFixture("tiny.msi", tempDir);
    await signing.signFileMsi(msiFile, scope);
    const result = await signing.signFileMsi(msiFile, scope);

    expect(result.signatureType).toBe("embedded");
    const verifyResult = await signing.verifyFileMsi(msiFile);
    expect(verifyResult.status).toBe("VALID");
  });
});
