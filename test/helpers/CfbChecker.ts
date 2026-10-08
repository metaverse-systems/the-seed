import crypto from "crypto";
import fs from "fs";

/**
 * Independent checker for Windows Installer packages (compound files).
 *
 * Reads version 3 and version 4 containers, the allocation index with its
 * extended index, the small-block stream and the directory, walks the
 * packages the way the format describes, and computes the Authenticode
 * fingerprint of a package with Node's SHA-256: the children of each storage
 * ordered by the raw bytes of their UTF-16LE names, stream bytes hashed,
 * storages recursed, the 16-byte class identifier of each storage hashed after
 * its children, the two signature streams of the root left out. It also finds
 * entries by searching the directory tree with the format's ordering (shorter
 * names first, then the upper-cased code units) without enumerating, which is
 * how a Windows reader finds the signature. It shares no code with the
 * signing code under test.
 *
 * Streams are read only when asked for, so a damaged signature stream does not
 * stop the rest of a package from being read.
 */

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const NO_STREAM = 0xffffffff;
const SIGNATURE_NAME = "\u0005DigitalSignature";
const SIGNATURE_EX_NAME = "\u0005MsiDigitalSignatureEx";
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

export interface CfbEntry {
  index: number;
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  classId: Buffer;
  state: number;
  created: string;
  modified: string;
  start: number;
  size: number;
}

/** Everything of one entry that must survive an operation unchanged. */
export interface ListedEntry {
  path: string;
  type: "storage" | "stream";
  classId: string;
  state: number;
  created: string;
  modified: string;
  size: number;
  sha256: string;
}

export class CfbPackage {
  readonly data: Buffer;
  readonly version: number;
  readonly sectorSize: number;
  readonly entries: CfbEntry[] = [];

  private readonly miniCutoff: number;
  private readonly miniSectorSize: number;
  private fat: number[] = [];
  private miniFat: number[] = [];
  private miniStream: Buffer | null = null;

  constructor(data: Buffer) {
    this.data = data;
    if (data.length < 512 ||
      data.readUInt32BE(0) !== 0xd0cf11e0 || data.readUInt32BE(4) !== 0xa1b11ae1) {
      throw new Error("not a compound file");
    }
    this.version = data.readUInt16LE(26);
    if (this.version !== 3 && this.version !== 4) {
      throw new Error(`unsupported compound file version ${this.version}`);
    }
    this.sectorSize = 1 << data.readUInt16LE(30);
    this.miniSectorSize = 1 << data.readUInt16LE(32);
    this.miniCutoff = data.readUInt32LE(56);
    this.readFat();
    this.readDirectory();
  }

  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  private sector(sector: number): Buffer {
    const at = this.sectorOffset(sector);
    if (at + this.sectorSize > this.data.length) {
      throw new Error(`sector ${sector} is outside the file`);
    }
    return this.data.subarray(at, at + this.sectorSize);
  }

  private readFat(): void {
    const header = this.data;
    const fatCount = header.readUInt32LE(44);
    const perSector = this.sectorSize / 4;
    const fatSectors: number[] = [];
    for (let i = 0; i < Math.min(fatCount, 109); i++) {
      fatSectors.push(header.readUInt32LE(76 + i * 4));
    }
    let difat = header.readUInt32LE(68);
    let hops = 0;
    while (fatSectors.length < fatCount && difat !== END_OF_CHAIN && difat !== FREE_SECTOR) {
      if (++hops > fatCount + 1) {
        throw new Error("extended index does not end");
      }
      const body = this.sector(difat);
      for (let i = 0; i < perSector - 1 && fatSectors.length < fatCount; i++) {
        fatSectors.push(body.readUInt32LE(i * 4));
      }
      difat = body.readUInt32LE((perSector - 1) * 4);
    }
    for (const fatSector of fatSectors) {
      const body = this.sector(fatSector);
      for (let i = 0; i < perSector; i++) {
        this.fat.push(body.readUInt32LE(i * 4));
      }
    }
  }

