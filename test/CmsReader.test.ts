import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Signing from "../src/Signing";
import { CmsDamaged, CmsUnsupported, findSignerCertificate, OID, readSignedData, verifySignerSignature } from "../src/CmsReader";
import { optionalExternalCheck } from "./helpers/ExternalTools";

const created: string[] = [];
let savedHome: string | undefined;
let signing: Signing;
let scopeCertDer: Buffer;

// eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
const addon = require("../native/build/Release/dependency_lister.node") as Record<string, (...args: unknown[]) => unknown>;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function binaries(...parts: string[]): string {
  return path.join(__dirname, "fixtures", "binaries", ...parts);
}

beforeAll(async () => {
  savedHome = process.env.HOME;
  process.env.HOME = tempDir("cms-home-");
  const configDir = tempDir("cms-config-");
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ prefix: "/tmp/seed-test-prefix", scopes: { "@ta": { author: { name: "Test A", email: "a@example.com", url: "" } } } })
  );
  signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope: "@ta" });
  scopeCertDer = Buffer.from(new crypto.X509Certificate(fs.readFileSync(signing.scopeCertPath("@ta"), "utf-8")).raw);
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

// ── a small DER reader and writer, independent of the code under test ──

interface Element {
  tag: number;
  value: Buffer;
  full: Buffer;
}

function readElement(buffer: Buffer, at: number): Element {
  const tag = buffer[at];
  let length = buffer[at + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + buffer[at + 2 + i];
    }
    header = 2 + count;
  }
  return { tag, value: buffer.subarray(at + header, at + header + length), full: buffer.subarray(at, at + header + length) };
}

function children(element: Element): Element[] {
  const result: Element[] = [];
  let at = 0;
  while (at < element.value.length) {
    const child = readElement(element.value, at);
    result.push(child);
    at += child.full.length;
  }
  return result;
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  let length: Buffer;
  if (value.length < 0x80) {
    length = Buffer.from([value.length]);
  } else {
    const bytes: number[] = [];
    for (let rest = value.length; rest > 0; rest = Math.floor(rest / 256)) {
      bytes.unshift(rest % 256);
    }
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, value]);
}

/** The pieces of a SignedData blob: ContentInfo { oid, [0] { SignedData { version, algs, content, [certs], signers } } }. */
function pieces(container: Buffer) {
  const contentInfo = readElement(container, 0);
  const [oid, explicit] = children(contentInfo);
  const signedData = children(explicit)[0];
  const parts = children(signedData);
  return { oid, parts, signedData };
}

/** Rebuilds the container with the signer records replaced by `signerInfos` (a SET OF). */
function withSigners(container: Buffer, signerInfos: Buffer[]): Buffer {
  const { oid, parts } = pieces(container);
  const rebuilt = parts.slice(0, parts.length - 1).map((part) => part.full);
  rebuilt.push(tlv(0x31, ...signerInfos));
  return tlv(0x30, oid.full, tlv(0xa0, tlv(0x30, ...rebuilt)));
}

/** The signer record of a container with its signature algorithm replaced by the given OID content. */
function withSignatureAlgorithm(container: Buffer, oidContent: Buffer): Buffer {
  const { parts } = pieces(container);
  const signerSet = parts[parts.length - 1];
  const signerInfo = children(signerSet)[0];
  const fields = children(signerInfo).map((field) => field.full);
  // version, issuerAndSerialNumber, digestAlgorithm, signatureAlgorithm, signature: the algorithm is the fourth
  fields[3] = tlv(0x30, tlv(0x06, oidContent), Buffer.from([0x05, 0x00]));
  return withSigners(container, [tlv(0x30, ...fields)]);
}

// ── the containers the tool writes ───────────────────────────

interface Sample {
  name: string;
  der: Buffer;
  /** What the signature covers when there are no signed attributes (the tool's own forms). */
  signedMessage: Buffer;
}

function slot(superBlob: Buffer, type: number): Buffer | null {
  const count = superBlob.readUInt32BE(8);
  for (let i = 0; i < count; i++) {
    const entryType = superBlob.readUInt32BE(12 + i * 8);
    const offset = superBlob.readUInt32BE(16 + i * 8);
    if (entryType === type) {
      const length = superBlob.readUInt32BE(offset + 4);
      return superBlob.subarray(offset, offset + length);
    }
  }
  return null;
}

