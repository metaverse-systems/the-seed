import crypto from "crypto";

/**
 * Independent checker for Mach-O code signatures.
 *
 * Reads a thin or universal (32-bit or 64-bit table) little-endian 64-bit
 * Mach-O file, walks the header and slice tables and, for every slice that has
 * a code signature command, recomputes every page hash with Node's SHA-256 and
 * checks the structural facts a signed program must satisfy. It uses nothing
 * from the signing code under test.
 */

const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_REQUIREMENTS = 2;
const HASH_SHA256 = 2;

export interface SliceReport {
  cputype: number;
  offset: number;
  size: number;
  signatureCommands: number;
  dataoff: number;
  datasize: number;
  identifier: string;
  codeLimit: number;
  codeSlots: number;
  superBlobLength: number;
  pagesChecked: number;
  pagesMismatched: number;
}

export interface MachOReport {
  form: "thin" | "fat32" | "fat64";
  slices: SliceReport[];
  problems: string[];
}

interface Container {
  cputype: number;
  offset: number;
  size: number;
}

function readContainers(data: Buffer): { form: MachOReport["form"]; entries: Container[] } {
  if (data.length < 4) {
    throw new Error("file shorter than four bytes");
  }
  const magic = data.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const wide = magic === 0xcafebabf;
    const count = data.readUInt32BE(4);
    const entry = wide ? 32 : 20;
    if (count > 64 || 8 + count * entry > data.length) {
      throw new Error("universal table does not fit");
    }
    const entries: Container[] = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * entry;
      entries.push({
        cputype: data.readInt32BE(at),
        offset: wide ? Number(data.readBigUInt64BE(at + 8)) : data.readUInt32BE(at + 8),
        size: wide ? Number(data.readBigUInt64BE(at + 16)) : data.readUInt32BE(at + 12),
      });
    }
    return { form: wide ? "fat64" : "fat32", entries };
  }
  if (data.readUInt32LE(0) === 0xfeedfacf) {
    return { form: "thin", entries: [{ cputype: data.readInt32LE(4), offset: 0, size: data.length }] };
  }
  throw new Error("not a little-endian 64-bit Mach-O or universal file");
}

function sha256(bytes: Buffer): Buffer {
  return crypto.createHash("sha256").update(bytes).digest();
}

