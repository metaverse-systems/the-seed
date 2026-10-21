import crypto from "crypto";
import fs from "fs";
import path from "path";
import { NATIVE_COMPONENT_PATH } from "../src/NativeComponent";
import * as asn1js from "asn1js";
import * as x509 from "@peculiar/x509";
import { BUILDER_OID, buildSignatureContainer, containerCapacity, spcIndirectDataContent, SignedContent } from "../src/CmsBuilder";
import { OID, readSignedData, SignedDataInfo } from "../src/CmsReader";

// eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
const addon = require(path.join(__dirname, "..", NATIVE_COMPONENT_PATH)) as Record<string, (...args: unknown[]) => unknown>;

// Choices where the contracts leave the details open:
// - spcIndirectDataContent returns the SpcIndirectDataContent element as encoded (tag, length and value), which is what
//   readSignedData reports as contentDer; the message digest covers its value bytes.
// - Errors name the problem with these words: "fingerprint" with "32", "code directory", "certificate" with "DER".

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

function hex(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ""), "hex");
}

function sha256(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

/** The decoded dotted form of an OBJECT IDENTIFIER element. */
function oidOf(element: Element): string {
  const bytes = element.value;
  const arcs: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let current = 0;
  for (let i = 1; i < bytes.length; i++) {
    current = current * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      arcs.push(current);
      current = 0;
    }
  }
  return arcs.join(".");
}

interface ContainerParts {
  signedData: Element;
  encapsulated: Element;
  certificates: Element;
  signerInfo: Element;
  signerFields: Element[];
}

/** ContentInfo { oid, [0] { SignedData { version, digestAlgorithms, encapContentInfo, [0] certificates, SET { signer } } } }. */
function partsOf(container: Buffer): ContainerParts {
  const contentInfo = readElement(container, 0);
  const [, explicit] = children(contentInfo);
  const signedData = children(explicit)[0];
  const fields = children(signedData);
  expect(fields.map((field) => field.tag)).toEqual([0x02, 0x31, 0x30, 0xa0, 0x31]);
  const signers = children(fields[4]);
  expect(signers).toHaveLength(1);
  return { signedData, encapsulated: fields[2], certificates: fields[3], signerInfo: signers[0], signerFields: children(signers[0]) };
}

interface Attribute {
  oid: string;
  full: Buffer;
  values: Element[];
}

function attributesOf(raw: Buffer): Attribute[] {
  expect(raw[0]).toBe(0xa0);
  return children(readElement(raw, 0)).map((attribute) => {
    const [oid, values] = children(attribute);
    return { oid: oidOf(oid), full: attribute.full, values: children(values) };
  });
}

/** Checks that every element lies inside its parent and that the children of a constructed element fill it exactly. */
function checkNesting(buffer: Buffer, start: number, end: number): void {
  let at = start;
  while (at < end) {
    const element = readElement(buffer, at);
    const next = at + element.full.length;
    expect(next).toBeLessThanOrEqual(end);
    if (element.tag & 0x20) {
      checkNesting(element.full, element.full.length - element.value.length, element.full.length);
    }
    at = next;
  }
  expect(at).toBe(end);
}

// ── certificates made in the test ──────────────────────────

interface TestCertificate {
  der: Buffer;
  key: crypto.KeyObject;
}

const webcrypto = crypto.webcrypto as unknown as crypto.webcrypto.Crypto;

async function makeCertificate(options: { serialHex: string; name: string }): Promise<TestCertificate> {
  x509.cryptoProvider.set(webcrypto);
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: options.serialHex,
    name: options.name,
    notBefore: new Date("2026-01-01T00:00:00Z"),
    notAfter: new Date("2036-01-01T00:00:00Z"),
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  return { der: Buffer.from(certificate.rawData), key: crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }) };
}

/** The serial number element and issuer element of a certificate, as the certificate encodes them. */
function certificateIdentity(der: Buffer): { serial: Buffer; issuer: Buffer } {
  const tbs = children(readElement(der, 0))[0];
  const fields = children(tbs);
  const index = fields[0].tag === 0xa0 ? 1 : 0;
  return { serial: fields[index].full, issuer: fields[index + 2].full };
}