async function ownSamples(): Promise<Sample[]> {
  const dir = tempDir("cms-own-");
  const exe = path.join(dir, "tiny.exe");
  fs.copyFileSync(binaries("tiny.exe"), exe);
  await signing.signFile(exe, { scope: "@ta" });

  const msi = path.join(dir, "tiny.msi");
  fs.copyFileSync(binaries("genuine", "tiny.msi"), msi);
  await signing.signFile(msi, { scope: "@ta" });

  const mac = path.join(dir, "tiny-macho-arm64");
  fs.copyFileSync(binaries("genuine", "tiny-macho-arm64"), mac);
  await signing.signFile(mac, { scope: "@ta" });
  const superBlob = addon.machoExtractSignature(mac) as Buffer;
  const cms = slot(superBlob, 0x10000) as Buffer;
  const codeDirectory = slot(superBlob, 0) as Buffer;

  return [
    { name: "Windows program", der: addon.peExtractSignature(exe) as Buffer, signedMessage: (addon.peComputeDigest(exe) as { digest: Buffer }).digest },
    { name: "installer", der: addon.msiExtractSignature(msi) as Buffer, signedMessage: (addon.msiComputeDigest(msi) as { digest: Buffer }).digest },
    // A CMS blob is an 8-byte header (magic, length) followed by the DER
    { name: "Mac program", der: cms.subarray(8), signedMessage: codeDirectory },
  ];
}

describe("the tool's own signature containers", () => {
  let samples: Sample[];

  beforeAll(async () => {
    samples = await ownSamples();
  });

  it("finds the signing certificate inside the certificate list wrapper, for each form", () => {
    for (const sample of samples) {
      const info = readSignedData(sample.der);
      expect(info.certificates.length).toBe(1);
      expect(info.certificates[0].equals(scopeCertDer)).toBe(true);
      expect(info.signers).toHaveLength(1);
    }
  });

  it("matches the signer record to the certificate with findSignerCertificate, for each form", () => {
    for (const sample of samples) {
      const info = readSignedData(sample.der);
      const found = findSignerCertificate(info, info.signers[0]);
      expect(found).not.toBeNull();
      expect((found as Buffer).equals(scopeCertDer)).toBe(true);
    }
  });

  it("verifies the signature over what each form signs", () => {
    for (const sample of samples) {
      const info = readSignedData(sample.der);
      const certificate = findSignerCertificate(info, info.signers[0]) as Buffer;
      expect(verifySignerSignature(info.signers[0], certificate, sample.signedMessage)).toBe("verified");
    }
  });

  it("does not verify the signature over something else", () => {
    for (const sample of samples) {
      const info = readSignedData(sample.der);
      const certificate = findSignerCertificate(info, info.signers[0]) as Buffer;
      const other = Buffer.from(sample.signedMessage);
      other[0] ^= 0xff;
      expect(verifySignerSignature(info.signers[0], certificate, other)).toBe("failed");
    }
  });

  it("reads the content types: Authenticode content for programs and installers, none for the Mac program", () => {
    expect(readSignedData(samples[0].der).contentType).toBe(OID.spcIndirectData);
    expect(readSignedData(samples[1].der).contentType).toBe(OID.spcIndirectData);
    const mac = readSignedData(samples[2].der);
    expect(mac.contentType).toBe(OID.data);
    expect(mac.content).toBeUndefined();
  });

  it("gives the Authenticode content value bytes: they start with the content's first element and hold the stored digest", () => {
    for (const sample of samples.slice(0, 2)) {
      const info = readSignedData(sample.der);
      expect(info.content).toBeDefined();
      expect((info.content as Buffer).includes(sample.signedMessage)).toBe(true);
      // contentDer is the element as encoded, so it is the value behind a tag and a length
      expect((info.contentDer as Buffer).length).toBeGreaterThan((info.content as Buffer).length);
      expect((info.contentDer as Buffer).subarray(-(info.content as Buffer).length).equals(info.content as Buffer)).toBe(true);
    }
  });

  it("ignores bytes after the outer element, such as the zero padding of a PE certificate table", () => {
    for (const sample of samples) {
      const plain = readSignedData(sample.der);
      const padded = readSignedData(Buffer.concat([sample.der, Buffer.alloc(7)]));
      expect(padded.certificates.map((c: Buffer) => c.toString("hex"))).toEqual(plain.certificates.map((c: Buffer) => c.toString("hex")));
      expect(padded.signers).toHaveLength(1);
    }
  });
});

