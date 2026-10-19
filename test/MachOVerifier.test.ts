import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Signing from "../src/Signing";
import { checkMachO } from "../src/MachOVerifier";
import type { MachOCheck, MachOSliceInfo } from "../src/MachOVerifier";
import { checkMachO as checkWithIndependentChecker } from "./helpers/MachOChecker";
import { expectPresent } from "./helpers/Assert";
import { makeUniversal } from "./helpers/Universal";
import { optionalExternalCheck } from "./helpers/ExternalTools";

// Cases for the pure Mach-O verification function: it is given the bytes of a file and the slice
// table (as the addon's machoListSlices returns it) and nothing else. Signed inputs are copies of the
// genuine fixtures signed with a scratch certificate. The independent checker of the test helpers is
// the second opinion for the agreement cases.
//
// Wording these tests fix:
//   - a page that does not match:        reason contains "slice <arch>: page <n> fingerprint does not match"
//   - signature over the code directory:  reason contains "signature over the code directory does not verify"
//   - special slot that does not match:   reason contains "special slot <n>"
//   - an uncovered SuperBlob slot:        reason contains "not covered by the code directory"
//   - codeLimit below the signature:      reason contains "does not cover the whole program"; the coverage
//                                         rule is applied before the signature check (the signature also
//                                         fails there, because the code directory changed)
//   - slices of different signers:        reason contains "slices are signed by different certificates"
//   - an architecture without a name:     "0x<cputype>" in hexadecimal, so CPU type 7 reads "0x7"

const PAGE = 4096;
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

const created: string[] = [];
let savedHome: string | undefined;
let scratch: string;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function genuine(name: string): Buffer {
  return fs.readFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", name));
}

async function makeConfiguration(prefix: string, scope: string): Promise<Signing> {
  const configDir = tempDir(prefix);
  const scopes = { [scope]: { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } } };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
  const signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope });
  return signing;
}

/** Signs a copy of a genuine fixture in the given configuration and returns the signed bytes. */
async function signedCopy(signing: Signing, scope: string, name: string): Promise<Buffer> {
  const file = path.join(scratch, `signed-${scope.slice(1)}-${name}`);
  fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", name), file);
  await signing.signFileMachO(file, scope);
  return fs.readFileSync(file);
}

let counter = 0;

/** The addon's slice table for a byte buffer (written to a scratch file for the call). */
function tableOf(bytes: Buffer): MachOSliceInfo[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
  const addon = require("../native/build/Release/dependency_lister.node");
  const file = path.join(scratch, `table-${counter++}`);
  fs.writeFileSync(file, bytes);
  return addon.machoListSlices(file) as MachOSliceInfo[];
}

interface Layout {
  signature: number; // absolute offset of the SuperBlob
  signatureSize: number;
  length: number; // SuperBlob length
  slots: Array<{ type: number; offset: number; indexAt: number; length: number }>;
  cd: number; // absolute offset of the slot-0 code directory
  hashOffset: number;
  identOffset: number;
  specialSlots: number;
  codeSlots: number;
  codeLimit: number;
  page: number;
}

/** Reads, independently of the code under test, where the parts of a signed slice are. */
function layoutOf(bytes: Buffer, slice: MachOSliceInfo): Layout {
  const signature = slice.offset + slice.signatureOffset;
  const count = bytes.readUInt32BE(signature + 8);
  const slots = [];
  for (let i = 0; i < count; i++) {
    const indexAt = signature + 12 + 8 * i;
    const offset = bytes.readUInt32BE(indexAt + 4);
    slots.push({ type: bytes.readUInt32BE(indexAt), offset, indexAt, length: bytes.readUInt32BE(signature + offset + 4) });
  }
  const cd = signature + expectPresent(slots.find((s) => s.type === 0), "slot 0").offset;
  return {
    signature,
    signatureSize: slice.signatureSize,
    length: bytes.readUInt32BE(signature + 4),
    slots,
    cd,
    hashOffset: bytes.readUInt32BE(cd + 16),
    identOffset: bytes.readUInt32BE(cd + 20),
    specialSlots: bytes.readUInt32BE(cd + 24),
    codeSlots: bytes.readUInt32BE(cd + 28),
    codeLimit: bytes.readUInt32BE(cd + 32),
    page: 2 ** bytes[cd + 39],
  };
}

