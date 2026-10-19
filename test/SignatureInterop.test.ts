import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import Signing from "../src/Signing";
import { OID, readSignedData } from "../src/CmsReader";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { haveOpenssl, haveOsslsigncode, opensslVerifyDetached, osslsigncodeVerify } from "./helpers/IndependentCheck";
import { checkMachO, sliceSignatureBlobs } from "./helpers/MachOChecker";

// Choices where the contracts leave the shape open:
//   - the scope @ti is created once for the file in a scratch configuration directory; each case signs its own scratch copy
//   - the scratch HOME of the process is also the HOME given to the child tools
//   - "no earlier-form notice" is checked on every warning, so it holds before the notice exists and keeps meaning after
//   - the paths case asserts the exact-path reading (one signature, equal digests, tool VALID) and not the whole pass, so it guards the path handling alone
//   - the Mac cases run on both genuine samples (thin arm64 and universal), one scratch copy each, and assert every slice
//   - the Mac tamper case changes the last byte of the first slice's code directory in the file, then re-reads the slices from the changed file for openssl
//   - the installer read-back is taken straight from the addon's msiCheckSignature
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

function haveOpensslTool(): boolean {
  return optionalExternalCheck("signature-interop-openssl", haveOpenssl(), "openssl not found");
}

// eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
const addon = require("../native/build/Release/dependency_lister.node") as Record<string, (...args: unknown[]) => unknown>;

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

describe("installer", () => {
  it("genuine/tiny.msi signed by the tool passes osslsigncode, and reads back as matching", async () => {
    const file = path.join(tempDir("interop-msi-"), "tiny.msi");
    fs.copyFileSync(fixture("genuine", "tiny.msi"), file);
    await signing.signFile(file, { scope: "@ti" });

    expect((addon.msiCheckSignature(file) as { state: string }).state).toBe("matches");
    if (!haveTool()) return;
    const result = osslsigncodeVerify(file, certPath, home);
    expect(result.output).not.toMatch(/asn1/i);
    expect(result.passed).toBe(true);
  });
});

const MAC_SAMPLES = ["tiny-macho-arm64", "tiny-macho-universal"];

async function signedMac(name: string): Promise<string> {
  const file = path.join(tempDir("interop-mac-"), name);
  fs.copyFileSync(fixture("genuine", name), file);
  await signing.signFile(file, { scope: "@ti" });
  return file;
}

describe("Mac program", () => {
  it("each slice of genuine/tiny-macho-arm64 and genuine/tiny-macho-universal carries a standard container that openssl verifies over the slice's code directory", async () => {
    const certificate = Buffer.from(new crypto.X509Certificate(fs.readFileSync(certPath)).raw);
    for (const name of MAC_SAMPLES) {
      const file = await signedMac(name);
      const slices = sliceSignatureBlobs(fs.readFileSync(file));
      expect(slices).toHaveLength(name === "tiny-macho-universal" ? 2 : 1);
      for (const slice of slices) {
        expect(slice.cms).not.toBeNull();
        const info = readSignedData(slice.cms as Buffer);
        expect(info.contentType).toBe(OID.data);
        expect(info.content).toBeUndefined();
        expect(info.certificates).toHaveLength(1);
        expect(info.certificates[0].equals(certificate)).toBe(true);
        const attributes = info.signers[0].signedAttributes;
        expect(attributes).toBeDefined();
        const found = attributes as NonNullable<typeof attributes>;
        expect(found.contentType).toBe(OID.data);
        expect((found.messageDigest as Buffer).equals(crypto.createHash("sha256").update(slice.codeDirectory).digest())).toBe(true);

        if (haveOpensslTool()) {
          expect(opensslVerifyDetached(slice.cms as Buffer, slice.codeDirectory, certPath, tempDir("interop-openssl-")).passed).toBe(true);
        }
      }
    }
  });

  it("the independent checker reports every slice intact and the tool's verifier reports it valid and trusted", async () => {
    for (const name of MAC_SAMPLES) {
      const file = await signedMac(name);
      const report = checkMachO(fs.readFileSync(file));
      expect(report.problems).toEqual([]);
      for (const slice of report.slices) {
        expect(slice.pagesChecked).toBeGreaterThan(0);
        expect(slice.pagesMismatched).toBe(0);
      }
      const verified = await signing.verifyFile(file);
      expect(verified.status).toBe("VALID");
      expect(verified.trust.state).toBe("trusted");
    }
  });

  it("a changed code directory byte: openssl and the tool both reject", async () => {
    for (const name of MAC_SAMPLES) {
      const file = await signedMac(name);
      const data = fs.readFileSync(file);
      const codeDirectory = sliceSignatureBlobs(data)[0].codeDirectory;
      const at = data.indexOf(codeDirectory);
      expect(at).toBeGreaterThan(0);
      data[at + codeDirectory.length - 1] ^= 0x01;
      fs.writeFileSync(file, data);

      expect((await signing.verifyFile(file)).status).toBe("INVALID");
      if (haveOpensslTool()) {
        const slice = sliceSignatureBlobs(data)[0];
        expect(opensslVerifyDetached(slice.cms as Buffer, slice.codeDirectory, certPath, tempDir("interop-openssl-")).passed).toBe(false);
      }
    }
  });
});