// ── the samples made by osslsigncode ─────────────────────────

describe("installers signed by osslsigncode (genuine samples)", () => {
  for (const name of ["tiny-osslsig-small.msi", "tiny-osslsig-large.msi"]) {
    describe(name, () => {
      const digestNames: Record<string, string> = { [OID.sha1]: "sha1", [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };

      function container(): Buffer {
        const dir = tempDir("cms-ossl-");
        const copy = path.join(dir, name);
        fs.copyFileSync(binaries("genuine", name), copy);
        return addon.msiExtractSignature(copy) as Buffer;
      }

      it("reads the signed attributes: content type and message digest, and the digest is that of the content", () => {
        const info = readSignedData(container());
        expect(info.signers).toHaveLength(1);
        const signer = info.signers[0];
        expect(signer.signedAttributes).toBeDefined();
        const attributes = signer.signedAttributes as NonNullable<typeof signer.signedAttributes>;
        expect(attributes.contentType).toBe(OID.spcIndirectData);
        expect(attributes.messageDigest).toBeDefined();
        const digestName = digestNames[signer.digestAlgorithm];
        expect(digestName).toBeDefined();
        const expected = crypto.createHash(digestName).update(info.content as Buffer).digest();
        expect((attributes.messageDigest as Buffer).equals(expected)).toBe(true);
        // The raw attributes keep their context tag, as encoded
        expect(attributes.raw[0]).toBe(0xa0);
      });

      it("verifies the RSA signature over the signed attributes", () => {
        const info = readSignedData(container());
        const certificate = findSignerCertificate(info, info.signers[0]);
        expect(certificate).not.toBeNull();
        expect(verifySignerSignature(info.signers[0], certificate as Buffer, info.content as Buffer)).toBe("verified");
      });

      it("names the signer CN=sample-check", () => {
        const info = readSignedData(container());
        const certificate = findSignerCertificate(info, info.signers[0]) as Buffer;
        expect(new crypto.X509Certificate(certificate).subject).toBe("CN=sample-check");
      });

      it("does not verify when the message digest no longer matches the content", () => {
        const info = readSignedData(container());
        const certificate = findSignerCertificate(info, info.signers[0]) as Buffer;
        const changed = Buffer.from(info.content as Buffer);
        changed[changed.length - 1] ^= 0x01;
        expect(verifySignerSignature(info.signers[0], certificate, changed)).toBe("failed");
      });
    });
  }
});

// ── a program signed by osslsigncode with an openssl ECDSA certificate ──

describe("a Windows program signed by osslsigncode with an ECDSA certificate", () => {
  const haveTools = (): boolean => spawnSync("openssl", ["version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).status === 0 && spawnSync("osslsigncode", ["--version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).status === 0;

  /** Runs a tool with an explicit environment, in the scratch directory. */
  function run(dir: string, command: string, args: string[]): void {
    const result = spawnSync(command, args, {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LC_ALL: "C", TZ: "UTC" },
    });
    if (result.status !== 0) {
      throw new Error(command + " " + args.join(" ") + " failed: " + result.stdout + result.stderr);
    }
  }

  /** An ECDSA certificate and key made by openssl; `plain` leaves out the extensions, which makes the certificate shorter. */
  function makeCertificate(dir: string, name: string, plain = false): { cert: string; key: string } {
    const key = path.join(dir, name + "-key.pem");
    const cert = path.join(dir, name + "-cert.pem");
    run(dir, "openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    const extensions = plain ? [] : ["-addext", "keyUsage=digitalSignature", "-addext", "extendedKeyUsage=codeSigning"];
    run(dir, "openssl", ["req", "-new", "-x509", "-key", key, "-subj", "/CN=" + name, "-days", "30", "-out", cert, ...extensions]);
    return { cert, key };
  }

  function signWith(dir: string, certsFile: string, key: string, out: string): void {
    run(dir, "osslsigncode", ["sign", "-certs", certsFile, "-key", key, "-h", "sha256", "-in", binaries("tiny.exe"), "-out", out]);
  }

  /** The certificate table of a PE file, padding included, without its 8-byte header. */
  function certificateTable(file: string): Buffer {
    const data = fs.readFileSync(file);
    const optional = data.readUInt32LE(0x3c) + 24;
    const plus = data.readUInt16LE(optional) === 0x20b;
    const directory = optional + (plus ? 112 : 96) + 4 * 8;
    const offset = data.readUInt32LE(directory);
    const size = data.readUInt32LE(directory + 4);
    return data.subarray(offset + 8, offset + size);
  }

  it("reads the signer the signer record names, and verifies it", () => {
    if (!optionalExternalCheck("cms-osslsigncode", haveTools(), "openssl or osslsigncode not found")) {
      return;
    }
    const dir = tempDir("cms-ecdsa-");
    const signer = makeCertificate(dir, "ossl-ecdsa");
    const out = path.join(dir, "signed.exe");
    signWith(dir, signer.cert, signer.key, out);

    const signerDer = Buffer.from(new crypto.X509Certificate(fs.readFileSync(signer.cert)).raw);
    const info = readSignedData(addon.peExtractSignature(out) as Buffer);
    expect(info.signers).toHaveLength(1);
    const found = findSignerCertificate(info, info.signers[0]);
    expect((found as Buffer).equals(signerDer)).toBe(true);
    expect(verifySignerSignature(info.signers[0], found as Buffer, info.content as Buffer)).toBe("verified");
  });

  it("reads the signer record's certificate, not the first one, when another certificate comes first", () => {
    if (!optionalExternalCheck("cms-osslsigncode", haveTools(), "openssl or osslsigncode not found")) {
      return;
    }
    const dir = tempDir("cms-ecdsa-extra-");
    const signer = makeCertificate(dir, "ossl-ecdsa");
    const signerDer = Buffer.from(new crypto.X509Certificate(fs.readFileSync(signer.cert)).raw);
    const out = path.join(dir, "signed.exe");

    // The certificate list is a DER SET OF, so osslsigncode orders it by encoding whatever order the
    // certificates are given in, and a shorter certificate sorts first: the extra one has a short name and no extensions.
    const extraCert = makeCertificate(dir, "x", true);
    const chain = path.join(dir, "chain.pem");
    fs.writeFileSync(chain, fs.readFileSync(extraCert.cert, "utf-8") + fs.readFileSync(signer.cert, "utf-8"));
    signWith(dir, chain, signer.key, out);
    const extra = Buffer.from(new crypto.X509Certificate(fs.readFileSync(extraCert.cert)).raw);
    const info = readSignedData(addon.peExtractSignature(out) as Buffer);
    // The container lists the extra certificate first, which is what makes "first certificate" wrong
    expect(info.certificates).toHaveLength(2);
    expect(info.certificates[0].equals(extra)).toBe(true);
    const found = findSignerCertificate(info, info.signers[0]) as Buffer;
    expect(found.equals(signerDer)).toBe(true);
    expect(verifySignerSignature(info.signers[0], found, info.content as Buffer)).toBe("verified");
    // The extra certificate is not the signer's, so its key does not verify the signature
    expect(verifySignerSignature(info.signers[0], extra, info.content as Buffer)).toBe("failed");
  });

  it("ignores the zero padding after the container in the file's certificate table", () => {
    if (!optionalExternalCheck("cms-osslsigncode", haveTools(), "openssl or osslsigncode not found")) {
      return;
    }
    const dir = tempDir("cms-ecdsa-pad-");
    const signer = makeCertificate(dir, "ossl-ecdsa");
    const out = path.join(dir, "signed.exe");
    signWith(dir, signer.cert, signer.key, out);

    const table = certificateTable(out);
    const exact = addon.peExtractSignature(out) as Buffer;
    const info = readSignedData(table);
    const found = findSignerCertificate(info, info.signers[0]) as Buffer;
    expect(verifySignerSignature(info.signers[0], found, info.content as Buffer)).toBe("verified");
    const padded = readSignedData(Buffer.concat([exact, Buffer.alloc(16)]));
    expect(padded.certificates.map((c: Buffer) => c.toString("hex"))).toEqual(readSignedData(exact).certificates.map((c: Buffer) => c.toString("hex")));
  });
});

// ── unsupported shapes ───────────────────────────────────────

describe("signature data of an unsupported shape", () => {
  let der: Buffer;

  beforeAll(async () => {
    der = (await ownSamples())[0].der;
  });

  function throwsUnsupported(input: Buffer): void {
    expect(() => readSignedData(input)).toThrow(CmsUnsupported);
  }

  it("two signer records are CmsUnsupported", () => {
    const { parts } = pieces(der);
    const signerInfo = children(parts[parts.length - 1])[0].full;
    throwsUnsupported(withSigners(der, [signerInfo, signerInfo]));
  });

  it("no signer record is CmsUnsupported", () => {
    throwsUnsupported(withSigners(der, []));
  });

  it("an indefinite length is CmsUnsupported", () => {
    const outer = readElement(der, 0);
    const indefinite = Buffer.concat([Buffer.from([0x30, 0x80]), outer.value, Buffer.from([0x00, 0x00])]);
    throwsUnsupported(indefinite);
  });

  it("a content type other than signedData is CmsUnsupported", () => {
    const { oid, parts } = pieces(der);
    const dataOid = tlv(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]));
    expect(oid.full.equals(dataOid)).toBe(false);
    const rebuilt = tlv(0x30, dataOid, tlv(0xa0, tlv(0x30, ...parts.map((part) => part.full))));
    throwsUnsupported(rebuilt);
  });

  it("an unknown signature algorithm OID is CmsUnsupported when read, or 'unsupported' when the signature is checked", () => {
    // 1.2.3.4.5
    const changed = withSignatureAlgorithm(der, Buffer.from([0x2a, 0x03, 0x04, 0x05]));
    let info;
    try {
      info = readSignedData(changed);
    } catch (err) {
      expect(err).toBeInstanceOf(CmsUnsupported);
      return;
    }
    const certificate = findSignerCertificate(info, info.signers[0]) as Buffer;
    expect(verifySignerSignature(info.signers[0], certificate, Buffer.alloc(32))).toBe("unsupported");
  });
});