/** A certificate whose serial number is written `00 05`, with the signature made again over the changed TBS. */
async function makeRedundantZeroCertificate(): Promise<TestCertificate> {
  const source = await makeCertificate({ serialHex: "05", name: "CN=Redundant Zero" });
  const [tbs, algorithm] = children(readElement(source.der, 0));
  const fields = children(tbs);
  expect(fields[1].full.equals(hex("02 01 05"))).toBe(true);
  const changed = tlv(0x30, fields[0].full, hex("02 02 00 05"), ...fields.slice(2).map((field) => field.full));
  const signature = crypto.sign("sha256", changed, source.key);
  const der = tlv(0x30, changed, algorithm.full, tlv(0x03, Buffer.from([0]), signature));
  // The library still reads the certificate, and the serial is as built
  expect(new x509.X509Certificate(der).serialNumber).toBeDefined();
  expect(certificateIdentity(der).serial.equals(hex("02 02 00 05"))).toBe(true);
  return { der, key: source.key };
}

function longName(): string {
  return `CN=${"a".repeat(120)}, O=${"b".repeat(120)}, OU=${"c".repeat(120)}, L=${"d".repeat(60)}`;
}

let normal: TestCertificate;
let longNamed: TestCertificate;
let topBit: TestCertificate;
let redundantZero: TestCertificate;

const TOP_BIT_SERIAL = "82aabbccddeeff00112233445566778899aabbcc";

beforeAll(async () => {
  normal = await makeCertificate({ serialHex: "1234567890abcdef1234567890abcdef", name: "CN=Builder Test, O=@bt" });
  longNamed = await makeCertificate({ serialHex: "7f00112233445566778899aabbccddeeff001122", name: longName() });
  topBit = await makeCertificate({ serialHex: TOP_BIT_SERIAL, name: "CN=Top Bit, O=@bt" });
  redundantZero = await makeRedundantZeroCertificate();
});

// ── the three kinds of signed content ────────────────────────

const FINGERPRINT = sha256(Buffer.from("fingerprint under test"));
const CODE_DIRECTORY = Buffer.concat([hex("fade0c02"), Buffer.alloc(296, 0x5a)]);

type Kind = SignedContent["kind"];
const KINDS: Kind[] = ["windows-program", "installer", "mac-program"];
const WINDOWS_KINDS: Array<"windows-program" | "installer"> = ["windows-program", "installer"];

function contentFor(kind: Kind): SignedContent {
  return kind === "mac-program" ? { kind, codeDirectory: CODE_DIRECTORY } : { kind, fingerprint: FINGERPRINT };
}

/** A DER ECDSA signature of the longest P-256 length, 72 bytes, with fixed content. */
const FIXED_SIGNATURE = Buffer.concat([hex("30 46 02 21 00"), Buffer.alloc(32, 0xc3), hex("02 21 00"), Buffer.alloc(32, 0xd4)]);

function realSign(key: crypto.KeyObject): (data: Buffer) => Buffer {
  return (data) => crypto.sign("sha256", data, key);
}

function build(kind: Kind, certificate: TestCertificate = normal): Buffer {
  return buildSignatureContainer(contentFor(kind), certificate.der, realSign(certificate.key));
}

function signedAttributesOf(info: SignedDataInfo): NonNullable<SignedDataInfo["signers"][number]["signedAttributes"]> {
  expect(info.signers).toHaveLength(1);
  const attributes = info.signers[0].signedAttributes;
  expect(attributes).toBeDefined();
  return attributes as NonNullable<typeof attributes>;
}

