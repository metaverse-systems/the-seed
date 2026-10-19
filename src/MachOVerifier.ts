import crypto from "crypto";
import { CmsDamaged, CmsUnsupported, OID, findSignerCertificate, readSignedData, verifySignerSignature } from "./CmsReader";
import { certificateFingerprint } from "./Trust";
import { IntegrityResult, MachOSliceResult } from "./types";

/** One entry of a Mach-O file's slice table, as the native component lists it (`machoListSlices`). */
export interface MachOSliceInfo {
  cpuType: number;
  cpuSubtype: number;
  offset: number;
  size: number;
  isSigned: boolean;
  signatureOffset: number; // relative to the slice
  signatureSize: number;
  supported: boolean;
  unsupportedReason: string;
}

export interface MachOCheck {
  slices: MachOSliceResult[];
  signerCertificate?: Buffer; // DER, when every signed slice has the same signer
  integrity: IntegrityResult;
  warnings: string[];
  notChecked: string[];
}

const MAGIC_SUPERBLOB = 0xfade0cc0;
const MAGIC_CODEDIRECTORY = 0xfade0c02;
const MAGIC_CMS = 0xfade0b01;
const SLOT_CODEDIRECTORY = 0;
const SLOT_ALTERNATE_FIRST = 0x1000;
const SLOT_ALTERNATE_LAST = 0x1004;
const SLOT_CMS = 0x10000;
const SPECIAL_SLOT_HASHED_BLOBS = [2, 5, 7];
const SPECIAL_SLOT_NAMES: Record<number, string> = {
  1: "the Info.plist",
  2: "the requirements",
  3: "the resource directory",
  4: "application-specific data",
  5: "the entitlements",
  7: "the DER entitlements",
};
const CODE_DIRECTORY_FIXED_SIZE = 44;
const MAX_PAGE_SIZE_LOG2 = 30;
const MAX_REASONS = 3;

type HashType = "sha1" | "sha256" | "sha384";
const HASH_TYPES: Record<number, { name: HashType; size: number }> = {
  1: { name: "sha1", size: 20 },
  2: { name: "sha256", size: 32 },
  4: { name: "sha384", size: 48 },
};

/** A structure that runs past its bounds or is not what it should be. */
class Damaged extends Error {}

/** A part of the signature that is present but not supported by this check. */
class NotSupported extends Error {}

interface Blob {
  type: number;
  offset: number; // in the SuperBlob
  length: number;
}

function archName(cpuType: number): string {
  if (cpuType === 0x0100000c) {
    return "arm64";
  }
  if (cpuType === 0x01000007) {
    return "x86_64";
  }
  return "0x" + (cpuType >>> 0).toString(16);
}

function hex(value: number): string {
  return "0x" + value.toString(16);
}

/** Reads a big-endian 32-bit value, inside [start, end) of the buffer. */
function u32(bytes: Buffer, at: number, end: number, what: string): number {
  if (at < 0 || at + 4 > end || at + 4 > bytes.length) {
    throw new Damaged(`${what} lies outside the signature data`);
  }
  return bytes.readUInt32BE(at);
}

function digest(type: HashType, bytes: Buffer): Buffer {
  return crypto.createHash(type).update(bytes).digest();
}

interface SignerInfo {
  adHoc: boolean;
  certificate?: Buffer;
}

interface SliceFinding {
  result: MachOSliceResult;
  signer?: SignerInfo;
  checked: string[];
  warnings: string[];
  notChecked: string[];
}

