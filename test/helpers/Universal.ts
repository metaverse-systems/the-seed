// Assembles a universal Mac program from thin programs, for tests only. It shares nothing with the
// source tree or with the independent checker, so it cannot hide a fault in either.

export interface UniversalSlice {
  cpuType: number;
  cpuSubtype: number;
  bytes: Buffer;
}

const MAGIC = 0xcafebabe;
const HEADER_SIZE = 8;
const ENTRY_SIZE = 20;

// Writes a 32-bit universal table (all fields big-endian) followed by the slices in the order given.
// Each slice starts at the first multiple of 2^align at or after the end of what precedes it; the gaps
// are zero bytes; nothing follows the last slice. Each entry records align.
export function makeUniversal(slices: UniversalSlice[], align = 14): Buffer {
  const boundary = 2 ** align;
  const roundUp = (value: number): number => Math.ceil(value / boundary) * boundary;

  const offsets: number[] = [];
  let end = HEADER_SIZE + ENTRY_SIZE * slices.length;
  for (const slice of slices) {
    const offset = roundUp(end);
    offsets.push(offset);
    end = offset + slice.bytes.length;
  }

  const result = Buffer.alloc(end);
  result.writeUInt32BE(MAGIC, 0);
  result.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const at = HEADER_SIZE + index * ENTRY_SIZE;
    result.writeUInt32BE(slice.cpuType >>> 0, at);
    result.writeUInt32BE(slice.cpuSubtype >>> 0, at + 4);
    result.writeUInt32BE(offsets[index], at + 8);
    result.writeUInt32BE(slice.bytes.length, at + 12);
    result.writeUInt32BE(align, at + 16);
    slice.bytes.copy(result, offsets[index]);
  });
  return result;
}
