export interface ElfImageOptions {
  bits: 32 | 64;
  endian: "little" | "big";
  type: "dyn" | "exec";
  soname?: string;
  needed?: string[];
  dynamic?: boolean;
  corrupt?: "phoff" | "strtab" | "name";
}

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_SONAME = 14;

/**
 * Builds a minimal linked ELF file: header, a program header table with one PT_LOAD covering
 * the whole file (virtual address equal to file offset) and, unless `dynamic` is false, one
 * PT_DYNAMIC, then the dynamic entries and the string table.
 */
export function elfImage(options: ElfImageOptions): Buffer {
  const little = options.endian === "little";
  const wide = options.bits === 64;
  const withDynamic = options.dynamic !== false;
  const needed = options.needed ?? [];

  const headerSize = wide ? 64 : 52;
  const phSize = wide ? 56 : 32;
  const phCount = withDynamic ? 2 : 1;
  const dynEntrySize = wide ? 16 : 8;

  // String table: a leading NUL, then each name NUL-terminated.
  const strings: Buffer[] = [Buffer.from([0])];
  let strSize = 1;
  const offsets: { tag: number; offset: number }[] = [];
  const addName = (tag: number, name: string): void => {
    offsets.push({ tag, offset: strSize });
    const bytes = Buffer.from(name + "\0");
    strings.push(bytes);
    strSize += bytes.length;
  };
  for (const name of needed) {
    addName(DT_NEEDED, name);
  }
  if (options.soname !== undefined) {
    addName(DT_SONAME, options.soname);
  }
  const strtab = Buffer.concat(strings);

  const phOffset = headerSize;
  const dynOffset = phOffset + phSize * phCount;
  const dynCount = offsets.length + 3; // names, DT_STRTAB, DT_STRSZ, DT_NULL
  const dynSize = withDynamic ? dynCount * dynEntrySize : 0;
  const strOffset = dynOffset + dynSize;
  const total = strOffset + strtab.length;

  const out = Buffer.alloc(total);
  const u16 = (at: number, value: number): void => {
    little ? out.writeUInt16LE(value, at) : out.writeUInt16BE(value, at);
  };
  const u32 = (at: number, value: number): void => {
    little ? out.writeUInt32LE(value, at) : out.writeUInt32BE(value, at);
  };
  const word = (at: number, value: number): void => {
    if (wide) {
      little ? out.writeBigUInt64LE(BigInt(value), at) : out.writeBigUInt64BE(BigInt(value), at);
    } else {
      u32(at, value);
    }
  };

  out.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1, 0]);
  u16(16, options.type === "dyn" ? 3 : 2);
  u16(18, wide ? 62 : 3);
  u32(20, 1);
  const phoff = options.corrupt === "phoff" ? total + 0x1000 : phOffset;
  if (wide) {
    word(24, 0);
    word(32, phoff);
    word(40, 0);
    u32(48, 0);
    u16(52, headerSize);
    u16(54, phSize);
    u16(56, phCount);
  } else {
    word(24, 0);
    word(28, phoff);
    word(32, 0);
    u32(36, 0);
    u16(40, headerSize);
    u16(42, phSize);
    u16(44, phCount);
  }

  const phdr = (index: number, type: number, offset: number, size: number): void => {
    const at = phOffset + index * phSize;
    if (wide) {
      u32(at, type);
      u32(at + 4, 6);
      word(at + 8, offset);
      word(at + 16, offset);
      word(at + 24, offset);
      word(at + 32, size);
      word(at + 40, size);
      word(at + 48, 8);
    } else {
      u32(at, type);
      word(at + 4, offset);
      word(at + 8, offset);
      word(at + 12, offset);
      word(at + 16, size);
      word(at + 20, size);
      u32(at + 24, 6);
      u32(at + 28, 4);
    }
  };
  phdr(0, PT_LOAD, 0, total);

  if (withDynamic) {
    phdr(1, PT_DYNAMIC, dynOffset, dynSize);
    const strtabAddress = options.corrupt === "strtab" ? total + 0x1000 : strOffset;
    const entries: [number, number][] = offsets.map((item, index) => [
      item.tag,
      options.corrupt === "name" && index === 0 ? strtab.length + 16 : item.offset,
    ]);
    entries.push([DT_STRTAB, strtabAddress], [DT_STRSZ, strtab.length], [DT_NULL, 0]);
    entries.forEach(([tag, value], index) => {
      const at = dynOffset + index * dynEntrySize;
      word(at, tag);
      word(at + (wide ? 8 : 4), value);
    });
  }

  strtab.copy(out, strOffset);
  return out;
}