  private chain(first: number): number[] {
    const sectors: number[] = [];
    let at = first;
    while (at !== END_OF_CHAIN) {
      if (at >= this.fat.length || sectors.length > this.fat.length) {
        throw new Error("allocation chain is broken");
      }
      sectors.push(at);
      at = this.fat[at];
    }
    return sectors;
  }

  private readChain(first: number): Buffer {
    return Buffer.concat(this.chain(first).map((s) => this.sector(s)));
  }

  private readDirectory(): void {
    const dir = this.readChain(this.data.readUInt32LE(48));
    for (let i = 0; i + 128 <= dir.length; i++) {
      const e = dir.subarray(i * 128, i * 128 + 128);
      if (e.length < 128) break;
      const nameLength = e.readUInt16LE(64);
      const name = nameLength >= 2 ? e.subarray(0, Math.min(nameLength, 64) - 2).toString("utf16le") : "";
      this.entries.push({
        index: i,
        name,
        type: e[66],
        left: e.readUInt32LE(68),
        right: e.readUInt32LE(72),
        child: e.readUInt32LE(76),
        classId: Buffer.from(e.subarray(80, 96)),
        state: e.readUInt32LE(96),
        created: e.subarray(100, 108).toString("hex"),
        modified: e.subarray(108, 116).toString("hex"),
        start: e.readUInt32LE(116),
        size: e.readUInt32LE(120) + (this.version === 3 ? 0 : e.readUInt32LE(124) * 0x100000000),
      });
    }
    if (this.entries.length === 0 || this.entries[0].type !== TYPE_ROOT) {
      throw new Error("directory has no root entry");
    }
  }

  private mini(): Buffer {
    if (this.miniStream === null) {
      const root = this.entries[0];
      this.miniStream = root.size > 0 ? this.readChain(root.start).subarray(0, root.size) : Buffer.alloc(0);
      const first = this.data.readUInt32LE(60);
      this.miniFat = [];
      if (first !== END_OF_CHAIN) {
        const raw = this.readChain(first);
        for (let i = 0; i + 4 <= raw.length; i += 4) {
          this.miniFat.push(raw.readUInt32LE(i));
        }
      }
    }
    return this.miniStream;
  }

  /** Whether a stream of this entry lives in the small-block stream (decided by size). */
  inMiniStream(entry: CfbEntry): boolean {
    return entry.size < this.miniCutoff;
  }

  /** Children of a storage in the order of an in-order walk of its search tree. */
  children(storage: number): CfbEntry[] {
    const order: CfbEntry[] = [];
    const seen = new Set<number>();
    const stack: number[] = [];
    let node = this.entries[storage].child;
    while (node !== NO_STREAM || stack.length > 0) {
      while (node !== NO_STREAM) {
        if (node >= this.entries.length || seen.has(node)) {
          throw new Error(`search tree of entry ${storage} is not a tree`);
        }
        seen.add(node);
        stack.push(node);
        node = this.entries[node].left;
      }
      node = stack.pop() as number;
      order.push(this.entries[node]);
      node = this.entries[node].right;
    }
    return order;
  }

  /** Looks a name up in one storage by walking its search tree. Never enumerates. */
  find(storage: number, name: string): CfbEntry | null {
    let node = this.entries[storage].child;
    for (let steps = 0; node !== NO_STREAM && steps <= this.entries.length; steps++) {
      if (node >= this.entries.length) return null;
      const entry = this.entries[node];
      const order = compareNames(name, entry.name);
      if (order === 0) return entry;
      node = order < 0 ? entry.left : entry.right;
    }
    return null;
  }

  /** The signature stream of the root, found by search. */
  findSignature(): CfbEntry | null {
    return this.find(0, SIGNATURE_NAME);
  }

  /** The extended signature stream of the root, found by search. */
  findSignatureEx(): CfbEntry | null {
    return this.find(0, SIGNATURE_EX_NAME);
  }