/** Reads the SuperBlob's index and checks that every blob lies inside it. */
function readBlobs(file: Buffer, start: number, regionSize: number): { blobs: Blob[]; length: number } {
  const end = start + regionSize;
  if (regionSize < 12) {
    throw new Damaged("the signature data is too short to hold a SuperBlob");
  }
  if (u32(file, start, end, "SuperBlob magic") !== MAGIC_SUPERBLOB) {
    throw new Damaged("the signature data is not a SuperBlob");
  }
  const length = u32(file, start + 4, end, "SuperBlob length");
  if (length > regionSize) {
    throw new Damaged(`the SuperBlob length (${length}) is longer than the signature data (${regionSize})`);
  }
  const count = u32(file, start + 8, end, "SuperBlob count");
  if (length < 12 || 12 + 8 * count > length) {
    throw new Damaged(`the SuperBlob index (${count} entries) does not fit in its length (${length})`);
  }
  const blobs: Blob[] = [];
  for (let i = 0; i < count; i++) {
    const type = u32(file, start + 12 + 8 * i, end, "SuperBlob index");
    const offset = u32(file, start + 16 + 8 * i, end, "SuperBlob index");
    if (offset < 12 + 8 * count || offset + 8 > length) {
      throw new Damaged(`the SuperBlob slot ${hex(type)} starts outside the blob`);
    }
    const blobLength = u32(file, start + offset + 4, end, "blob length");
    if (blobLength < 8 || offset + blobLength > length) {
      throw new Damaged(`the SuperBlob slot ${hex(type)} runs past the end of the blob`);
    }
    blobs.push({ type, offset, length: blobLength });
  }
  return { blobs, length };
}

interface CodeDirectory {
  slot: number;
  at: number; // absolute offset of the code directory in the file
  length: number;
  hashType: HashType;
  hashSize: number;
  hashOffset: number;
  specialSlots: number;
  codeSlots: number;
  codeLimit: number;
  pageSize: number; // 0: one page of codeLimit bytes
}

function readCodeDirectory(file: Buffer, blob: Blob, start: number, end: number): CodeDirectory {
  const at = start + blob.offset;
  const name = `code directory ${hex(blob.type)}`;
  if (u32(file, at, end, name) !== MAGIC_CODEDIRECTORY) {
    throw new Damaged(`the ${name} does not have the code directory magic`);
  }
  const length = blob.length;
  if (length < CODE_DIRECTORY_FIXED_SIZE) {
    throw new Damaged(`the ${name} is shorter than its header`);
  }
  const version = u32(file, at + 8, end, name);
  const hashOffset = u32(file, at + 16, end, name);
  const identOffset = u32(file, at + 20, end, name);
  const specialSlots = u32(file, at + 24, end, name);
  const codeSlots = u32(file, at + 28, end, name);
  const codeLimit = u32(file, at + 32, end, name);
  const hashSize = file[at + 36];
  const hashTypeCode = file[at + 37];
  const pageLog2 = file[at + 39];

  const type = HASH_TYPES[hashTypeCode];
  if (type === undefined) {
    throw new NotSupported(`the ${name} uses hash type ${hashTypeCode}, which is not supported`);
  }
  if (version >= 0x20300 && length >= 64) {
    const high = u32(file, at + 56, end, name);
    const low = u32(file, at + 60, end, name);
    if (high !== 0 || low !== 0) {
      throw new NotSupported(`the ${name} has a 64-bit code limit, which is not supported`);
    }
  }
  if (hashSize !== type.size) {
    throw new Damaged(`the ${name} has a hash size of ${hashSize} bytes, not ${type.size}`);
  }
  if (identOffset >= length) {
    throw new Damaged(`the identifier of the ${name} lies outside it`);
  }
  if (pageLog2 > MAX_PAGE_SIZE_LOG2) {
    throw new Damaged(`the ${name} has an unreasonable page size (2^${pageLog2})`);
  }
  if (hashOffset > length || specialSlots * hashSize > hashOffset || codeSlots * hashSize > length - hashOffset) {
    throw new Damaged(`the hashes of the ${name} (${specialSlots} special, ${codeSlots} code) do not fit in it`);
  }
  return { slot: blob.type, at, length, hashType: type.name, hashSize, hashOffset, specialSlots, codeSlots, codeLimit, pageSize: pageLog2 === 0 ? 0 : 2 ** pageLog2 };
}

function isCodeDirectorySlot(type: number): boolean {
  return type === SLOT_CODEDIRECTORY || (type >= SLOT_ALTERNATE_FIRST && type <= SLOT_ALTERNATE_LAST);
}

