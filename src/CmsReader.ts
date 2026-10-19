import crypto from "crypto";
import * as x509 from "@peculiar/x509";

/** The bytes are not readable as the structure they should hold: truncated, wrong tags, lengths past the end. */
export class CmsDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsDamaged";
  }
}

/** The bytes are readable but of a shape this reader does not handle. */
export class CmsUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsUnsupported";
  }
}

export const OID = {
  signedData: "1.2.840.113549.1.7.2",
  data: "1.2.840.113549.1.7.1",
  spcIndirectData: "1.3.6.1.4.1.311.2.1.4",
  nestedSignature: "1.3.6.1.4.1.311.2.4.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha1WithRSA: "1.2.840.113549.1.1.5",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha384WithRSA: "1.2.840.113549.1.1.12",
  sha512WithRSA: "1.2.840.113549.1.1.13",
  idEcPublicKey: "1.2.840.10045.2.1",
  ecdsaWithSha1: "1.2.840.10045.4.1",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  ecdsaWithSha512: "1.2.840.10045.4.3.4",
};

export interface SignerRecord {
  sid: { issuer: Buffer; serial: Buffer } | { subjectKeyIdentifier: Buffer };
  digestAlgorithm: string;
  signedAttributes?: {
    raw: Buffer; // as encoded, with the [0] tag
    contentType?: string;
    messageDigest?: Buffer;
  };
  signatureAlgorithm: string;
  signature: Buffer;
  hasNestedSignature: boolean;
}

export interface SignedDataInfo {
  contentType: string;
  content?: Buffer; // value bytes of the encapsulated content, without tag and length
  contentDer?: Buffer; // the encapsulated content element as encoded
  certificates: Buffer[];
  signers: SignerRecord[];
}

// ── DER reading ──────────────────────────────────────────────

interface Element {
  tag: number;
  /** The element as encoded: tag, length and value. */
  full: Buffer;
  /** The value bytes. */
  value: Buffer;
}

/** Reads the element starting at `at` in `buffer`; every read is checked against the end of the buffer. */
function readElement(buffer: Buffer, at: number): Element {
  if (at < 0 || at + 2 > buffer.length) {
    throw new CmsDamaged("signature data ends inside an element header");
  }
  const tag = buffer[at];
  if ((tag & 0x1f) === 0x1f) {
    throw new CmsDamaged("signature data holds a tag number that is not valid here");
  }
  const first = buffer[at + 1];
  let length: number;
  let header: number;
  if (first < 0x80) {
    length = first;
    header = 2;
  } else if (first === 0x80) {
    throw new CmsUnsupported("signature data uses an indefinite length");
  } else {
    const count = first & 0x7f;
    if (count > 6) {
      throw new CmsDamaged("signature data holds a length that is too large");
    }
    if (at + 2 + count > buffer.length) {
      throw new CmsDamaged("signature data ends inside a length");
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + buffer[at + 2 + i];
    }
    header = 2 + count;
  }
  const end = at + header + length;
  if (end > buffer.length) {
    throw new CmsDamaged("signature data holds a length that runs past the end");
  }
  return { tag, full: buffer.subarray(at, end), value: buffer.subarray(at + header, end) };
}

function childrenOf(element: Element): Element[] {
  const result: Element[] = [];
  let at = 0;
  while (at < element.value.length) {
    const child = readElement(element.value, at);
    result.push(child);
    at += child.full.length;
  }
  return result;
}

function expectTag(element: Element | undefined, tag: number, what: string): Element {
  if (element === undefined || element.tag !== tag) {
    throw new CmsDamaged(`signature data does not hold ${what} where it should`);
  }
  return element;
}

function decodeOid(element: Element): string {
  const bytes = expectTag(element, 0x06, "an object identifier").value;
  if (bytes.length === 0) {
    throw new CmsDamaged("signature data holds an empty object identifier");
  }
  const parts: string[] = [];
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      if (parts.length === 0) {
        const head = Math.min(Math.floor(value / 40), 2);
        parts.push(String(head), String(value - head * 40));
      } else {
        parts.push(String(value));
      }
      value = 0;
    }
  }
  return parts.join(".");
}

function algorithmOid(element: Element | undefined): string {
  return decodeOid(childrenOf(expectTag(element, 0x30, "an algorithm"))[0]);
}

// ── reading SignedData ───────────────────────────────────────

/**
 * Reads a ContentInfo holding SignedData. Bytes after the outer element are ignored.
 * Throws CmsDamaged for data that cannot be read and CmsUnsupported for readable data of a shape not handled.
 */
export function readSignedData(der: Buffer): SignedDataInfo {
  try {
    return parseSignedData(der);
  } catch (err) {
    if (err instanceof CmsDamaged || err instanceof CmsUnsupported) {
      throw err;
    }
    throw new CmsDamaged(`signature data cannot be read: ${(err as Error).message}`);
  }
}