function checkSlice(b: Buffer, container: Container, problems: string[]): SliceReport {
  const report: SliceReport = {
    cputype: container.cputype,
    offset: container.offset,
    size: container.size,
    signatureCommands: 0,
    dataoff: 0,
    datasize: 0,
    identifier: "",
    codeLimit: 0,
    codeSlots: 0,
    superBlobLength: 0,
    pagesChecked: 0,
    pagesMismatched: 0,
  };
  const problem = (text: string) => problems.push(`slice at ${container.offset}: ${text}`);

  if (b.length < 32) {
    problem("slice shorter than a 64-bit header");
    return report;
  }
  const ncmds = b.readUInt32LE(16);
  const sizeofcmds = b.readUInt32LE(20);
  const headerEnd = 32 + sizeofcmds;
  if (headerEnd > b.length) {
    problem("load commands run past the end of the slice");
    return report;
  }

  let at = 32;
  let total = 0;
  const sigs: number[] = [];
  let linkedit: { fileoff: number; filesize: number } | null = null;
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > headerEnd) {
      problem(`command ${i} header is outside sizeofcmds`);
      return report;
    }
    const cmd = b.readUInt32LE(at);
    const size = b.readUInt32LE(at + 4);
    if (size < 8 || size % 4 !== 0 || at + size > headerEnd) {
      problem(`command ${i} has a bad size ${size}`);
      return report;
    }
    total += size;
    if (cmd === LC_CODE_SIGNATURE) {
      sigs.push(at);
    }
    if (cmd === LC_SEGMENT_64 && size >= 72) {
      const name = b.subarray(at + 8, at + 24).toString("ascii").split("\0")[0];
      if (name === "__LINKEDIT") {
        linkedit = {
          fileoff: Number(b.readBigUInt64LE(at + 40)),
          filesize: Number(b.readBigUInt64LE(at + 48)),
        };
      }
    }
    at += size;
  }
  if (total !== sizeofcmds) {
    problem(`sum of command sizes ${total} differs from sizeofcmds ${sizeofcmds}`);
  }

  report.signatureCommands = sigs.length;
  if (sigs.length === 0) {
    return report;
  }
  if (sigs.length !== 1) {
    problem(`${sigs.length} code signature commands`);
  }
  const cmdAt = sigs[0];
  if (b.readUInt32LE(cmdAt + 4) !== 16) {
    problem(`code signature command size is ${b.readUInt32LE(cmdAt + 4)}`);
    return report;
  }
  const dataoff = b.readUInt32LE(cmdAt + 8);
  const datasize = b.readUInt32LE(cmdAt + 12);
  report.dataoff = dataoff;
  report.datasize = datasize;
  if (dataoff % 16 !== 0) {
    problem("signature data is not 16-byte aligned");
  }
  if (dataoff + datasize > b.length) {
    problem("signature data runs past the end of the slice");
    return report;
  }
  if (dataoff + datasize !== b.length) {
    problem(`signature data ends ${b.length - dataoff - datasize} bytes before the end of the slice`);
  }
  if (linkedit && linkedit.fileoff + linkedit.filesize !== dataoff + datasize) {
    problem("__LINKEDIT does not end where the signature ends");
  }

  const blob = b.subarray(dataoff, dataoff + datasize);
  if (blob.length < 12 || blob.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    problem("no SuperBlob at the signature offset");
    return report;
  }
  const length = blob.readUInt32BE(4);
  const count = blob.readUInt32BE(8);
  report.superBlobLength = length;
  if (length > datasize) {
    problem(`SuperBlob length ${length} exceeds the signature area ${datasize}`);
    return report;
  }
  if (blob.subarray(length).some((v) => v !== 0)) {
    problem("bytes after the SuperBlob length are not zero");
  }
  const slots = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    slots.set(blob.readUInt32BE(12 + 8 * i), blob.readUInt32BE(16 + 8 * i));
  }
  const cdOff = slots.get(CSSLOT_CODEDIRECTORY);
  if (cdOff === undefined) {
    problem("no CodeDirectory slot");
    return report;
  }
  const cd = blob.subarray(cdOff);
  if (cd.readUInt32BE(0) !== CSMAGIC_CODEDIRECTORY) {
    problem("CodeDirectory magic is wrong");
    return report;
  }
  const hashOff = cd.readUInt32BE(16);
  const identOff = cd.readUInt32BE(20);
  const nSpecial = cd.readUInt32BE(24);
  const nCode = cd.readUInt32BE(28);
  const codeLimit = cd.readUInt32BE(32);
  const hashSize = cd[36];
  const hashType = cd[37];
  const pageLog2 = cd[39];
  const page = pageLog2 ? 2 ** pageLog2 : codeLimit;
  const identEnd = cd.indexOf(0, identOff);
  report.identifier = cd.subarray(identOff, identEnd).toString("utf8");
  report.codeLimit = codeLimit;
  report.codeSlots = nCode;
  if (hashType !== HASH_SHA256 || hashSize !== 32) {
    problem(`hash type ${hashType} size ${hashSize} is not SHA-256`);
    return report;
  }
  if (codeLimit !== dataoff) {
    problem(`codeLimit ${codeLimit} differs from the signature offset ${dataoff}`);
  }
  const expected = page ? Math.ceil(codeLimit / page) : 0;
  if (nCode !== expected) {
    problem(`nCodeSlots ${nCode}, expected ${expected}`);
  }
  if (hashOff + nCode * 32 > cd.length || hashOff < nSpecial * 32) {
    problem("hash slots do not fit in the CodeDirectory");
    return report;
  }
  for (let i = 0; i < nCode; i++) {
    const want = sha256(b.subarray(i * page, Math.min((i + 1) * page, codeLimit)));
    const got = cd.subarray(hashOff + 32 * i, hashOff + 32 * i + 32);
    report.pagesChecked++;
    if (!want.equals(got)) {
      report.pagesMismatched++;
      problem(`page ${i} hash does not match`);
    }
  }
  const reqOff = slots.get(CSSLOT_REQUIREMENTS);
  if (nSpecial >= 2 && reqOff !== undefined) {
    const reqLen = blob.readUInt32BE(reqOff + 4);
    const want = sha256(blob.subarray(reqOff, reqOff + reqLen));
    const got = cd.subarray(hashOff - 64, hashOff - 32);
    if (!want.equals(got)) {
      problem("requirements special slot does not match the requirements blob");
    }
  }
  return report;
}

/**
 * Check every slice of a Mach-O file. `problems` is empty when the file is a
 * consistent program; signed slices have been checked page by page.
 */
export function checkMachO(data: Buffer): MachOReport {
  const problems: string[] = [];
  let form: MachOReport["form"];
  let entries: Container[];
  try {
    ({ form, entries } = readContainers(data));
  } catch (error) {
    return { form: "thin", slices: [], problems: [(error as Error).message] };
  }
  const slices: SliceReport[] = [];
  for (const entry of entries) {
    if (entry.offset + entry.size > data.length) {
      problems.push(`slice at ${entry.offset} runs past the end of the file`);
      continue;
    }
    slices.push(checkSlice(data.subarray(entry.offset, entry.offset + entry.size), entry, problems));
  }
  return { form, slices, problems };
}
