/*
 * Format detection by the native component: which files it calls a Windows program, a Mac program, an
 * installer or other, how much of a file it reads to decide, and how often signing and verification ask.
 *
 * Interfaces fixed here:
 * - The component is reached through the existing loader (`loadNativeComponent`); a case that needs it
 *   returns early through `optionalExternalCheck` when the component file is not built.
 * - The oracle for "Windows program" is the component's own `peComputeDigest`, which is unchanged and
 *   parses the whole layout: detection says "pe" exactly when `peComputeDigest` returns, and the
 *   sub-format is "pe32+" exactly when it reports `isPe32Plus`.
 * - Damaged files are made in memory from `tiny.exe` and from a copy signed with a scratch certificate
 *   (for the checks on the certificate table), each breaking one header check; the checksum field lies
 *   before the field that precedes it in every layout, so it cannot be broken alone and has no case.
 * - The bounded-read case runs in a child `node` process: it loads the component, warms it with a small
 *   file, reads `rchar` from `/proc/self/io`, detects a 100 MiB sparse copy of `tiny.exe`, reads `rchar`
 *   again and prints both. The 100 MiB file is made in the scratch temporary directory and removed
 *   afterwards. No timing is measured.
 * - The count cases spy on the loaded component's `detectBinaryFormat` (the same object the signing code
 *   calls) while signing copies of `tiny.exe`, `tiny-macho-x86_64` and `tiny.msi` with a scratch
 *   certificate, and while verifying a signed program.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { loadNativeComponent, NATIVE_COMPONENT_PATH, packageRoot } from "../src/NativeComponent";
import Signing from "../src/Signing";
import { optionalExternalCheck } from "./helpers/ExternalTools";

interface Detection {
  format: string;
  subFormat: string | null;
}

interface Component {
  detectBinaryFormat(file: string): Detection;
  peComputeDigest(file: string): { digest: Buffer; isPe32Plus: boolean };
}

const binaries = path.join(__dirname, "fixtures", "binaries");
const componentFile = path.join(packageRoot(), NATIVE_COMPONENT_PATH);

/** True when the component is built; otherwise reports the skipped check (an error when tools are required). */
function haveComponent(): boolean {
  return optionalExternalCheck("native component", fs.existsSync(componentFile), "the native component is not built");
}

function component(): Component {
  return loadNativeComponent<Component>();
}

/** What the unchanged digest says about a file: its sub-format when it parses, null when it throws. */
function oracle(file: string): "pe32+" | "pe32" | null {
  try {
    return component().peComputeDigest(file).isPe32Plus ? "pe32+" : "pe32";
  } catch {
    return null;
  }
}

/** Offsets of the fields the header checks read, found in a well-formed Windows program. */
interface Layout {
  lfanew: number;
  optional: number;
  numberOfRvaAndSizes: number;
  checksum: number;
  directory: number;
  sizeOfHeaders: number;
}

function layoutOf(bytes: Buffer): Layout {
  const lfanew = bytes.readInt32LE(60);
  const optional = lfanew + 24;
  const plus = bytes.readUInt16LE(optional) === 0x20b;
  return {
    lfanew,
    optional,
    numberOfRvaAndSizes: optional + (plus ? 108 : 92),
    checksum: optional + 64,
    directory: optional + (plus ? 144 : 128),
    sizeOfHeaders: bytes.readUInt32LE(optional + 60),
  };
}

interface Damage {
  name: string;
  from: "unsigned" | "signed";
  damage: (bytes: Buffer, layout: Layout) => Buffer;
}

/** A copy of the bytes with the edit applied. */
function edited(bytes: Buffer, edit: (copy: Buffer) => void): Buffer {
  const copy = Buffer.from(bytes);
  edit(copy);
  return copy;
}

