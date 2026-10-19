/**
 * Builds the signature containers the tool writes: a CMS ContentInfo holding SignedData with one signer, in the standard
 * form other verifiers accept, for Windows programs, installers and Mac programs. The functions work on bytes only: the
 * certificate and the signing function are arguments, and nothing is read from files or keys here.
 */
import crypto from "crypto";
import * as asn1js from "asn1js";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  Attribute,
  CertificateChoices,
  CertificateSet,
  CMSVersion,
  ContentInfo,
  DigestAlgorithmIdentifiers,
  EncapsulatedContent,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedData,
  SignerIdentifier,
  SignerInfo,
  SignerInfos,
} from "@peculiar/asn1-cms";
import { AlgorithmIdentifier, Certificate } from "@peculiar/asn1-x509";
import { issuerAndSerialOf, OID, readSignedData } from "./CmsReader";

/** What a container signs: a Windows fingerprint, or a Mac slice's code directory (signed detached). */
export type SignedContent =
  | { kind: "windows-program"; fingerprint: Buffer }
  | { kind: "installer"; fingerprint: Buffer }
  | { kind: "mac-program"; codeDirectory: Buffer };

/** Returns the DER signature over `signedAttributes` (the SET-tagged DER of the signed attributes). */
export type SignCallback = (signedAttributes: Buffer) => Buffer;

export const BUILDER_OID = {
  spcPeImageData: "1.3.6.1.4.1.311.2.1.15",
  spcSipInfo: "1.3.6.1.4.1.311.2.1.30",
  spcSpOpusInfo: "1.3.6.1.4.1.311.2.1.12",
  spcStatementType: "1.3.6.1.4.1.311.2.1.11",
  individualCodeSigning: "1.3.6.1.4.1.311.2.1.21",
} as const;

/** The GUID of the installer signature interface (F1100C00-0000-0000-C000-000000000046), as the earlier form wrote it. */
const MSI_SIP_GUID = Buffer.from("f1100c00" + "0000" + "0000" + "c000" + "000000000046", "hex");

/** Room added to the size of a Mac container built with the longest P-256 signature. */
const CAPACITY_MARGIN = 16;
const PLACEHOLDER_SIGNATURE_LENGTH = 72;

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
}

function sha256(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function oidDer(oid: string): ArrayBuffer {
  return new asn1js.ObjectIdentifier({ value: oid }).toBER();
}

function sha256Algorithm(): AlgorithmIdentifier {
  return new AlgorithmIdentifier({ algorithm: OID.sha256, parameters: new asn1js.Null().toBER() });
}

// ── Authenticode content ─────────────────────────────────────

function peImageData(): asn1js.Sequence {
  const obsolete = Buffer.from("<<<Obsolete>>>", "utf16le").swap16();
  const unicode = new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: toArrayBuffer(obsolete) });
  const file = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 2 }, value: [unicode] });
  const link = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [file] });
  return new asn1js.Sequence({ value: [new asn1js.BitString({ valueHex: new ArrayBuffer(0) }), link] });
}

function sipInfo(): asn1js.Sequence {
  const zero = (): asn1js.Integer => new asn1js.Integer({ value: 0 });
  return new asn1js.Sequence({
    value: [new asn1js.Integer({ value: 65536 }), new asn1js.OctetString({ valueHex: toArrayBuffer(MSI_SIP_GUID) }), zero(), zero(), zero(), zero()],
  });
}

/** The Authenticode content for a Windows form, as encoded (the whole SEQUENCE element). */
export function spcIndirectDataContent(kind: "windows-program" | "installer", fingerprint: Buffer): Buffer {
  if (fingerprint.length !== 32) {
    throw new Error(`the fingerprint must be 32 bytes (SHA-256), not ${fingerprint.length}`);
  }
  const data = new asn1js.Sequence({
    value: [new asn1js.ObjectIdentifier({ value: kind === "windows-program" ? BUILDER_OID.spcPeImageData : BUILDER_OID.spcSipInfo }), kind === "windows-program" ? peImageData() : sipInfo()],
  });
  const digest = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: OID.sha256 }), new asn1js.Null()] }),
      new asn1js.OctetString({ valueHex: toArrayBuffer(fingerprint) }),
    ],
  });
  return Buffer.from(new asn1js.Sequence({ value: [data, digest] }).toBER());
}

// ── the container ────────────────────────────────────────────

interface Prepared {
  contentType: string;
  /** The encapsulated content element as encoded; absent for a detached signature. */
  content?: Buffer;
  /** What the message digest covers. */
  digested: Buffer;
  extraAttributes: Attribute[];
}

function prepare(content: SignedContent): Prepared {
  if (content.kind === "mac-program") {
    if (content.codeDirectory.length === 0) {
      throw new Error("the code directory is empty");
    }
    return { contentType: OID.data, digested: content.codeDirectory, extraAttributes: [] };
  }
  const element = spcIndirectDataContent(content.kind, content.fingerprint);
  const value = element.subarray(headerLength(element));
  const statementType = new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: BUILDER_OID.individualCodeSigning })] });
  return {
    contentType: OID.spcIndirectData,
    content: element,
    digested: value,
    extraAttributes: [
      new Attribute({ attrType: BUILDER_OID.spcSpOpusInfo, attrValues: [new asn1js.Sequence().toBER()] }),
      new Attribute({ attrType: BUILDER_OID.spcStatementType, attrValues: [statementType.toBER()] }),
    ],
  };
}