describe("each form", () => {
  it("content type and encapsulated content", () => {
    for (const kind of WINDOWS_KINDS) {
      const info = readSignedData(build(kind));
      expect(info.contentType).toBe(OID.spcIndirectData);
      expect(info.content).toBeDefined();
      expect((info.contentDer as Buffer).equals(spcIndirectDataContent(kind, FINGERPRINT))).toBe(true);
    }
    const mac = readSignedData(build("mac-program"));
    expect(mac.contentType).toBe(OID.data);
    expect(mac.content).toBeUndefined();
  });

  it("signed attributes", () => {
    for (const kind of KINDS) {
      const container = build(kind);
      const info = readSignedData(container);
      const raw = signedAttributesOf(info).raw;
      const attributes = attributesOf(raw);
      const oids = attributes.map((attribute) => attribute.oid);

      if (kind === "mac-program") {
        expect([...oids].sort()).toEqual(["1.2.840.113549.1.9.3", "1.2.840.113549.1.9.4"]);
      } else {
        expect([...oids].sort()).toEqual(["1.2.840.113549.1.9.3", "1.2.840.113549.1.9.4", BUILDER_OID.spcSpOpusInfo, BUILDER_OID.spcStatementType].sort());
        const opus = attributes.find((attribute) => attribute.oid === BUILDER_OID.spcSpOpusInfo) as Attribute;
        expect(opus.values.map((value) => value.full.toString("hex"))).toEqual(["3000"]);
        const statement = attributes.find((attribute) => attribute.oid === BUILDER_OID.spcStatementType) as Attribute;
        expect(statement.values).toHaveLength(1);
        expect(statement.values[0].tag).toBe(0x30);
        expect(children(statement.values[0]).map((element) => oidOf(element))).toEqual([BUILDER_OID.individualCodeSigning]);
      }

      // The content type attribute is the container's content type
      const contentType = attributes.find((attribute) => attribute.oid === "1.2.840.113549.1.9.3") as Attribute;
      expect(contentType.values).toHaveLength(1);
      expect(oidOf(contentType.values[0])).toBe(info.contentType);
      expect(signedAttributesOf(info).contentType).toBe(info.contentType);

      // One value for the message digest, a 32-byte OCTET STRING
      const digest = attributes.find((attribute) => attribute.oid === "1.2.840.113549.1.9.4") as Attribute;
      expect(digest.values).toHaveLength(1);
      expect(digest.values[0].tag).toBe(0x04);
      expect(digest.values[0].value).toHaveLength(32);

      // The set is in DER order: ascending by encoding
      const encodings = attributes.map((attribute) => attribute.full);
      const sorted = [...encodings].sort(Buffer.compare);
      expect(encodings.map((e) => e.toString("hex"))).toEqual(sorted.map((e) => e.toString("hex")));
    }
  });

  it("message digest", () => {
    for (const kind of KINDS) {
      const info = readSignedData(build(kind));
      const digest = signedAttributesOf(info).messageDigest as Buffer;
      const covered = kind === "mac-program" ? CODE_DIRECTORY : (info.content as Buffer);
      expect(digest.equals(sha256(covered))).toBe(true);
    }
  });

  it("the sign callback receives the SET-tagged attributes, and the signature is stored as returned", () => {
    for (const kind of KINDS) {
      const received: Buffer[] = [];
      const container = buildSignatureContainer(contentFor(kind), normal.der, (data) => {
        received.push(Buffer.from(data));
        return FIXED_SIGNATURE;
      });
      expect(received).toHaveLength(1);
      expect(received[0][0]).toBe(0x31);
      const info = readSignedData(container);
      const stored = signedAttributesOf(info).raw;
      expect(received[0].equals(Buffer.concat([Buffer.from([0x31]), stored.subarray(1)]))).toBe(true);
      expect(info.signers[0].signature.equals(FIXED_SIGNATURE)).toBe(true);
      expect(FIXED_SIGNATURE).toHaveLength(72);
    }
  });

  it("a signature made with the real key verifies over the received attributes", () => {
    for (const kind of KINDS) {
      const container = build(kind);
      const info = readSignedData(container);
      const data = Buffer.concat([Buffer.from([0x31]), signedAttributesOf(info).raw.subarray(1)]);
      expect(crypto.verify("sha256", data, new crypto.X509Certificate(normal.der).publicKey, info.signers[0].signature)).toBe(true);
    }
  });

  it("the container fields: version 1, SHA-256 with NULL parameters, ecdsa-with-SHA256 without parameters, one certificate, no unsigned attributes", () => {
    for (const kind of KINDS) {
      const parts = partsOf(build(kind));
      expect(children(parts.signedData)[0].full.equals(hex("02 01 01"))).toBe(true);
      const sha256Algorithm = hex("30 0d 06 09 60 86 48 01 65 03 04 02 01 05 00");
      expect(children(parts.signedData)[1].value.equals(sha256Algorithm)).toBe(true);
      expect(children(parts.certificates)).toHaveLength(1);
      expect(children(parts.certificates)[0].full.equals(normal.der)).toBe(true);
      // version, sid, digestAlgorithm, signedAttrs, signatureAlgorithm, signature
      expect(parts.signerFields.map((field) => field.tag)).toEqual([0x02, 0x30, 0x30, 0xa0, 0x30, 0x04]);
      expect(parts.signerFields[0].full.equals(hex("02 01 01"))).toBe(true);
      expect(parts.signerFields[2].full.equals(sha256Algorithm)).toBe(true);
      expect(parts.signerFields[4].full.equals(hex("30 0a 06 08 2a 86 48 ce 3d 04 03 02"))).toBe(true);
    }
  });
});