const damages: Damage[] = [
  { name: "check 1: shorter than the DOS header (63 bytes)", from: "unsigned", damage: (b) => b.subarray(0, 63) },
  { name: "check 1: signature is not MZ", from: "unsigned", damage: (b) => edited(b, (c) => c.writeUInt16LE(0x5a5b, 0)) },
  { name: "check 2: e_lfanew is negative", from: "unsigned", damage: (b) => edited(b, (c) => c.writeInt32LE(-16, 60)) },
  { name: "check 3: e_lfanew is past the end of the file", from: "unsigned", damage: (b) => edited(b, (c) => c.writeInt32LE(c.length + 100, 60)) },
  { name: "check 3: truncated at e_lfanew + 25", from: "unsigned", damage: (b, l) => b.subarray(0, l.lfanew + 25) },
  { name: "check 3: the PE signature is wrong", from: "unsigned", damage: (b, l) => edited(b, (c) => c.writeUInt8(0x51, l.lfanew)) },
  { name: "check 3: the optional-header magic is neither 0x10b nor 0x20b", from: "unsigned", damage: (b, l) => edited(b, (c) => c.writeUInt16LE(0x10a, l.optional)) },
  { name: "check 4: NumberOfRvaAndSizes is 4", from: "unsigned", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(4, l.numberOfRvaAndSizes)) },
  { name: "check 4: truncated inside the NumberOfRvaAndSizes field", from: "unsigned", damage: (b, l) => b.subarray(0, l.numberOfRvaAndSizes + 2) },
  { name: "check 6: truncated inside the certificate directory entry", from: "unsigned", damage: (b, l) => b.subarray(0, l.directory + 4) },
  { name: "check 8: the table starts past the end of the file", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(c.length + 16, l.directory)) },
  { name: "check 8: the table reaches past the end of the file", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(c.length, l.directory + 4)) },
  { name: "check 8: address and size overflow 32 bits when added", from: "signed", damage: (b, l) => edited(b, (c) => {
    c.writeUInt32LE(0xfffffff8, l.directory);
    c.writeUInt32LE(0x20, l.directory + 4);
  }) },
  { name: "check 9: the table overlaps the headers", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(l.directory, l.directory)) },
  { name: "check 10: the table is smaller than 8 bytes", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(4, l.directory + 4)) },
  { name: "check 11: truncated inside the WIN_CERTIFICATE header", from: "signed", damage: (b, l) => b.subarray(0, b.readUInt32LE(l.directory) + 4) },
  { name: "check 11: the certificate length is below 8", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(4, c.readUInt32LE(l.directory))) },
  { name: "check 11: the certificate length exceeds the table", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt32LE(c.readUInt32LE(l.directory + 4) + 8, c.readUInt32LE(l.directory))) },
  { name: "check 11: the revision is not 0x0200", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt16LE(0x0100, c.readUInt32LE(l.directory) + 4)) },
  { name: "check 11: the type is not 0x0002", from: "signed", damage: (b, l) => edited(b, (c) => c.writeUInt16LE(0x0001, c.readUInt32LE(l.directory) + 6)) },
];

/** Reads of /proc/self/io are how this process's own read volume is counted. */
function haveProcessIo(): boolean {
  let readable = false;
  try {
    readable = /^rchar:/m.test(fs.readFileSync("/proc/self/io", "utf8"));
  } catch {
    readable = false;
  }
  return optionalExternalCheck("process io accounting", readable, "no /proc/self/io");
}