// ── damaged data ─────────────────────────────────────────────

describe("damaged signature data", () => {
  let der: Buffer;

  beforeAll(async () => {
    der = (await ownSamples())[0].der;
  });

  function throwsDamaged(input: Buffer): void {
    expect(() => readSignedData(input)).toThrow(CmsDamaged);
  }

  it("a length that runs past the end is CmsDamaged", () => {
    throwsDamaged(der.subarray(0, der.length - 10));
    throwsDamaged(der.subarray(0, 40));
  });

  it("an inner length that runs past the enclosing element is CmsDamaged", () => {
    const { oid } = pieces(der);
    const outer = readElement(der, 0);
    const explicit = readElement(outer.value, oid.full.length);
    const headerSize = (element: Element): number => element.full.length - element.value.length;
    // Offset of the SignedData element: after the outer header, the content type and the explicit tag
    const at = headerSize(outer) + oid.full.length + headerSize(explicit);
    const lengthBytes = der[at + 1] & 0x7f;
    expect(der[at + 1] & 0x80).toBe(0x80);
    const damaged = Buffer.from(der);
    for (let i = 0; i < lengthBytes; i++) {
      damaged[at + 2 + i] = 0xff;
    }
    throwsDamaged(damaged);
  });

  it("a wrong outer tag is CmsDamaged", () => {
    const wrong = Buffer.from(der);
    wrong[0] = 0x31;
    throwsDamaged(wrong);
    const integer = Buffer.from(der);
    integer[0] = 0x02;
    throwsDamaged(integer);
  });

  it("empty input and bytes that are not DER are CmsDamaged", () => {
    throwsDamaged(Buffer.alloc(0));
    throwsDamaged(Buffer.from("this is not a signature", "utf-8"));
  });

  it("raises no exception of another class for any truncation or any single byte inverted", () => {
    const check = (input: Buffer): void => {
      try {
        const info = readSignedData(input);
        for (const signer of info.signers) {
          const certificate = findSignerCertificate(info, signer);
          if (certificate !== null) {
            verifySignerSignature(signer, certificate, Buffer.alloc(32));
          }
        }
      } catch (err) {
        if (!(err instanceof CmsDamaged) && !(err instanceof CmsUnsupported)) {
          throw new Error("unexpected " + (err as Error).name + ": " + (err as Error).message);
        }
      }
    };
    for (let length = 0; length < der.length; length++) {
      check(der.subarray(0, length));
    }
    for (let at = 0; at < der.length; at++) {
      const flipped = Buffer.from(der);
      flipped[at] ^= 0xff;
      check(flipped);
    }
  });
});