/** Checks one supported, signed slice. Never throws: damage becomes an invalid result. */
function checkSignedSlice(file: Buffer, slice: MachOSliceInfo, arch: string, result: MachOSliceResult): SliceFinding {
  const finding: SliceFinding = { result, checked: [], warnings: [], notChecked: [] };
  const problems: string[] = [];
  const label = `slice ${arch}`;

  try {
    const start = slice.offset + slice.signatureOffset;
    const end = start + slice.signatureSize;
    if (slice.offset + slice.size > file.length || slice.signatureOffset + slice.signatureSize > slice.size || end > file.length) {
      throw new Damaged("the signature data extends past the end of the file");
    }

    const { blobs, length } = readBlobs(file, start, slice.signatureSize);
    const directories: CodeDirectory[] = [];
    for (const blob of blobs) {
      if (isCodeDirectorySlot(blob.type)) {
        directories.push(readCodeDirectory(file, blob, start, start + length));
      }
    }
    const primary = directories.find((directory) => directory.slot === SLOT_CODEDIRECTORY);
    if (primary === undefined) {
      throw new Damaged("the signature has no code directory");
    }
    directories.sort((a, b) => a.slot - b.slot);

    const sliceBytes = file.subarray(slice.offset, slice.offset + slice.size);
    for (const directory of directories) {
      const entry = { slot: directory.slot, hashType: directory.hashType, pages: directory.codeSlots, pagesMismatched: 0, codeLimit: directory.codeLimit };
      result.codeDirectories.push(entry);
      const suffix = directory.slot === SLOT_CODEDIRECTORY ? "" : ` in the code directory ${hex(directory.slot)}`;

      // The code directory must cover the program up to the signature, no more and no less
      if (directory.codeLimit < slice.signatureOffset) {
        problems.push(`${label}: the signature does not cover the whole program (it covers ${directory.codeLimit} of ${slice.signatureOffset} bytes)${suffix}`);
        continue;
      }
      if (directory.codeLimit > slice.signatureOffset) {
        problems.push(`${label}: the code limit (${directory.codeLimit}) reaches into the signature, which starts at ${slice.signatureOffset}${suffix}`);
        continue;
      }
      const pageSize = directory.pageSize === 0 ? directory.codeLimit : directory.pageSize;
      const expectedPages = pageSize === 0 ? 0 : Math.ceil(directory.codeLimit / pageSize);
      if (directory.codeSlots !== expectedPages) {
        problems.push(`${label}: the code directory${suffix} lists ${directory.codeSlots} page fingerprints for ${expectedPages} pages`);
        continue;
      }

      let first = -1;
      for (let page = 0; page < expectedPages; page++) {
        const pageStart = page * pageSize;
        const stored = file.subarray(directory.at + directory.hashOffset + page * directory.hashSize, directory.at + directory.hashOffset + (page + 1) * directory.hashSize);
        const computed = digest(directory.hashType, sliceBytes.subarray(pageStart, Math.min(pageStart + pageSize, directory.codeLimit)));
        if (!computed.equals(stored)) {
          entry.pagesMismatched++;
          if (first < 0) {
            first = page;
          }
        }
      }
      finding.checked.push(`every page fingerprint of ${label}${suffix} (${expectedPages} pages)`);
      if (first >= 0) {
        const count = entry.pagesMismatched > 1 ? ` (${entry.pagesMismatched} of ${expectedPages} pages differ)` : "";
        problems.push(`${label}: page ${first} fingerprint does not match${suffix}${count}`);
      }

      checkSpecialSlots(file, directory, blobs, start, label, suffix, problems, finding);
    }

    checkUncovered(blobs, directories, label, problems);
    checkSignature(file, blobs, start, primary, label, problems, finding);
  } catch (err) {
    if (err instanceof Damaged) {
      problems.push(`${label}: signature data is damaged: ${err.message}`);
    } else if (err instanceof NotSupported) {
      result.state = "not-checked";
      result.reason = `${label}: ${err.message}`;
      return finding;
    } else {
      problems.push(`${label}: signature data is damaged: ${(err as Error).message}`);
    }
  }

  if (problems.length > 0) {
    result.state = "invalid";
    result.reason = problems.slice(0, MAX_REASONS).join("; ") + (problems.length > MAX_REASONS ? `; and ${problems.length - MAX_REASONS} more` : "");
  } else if (result.state !== "not-checked") {
    result.state = "intact";
  }
  return finding;
}

