import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { haveOsslsigncode, osslsigncodeVerify } from "./helpers/IndependentCheck";

// Choices where the contracts leave the shape open:
//   - the scope @ti is created once for the file in a scratch configuration directory; each case signs its own scratch copy
//   - the scratch HOME of the process is also the HOME given to the child tools
//   - "no earlier-form notice" is checked on every warning, so it holds before the notice exists and keeps meaning after
//   - the paths case asserts the exact-path reading (one signature, equal digests, tool VALID) and not the whole pass, so it guards the path handling alone
//   - the changed byte is the first byte of the first section's raw data, found by reading the section table here

const created: string[] = [];
let savedHome: string | undefined;
let home: string;
let signing: Signing;
let certPath: string;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function fixture(...parts: string[]): string {
  return path.join(__dirname, "fixtures", "binaries", ...parts);
}

function haveTool(): boolean {
  return optionalExternalCheck("signature-interop-osslsigncode", haveOsslsigncode(), "osslsigncode not found");
}

beforeAll(async () => {
  savedHome = process.env.HOME;
  home = tempDir("interop-home-");
  process.env.HOME = home;
  const configDir = tempDir("interop-config-");
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes: { "@ti": { author: { name: "Test Interop", email: "ti@example.com", url: "" } } } }, null, 2)
  );
  signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope: "@ti" });
  certPath = signing.scopeCertPath("@ti");
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch copy of tiny.exe under the given file name, in a directory of its own. */
function programCopy(name: string, directory?: string): string {
  const dir = directory ?? tempDir("interop-file-");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.copyFileSync(fixture("tiny.exe"), file);
  return file;
}

/** The file offset of the first section's raw data, read from the section table. */
function firstSectionOffset(data: Buffer): number {
  const peHeader = data.readUInt32LE(0x3c);
  const sectionCount = data.readUInt16LE(peHeader + 6);
  const optionalSize = data.readUInt16LE(peHeader + 20);
  expect(sectionCount).toBeGreaterThan(0);
  const table = peHeader + 24 + optionalSize;
  return data.readUInt32LE(table + 20);
}

describe("Windows program", () => {
  it("tiny.exe signed by the tool passes osslsigncode with the signer's certificate as trusted root", async () => {
    if (!haveTool()) return;
    const file = programCopy("tiny.exe");
    await signing.signFile(file, { scope: "@ti" });

    const result = osslsigncodeVerify(file, certPath, home);
    expect(result.output).not.toMatch(/asn1/i);
    expect(result.digestsMatch).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("a library (.dll copy of tiny.exe) passes the same way", async () => {
    if (!haveTool()) return;
    const file = programCopy("tiny.dll");
    await signing.signFile(file, { scope: "@ti" });

    const result = osslsigncodeVerify(file, certPath, home);
    expect(result.output).not.toMatch(/asn1/i);
    expect(result.digestsMatch).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("the tool's verifier reports it valid and trusted, with no earlier-form notice", async () => {
    const file = programCopy("tiny.exe");
    await signing.signFile(file, { scope: "@ti" });

    const result = await signing.verifyFile(file);
    expect(result.status).toBe("VALID");
    expect(result.trust.state).toBe("trusted");
    expect(result.warnings.filter((warning: string) => /earlier form/i.test(warning))).toEqual([]);
  });

  it("one byte of the signed region changed: osslsigncode fails on the fingerprint and the tool reports invalid", async () => {
    const file = programCopy("tiny.exe");
    await signing.signFile(file, { scope: "@ti" });
    const data = fs.readFileSync(file);
    data[firstSectionOffset(data)] ^= 0x01;
    fs.writeFileSync(file, data);

    const verified = await signing.verifyFile(file);
    expect(verified.status).toBe("INVALID");
    expect(verified.integrity.state).toBe("invalid");
    expect(verified.integrity.reason).toMatch(/fingerprint differs/);

    if (!haveTool()) return;
    const result = osslsigncodeVerify(file, certPath, home);
    expect(result.passed).toBe(false);
    expect(result.digestsMatch).toBe(false);
  });

  describe("paths", () => {
    it("a file under a directory with spaces and shell characters is signed and checked at its exact path", async () => {
      if (!haveTool()) return;
      const directory = path.join(tempDir("interop-paths-"), "with space $HOME `x` 'q' \"d\" ; & (p) *");
      const file = programCopy("tiny program (1).exe", directory);
      await signing.signFile(file, { scope: "@ti" });

      // The check reads the signature at the exact path and its digests agree; the full pass is covered by the program cases
      const result = osslsigncodeVerify(file, certPath, home);
      expect(result.signatureCount).toBe(1);
      expect(result.digestsMatch).toBe(true);
      expect((await signing.verifyFile(file)).status).toBe("VALID");
    });
  });
});