describe("format detection", () => {
  let scratch: string;
  let signing: Signing;
  let scope: string;
  let signedExe: Buffer;

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "format-detection-")));
    scope = "@test";
    const configDir = path.join(scratch, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ prefix: path.join(scratch, "prefix"), scopes: { [scope]: { author: { name: "Test User", email: "test@test.com", url: "" } } } }, null, 2)
    );
    signing = new Signing(configDir);
    await signing.createCert({ validityDays: 365, scope });
    const signedFile = path.join(scratch, "signed.exe");
    fs.copyFileSync(path.join(binaries, "tiny.exe"), signedFile);
    if (fs.existsSync(componentFile)) {
      await signing.signFile(signedFile, { scope });
    }
    signedExe = fs.readFileSync(signedFile);
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe("Windows programs agree with the digest", () => {
    function windowsSamples(): string[] {
      const found: string[] = [path.join(binaries, "tiny.exe")];
      for (const directory of [path.join(binaries, "genuine"), path.join(binaries, "earlier-form")]) {
        for (const name of fs.readdirSync(directory).sort()) {
          const file = path.join(directory, name);
          const head = fs.readFileSync(file).subarray(0, 2).toString("latin1");
          if (head === "MZ") {
            found.push(file);
          }
        }
      }
      return found;
    }

    it("finds the Windows programs among the fixtures", () => {
      const names = windowsSamples().map((file) => path.relative(binaries, file));
      expect(names).toContain("tiny.exe");
      expect(names).toContain(path.join("earlier-form", "tiny.exe"));
    });

    it("calls each fixture a Windows program exactly when the digest parses it", () => {
      if (!haveComponent()) {
        return;
      }
      for (const file of windowsSamples()) {
        const expected = oracle(file);
        const result = component().detectBinaryFormat(file);
        expect({ file, format: result.format }).toEqual({ file, format: expected === null ? "other" : "pe" });
        expect({ file, subFormat: result.subFormat }).toEqual({ file, subFormat: expected });
      }
    });

    it("calls tiny.exe a PE32+ program", () => {
      if (!haveComponent()) {
        return;
      }
      expect(component().detectBinaryFormat(path.join(binaries, "tiny.exe"))).toEqual({ format: "pe", subFormat: "pe32+" });
    });

    it("calls a signed copy of tiny.exe a Windows program that the digest parses", () => {
      if (!haveComponent()) {
        return;
      }
      const file = path.join(scratch, "signed-check.exe");
      fs.writeFileSync(file, signedExe);
      expect(signedExe.length).toBeGreaterThan(fs.statSync(path.join(binaries, "tiny.exe")).size);
      expect(oracle(file)).toBe("pe32+");
      expect(component().detectBinaryFormat(file)).toEqual({ format: "pe", subFormat: "pe32+" });
    });
  });

  describe("damaged headers", () => {
    it.each(damages.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
      if (!haveComponent()) {
        return;
      }
      const base = entry.from === "signed" ? signedExe : fs.readFileSync(path.join(binaries, "tiny.exe"));
      const bytes = entry.damage(base, layoutOf(base));
      const file = path.join(scratch, "damaged.exe");
      fs.writeFileSync(file, bytes);
      try {
        expect(oracle(file)).toBeNull();
        expect(component().detectBinaryFormat(file)).toEqual({ format: "other", subFormat: null });
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it("calls tiny.exe truncated after its headers a Windows program that the digest parses", () => {
      if (!haveComponent()) {
        return;
      }
      const base = fs.readFileSync(path.join(binaries, "tiny.exe"));
      const file = path.join(scratch, "headers-only.exe");
      fs.writeFileSync(file, base.subarray(0, layoutOf(base).sizeOfHeaders));
      try {
        expect(oracle(file)).toBe("pe32+");
        expect(component().detectBinaryFormat(file)).toEqual({ format: "pe", subFormat: "pe32+" });
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });

  describe("other formats and small files", () => {
    const fixtureResults: Array<[string, Detection]> = [
      ["tiny-macho-x86_64", { format: "macho", subFormat: "macho64" }],
      ["tiny-macho-arm64", { format: "macho", subFormat: "macho64" }],
      ["tiny-macho-universal", { format: "macho", subFormat: "fat" }],
      ["tiny.msi", { format: "msi", subFormat: null }],
      ["plain.txt", { format: "other", subFormat: null }],
    ];

    it.each(fixtureResults)("%s keeps today's result", (name, expected) => {
      if (!haveComponent()) {
        return;
      }
      expect(component().detectBinaryFormat(path.join(binaries, name))).toEqual(expected);
    });

    it.each([
      ["an empty file", Buffer.alloc(0)],
      ["a file of one byte", Buffer.from("M")],
      ["a file holding only MZ", Buffer.from("MZ")],
    ])("%s is other", (_name, bytes) => {
      if (!haveComponent()) {
        return;
      }
      const file = path.join(scratch, "small.bin");
      fs.writeFileSync(file, bytes);
      try {
        expect(component().detectBinaryFormat(file)).toEqual({ format: "other", subFormat: null });
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it("calls a file that cannot be opened other", () => {
      if (!haveComponent()) {
        return;
      }
      expect(component().detectBinaryFormat(path.join(scratch, "does-not-exist"))).toEqual({ format: "other", subFormat: null });
    });
  });

  describe("bounded read", () => {
    const childScript = [
      "const fs = require('fs');",
      "const [componentPath, warmFile, bigFile] = process.argv.slice(1);",
      "const component = require(componentPath);",
      "const rchar = () => Number(/^rchar: (\\d+)/m.exec(fs.readFileSync('/proc/self/io', 'utf8'))[1]);",
      "component.detectBinaryFormat(warmFile);",
      "const before = rchar();",
      "const result = component.detectBinaryFormat(bigFile);",
      "const after = rchar();",
      "process.stdout.write(JSON.stringify({ before, after, result }));",
    ].join("\n");

    it("reads at most 16 KiB to detect a 100 MiB Windows program", () => {
      if (!haveComponent() || !haveProcessIo()) {
        return;
      }
      const bigFile = path.join(scratch, "big.exe");
      fs.copyFileSync(path.join(binaries, "tiny.exe"), bigFile);
      fs.truncateSync(bigFile, 100 * 1024 * 1024);
      try {
        const child = spawnSync(process.execPath, ["-e", childScript, componentFile, path.join(binaries, "tiny.exe"), bigFile], {
          encoding: "utf8",
          env: { ...process.env, HOME: scratch, TMPDIR: scratch },
        });
        expect(child.stderr).toBe("");
        expect(child.status).toBe(0);
        const report = JSON.parse(child.stdout) as { before: number; after: number; result: Detection };
        expect(report.result).toEqual({ format: "pe", subFormat: "pe32+" });
        expect(report.after - report.before).toBeLessThanOrEqual(16 * 1024);
      } finally {
        fs.rmSync(bigFile, { force: true });
      }
    });
  });

  describe("one detection per operation", () => {
    let tempDir: string;
    let spy: jest.SpyInstance;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(scratch, "case-"));
    });

    afterEach(() => {
      if (spy) {
        spy.mockRestore();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // Signable samples: tiny.exe, and the genuine Mac program and installer (the top-level ones are only detection fixtures)
    const signable = {
      "tiny.exe": path.join(binaries, "tiny.exe"),
      "tiny-macho-x86_64": path.join(binaries, "genuine", "tiny-macho-x86_64"),
      "tiny.msi": path.join(binaries, "genuine", "tiny.msi"),
    };
    const signed: Array<[string, string, string]> = [
      ["a Windows program", signable["tiny.exe"], "tiny.exe"],
      ["a Mac program", signable["tiny-macho-x86_64"], "tiny-macho-x86_64"],
      ["an installer", signable["tiny.msi"], "tiny.msi"],
    ];

    it.each(signed)("signing %s asks once", async (_what, source, copyName) => {
      if (!haveComponent()) {
        return;
      }
      const file = path.join(tempDir, copyName);
      fs.copyFileSync(source, file);
      spy = jest.spyOn(component(), "detectBinaryFormat");
      const result = await signing.signFile(file, { scope });
      expect(result.signatureType).toBe("embedded");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it.each(signed)("signing %s detached asks never", async (_what, source, copyName) => {
      if (!haveComponent()) {
        return;
      }
      const file = path.join(tempDir, copyName);
      fs.copyFileSync(source, file);
      spy = jest.spyOn(component(), "detectBinaryFormat");
      const result = await signing.signFile(file, { scope, detached: true });
      expect(result.signatureType).toBe("detached");
      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("verifying a signed Windows program asks once", async () => {
      if (!haveComponent()) {
        return;
      }
      const file = path.join(tempDir, "signed.exe");
      fs.writeFileSync(file, signedExe);
      spy = jest.spyOn(component(), "detectBinaryFormat");
      await signing.verifyFile(file);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("signing a directory asks once for each file signed", async () => {
      if (!haveComponent()) {
        return;
      }
      const directory = path.join(tempDir, "tree");
      fs.mkdirSync(directory);
      fs.copyFileSync(signable["tiny.exe"], path.join(directory, "a.exe"));
      fs.copyFileSync(signable["tiny-macho-x86_64"], path.join(directory, "b"));
      fs.copyFileSync(signable["tiny.msi"], path.join(directory, "c.msi"));
      spy = jest.spyOn(component(), "detectBinaryFormat");
      await signing.signDirectory(directory, { scope });
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });
});