function checkSpecialSlots(file: Buffer, directory: CodeDirectory, blobs: Blob[], start: number, label: string, suffix: string, problems: string[], finding: SliceFinding): void {
  const zero = Buffer.alloc(directory.hashSize);
  for (let n = 1; n <= directory.specialSlots; n++) {
    const stored = file.subarray(directory.at + directory.hashOffset - n * directory.hashSize, directory.at + directory.hashOffset - (n - 1) * directory.hashSize);
    const blob = blobs.find((candidate) => candidate.type === n);
    if (blob !== undefined) {
      const computed = digest(directory.hashType, file.subarray(start + blob.offset, start + blob.offset + blob.length));
      if (!computed.equals(stored)) {
        problems.push(`${label}: special slot ${n} (${SPECIAL_SLOT_NAMES[n] ?? "a signature part"}) does not match its fingerprint${suffix}`);
      }
      continue;
    }
    if (stored.equals(zero)) {
      continue;
    }
    if (SPECIAL_SLOT_HASHED_BLOBS.includes(n)) {
      problems.push(`${label}: special slot ${n} (${SPECIAL_SLOT_NAMES[n]}) has a fingerprint but the signature has no such part${suffix}`);
    } else {
      const bound = `${label}: bound to ${SPECIAL_SLOT_NAMES[n] ?? `special slot ${n}`} outside the program; bundles are not checked`;
      if (!finding.warnings.includes(bound)) {
        finding.warnings.push(bound);
        finding.notChecked.push(bound);
      }
    }
  }
  if (directory.specialSlots > 0) {
    finding.checked.push(`the special slot fingerprints of ${label}${suffix}`);
  }
}

/** A SuperBlob part that is neither a code directory, the CMS wrapper, nor named by a special slot of every code directory is not covered. */
function checkUncovered(blobs: Blob[], directories: CodeDirectory[], label: string, problems: string[]): void {
  for (const blob of blobs) {
    if (isCodeDirectorySlot(blob.type) || blob.type === SLOT_CMS) {
      continue;
    }
    if (directories.some((directory) => blob.type > directory.specialSlots)) {
      problems.push(`${label}: signature part ${hex(blob.type)} is not covered by the code directory`);
    }
  }
}

function checkSignature(file: Buffer, blobs: Blob[], start: number, primary: CodeDirectory, label: string, problems: string[], finding: SliceFinding): void {
  const cms = blobs.find((blob) => blob.type === SLOT_CMS);
  const hasBody = cms !== undefined && cms.length > 8 && file.readUInt32BE(start + cms.offset) === MAGIC_CMS;
  if (cms !== undefined && cms.length > 8 && !hasBody) {
    throw new Damaged("the CMS part does not have the CMS magic");
  }
  if (!hasBody || cms === undefined) {
    finding.signer = { adHoc: true };
    finding.result.adHoc = true;
    return;
  }

  let info;
  try {
    info = readSignedData(Buffer.from(file.subarray(start + cms.offset + 8, start + cms.offset + cms.length)));
  } catch (err) {
    if (err instanceof CmsDamaged) {
      throw new Damaged(err.message);
    }
    if (err instanceof CmsUnsupported) {
      throw new NotSupported(err.message);
    }
    throw err;
  }
  const signer = info.signers[0];
  const certificate = findSignerCertificate(info, signer);
  if (certificate === null) {
    problems.push(`${label}: the signer's certificate is not in the signature`);
    return;
  }
  finding.signer = { adHoc: false, certificate };
  finding.result.signerFingerprint = certificateFingerprint(certificate);

  if (signer.signedAttributes?.contentType !== undefined && signer.signedAttributes.contentType !== OID.data) {
    problems.push(`${label}: the signed content type is not plain data`);
    return;
  }
  const signed = file.subarray(primary.at, primary.at + primary.length);
  const outcome = verifySignerSignature(signer, certificate, signed);
  if (outcome === "verified") {
    finding.checked.push(`signature over the code directory of ${label}`);
  } else if (outcome === "failed") {
    problems.push(`${label}: signature over the code directory does not verify`);
  } else {
    throw new NotSupported(`unsupported signature algorithm ${signer.signatureAlgorithm}`);
  }
}