  /** The bytes of a stream. */
  read(entry: CfbEntry): Buffer {
    if (entry.type !== TYPE_STREAM) {
      throw new Error(`entry '${entry.name}' is not a stream`);
    }
    if (entry.size === 0) return Buffer.alloc(0);
    if (!this.inMiniStream(entry)) {
      return this.readChain(entry.start).subarray(0, entry.size);
    }
    const mini = this.mini();
    const parts: Buffer[] = [];
    let at = entry.start;
    for (let hops = 0; at !== END_OF_CHAIN; hops++) {
      if (at >= this.miniFat.length || hops > this.miniFat.length) {
        throw new Error("small-block chain is broken");
      }
      const from = at * this.miniSectorSize;
      if (from + this.miniSectorSize > mini.length) {
        throw new Error("small block is outside the small-block stream");
      }
      parts.push(mini.subarray(from, from + this.miniSectorSize));
      at = this.miniFat[at];
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length < entry.size) {
      throw new Error("small-block chain is shorter than the stream");
    }
    return bytes.subarray(0, entry.size);
  }

  /** The signature bytes found by search, or null when the search does not reach them. */
  signatureBytes(): Buffer | null {
    const entry = this.findSignature();
    return entry === null ? null : this.read(entry);
  }

  /** File offset of byte `position` of a stream (to damage it on purpose in a test). */
  fileOffsetOf(entry: CfbEntry, position: number): number {
    if (position < 0 || position >= entry.size) {
      throw new Error("position is outside the stream");
    }
    if (!this.inMiniStream(entry)) {
      const sectors = this.chain(entry.start);
      return this.sectorOffset(sectors[Math.floor(position / this.sectorSize)]) + (position % this.sectorSize);
    }
    this.mini();
    let at = entry.start;
    for (let i = 0; i < Math.floor(position / this.miniSectorSize); i++) {
      at = this.miniFat[at];
    }
    const inMini = at * this.miniSectorSize + (position % this.miniSectorSize);
    const containerSectors = this.chain(this.entries[0].start);
    return (
      this.sectorOffset(containerSectors[Math.floor(inMini / this.sectorSize)]) + (inMini % this.sectorSize)
    );
  }

  /** Number of entries below the root. */
  countEntries(): number {
    const walk = (storage: number): number =>
      this.children(storage).reduce((n, c) => n + 1 + (c.type === TYPE_STORAGE ? walk(c.index) : 0), 0);
    return walk(0);
  }

  /** The Authenticode fingerprint of the package (lower-case hexadecimal SHA-256). */
  fingerprint(): string {
    const hash = crypto.createHash("sha256");
    const visit = (storage: number): void => {
      const kids = this.children(storage).filter(
        (c) => !(storage === 0 && (c.name === SIGNATURE_NAME || c.name === SIGNATURE_EX_NAME))
      );
      kids.sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf16le"), Buffer.from(b.name, "utf16le")));
      for (const kid of kids) {
        if (kid.type === TYPE_STREAM) {
          if (kid.size > 0) hash.update(this.read(kid));
        } else if (kid.type === TYPE_STORAGE) {
          visit(kid.index);
        }
      }
      hash.update(this.entries[storage].classId);
    };
    visit(0);
    return hash.digest("hex");
  }

  /**
   * Names, kinds, class identifiers, state bits, times and content hashes of
   * everything but the two signature streams, keyed by path. Used to show an
   * operation changed nothing but the signature.
   */
  listing(): ListedEntry[] {
    const out: ListedEntry[] = [];
    const visit = (storage: number, prefix: string): void => {
      for (const kid of this.children(storage)) {
        if (storage === 0 && (kid.name === SIGNATURE_NAME || kid.name === SIGNATURE_EX_NAME)) continue;
        const entryPath = `${prefix}/${kid.name}`;
        const isStream = kid.type === TYPE_STREAM;
        out.push({
          path: entryPath,
          type: isStream ? "stream" : "storage",
          classId: kid.classId.toString("hex"),
          state: kid.state,
          created: kid.created,
          modified: kid.modified,
          size: isStream ? kid.size : 0,
          sha256: isStream ? crypto.createHash("sha256").update(this.read(kid)).digest("hex") : "",
        });
        if (kid.type === TYPE_STORAGE) visit(kid.index, entryPath);
      }
    };
    visit(0, "");
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }
}