describe("windows program", () => {
  it("SpcPeImageData holds the SpcLink file choice with \"<<<Obsolete>>>\"", () => {
    const info = readSignedData(build("windows-program"));
    const obsolete = Buffer.from("<<<Obsolete>>>", "utf16le").swap16();
    expect(obsolete).toHaveLength(28);
    const expected = Buffer.concat([hex("30 25 03 01 00 a0 20 a2 1e 80 1c"), obsolete]);
    expect((info.content as Buffer).includes(expected)).toBe(true);
    expect((info.content as Buffer).includes(hex("03 01 00 a0 02 a2 00"))).toBe(false);

    // It is the value of the first element of the content, behind the PE image data OID
    const [data] = children(readElement(info.contentDer as Buffer, 0));
    const [oid, value] = children(data);
    expect(oidOf(oid)).toBe(BUILDER_OID.spcPeImageData);
    expect(value.full.equals(expected)).toBe(true);
  });
});

describe("installer", () => {
  it("SpcSipInfo values are those written before", () => {
    const fixture = path.join(__dirname, "fixtures", "binaries", "earlier-form", "tiny.msi");
    const earlier = readSignedData(addon.msiExtractSignature(fixture) as Buffer);
    const earlierData = children(readElement(earlier.contentDer as Buffer, 0))[0];
    const [earlierOid, earlierValue] = children(earlierData);
    expect(oidOf(earlierOid)).toBe(BUILDER_OID.spcSipInfo);

    const info = readSignedData(build("installer"));
    const data = children(readElement(info.contentDer as Buffer, 0))[0];
    const [oid, value] = children(data);
    expect(oidOf(oid)).toBe(BUILDER_OID.spcSipInfo);
    expect(value.full.equals(earlierValue.full)).toBe(true);
    // 65536, the GUID, and four zeros
    expect(children(value).map((element) => element.tag)).toEqual([0x02, 0x04, 0x02, 0x02, 0x02, 0x02]);
  });
});

describe("signer identifier", () => {
  it("issuer and serial are the certificate's bytes", () => {
    const identity = certificateIdentity(topBit.der);
    // The certificate writes the serial in 21 bytes, the first of which is 00
    expect(identity.serial.subarray(0, 4).equals(hex("02 15 00 82"))).toBe(true);
    for (const kind of KINDS) {
      const parts = partsOf(build(kind, topBit));
      const [issuer, serial] = children(parts.signerFields[1]);
      expect(parts.signerFields[1].tag).toBe(0x30);
      expect(serial.full.equals(identity.serial)).toBe(true);
      expect(serial.value.subarray(0, 3).equals(hex("00 82 aa"))).toBe(true);
      expect(issuer.full.equals(identity.issuer)).toBe(true);
      // What the reader reports agrees
      const signer = readSignedData(build(kind, topBit)).signers[0];
      expect("serial" in signer.sid && signer.sid.serial.equals(serial.value)).toBe(true);
    }
  });

  it("a serial with a redundant leading zero is kept as the certificate holds it", () => {
    const identity = certificateIdentity(redundantZero.der);
    for (const kind of KINDS) {
      const parts = partsOf(build(kind, redundantZero));
      const [issuer, serial] = children(parts.signerFields[1]);
      expect(serial.full.equals(hex("02 02 00 05"))).toBe(true);
      expect(serial.full.equals(identity.serial)).toBe(true);
      expect(issuer.full.equals(identity.issuer)).toBe(true);
    }
  });
});

