import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";

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

  it("signs a Mach-O file with embedded code signature", async () => {
    const machoFile = copyFixture("tiny-macho-x86_64", tempDir);
    const result = await signing.signFileMachO(machoFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
    expect(result.fingerprint).toMatch(/^SHA256:/);
  });

  it("signs an arm64 Mach-O file", async () => {
    const machoFile = copyFixture("tiny-macho-arm64", tempDir);
    const result = await signing.signFileMachO(machoFile, scope);

    expect(result.signatureType).toBe("embedded");
    expect(result.signaturePath).toBeNull();
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
    const machoFile = copyFixture("tiny-macho-x86_64", tempDir);
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
});