function parseSignedData(der: Buffer): SignedDataInfo {
  const contentInfo = expectTag(readElement(der, 0), 0x30, "a sequence");
  const contentInfoParts = childrenOf(contentInfo);
  if (decodeOid(contentInfoParts[0]) !== OID.signedData) {
    throw new CmsUnsupported("signature data is not of the signed-data type");
  }
  const explicit = expectTag(contentInfoParts[1], 0xa0, "the signed data wrapper");
  const signedData = expectTag(childrenOf(explicit)[0], 0x30, "the signed data");
  const parts = childrenOf(signedData);
  if (parts.length < 4) {
    throw new CmsDamaged("signed data is missing parts");
  }
  expectTag(parts[0], 0x02, "a version");
  expectTag(parts[1], 0x31, "the digest algorithms");

  const encapsulated = childrenOf(expectTag(parts[2], 0x30, "the encapsulated content"));
  const info: SignedDataInfo = { contentType: decodeOid(encapsulated[0]), certificates: [], signers: [] };
  if (encapsulated.length > 1) {
    const wrapper = expectTag(encapsulated[1], 0xa0, "the content wrapper");
    const element = childrenOf(wrapper)[0];
    if (element !== undefined) {
      info.content = Buffer.from(element.value);
      info.contentDer = Buffer.from(element.full);
    }
  }

  let index = 3;
  while (index < parts.length - 1) {
    const part = parts[index];
    if (part.tag === 0xa0) {
      info.certificates = readCertificateList(part);
    } else if (part.tag !== 0xa1) {
      throw new CmsDamaged("signed data holds an element that is not valid here");
    }
    index++;
  }

  const signerSet = expectTag(parts[parts.length - 1], 0x31, "the signer records");
  const records = childrenOf(signerSet);
  if (records.length === 0) {
    throw new CmsUnsupported("signature data holds no signer record");
  }
  if (records.length > 1) {
    throw new CmsUnsupported("signature data holds more than one signer record");
  }
  info.signers = records.map(readSignerRecord);
  return info;
}

/** The list is a [0] IMPLICIT SET OF certificate, or the tool's earlier form where the list is wrapped in a SET. */
function readCertificateList(list: Element): Buffer[] {
  const certificates: Buffer[] = [];
  for (const child of childrenOf(list)) {
    if (child.tag === 0x30) {
      certificates.push(Buffer.from(child.full));
    } else if (child.tag === 0x31) {
      for (const inner of childrenOf(child)) {
        if (inner.tag === 0x30) {
          certificates.push(Buffer.from(inner.full));
        }
      }
    }
  }
  return certificates;
}

function readSignerRecord(record: Element): SignerRecord {
  const fields = childrenOf(expectTag(record, 0x30, "a signer record"));
  if (fields.length < 5) {
    throw new CmsDamaged("a signer record is missing parts");
  }
  expectTag(fields[0], 0x02, "a version");

  let sid: SignerRecord["sid"];
  if (fields[1].tag === 0x30) {
    const issuerAndSerial = childrenOf(fields[1]);
    sid = { issuer: Buffer.from(expectTag(issuerAndSerial[0], 0x30, "an issuer").full), serial: Buffer.from(expectTag(issuerAndSerial[1], 0x02, "a serial number").value) };
  } else if (fields[1].tag === 0x80) {
    sid = { subjectKeyIdentifier: Buffer.from(fields[1].value) };
  } else {
    throw new CmsDamaged("a signer record holds an identifier that is not valid");
  }

  let next = 2;
  const digestAlgorithm = algorithmOid(fields[next++]);

  let signedAttributes: SignerRecord["signedAttributes"];
  if (fields[next] !== undefined && fields[next].tag === 0xa0) {
    signedAttributes = readSignedAttributes(fields[next]);
    next++;
  }
  const signatureAlgorithm = algorithmOid(fields[next++]);
  const signature = Buffer.from(expectTag(fields[next++], 0x04, "a signature").value);

  let hasNestedSignature = false;
  if (fields[next] !== undefined && fields[next].tag === 0xa1) {
    for (const attribute of childrenOf(fields[next])) {
      const attributeParts = childrenOf(expectTag(attribute, 0x30, "an attribute"));
      if (decodeOid(attributeParts[0]) === OID.nestedSignature) {
        hasNestedSignature = true;
      }
    }
  }

  return { sid, digestAlgorithm, signedAttributes, signatureAlgorithm, signature, hasNestedSignature };
}

function readSignedAttributes(element: Element): NonNullable<SignerRecord["signedAttributes"]> {
  const result: NonNullable<SignerRecord["signedAttributes"]> = { raw: Buffer.from(element.full) };
  for (const attribute of childrenOf(element)) {
    const attributeParts = childrenOf(expectTag(attribute, 0x30, "an attribute"));
    const oid = decodeOid(attributeParts[0]);
    const values = childrenOf(expectTag(attributeParts[1], 0x31, "attribute values"));
    if (oid === OID.contentType && values.length > 0) {
      result.contentType = decodeOid(values[0]);
    } else if (oid === OID.messageDigest && values.length > 0) {
      result.messageDigest = Buffer.from(expectTag(values[0], 0x04, "a message digest").value);
    }
  }
  return result;
}