function upperCase(unit: number): number {
  return unit >= 0x61 && unit <= 0x7a ? unit - 32 : unit;
}

/** The format's ordering of names inside one storage: shorter first, then upper-cased code units. */
export function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  for (let i = 0; i < a.length; i++) {
    const x = upperCase(a.charCodeAt(i));
    const y = upperCase(b.charCodeAt(i));
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Parse a package held in memory. */
export function parsePackage(data: Buffer): CfbPackage {
  return new CfbPackage(data);
}

/** Parse a package from a file. */
export function readPackage(file: string): CfbPackage {
  return new CfbPackage(fs.readFileSync(file));
}

// ── The digest held in a signature ───────────────────────────

interface Tlv {
  tag: number;
  body: Buffer;
}

function readTlv(buf: Buffer, at: number): { tlv: Tlv; next: number } {
  if (at + 2 > buf.length) throw new Error("DER ends early");
  const tag = buf[at];
  let length = buf[at + 1];
  let head = 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || at + 2 + n > buf.length) throw new Error("bad DER length");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[at + 2 + i];
    head += n;
  }
  if (at + head + length > buf.length) throw new Error("DER value runs past the end");
  return { tlv: { tag, body: buf.subarray(at + head, at + head + length) }, next: at + head + length };
}

function tlvChildren(body: Buffer): Tlv[] {
  const kids: Tlv[] = [];
  let at = 0;
  while (at < body.length) {
    const { tlv, next } = readTlv(body, at);
    kids.push(tlv);
    at = next;
  }
  return kids;
}

/**
 * The package digest held in an Authenticode signature: ContentInfo, signed
 * data, the signed content (SpcIndirectDataContent) and its DigestInfo. Returns
 * lower-case hexadecimal, or null when the blob has no such path.
 */
export function storedDigest(signature: Buffer): string | null {
  try {
    const contentInfo = tlvChildren(readTlv(signature, 0).tlv.body);
    const signedData = tlvChildren(tlvChildren(contentInfo[1].body)[0].body);
    const encap = signedData.find((t, i) => i >= 2 && t.tag === 0x30);
    if (!encap) return null;
    const content = tlvChildren(tlvChildren(encap.body)[1].body)[0];
    const digestInfo = tlvChildren(content.body)[1];
    const octets = tlvChildren(digestInfo.body)[1];
    return octets.tag === 0x04 ? octets.body.toString("hex") : null;
  } catch {
    return null;
  }
}

// ── The recorded known answers ───────────────────────────────

export interface MsiReference {
  /** osslsigncode's "Calculated DigitalSignature" per sample. */
  fingerprint: Map<string, string>;
  /** Entry count below the root and signature stream size (null when none) per sample. */
  entries: Map<string, { count: number; signatureSize: number | null }>;
  /** osslsigncode's "Current DigitalSignature" per signed sample. */
  storedDigest: Map<string, string>;
  /** SHA-256 of each sample file. */
  sample: Map<string, string>;
}

/** Read the values recorded beside the samples. */
export function loadReference(file: string): MsiReference {
  const reference: MsiReference = {
    fingerprint: new Map(),
    entries: new Map(),
    storedDigest: new Map(),
    sample: new Map(),
  };
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "#" && words[1] === "sample" && words.length === 4) {
      reference.sample.set(words[2], words[3]);
    } else if (words[0] === "fingerprint" && words.length === 3) {
      reference.fingerprint.set(words[1], words[2]);
    } else if (words[0] === "entries" && words.length === 4) {
      reference.entries.set(words[1], {
        count: Number(words[2]),
        signatureSize: words[3] === "none" ? null : Number(words[3]),
      });
    } else if (words[0] === "stored-digest" && words.length === 3) {
      reference.storedDigest.set(words[1], words[2]);
    }
  }
  return reference;
}
