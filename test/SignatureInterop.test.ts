import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import Signing from "../src/Signing";
import { OID, readSignedData } from "../src/CmsReader";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { edgeCaseScope, haveOpenssl, haveOsslsigncode, opensslVerifyDetached, osslsigncodeVerify, toolEnv } from "./helpers/IndependentCheck";
import { checkMachO, sliceSignatureBlobs } from "./helpers/MachOChecker";

// Choices where the contracts leave the shape open:
//   - the scope @ti is created once for the file in a scratch configuration directory; each case signs its own scratch copy
//   - the scratch HOME of the process is also the HOME given to the child tools
//   - "no earlier-form notice" is checked on every warning, so it holds before the notice exists and keeps meaning after
//   - the Mac cases run on both genuine samples (thin arm64 and universal), one scratch copy each, and assert every slice
//   - the Mac tamper case changes the last byte of the first slice's code directory in the file, then re-reads the slices from the changed file for openssl
//   - the installer read-back is taken straight from the addon's msiCheckSignature
//   - edge-case certificates are written with openssl (edgeCaseScope) and imported into the scope @edge of the same configuration; the
//     expected signer serial bytes are the certificate's serial as Node reports it, with one leading zero byte when its top bit is set
//   - a signer serial is compared on the bytes of the container read back (Windows program and installer: the extracted container;
//     Mac program: each slice's container)
//   - the top-bit serial is 0x8a1b2c3d4e5f6071; the long-name certificate has six 60-character organisational units
//   - each fresh certificate gets its own scratch configuration; a case collects every failure (with the certificate's serial) and
//     asserts the list is empty, so a failure names the certificates and nothing is retried
//   - the tool's verifier is asked only for integrity here (the scopes of the edge-case certificates are not in the configuration, so trust is not asserted)
//   - tool-independent checks (signer serial bytes, the tool's own verification) run for every fresh certificate even without the external tools
//   - the changed byte is the first byte of the first section's raw data, found by reading the section table here

//   - re-signing: a program signed by osslsigncode uses a P-256 certificate written by edgeCaseScope (serial 0x0a1b); the nested
//     signature is added with `osslsigncode sign -nest` on that result, and the case first checks the tool reports two signatures
//   - re-signing cases sign scratch copies with the scope @ti and name every compared copy alike, so the Mac identifier is the same
//   - "equals signing the unsigned original once" compares the signed content (Authenticode content value) of programs and
//     installers, the code directories of Mac slices, and the tool's status, integrity and trust states; file sizes are not
//     compared (the ECDSA signature is 70 to 72 bytes)

const created: string[] = [];
const shared: string[] = [];
let savedHome: string | undefined;
let home: string;
let configDir: string;
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
  configDir = tempDir("interop-config-");
  shared.push(home, configDir);
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes: { "@ti": { author: { name: "Test Interop", email: "ti@example.com", url: "" } } } }, null, 2)
  );
  signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope: "@ti" });
  certPath = signing.scopeCertPath("@ti");
});