/**
 * Checks every slice of a Mach-O program against its signature: every page fingerprint of every code directory,
 * the special slots, the parts of the signature that nothing covers, and the signature over the code directory.
 * A pure function of the file's bytes and the slice table; structures that run past their bounds are reported
 * as invalid rather than thrown.
 */
export function checkMachO(file: Buffer, slices: MachOSliceInfo[]): MachOCheck {
  const findings: SliceFinding[] = slices.map((slice) => {
    const arch = archName(slice.cpuType);
    const result: MachOSliceResult = {
      arch,
      cpuType: slice.cpuType,
      offset: slice.offset,
      size: slice.size,
      state: "intact",
      codeDirectories: [],
      adHoc: false,
    };
    if (!slice.supported) {
      result.state = "not-checked";
      result.reason = `slice ${arch}: ${slice.unsupportedReason}`;
      return { result, checked: [], warnings: [], notChecked: [] };
    }
    if (!slice.isSigned) {
      result.state = "unsigned";
      result.reason = `slice ${arch} is not signed`;
      return { result, checked: [], warnings: [], notChecked: [] };
    }
    return checkSignedSlice(file, slice, arch, result);
  });

  const results = [...findings.map((finding) => finding.result)];
  const warnings = [...findings.flatMap((finding) => finding.warnings)];
  const notChecked = [...findings.flatMap((finding) => finding.notChecked)];
  const checked = [...findings.flatMap((finding) => finding.checked)];

  // One signer for all slices: certificate-signed slices must share a certificate and may not be mixed with ad-hoc ones
  const signers = findings.filter((finding) => finding.signer !== undefined);
  const identities = new Set(signers.map((finding) => (finding.signer?.certificate ? certificateFingerprint(finding.signer.certificate) : "ad hoc")));
  const differentSigners = identities.size > 1;
  const signerCertificate = !differentSigners ? signers.find((finding) => finding.signer?.certificate)?.signer?.certificate : undefined;

  const invalid = results.filter((r) => r.state === "invalid");
  const unsigned = results.filter((r) => r.state === "unsigned");
  const unchecked = results.filter((r) => r.state === "not-checked");

  const reasonOf = (items: MachOSliceResult[]): string => items.map((r) => r.reason).join("; ");
  const integrity: IntegrityResult = (() => {
    if (results.length === 0 || unsigned.length === results.length) {
      return { state: "none", reason: "No embedded Mach-O code signature found", checked: [] };
    }
    if (invalid.length > 0) {
      const parts = [reasonOf(invalid)];
      if (differentSigners) {
        parts.push("slices are signed by different certificates");
      }
      return { state: "invalid", reason: [...parts, ...unsigned.map((r) => r.reason ?? ""), ...unchecked.map((r) => r.reason ?? "")].filter((part) => part !== "").join("; "), checked };
    }
    if (differentSigners) {
      return { state: "invalid", reason: "slices are signed by different certificates", checked };
    }
    if (unsigned.length > 0) {
      return {
        state: "invalid",
        reason: [reasonOf(unsigned), ...unchecked.map((r) => r.reason ?? "")].join("; "),
        checked,
        unsignedOnly: unsigned.map((r) => r.arch),
      };
    }
    if (unchecked.length > 0) {
      return { state: "not-checked", reason: reasonOf(unchecked), checked };
    }
    return { state: "intact", checked };
  })();

  return { slices: results, signerCertificate, integrity, warnings, notChecked };
}
