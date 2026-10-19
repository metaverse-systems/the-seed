/**
 * Reads the CMS SignedData of a signature with the @peculiar ASN.1 libraries: the signer certificate and the signer's
 * signature over its signed attributes and content digest. Containers in the standard form and the earlier form
 * (no signed attributes) are both read. This is the integrity half of trust decisions; whether the signer is trusted
 * is decided in Trust.ts. Unreadable input throws CmsDamaged, a form not handled throws CmsUnsupported.
 */
import crypto from "crypto";
import * as asn1js from "asn1js";
import * as x509 from "@peculiar/x509";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import { ContentInfo, SignedData, SignerInfo } from "@peculiar/asn1-cms";
import { AlgorithmIdentifier, Certificate } from "@peculiar/asn1-x509";

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

// ── exact bytes from the asn1js tree ─────────────────────────

/** The part of an asn1js element this reader uses: its tag, its encoding as read and its value block. */
interface Node {
  idBlock: { tagClass: number; tagNumber: number; blockLength: number };
  lenBlock: { isIndefiniteForm: boolean; blockLength: number };
  valueBeforeDecodeView: Uint8Array;
  valueBlock: { value?: unknown };
}

const TAG_CLASS_UNIVERSAL = 1;
const TAG_CLASS_CONTEXT = 3;

function childrenOf(node: Node): Node[] {
  return node instanceof asn1js.Constructed ? (node.valueBlock.value as unknown as Node[]) : [];
}

/** The element as encoded: tag, length and value. */
function fullBytes(node: Node): Buffer {
  return Buffer.from(node.valueBeforeDecodeView);
}

/** The value bytes of an element, without tag and length. */
function valueBytes(node: Node): Buffer {
  return fullBytes(node).subarray(node.idBlock.blockLength + node.lenBlock.blockLength);
}

function isContext(node: Node | undefined, tagNumber: number): node is Node {
  return node !== undefined && node.idBlock.tagClass === TAG_CLASS_CONTEXT && node.idBlock.tagNumber === tagNumber;
}

function findIndefinite(node: Node): boolean {
  if (node.lenBlock.isIndefiniteForm) {
    return true;
  }
  return childrenOf(node).some(findIndefinite);
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
}

/** Decodes the first element of `bytes`; the decoder's failures are CmsDamaged. */
function decodeElement(bytes: Buffer): { node: Node; length: number } {
  const decoded = asn1js.fromBER(toArrayBuffer(bytes));
  if (decoded.offset === -1) {
    throw new CmsDamaged(`signature data cannot be decoded: ${decoded.result.error || "invalid encoding"}`);
  }
  return { node: decoded.result as unknown as Node, length: decoded.offset };
}

function parseTyped<T>(bytes: Buffer | ArrayBuffer, type: new () => T, what: string): T {
  try {
    return AsnConvert.parse(bytes, type);
  } catch (err) {
    throw new CmsDamaged(`signature data does not hold ${what} where it should: ${(err as Error).message}`);
  }
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
  const { node: root, length } = decodeElement(der);
  if (findIndefinite(root)) {
    throw new CmsUnsupported("signature data uses an indefinite length");
  }
  if (root.idBlock.tagClass !== TAG_CLASS_UNIVERSAL || root.idBlock.tagNumber !== 16) {
    throw new CmsDamaged("signature data does not hold a sequence where it should");
  }
  const contentInfo = parseTyped(fullBytes(root).subarray(0, length), ContentInfo, "the content info");
  if (contentInfo.contentType !== OID.signedData) {
    throw new CmsUnsupported("signature data is not of the signed-data type");
  }
  const signedData = parseTyped(contentInfo.content, SignedData, "the signed data");

  // The tree gives the bytes that must not be re-encoded
  const signedDataNode = childrenOf(childrenOf(root)[1])[0];
  const parts = childrenOf(signedDataNode);
  const info: SignedDataInfo = { contentType: signedData.encapContentInfo.eContentType, certificates: [], signers: [] };

  const wrapper = childrenOf(parts[2])[1];
  const content = wrapper === undefined ? undefined : childrenOf(wrapper)[0];
  if (content !== undefined) {
    info.contentDer = fullBytes(content);
    info.content = valueBytes(content);
  }
  const list = parts.find((part) => isContext(part, 0));
  if (list !== undefined) {
    info.certificates = readCertificateList(list);
  }

  const signerNodes = childrenOf(parts[parts.length - 1]);
  if (signedData.signerInfos.length === 0) {
    throw new CmsUnsupported("signature data holds no signer record");
  }
  if (signedData.signerInfos.length > 1) {
    throw new CmsUnsupported("signature data holds more than one signer record");
  }
  info.signers = [readSignerRecord(signedData.signerInfos[0], signerNodes[0])];
  return info;
}