// ── finding the signer's certificate ─────────────────────────

function stripLeadingZeros(bytes: Buffer): string {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  return bytes.subarray(start).toString("hex");
}

/** The issuer element and serial number value of a certificate, as encoded. */
function issuerAndSerialOf(certificate: Buffer): { issuer: Buffer; serial: Buffer } | null {
  const tbs = childrenOf(expectTag(readElement(certificate, 0), 0x30, "a certificate"))[0];
  const fields = childrenOf(expectTag(tbs, 0x30, "the certificate body"));
  let index = 0;
  if (fields[index] !== undefined && fields[index].tag === 0xa0) {
    index++;
  }
  const serial = fields[index];
  const issuer = fields[index + 2];
  if (serial === undefined || serial.tag !== 0x02 || issuer === undefined || issuer.tag !== 0x30) {
    return null;
  }
  return { issuer: issuer.full, serial: serial.value };
}

/** The certificate the signer record names, wherever it is in the list; null when none matches. */
export function findSignerCertificate(info: SignedDataInfo, signer: SignerRecord): Buffer | null {
  for (const certificate of info.certificates) {
    try {
      if ("subjectKeyIdentifier" in signer.sid) {
        const extension = new x509.X509Certificate(certificate).getExtension(x509.SubjectKeyIdentifierExtension);
        if (extension !== null && Buffer.from(extension.keyId, "hex").equals(signer.sid.subjectKeyIdentifier)) {
          return certificate;
        }
      } else {
        const found = issuerAndSerialOf(certificate);
        if (found !== null && found.issuer.equals(signer.sid.issuer) && stripLeadingZeros(found.serial) === stripLeadingZeros(signer.sid.serial)) {
          return certificate;
        }
      }
    } catch {
      // A certificate that cannot be read is never the match
    }
  }
  return null;
}

// ── checking the signature ───────────────────────────────────

const DIGEST_NAMES: Record<string, string> = {
  [OID.sha1]: "sha1",
  [OID.sha256]: "sha256",
  [OID.sha384]: "sha384",
  [OID.sha512]: "sha512",
};

/** For each signature algorithm: the key type it needs and the digest it fixes (null: the signer's digest algorithm). */
const SIGNATURE_ALGORITHMS: Record<string, { key: "ec" | "rsa"; digest: string | null }> = {
  [OID.idEcPublicKey]: { key: "ec", digest: null },
  [OID.ecdsaWithSha1]: { key: "ec", digest: "sha1" },
  [OID.ecdsaWithSha256]: { key: "ec", digest: "sha256" },
  [OID.ecdsaWithSha384]: { key: "ec", digest: "sha384" },
  [OID.ecdsaWithSha512]: { key: "ec", digest: "sha512" },
  [OID.rsaEncryption]: { key: "rsa", digest: null },
  [OID.sha1WithRSA]: { key: "rsa", digest: "sha1" },
  [OID.sha256WithRSA]: { key: "rsa", digest: "sha256" },
  [OID.sha384WithRSA]: { key: "rsa", digest: "sha384" },
  [OID.sha512WithRSA]: { key: "rsa", digest: "sha512" },
};

/**
 * Checks a signer record's signature with the certificate's key.
 * With signed attributes the attributes are what is signed, and `unsignedMessage` must hash to their message digest;
 * without them `unsignedMessage` is what is signed.
 */
export function verifySignerSignature(signer: SignerRecord, certificate: Buffer, unsignedMessage: Buffer): "verified" | "failed" | "unsupported" {
  const algorithm = SIGNATURE_ALGORITHMS[signer.signatureAlgorithm];
  const digestName = DIGEST_NAMES[signer.digestAlgorithm];
  if (algorithm === undefined || digestName === undefined) {
    return "unsupported";
  }
  const signatureDigest = algorithm.digest ?? digestName;

  try {
    const key = new crypto.X509Certificate(certificate).publicKey;
    if (key.asymmetricKeyType === "rsa-pss" || (key.asymmetricKeyType !== "ec" && key.asymmetricKeyType !== "rsa")) {
      return "unsupported";
    }
    if (key.asymmetricKeyType !== algorithm.key) {
      return "failed";
    }

    let signed = unsignedMessage;
    if (signer.signedAttributes !== undefined) {
      const expected = signer.signedAttributes.messageDigest;
      if (expected === undefined || !crypto.createHash(digestName).update(unsignedMessage).digest().equals(expected)) {
        return "failed";
      }
      // The attributes are signed with the SET tag in place of the [0] tag
      signed = Buffer.concat([Buffer.from([0x31]), signer.signedAttributes.raw.subarray(1)]);
    }
    return crypto.verify(signatureDigest, signed, key, signer.signature) ? "verified" : "failed";
  } catch {
    return "failed";
  }
}