function sha256(bytes: Buffer): Buffer {
  return crypto.createHash("sha256").update(bytes).digest();
}

/** Writes the SHA-256 of each page of the slice into the code directory's hash slots. */
function rewriteHashes(bytes: Buffer, slice: MachOSliceInfo, layout: Layout, codeLimit: number): void {
  const pages = Math.ceil(codeLimit / layout.page);
  for (let p = 0; p < pages; p++) {
    const start = slice.offset + p * layout.page;
    const end = slice.offset + Math.min((p + 1) * layout.page, codeLimit);
    sha256(bytes.subarray(start, end)).copy(bytes, layout.cd + layout.hashOffset + 32 * p);
  }
}

function archOf(cpuType: number): string {
  return cpuType === ARM64 ? "arm64" : cpuType === X86_64 ? "x86_64" : "0x" + cpuType.toString(16);
}

// Builders of the damaged and assembled programs, shared by the cases and the agreement corpus
function pageChangedHashRewritten(): Buffer {
  const slices = tableOf(signedArm64);
  const layout = layoutOf(signedArm64, slices[0]);
  const bytes = Buffer.from(signedArm64);
  bytes[slices[0].offset + PAGE + 100] ^= 0xff;
  rewriteHashes(bytes, slices[0], layout, layout.codeLimit);
  return bytes;
}

function codeLimitLowered(): Buffer {
  const slices = tableOf(signedArm64);
  const layout = layoutOf(signedArm64, slices[0]);
  const lowered = layout.codeLimit - PAGE;
  const bytes = Buffer.from(signedArm64);
  bytes.writeUInt32BE(lowered, layout.cd + 32);
  bytes.writeUInt32BE(Math.ceil(lowered / PAGE), layout.cd + 28);
  rewriteHashes(bytes, slices[0], layout, lowered);
  return bytes;
}

function signedArm64With32BitSlice(): Buffer {
  // A 32-bit Mach-O header with no load commands: i386, little-endian
  const small = Buffer.alloc(28);
  small.writeUInt32LE(0xfeedface, 0);
  small.writeUInt32LE(7, 4);
  small.writeUInt32LE(3, 8);
  small.writeUInt32LE(2, 12);
  return makeUniversal([
    { cpuType: ARM64, cpuSubtype: 0, bytes: signedArm64 },
    { cpuType: 7, cpuSubtype: 3, bytes: small },
  ]);
}

function signedByAAndB(): Buffer {
  // arm64 signed in configuration B, x86_64 signed in configuration A
  return makeUniversal([
    { cpuType: ARM64, cpuSubtype: 0, bytes: signedArm64B },
    { cpuType: X86_64, cpuSubtype: 0x80000003, bytes: signedX86 },
  ]);
}

const DAMAGES: Array<[string, (bytes: Buffer, layout: Layout) => Buffer]> = [
  ["a truncated signature", (bytes) => bytes.subarray(0, bytes.length - 100)],
  [
    "a SuperBlob length past the signature region",
    (bytes, layout) => {
      bytes.writeUInt32BE(layout.signatureSize + 1000, layout.signature + 4);
      return bytes;
    },
  ],
  [
    "a slot offset past the blob",
    (bytes, layout) => {
      const requirements = expectPresent(layout.slots.find((s) => s.type === 2), "requirements slot");
      bytes.writeUInt32BE(0x00ffffff, requirements.indexAt + 4);
      return bytes;
    },
  ],
  [
    "an nCodeSlots past the code directory",
    (bytes, layout) => {
      bytes.writeUInt32BE(100000, layout.cd + 28);
      return bytes;
    },
  ],
];

function damaged(name: string): Buffer {
  const slices = tableOf(signedArm64);
  const layout = layoutOf(signedArm64, slices[0]);
  const damage = expectPresent(DAMAGES.find((entry) => entry[0] === name), name)[1];
  return damage(Buffer.from(signedArm64), layout);
}

let signedArm64: Buffer;
let signedX86: Buffer;
let signedUniversal: Buffer;
let signedArm64B: Buffer;
let certificateA: Buffer;

// Every Mac file used by the group, by name, for the agreement cases (filled in beforeAll)
const corpus = new Map<string, Buffer>();
// Slice tables for files the addon refuses to list (a truncated signature): the table of the file they were made from
const tables = new Map<string, MachOSliceInfo[]>();
function use(name: string, bytes: Buffer): Buffer {
  corpus.set(name, bytes);
  return bytes;
}