/** The size of the tag and length of a DER element. */
function headerLength(element: Buffer): number {
  return element[1] < 0x80 ? 2 : 2 + (element[1] & 0x7f);
}

/** The certificate parsed as DER; anything that does not re-encode to the same bytes is refused. */
function parseCertificate(certificateDer: Buffer): Certificate {
  let certificate: Certificate;
  try {
    certificate = AsnConvert.parse(certificateDer, Certificate);
  } catch (err) {
    throw new Error(`the certificate is not valid DER: ${(err as Error).message}`);
  }
  if (!Buffer.from(AsnConvert.serialize(certificate)).equals(certificateDer)) {
    throw new Error("the certificate is not DER: it does not encode to the same bytes");
  }
  return certificate;
}

/** The one builder: a ContentInfo holding SignedData in the standard form for the given content. */
export function buildSignatureContainer(content: SignedContent, certificateDer: Buffer, sign: SignCallback): Buffer {
  const certificate = parseCertificate(certificateDer);
  const prepared = prepare(content);

  const attributes = [
    new Attribute({ attrType: OID.contentType, attrValues: [oidDer(prepared.contentType)] }),
    new Attribute({ attrType: OID.messageDigest, attrValues: [new asn1js.OctetString({ valueHex: toArrayBuffer(sha256(prepared.digested)) }).toBER()] }),
    ...prepared.extraAttributes,
  ];
  // A SET OF is written in the order of its encodings
  attributes.sort((a, b) => Buffer.compare(Buffer.from(AsnConvert.serialize(a)), Buffer.from(AsnConvert.serialize(b))));

  const signedSet = new asn1js.Set({ value: attributes.map((attribute) => asn1js.fromBER(AsnConvert.serialize(attribute)).result) });
  const toSign = Buffer.from(signedSet.toBER());
  const signature = sign(toSign);

  const signer = new SignerInfo({
    version: CMSVersion.v1,
    sid: new SignerIdentifier({
      issuerAndSerialNumber: new IssuerAndSerialNumber({ issuer: certificate.tbsCertificate.issuer, serialNumber: certificate.tbsCertificate.serialNumber }),
    }),
    digestAlgorithm: sha256Algorithm(),
    signedAttrs: attributes,
    signatureAlgorithm: new AlgorithmIdentifier({ algorithm: OID.ecdsaWithSha256 }),
    signature: new OctetString(toArrayBuffer(signature)),
  });

  const signedData = new SignedData({
    version: CMSVersion.v1,
    digestAlgorithms: new DigestAlgorithmIdentifiers([sha256Algorithm()]),
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: prepared.contentType,
      eContent: prepared.content === undefined ? undefined : new EncapsulatedContent({ any: toArrayBuffer(prepared.content) }),
    }),
    certificates: new CertificateSet([new CertificateChoices({ certificate })]),
    signerInfos: new SignerInfos([signer]),
  });

  const container = Buffer.from(AsnConvert.serialize(new ContentInfo({ contentType: OID.signedData, content: AsnConvert.serialize(signedData) })));
  checkContainer(container, certificateDer, toSign, prepared);
  return container;
}

/** Reads the container back and compares it with what was meant to be written; a failure is a programming error. */
function checkContainer(container: Buffer, certificateDer: Buffer, signed: Buffer, prepared: Prepared): void {
  const fail = (what: string): never => {
    throw new Error(`signature container self-check failed: ${what}`);
  };
  const info = readSignedData(container);
  const signer = info.signers[0];
  if (signer === undefined || signer.signedAttributes === undefined) {
    return fail("the signer record has no signed attributes");
  }
  if (!Buffer.concat([Buffer.from([0x31]), signer.signedAttributes.raw.subarray(1)]).equals(signed)) {
    fail("the signed attributes differ from what was signed");
  }
  if (info.certificates.length !== 1 || !info.certificates[0].equals(certificateDer)) {
    fail("the certificate differs from the one given");
  }
  const identity = issuerAndSerialOf(certificateDer);
  if (identity === null || !("issuer" in signer.sid) || !signer.sid.issuer.equals(identity.issuer) || !signer.sid.serial.equals(identity.serial)) {
    fail("the signer's issuer or serial differs from the certificate's");
  }
  if (info.contentType !== prepared.contentType || signer.signedAttributes.contentType !== prepared.contentType) {
    fail("the content type differs from the one given");
  }
  if (prepared.content !== undefined && (info.contentDer === undefined || !info.contentDer.equals(prepared.content))) {
    fail("the encapsulated content differs from the one given");
  }
  if (signer.signedAttributes.messageDigest === undefined || !signer.signedAttributes.messageDigest.equals(sha256(prepared.digested))) {
    fail("the message digest differs from the digest of the signed content");
  }
}

/** Upper bound in bytes of a Mac container for this certificate (P-256 signature); used as the reserved room. */
export function containerCapacity(certificateDer: Buffer): number {
  const placeholder = Buffer.alloc(PLACEHOLDER_SIGNATURE_LENGTH, 0x5a);
  return buildSignatureContainer({ kind: "mac-program", codeDirectory: Buffer.alloc(32) }, certificateDer, () => placeholder).length + CAPACITY_MARGIN;
}