afterEach(() => {
  for (const dir of created.splice(0).filter((entry) => !shared.includes(entry))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  created.push(...shared);
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

      const result = osslsigncodeVerify(file, certPath, home);
      expect(result.signatureCount).toBe(1);
      expect(result.digestsMatch).toBe(true);
      expect(result.passed).toBe(true);
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

/** The serial number bytes a signer record must carry for a certificate: Node's hex, with a zero byte first when the top bit is set. */
function expectedSerial(certificatePem: Buffer): Buffer {
  let hex = new crypto.X509Certificate(certificatePem).serialNumber;
  if (hex.length % 2 === 1) {
    hex = "0" + hex;
  }
  const bytes = Buffer.from(hex, "hex");
  return (bytes[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
}

function signerSerial(container: Buffer): Buffer {
  const sid = readSignedData(container).signers[0].sid;
  if (!("serial" in sid)) {
    throw new Error("signer identified by subject key identifier");
  }
  return sid.serial;
}

/**
 * Signs a scratch copy of each form with `scope` of `signer`, whose certificate is in `certFile`, and returns what went wrong
 * (empty when all passed): the signer serial bytes of every container, the tool's own verification, and, where the external
 * tools exist, their verdicts.
 */
async function problemsFor(forms: Array<"program" | "installer" | "mac">, subject: Signing, scope: string, certFile: string): Promise<string[]> {
  const problems: string[] = [];
  const expected = expectedSerial(fs.readFileSync(certFile));
  const serialText = expected.toString("hex");
  for (const form of forms) {
    const dir = tempDir("interop-fresh-");
    if (form === "program") {
      const file = path.join(dir, "tiny.exe");
      fs.copyFileSync(fixture("tiny.exe"), file);
      await subject.signFile(file, { scope });
      if (!signerSerial(addon.peExtractSignature(file) as Buffer).equals(expected)) problems.push(`program ${serialText}: signer serial bytes differ`);
      if ((await subject.verifyFile(file)).integrity.state !== "intact") problems.push(`program ${serialText}: the tool does not find the signature intact`);
      if (haveTool() && !osslsigncodeVerify(file, certFile, home).passed) problems.push(`program ${serialText}: osslsigncode fails`);
    } else if (form === "installer") {
      const file = path.join(dir, "tiny.msi");
      fs.copyFileSync(fixture("genuine", "tiny.msi"), file);
      await subject.signFile(file, { scope });
      if (!signerSerial(addon.msiExtractSignature(file) as Buffer).equals(expected)) problems.push(`installer ${serialText}: signer serial bytes differ`);
      if ((addon.msiCheckSignature(file) as { state: string }).state !== "matches") problems.push(`installer ${serialText}: fingerprint does not read back`);
      if (haveTool() && !osslsigncodeVerify(file, certFile, home).passed) problems.push(`installer ${serialText}: osslsigncode fails`);
    } else {
      const file = path.join(dir, "tiny-macho-universal");
      fs.copyFileSync(fixture("genuine", "tiny-macho-universal"), file);
      await subject.signFile(file, { scope });
      const slices = sliceSignatureBlobs(fs.readFileSync(file));
      if (slices.length !== 2) problems.push(`mac ${serialText}: ${slices.length} slices`);
      for (const slice of slices) {
        if (slice.cms === null || !signerSerial(slice.cms).equals(expected)) {
          problems.push(`mac ${serialText}: signer serial bytes differ`);
        } else if (haveOpensslTool() && !opensslVerifyDetached(slice.cms, slice.codeDirectory, certFile, tempDir("interop-openssl-")).passed) {
          problems.push(`mac ${serialText}: openssl fails`);
        }
      }
      if (checkMachO(fs.readFileSync(file)).problems.length > 0) problems.push(`mac ${serialText}: the independent checker reports problems`);
      if ((await subject.verifyFile(file)).integrity.state !== "intact") problems.push(`mac ${serialText}: the tool does not find the signature intact`);
    }
  }
  return problems;
}

describe("edge-case certificates", () => {
  async function importEdge(options: { serialHex: string; longNames?: boolean }, scope: string): Promise<string> {
    const made = edgeCaseScope(tempDir("interop-edge-"), options);
    await signing.importCert(made.certPath, made.keyPath, scope);
    return signing.scopeCertPath(scope);
  }

  it("top-bit serial: each form passes its independent check and the signer record carries the certificate's serial", async () => {
    if (!haveTool() || !haveOpensslTool()) return;
    const certFile = await importEdge({ serialHex: "8a1b2c3d4e5f6071" }, "@edge");
    expect(expectedSerial(fs.readFileSync(certFile)).toString("hex")).toBe("008a1b2c3d4e5f6071");
    expect(await problemsFor(["program", "installer", "mac"], signing, "@edge", certFile)).toEqual([]);
  });

  it("20-byte serial (0x7f00112233445566778899aabbccddeeff001122) and long names: each form passes; the Mac signature fits", async () => {
    if (!haveTool() || !haveOpensslTool()) return;
    const certFile = await importEdge({ serialHex: "7f00112233445566778899aabbccddeeff001122", longNames: true }, "@edge20");
    expect(expectedSerial(fs.readFileSync(certFile)).toString("hex")).toBe("7f00112233445566778899aabbccddeeff001122");
    expect(await problemsFor(["program", "installer", "mac"], signing, "@edge20", certFile)).toEqual([]);
  });
});

describe("fresh certificates", () => {
  const COUNT = 20;

  async function fresh(index: number): Promise<{ subject: Signing; certFile: string }> {
    const dir = tempDir("interop-fresh-config-");
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ prefix: path.join(dir, "prefix"), scopes: { "@tf": { author: { name: "Fresh " + index, email: "fresh@example.com", url: "" } } } }, null, 2)
    );
    const subject = new Signing(dir);
    await subject.createCert({ validityDays: 365, scope: "@tf" });
    return { subject, certFile: subject.scopeCertPath("@tf") };
  }

  async function allPass(form: "program" | "installer" | "mac"): Promise<string[]> {
    const failures: string[] = [];
    for (let index = 0; index < COUNT; index++) {
      const { subject, certFile } = await fresh(index);
      failures.push(...(await problemsFor([form], subject, "@tf", certFile)));
    }
    return failures;
  }

  it("20 certificates from createCert: every Windows program signature passes osslsigncode", async () => {
    expect(await allPass("program")).toEqual([]);
  });

  it("20 certificates from createCert: every installer signature passes osslsigncode", async () => {
    expect(await allPass("installer")).toEqual([]);
  });

  it("20 certificates from createCert: every Mac slice passes openssl", async () => {
    expect(await allPass("mac")).toEqual([]);
  });
});

describe("re-signing", () => {
  function runTool(args: string[]): void {
    const result = spawnSync("osslsigncode", args, { env: toolEnv(home), encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error("osslsigncode " + args.join(" ") + " failed: " + result.stdout + result.stderr);
    }
  }

  /** tiny.exe signed by osslsigncode (and again with -nest when asked) with a fresh openssl certificate. */
  function osslsigncodeSigned(nested: boolean): string {
    const dir = tempDir("interop-ossl-");
    const made = edgeCaseScope(dir, { serialHex: "0a1b" });
    const first = path.join(dir, "tiny.exe");
    runTool(["sign", "-certs", made.certPath, "-key", made.keyPath, "-h", "sha256", "-in", fixture("tiny.exe"), "-out", first]);
    if (!nested) {
      return first;
    }
    const second = path.join(dir, "tiny-nested.exe");
    runTool(["sign", "-nest", "-certs", made.certPath, "-key", made.keyPath, "-h", "sha256", "-in", first, "-out", second]);
    return second;
  }

  it("a program signed by osslsigncode: replaced, one signature, passes", async () => {
    if (!haveTool() || !haveOpensslTool()) return;
    const file = osslsigncodeSigned(false);
    const result = await signing.signFile(file, { scope: "@ti" });
    expect(result.warnings).toContain("Replaced existing embedded signature");

    const checked = osslsigncodeVerify(file, certPath, home);
    expect(checked.signatureCount).toBe(1);
    expect(checked.passed).toBe(true);
  });

  it("a program with a nested signature: replaced by one, no nested warning", async () => {
    if (!haveTool() || !haveOpensslTool()) return;
    const file = osslsigncodeSigned(true);
    expect(osslsigncodeVerify(file, path.join(path.dirname(file), "edge-cert.pem"), home).signatureCount).toBe(2);

    const result = await signing.signFile(file, { scope: "@ti" });
    expect(result.warnings).toContain("Replaced existing embedded signature");

    const checked = osslsigncodeVerify(file, certPath, home);
    expect(checked.signatureCount).toBe(1);
    expect(checked.passed).toBe(true);
    const verified = await signing.verifyFile(file);
    expect(verified.status).toBe("VALID");
    expect(verified.warnings.filter((warning: string) => /nested/i.test(warning))).toEqual([]);
  });

  it.each(["tiny-osslsig-small.msi", "tiny-osslsig-large.msi", "tiny-osslsig-dse.msi"])("installer sample %s passes after re-signing", async (name) => {
    const file = path.join(tempDir("interop-resign-msi-"), name);
    fs.copyFileSync(fixture("genuine", name), file);
    await signing.signFile(file, { scope: "@ti" });

    expect((addon.msiCheckSignature(file) as { state: string }).state).toBe("matches");
    if (!haveTool()) return;
    const result = osslsigncodeVerify(file, certPath, home);
    expect(result.signatureCount).toBe(1);
    expect(result.passed).toBe(true);
  });

  it.each(["tiny-macho-arm64-adhoc", "tiny-macho-x86_64-adhoc", "tiny-macho-universal-adhoc"])("ad-hoc Mac sample %s gets a standard container on every slice", async (name) => {
    const file = path.join(tempDir("interop-resign-mac-"), name);
    fs.copyFileSync(fixture("genuine", name), file);
    await signing.signFile(file, { scope: "@ti" });

    const slices = sliceSignatureBlobs(fs.readFileSync(file));
    expect(slices).toHaveLength(name === "tiny-macho-universal-adhoc" ? 2 : 1);
    for (const slice of slices) {
      expect(slice.cms).not.toBeNull();
      const attributes = readSignedData(slice.cms as Buffer).signers[0].signedAttributes;
      expect(attributes).toBeDefined();
      expect(((attributes as NonNullable<typeof attributes>).messageDigest as Buffer).equals(crypto.createHash("sha256").update(slice.codeDirectory).digest())).toBe(true);
      if (haveOpensslTool()) {
        expect(opensslVerifyDetached(slice.cms as Buffer, slice.codeDirectory, certPath, tempDir("interop-openssl-")).passed).toBe(true);
      }
    }
    expect(checkMachO(fs.readFileSync(file)).problems).toEqual([]);
    expect((await signing.verifyFile(file)).status).toBe("VALID");
  });

  describe("earlier-form fixtures", () => {
    const FORMS: Array<{ name: string; original: string[]; kind: "program" | "installer" | "mac" }> = [
      { name: "tiny.exe", original: ["tiny.exe"], kind: "program" },
      { name: "tiny.msi", original: ["genuine", "tiny.msi"], kind: "installer" },
      { name: "tiny-macho-universal", original: ["genuine", "tiny-macho-universal"], kind: "mac" },
    ];

    /** Copies `source` under `name` into a directory of its own and signs it with @ti. */
    async function signedFrom(source: string, name: string): Promise<string> {
      const file = path.join(tempDir("interop-earlier-"), name);
      fs.copyFileSync(source, file);
      await signing.signFile(file, { scope: "@ti" });
      return file;
    }

    function signedContent(kind: "program" | "installer", file: string): Buffer {
      const container = (kind === "program" ? addon.peExtractSignature(file) : addon.msiExtractSignature(file)) as Buffer;
      return readSignedData(container).content as Buffer;
    }

    it.each(FORMS)("$name, signed again, passes and equals signing the unsigned original once", async ({ name, original, kind }) => {
      const again = await signedFrom(fixture("earlier-form", name), name);
      const once = await signedFrom(fixture(...original), name);

      const verdictAgain = await signing.verifyFile(again);
      const verdictOnce = await signing.verifyFile(once);
      expect(verdictAgain.status).toBe(verdictOnce.status);
      expect(verdictAgain.status).toBe("VALID");
      expect(verdictAgain.integrity.state).toBe(verdictOnce.integrity.state);
      expect(verdictAgain.trust.state).toBe(verdictOnce.trust.state);
      expect(verdictAgain.warnings).toEqual(verdictOnce.warnings);

      if (kind === "mac") {
        const slicesAgain = sliceSignatureBlobs(fs.readFileSync(again));
        const slicesOnce = sliceSignatureBlobs(fs.readFileSync(once));
        expect(slicesAgain).toHaveLength(2);
        expect(slicesAgain.map((slice) => slice.cputype)).toEqual(slicesOnce.map((slice) => slice.cputype));
        slicesAgain.forEach((slice, index) => {
          expect(slice.codeDirectory.equals(slicesOnce[index].codeDirectory)).toBe(true);
          expect(slice.cms).not.toBeNull();
          if (haveOpensslTool()) {
            expect(opensslVerifyDetached(slice.cms as Buffer, slice.codeDirectory, certPath, tempDir("interop-openssl-")).passed).toBe(true);
          }
        });
        expect(checkMachO(fs.readFileSync(again)).problems).toEqual([]);
      } else {
        expect(signedContent(kind, again).equals(signedContent(kind, once))).toBe(true);
        if (haveTool()) {
          expect(osslsigncodeVerify(again, certPath, home).passed).toBe(true);
          expect(osslsigncodeVerify(once, certPath, home).passed).toBe(true);
        }
      }
    });
  });
});