beforeAll(async () => {
  savedHome = process.env.HOME;
  process.env.HOME = tempDir("machoverifier-home-");
  scratch = tempDir("machoverifier-scratch-");
  const a = await makeConfiguration("machoverifier-a-", "@ta");
  const b = await makeConfiguration("machoverifier-b-", "@tb");
  certificateA = new crypto.X509Certificate(fs.readFileSync(a.scopeCertPath("@ta"))).raw;

  signedArm64 = use("signed arm64", await signedCopy(a, "@ta", "tiny-macho-arm64"));
  signedX86 = use("signed x86_64", await signedCopy(a, "@ta", "tiny-macho-x86_64"));
  signedUniversal = use("signed universal", await signedCopy(a, "@ta", "tiny-macho-universal"));
  signedArm64B = await signedCopy(b, "@tb", "tiny-macho-arm64");

  for (const name of ["tiny-macho-arm64-adhoc", "tiny-macho-x86_64-adhoc", "tiny-macho-universal-adhoc", "tiny-macho-arm64", "tiny-macho-x86_64", "tiny-macho-universal"]) {
    use(name, genuine(name));
  }
  use("page changed, hash rewritten", pageChangedHashRewritten());
  use("code limit lowered", codeLimitLowered());
  use("signed arm64 and 32-bit", signedArm64With32BitSlice());
  use("signed by A and B", signedByAAndB());
  for (const [name] of DAMAGES) {
    // The independent checker cannot read a slot offset past the blob (it would throw), so that file is not compared
    if (name !== "a slot offset past the blob") {
      use("damaged: " + name, damaged(name));
      if (name === "a truncated signature") {
        tables.set("damaged: " + name, tableOf(signedArm64));
      }
    }
  }
  const pageChanged = Buffer.from(signedArm64);
  pageChanged[2 * PAGE + 10] ^= 0xff;
  use("signed arm64, one page changed", pageChanged);
  const firstSliceChanged = Buffer.from(signedUniversal);
  firstSliceChanged[tableOf(signedUniversal)[0].offset + 10] ^= 0xff;
  use("signed universal, one page of the first slice changed", firstSliceChanged);
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("signed programs", () => {
  it("are intact, with the signer certificate and a checked-page list per slice", () => {
    for (const bytes of [signedArm64, signedX86, signedUniversal]) {
      const slices = tableOf(bytes);
      const check = checkMachO(bytes, slices);
      expect(check.integrity.state).toBe("intact");
      expect(check.integrity.checked.length).toBeGreaterThan(0);
      expect(check.slices).toHaveLength(slices.length);
      expect(check.signerCertificate).toEqual(certificateA);
      expect(check.warnings).toEqual(expect.any(Array));
      expect(check.notChecked).toEqual(expect.any(Array));
      check.slices.forEach((result, i) => {
        const layout = layoutOf(bytes, slices[i]);
        expect(result.state).toBe("intact");
        expect(result.arch).toBe(archOf(slices[i].cpuType));
        expect(result.adHoc).toBe(false);
        expect(result.codeDirectories[0]).toMatchObject({ slot: 0, hashType: "sha256", pages: layout.codeSlots, pagesMismatched: 0, codeLimit: layout.codeLimit });
      });
    }
  });
});

describe("every page of every slice", () => {
  const cases: Array<[string, () => Buffer]> = [
    ["genuine/tiny-macho-arm64", () => signedArm64],
    ["genuine/tiny-macho-x86_64", () => signedX86],
    ["genuine/tiny-macho-universal", () => signedUniversal],
  ];

  for (const [name, bytesOf] of cases) {
    it(`inverting one byte of each page in turn is invalid, naming that slice and page (${name})`, () => {
      const original = bytesOf();
      const slices = tableOf(original);
      let tried = 0;
      slices.forEach((slice, index) => {
        const layout = layoutOf(original, slice);
        expect(layout.page).toBe(PAGE);
        for (let page = 0; page < layout.codeSlots; page++) {
          const start = page * layout.page;
          const end = Math.min(start + layout.page, layout.codeLimit);
          const bytes = Buffer.from(original);
          bytes[slice.offset + start + Math.floor((end - start) / 2)] ^= 0xff;

          const check = checkMachO(bytes, slices);
          const arch = archOf(slice.cpuType);
          expect(check.integrity.state).toBe("invalid");
          expect(check.integrity.reason).toContain(`slice ${arch}: page ${page} fingerprint does not match`);
          expect(check.slices[index].state).toBe("invalid");
          check.slices.forEach((other, i) => {
            if (i !== index) {
              expect(other.state).toBe("intact");
            }
          });
          tried++;
        }
      });
      // 5 pages in the arm64 slice, 2 in the x86_64 slice
      expect(tried).toBe(name.endsWith("arm64") ? 5 : name.endsWith("x86_64") ? 2 : 7);
    });
  }
});

describe("damage to the signature structure", () => {
  const signatureReason = /signature over the code directory does not verify/;

  it("a changed byte of the code directory's identifier is invalid: the signature over the code directory does not verify", () => {
    const slices = tableOf(signedArm64);
    const layout = layoutOf(signedArm64, slices[0]);
    const bytes = Buffer.from(signedArm64);
    bytes[layout.cd + layout.identOffset] ^= 0x01;
    const check = checkMachO(bytes, slices);
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(signatureReason);
  });

  it("a page changed with its hash rewritten in the code directory is invalid: the signature over the code directory does not verify", () => {
    const slices = tableOf(signedArm64);
    const bytes = pageChangedHashRewritten();

    // The checker sees a consistent program; only the signature can tell
    expect(checkWithIndependentChecker(bytes).problems).toEqual([]);
    const check = checkMachO(bytes, slices);
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(signatureReason);
    expect(check.slices[0].codeDirectories[0].pagesMismatched).toBe(0);
  });

  it("a changed requirements blob is invalid, naming special slot 2", () => {
    const slices = tableOf(signedArm64);
    const layout = layoutOf(signedArm64, slices[0]);
    const requirements = expectPresent(layout.slots.find((s) => s.type === 2), "requirements slot");
    const bytes = Buffer.from(signedArm64);
    // The last byte of the blob; its hash is in special slot 2 of the code directory
    bytes[layout.signature + requirements.offset + requirements.length - 1] ^= 0xff;
    const check = checkMachO(bytes, slices);
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(/special slot 2/i);
  });

  it("an extra SuperBlob slot that no hash covers is invalid", () => {
    const slices = tableOf(signedArm64);
    const layout = layoutOf(signedArm64, slices[0]);
    // Rebuild the SuperBlob with an additional entitlements blob (slot 5); the code directory has only
    // two special slots, so nothing covers it
    const blobs = layout.slots.map((s) => ({ type: s.type, data: signedArm64.subarray(layout.signature + s.offset, layout.signature + s.offset + s.length) }));
    const extra = Buffer.alloc(12);
    extra.writeUInt32BE(0xfade7171, 0);
    extra.writeUInt32BE(12, 4);
    blobs.push({ type: 5, data: extra });
    const headerSize = 12 + 8 * blobs.length;
    const total = headerSize + blobs.reduce((sum, blob) => sum + blob.data.length, 0);
    expect(total).toBeLessThanOrEqual(layout.signatureSize);
    const rebuilt = Buffer.alloc(layout.signatureSize);
    rebuilt.writeUInt32BE(0xfade0cc0, 0);
    rebuilt.writeUInt32BE(total, 4);
    rebuilt.writeUInt32BE(blobs.length, 8);
    let at = headerSize;
    blobs.forEach((blob, i) => {
      rebuilt.writeUInt32BE(blob.type, 12 + 8 * i);
      rebuilt.writeUInt32BE(at, 16 + 8 * i);
      blob.data.copy(rebuilt, at);
      at += blob.data.length;
    });
    const bytes = Buffer.from(signedArm64);
    rebuilt.copy(bytes, layout.signature);

    const check = checkMachO(bytes, slices);
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(/not covered by the code directory/i);
  });

  it("a codeLimit below the signature offset with the hashes recomputed is invalid: the signature does not cover the whole program", () => {
    const bytes = codeLimitLowered();
    const check = checkMachO(bytes, tableOf(signedArm64));
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(/does not cover the whole program/);
  });

  describe("structures that run past their bounds are invalid with a reason, and nothing throws", () => {
    for (const [name] of DAMAGES) {
      it(name, () => {
        const slices = tableOf(signedArm64);
        const bytes = damaged(name);
        let check: MachOCheck | undefined;
        expect(() => {
          check = checkMachO(bytes, slices);
        }).not.toThrow();
        const result = expectPresent(check, "result");
        expect(result.integrity.state).toBe("invalid");
        expect(expectPresent(result.integrity.reason, "reason").length).toBeGreaterThan(0);
        expect(result.slices[0].state).toBe("invalid");
      });
    }
  });
});

describe("programs with no signer, with an unsupported slice, and with mixed signers", () => {
  it("the linker's ad-hoc samples, thin and universal, are intact, ad hoc and without a signer certificate", () => {
    for (const name of ["tiny-macho-arm64-adhoc", "tiny-macho-x86_64-adhoc", "tiny-macho-universal-adhoc"]) {
      const bytes = genuine(name);
      const slices = tableOf(bytes);
      const check = checkMachO(bytes, slices);
      expect(check.integrity.state).toBe("intact");
      expect(check.signerCertificate).toBeUndefined();
      expect(check.slices).toHaveLength(slices.length);
      for (const result of check.slices) {
        expect(result.state).toBe("intact");
        expect(result.adHoc).toBe(true);
        expect(result.signerFingerprint).toBeUndefined();
      }
    }
  });

  it("a signed arm64 slice with a 32-bit slice: that slice is not checked with the library's reason, and the program is never intact", () => {
    const bytes = signedArm64With32BitSlice();
    const slices = tableOf(bytes);
    expect(slices[1].supported).toBe(false);
    const check = checkMachO(bytes, slices);
    expect(check.slices[0].state).toBe("intact");
    expect(check.slices[1].state).toBe("not-checked");
    expect(check.slices[1].reason).toContain(slices[1].unsupportedReason);
    expect(check.integrity.state).toBe("not-checked");
    expect(check.integrity.state).not.toBe("intact");
    expect(check.integrity.reason).toMatch(/0x0*7\b/);
  });

  it("slices signed by different certificates are invalid: the slices are signed by different certificates", () => {
    const bytes = signedByAAndB();
    const check = checkMachO(bytes, tableOf(bytes));
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(/slices are signed by different certificates/);
  });
});

describe("agreement with the independent checker", () => {
  it("covers the unsigned, signed, ad-hoc, changed and damaged programs of this group", () => {
    expect(corpus.size).toBe(18);
  });

  it("gives the same pages checked and mismatched per slice where the checker reads the slice, and never intact where the checker lists a problem", () => {
    let compared = 0;
    let problemSlices = 0;
    for (const [name, bytes] of corpus) {
      const slices = tables.get(name) ?? tableOf(bytes);
      const check = checkMachO(bytes, slices);
      const report = checkWithIndependentChecker(bytes);
      slices.forEach((slice, index) => {
        const mine = check.slices[index];
        const theirs = report.slices.find((s) => s.offset === slice.offset);
        const own = report.problems.filter((problem) => problem.startsWith(`slice at ${slice.offset}:`));
        const readCleanly = theirs !== undefined && own.every((problem) => /page \d+ hash does not match/.test(problem));
        if (own.length > 0 || theirs === undefined) {
          problemSlices++;
          expect([name, mine.state]).not.toEqual([name, "intact"]);
        }
        if (readCleanly && theirs) {
          const directory = mine.codeDirectories.find((cd) => cd.slot === 0);
          expect([name, directory?.pages ?? 0]).toEqual([name, theirs.pagesChecked]);
          expect([name, directory?.pagesMismatched ?? 0]).toEqual([name, theirs.pagesMismatched]);
          compared++;
        }
      });
    }
    // The corpus holds slices of both kinds, so neither half of the rule is empty
    expect(compared).toBeGreaterThan(10);
    expect(problemSlices).toBeGreaterThan(4);
  });

  it("the checker imports nothing from src/", () => {
    const source = fs.readFileSync(path.join(__dirname, "helpers", "MachOChecker.ts"), "utf-8");
    const specifiers = [...source.matchAll(/(?:from\s+|require\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(^|\/)src(\/|$)/);
    }
  });
});

describe("standard signed-attribute signatures made by openssl", () => {
  // The CodeDirectory of the arm64 sample is prepared with the library (capacity 4096), signed by
  // `openssl cms -sign -binary -md sha256` (DER, detached, with signed attributes), and the result is put in
  // with machoCompleteSignature. Wording these tests fix:
  //   - a signature algorithm the verifier does not implement (RSA-PSS): the program's integrity is `not-checked`
  //     with a reason containing "unsupported signature algorithm"; the slice is `not-checked` too
  const haveOpenssl = (): boolean => spawnSync("openssl", ["version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).status === 0;

  function run(dir: string, args: string[]): void {
    const result = spawnSync("openssl", args, {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LC_ALL: "C", TZ: "UTC" },
    });
    if (result.status !== 0) {
      throw new Error("openssl " + args.join(" ") + " failed: " + result.stdout + result.stderr);
    }
  }

  /** Signs a copy of the genuine arm64 program with openssl; returns the file's bytes and the signer certificate. */
  function signWithOpenssl(kind: "ecdsa" | "rsa-pss"): { bytes: Buffer; certificate: Buffer } {
    const dir = tempDir("machoverifier-openssl-");
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    const keyArgs = kind === "ecdsa" ? ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key] : ["genrsa", "-out", key, "2048"];
    run(dir, keyArgs);
    run(dir, ["req", "-new", "-x509", "-key", key, "-subj", "/CN=openssl-" + kind, "-days", "30", "-out", cert]);

    const file = path.join(dir, "program");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
    const addon = require("../native/build/Release/dependency_lister.node");
    const prepared = addon.machoPrepareSignature(file, "openssl-test", 4096);
    const signatures = prepared.slices.map((slice: { codeDirectory: Buffer }, index: number) => {
      const content = path.join(dir, `cd-${index}`);
      const out = path.join(dir, `cms-${index}`);
      fs.writeFileSync(content, slice.codeDirectory);
      const options = kind === "rsa-pss" ? ["-keyopt", "rsa_padding_mode:pss"] : [];
      run(dir, ["cms", "-sign", "-binary", "-md", "sha256", "-in", content, "-signer", cert, "-inkey", key, ...options, "-outform", "DER", "-out", out]);
      return fs.readFileSync(out);
    });
    addon.machoCompleteSignature(file, prepared, signatures);
    return { bytes: fs.readFileSync(file), certificate: Buffer.from(new crypto.X509Certificate(fs.readFileSync(cert)).raw) };
  }

  it("is intact with the openssl certificate as signer, and the independent checker reads the same pages", () => {
    if (!optionalExternalCheck("openssl", haveOpenssl(), "openssl not found")) {
      return;
    }
    const { bytes, certificate } = signWithOpenssl("ecdsa");
    const slices = tableOf(bytes);
    const check = checkMachO(bytes, slices);
    expect(check.integrity.state).toBe("intact");
    expect(check.signerCertificate).toEqual(certificate);
    expect(check.slices[0].adHoc).toBe(false);

    const report = checkWithIndependentChecker(bytes);
    expect(report.problems).toEqual([]);
    expect(check.slices[0].codeDirectories[0].pages).toBe(report.slices[0].pagesChecked);
    expect(check.slices[0].codeDirectories[0].pagesMismatched).toBe(report.slices[0].pagesMismatched);
  });

  it("with one byte changed is invalid, and the independent checker lists a problem too", () => {
    if (!optionalExternalCheck("openssl", haveOpenssl(), "openssl not found")) {
      return;
    }
    const { bytes } = signWithOpenssl("ecdsa");
    const changed = Buffer.from(bytes);
    changed[2 * PAGE + 10] ^= 0xff;
    const check = checkMachO(changed, tableOf(changed));
    expect(check.integrity.state).toBe("invalid");
    expect(check.integrity.reason).toMatch(/slice arm64: page 2/);

    const report = checkWithIndependentChecker(changed);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.slices[0].pagesMismatched).toBe(check.slices[0].codeDirectories[0].pagesMismatched);
  });

  it("signed with RSA-PSS is not checked: unsupported signature algorithm, and never intact", () => {
    if (!optionalExternalCheck("openssl", haveOpenssl(), "openssl not found")) {
      return;
    }
    const { bytes } = signWithOpenssl("rsa-pss");
    const check = checkMachO(bytes, tableOf(bytes));
    expect(check.integrity.state).toBe("not-checked");
    expect(check.integrity.reason).toMatch(/unsupported signature algorithm/);
    expect(check.slices[0].state).toBe("not-checked");

    // The pages themselves are fine, which the independent checker confirms
    expect(checkWithIndependentChecker(bytes).problems).toEqual([]);
  });
});
