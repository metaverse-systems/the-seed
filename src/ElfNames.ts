/**
 * Reads the names an ELF file records about itself: the name programs load a library by (its
 * soname) and the library names it asks for. Packaging uses the soname to write each Linux library
 * under the name programs load it by (for example libgreet.so.0) and the needed names to list the
 * libraries left to the target system. Only the parts of the file that hold these names are read.
 */
import fs from "fs";

export type ElfNames = {
  /** The name programs load the library by, or null when the file records none. */
  soname: string | null;
  /** The library names the file asks for, in the order it records them. */
  needed: string[];
};

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_SONAME = 14;
const MAX_NAME_LENGTH = 4096;
const MAX_DYNAMIC_BYTES = 1 << 20;
const MAX_STRING_TABLE_BYTES = 64 << 20;

type Segment = { type: number; offset: number; vaddr: number; filesz: number };

/**
 * Read the soname and the needed library names an ELF file records. Only the header, the program
 * header table, the dynamic segment and the string table are read. Returns null when the file is
 * not ELF; throws an Error starting "<path>: ELF " and naming the structure when it is malformed.
 */
export function readElfNames(filePath: string): ElfNames | null {
  const fail = (structure: string): Error => new Error(filePath + ": ELF " + structure);
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const read = (offset: number, length: number): Buffer => {
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const count = fs.readSync(fd, buffer, done, length - done, offset + done);
        if (count === 0) break;
        done += count;
      }
      return buffer;
    };

    const ident = read(0, 16);
    if (fileSize < 16 || ident[0] !== 0x7f || ident[1] !== 0x45 || ident[2] !== 0x4c || ident[3] !== 0x46) {
      return null;
    }
    const wide = ident[4] === 2;
    const little = ident[5] === 1;
    if ((ident[4] !== 1 && ident[4] !== 2) || (ident[5] !== 1 && ident[5] !== 2)) {
      throw fail("header has an unknown class or byte order");
    }
    const headerSize = wide ? 64 : 52;
    if (fileSize < headerSize) {
      throw fail("header is truncated");
    }
    const header = read(0, headerSize);

    const u16 = (buffer: Buffer, at: number): number => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
    const u32 = (buffer: Buffer, at: number): number => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
    const word = (buffer: Buffer, at: number): number => {
      if (!wide) {
        return u32(buffer, at);
      }
      const value = little ? buffer.readBigUInt64LE(at) : buffer.readBigUInt64BE(at);
      return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
    };

    const phoff = wide ? word(header, 32) : word(header, 28);
    const phentsize = u16(header, wide ? 54 : 42);
    const phnum = u16(header, wide ? 56 : 44);
    if (phnum === 0) {
      return { soname: null, needed: [] };
    }
    const minimumEntry = wide ? 56 : 32;
    if (phentsize < minimumEntry) {
      throw fail("program header table has entries too small");
    }
    if (phoff + phentsize * phnum > fileSize) {
      throw fail("program header table lies outside the file");
    }
    const table = read(phoff, phentsize * phnum);
    const segments: Segment[] = [];
    for (let index = 0; index < phnum; index++) {
      const at = index * phentsize;
      if (wide) {
        segments.push({ type: u32(table, at), offset: word(table, at + 8), vaddr: word(table, at + 16), filesz: word(table, at + 32) });
      } else {
        segments.push({ type: u32(table, at), offset: word(table, at + 4), vaddr: word(table, at + 8), filesz: word(table, at + 16) });
      }
    }

    const dynamic = segments.find((segment) => segment.type === PT_DYNAMIC);
    if (!dynamic) {
      return { soname: null, needed: [] };
    }
    if (dynamic.offset + dynamic.filesz > fileSize || dynamic.filesz > MAX_DYNAMIC_BYTES) {
      throw fail("dynamic segment lies outside the file");
    }
    const entrySize = wide ? 16 : 8;
    const dynamicBytes = read(dynamic.offset, dynamic.filesz);
    let strtab: number | null = null;
    let strsz: number | null = null;
    const neededOffsets: number[] = [];
    let sonameOffset: number | null = null;
    for (let at = 0; at + entrySize <= dynamicBytes.length; at += entrySize) {
      const tag = word(dynamicBytes, at);
      const value = word(dynamicBytes, at + (wide ? 8 : 4));
      if (tag === DT_NULL) break;
      if (tag === DT_NEEDED) neededOffsets.push(value);
      else if (tag === DT_SONAME) sonameOffset = value;
      else if (tag === DT_STRTAB) strtab = value;
      else if (tag === DT_STRSZ) strsz = value;
    }
    if (neededOffsets.length === 0 && sonameOffset === null) {
      return { soname: null, needed: [] };
    }

    if (strtab === null || strsz === null) {
      throw fail("string table is not described by the dynamic segment");
    }
    const load = segments.find(
      (segment) => segment.type === PT_LOAD && strtab !== null && strtab >= segment.vaddr && strtab < segment.vaddr + segment.filesz
    );
    if (!load) {
      throw fail("string table address is not covered by any loadable segment");
    }
    const tableOffset = load.offset + (strtab - load.vaddr);
    if (tableOffset + strsz > fileSize || strsz > MAX_STRING_TABLE_BYTES) {
      throw fail("string table lies outside the file");
    }
    const strings = read(tableOffset, strsz);

    const nameAt = (offset: number): string => {
      if (offset >= strings.length) {
        throw fail("name offset lies outside the string table");
      }
      const limit = Math.min(strings.length, offset + MAX_NAME_LENGTH + 1);
      const end = strings.indexOf(0, offset);
      if (end === -1 || end >= limit) {
        throw fail("name is not terminated within " + MAX_NAME_LENGTH + " bytes");
      }
      return strings.toString("latin1", offset, end);
    };

    return {
      soname: sonameOffset === null ? null : nameAt(sonameOffset),
      needed: neededOffsets.map(nameAt),
    };
  } finally {
    fs.closeSync(fd);
  }
}