describe("large inputs", () => {
  it("long names and a 200-byte signature use long-form lengths and nest correctly", () => {
    for (const kind of KINDS) {
      for (const certificate of [normal, longNamed]) {
        for (const size of [70, 200]) {
          const signature = Buffer.alloc(size, 0xab);
          const container = buildSignatureContainer(contentFor(kind), certificate.der, () => signature);

          // The whole value is one well-formed tree that fills the buffer
          const top = readElement(container, 0);
          expect(top.full.length).toBe(container.length);
          checkNesting(container, 0, container.length);
          const decoded = asn1js.fromBER(new Uint8Array(container).buffer);
          expect(decoded.offset).toBe(container.length);
          expect(decoded.result.error).toBe("");

          // The signature is the last element of the signer record, so it ends the container
          const expectedHeader = size < 128 ? Buffer.from([0x04, size]) : Buffer.from([0x04, 0x81, size]);
          const at = container.lastIndexOf(Buffer.concat([expectedHeader, signature]));
          expect(at).toBeGreaterThan(0);
          expect(at + expectedHeader.length + size).toBe(container.length);

          // And it reads back as stored
          expect(readSignedData(container).signers[0].signature.equals(signature)).toBe(true);
        }
      }
    }
    expect(longNamed.der.length).toBeGreaterThan(600);
  });
});

describe("capacity", () => {
  it("every container fits containerCapacity, for normal, long-name and top-bit certificates", () => {
    for (const certificate of [normal, longNamed, topBit]) {
      const capacity = containerCapacity(certificate.der);
      expect(capacity).toBeGreaterThan(certificate.der.length);
      for (let i = 0; i < 50; i++) {
        const codeDirectory = crypto.randomBytes(200 + i);
        const container = buildSignatureContainer({ kind: "mac-program", codeDirectory }, certificate.der, realSign(certificate.key));
        expect(container.length).toBeLessThanOrEqual(capacity);
      }
    }
  });
});

describe("errors", () => {
  const sign = (): Buffer => FIXED_SIGNATURE;

  it("a fingerprint that is not 32 bytes throws with a message naming it", () => {
    for (const kind of WINDOWS_KINDS) {
      for (const size of [0, 31, 33]) {
        expect(() => buildSignatureContainer({ kind, fingerprint: Buffer.alloc(size, 1) }, normal.der, sign)).toThrow(/fingerprint.*32|32.*fingerprint/i);
      }
    }
  });

  it("an empty code directory throws with a message naming it", () => {
    expect(() => buildSignatureContainer({ kind: "mac-program", codeDirectory: Buffer.alloc(0) }, normal.der, sign)).toThrow(/code directory/i);
  });

  it("a certificate that is not DER throws with a message naming it", () => {
    const pem = Buffer.from(new x509.X509Certificate(normal.der).toString("pem"));
    for (const kind of KINDS) {
      expect(() => buildSignatureContainer(contentFor(kind), pem, sign)).toThrow(/certificate.*DER|DER.*certificate/i);
      expect(() => buildSignatureContainer(contentFor(kind), Buffer.alloc(0), sign)).toThrow(/certificate/i);
    }
    expect(() => containerCapacity(pem)).toThrow(/certificate/i);
  });

  it("no file is read: the module reads certificates and keys only from its arguments", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "CmsBuilder.ts"), "utf-8");
    expect(source).not.toMatch(/from "fs"|require\("fs"\)|from "node:fs"/);
  });
});