/** The list is a [0] IMPLICIT SET OF certificate, or the tool's earlier form where the list is wrapped in a SET. */
function readCertificateList(list: Node): Buffer[] {
  const certificates: Buffer[] = [];
  for (const child of childrenOf(list)) {
    if (child.idBlock.tagClass !== TAG_CLASS_UNIVERSAL) {
      continue;
    }
    if (child.idBlock.tagNumber === 16) {
      certificates.push(fullBytes(child));
    } else if (child.idBlock.tagNumber === 17) {
      for (const inner of childrenOf(child)) {
        if (inner.idBlock.tagClass === TAG_CLASS_UNIVERSAL && inner.idBlock.tagNumber === 16) {
          certificates.push(fullBytes(inner));
        }
      }
    }
  }
  return certificates;
}

function readSignerRecord(record: SignerInfo, node: Node): SignerRecord {
  const fields = childrenOf(node);
  let sid: SignerRecord["sid"];
  if (record.sid.issuerAndSerialNumber !== undefined) {
    const [issuer, serial] = childrenOf(fields[1]);
    sid = { issuer: fullBytes(issuer), serial: valueBytes(serial) };
  } else if (record.sid.subjectKeyIdentifier !== undefined) {
    sid = { subjectKeyIdentifier: Buffer.from(record.sid.subjectKeyIdentifier.buffer) };
  } else {
    throw new CmsDamaged("a signer record holds an identifier that is not valid");
  }

  let signedAttributes: SignerRecord["signedAttributes"];
  if (record.signedAttrs !== undefined) {
    const rawNode = fields.find((field) => isContext(field, 0));
    if (rawNode === undefined) {
      throw new CmsDamaged("a signer record holds signed attributes that cannot be located");
    }
    signedAttributes = { raw: fullBytes(rawNode) };
    for (const attribute of record.signedAttrs) {
      const value = attribute.attrValues[0];
      if (value === undefined) {
        continue;
      }
      if (attribute.attrType === OID.contentType) {
        const oid = decodeElement(Buffer.from(value)).node as unknown;
        if (!(oid instanceof asn1js.ObjectIdentifier)) {
          throw new CmsDamaged("signature data does not hold an object identifier where it should");
        }
        signedAttributes.contentType = oid.valueBlock.toString();
      } else if (attribute.attrType === OID.messageDigest) {
        signedAttributes.messageDigest = Buffer.from(parseTyped(Buffer.from(value), OctetString, "a message digest").buffer);
      }
    }
  }

  const hasNestedSignature = (record.unsignedAttrs ?? []).some((attribute) => attribute.attrType === OID.nestedSignature);
  return {
    sid,
    digestAlgorithm: record.digestAlgorithm.algorithm,
    signedAttributes,
    signatureAlgorithm: record.signatureAlgorithm.algorithm,
    signature: Buffer.from(record.signature.buffer),
    hasNestedSignature,
  };
}

// ── finding the signer's certificate ─────────────────────────

function stripLeadingZeros(bytes: Buffer): string {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  return bytes.subarray(start).toString("hex");
}

/** The issuer element and serial number value of a certificate, as encoded; null when the certificate has neither. */
export function issuerAndSerialOf(certificate: Buffer): { issuer: Buffer; serial: Buffer } | null {
  const parsed = AsnConvert.parse(certificate, Certificate);
  if (parsed.tbsCertificateRaw === undefined) {
    return null;
  }
  const fields = childrenOf(decodeElement(Buffer.from(parsed.tbsCertificateRaw)).node);
  const index = isContext(fields[0], 0) ? 1 : 0;
  const serial = fields[index];
  const issuer = fields[index + 2];
  if (serial === undefined || issuer === undefined) {
    return null;
  }
  return { issuer: fullBytes(issuer), serial: valueBytes(serial) };
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

// ── Authenticode content ─────────────────────────────────────

/**
 * Reads the digest an Authenticode signature holds: the DigestInfo of its SpcIndirectDataContent.
 * `content` is the value bytes of the encapsulated content (`SignedDataInfo.content`).
 */
export function readSpcDigest(content: Buffer): { algorithm: string; digest: Buffer } {
  try {
    const parts: Node[] = [];
    let at = 0;
    while (at < content.length) {
      const { node, length } = decodeElement(content.subarray(at));
      parts.push(node);
      at += length;
    }
    if (parts.length < 2) {
      throw new CmsDamaged("the signed content is missing parts");
    }
    const [algorithm, digest] = childrenOf(parts[1]);
    if (algorithm === undefined || digest === undefined || !(digest instanceof asn1js.OctetString)) {
      throw new CmsDamaged("signature data does not hold a digest where it should");
    }
    return {
      algorithm: parseTyped(fullBytes(algorithm), AlgorithmIdentifier, "an algorithm").algorithm,
      digest: valueBytes(digest),
    };
  } catch (err) {
    if (err instanceof CmsDamaged || err instanceof CmsUnsupported) {
      throw err;
    }
    throw new CmsDamaged(`signature data cannot be read: ${(err as Error).message}`);
  }
}
