import fs from "fs";
import os from "os";
import path from "path";
import { groupOutputs, outputKind, placeStaged, readStage, runInstallPhase, signOutputs, stripOutputs } from "../src/InstallPhase";
import Signing from "../src/Signing";
import { findOnPath } from "../src/ProcessRunner";
import { InstallPhaseOptions, InstallPhaseResult, OutputGroup, SigningOutcome } from "../src/types";

// Choices made where the contracts leave a detail open (the implementation matches these):
// - `readStage` and `placeStaged` are synchronous and throw; the two distinguishable errors have
//   `name` "OutsidePrefix" and "NothingStaged".
// - `StagedTree.entries` does not list `root` itself; `relPath` uses "/" separators and siblings
//   are in name order; `mode` is the full `lstat` mode (the tests mask it with 0o7777).
// - The outside-prefix message is `the install step writes outside the prefix <prefix>: <paths>`
//   with the paths in installed form, in name order, at most ten, followed by ` and <n> more`.
// - The nothing-staged message contains `wrote nothing under DESTDIR`.
// - `OutputGroup.file` is the first name in name order that is a regular file; `names` and
//   `links` are compared as sets by these tests.

// - `stripOutputs(groups, target, signal, log)` and `signOutputs(groups, scope, configDir, target, signal, log)`
//   return promises that resolve to nothing the tests use; they reject with the messages of the contract.
//   Both call `Signing` methods on an instance (`removeEmbeddedSignature`, `detectBinaryFormat`, `signFile`),
//   which the tests replace on `Signing.prototype`, so the implementation must not call them as static
//   functions or through a copy of the class.
// - `runInstallPhase` never rejects for these cases. `report.installed` counts every file and link placed
//   (signature files and links included); `report.stripped` and `report.signed[].display` hold the
//   installed paths in the prefix. The fake `make` is found through `options.env.PATH`.
// - The log line of a completed phase is `Installed <n> file(s) into <prefix>`.

const nativeTriplet = "x86_64-linux-gnu";
const windowsTriplet = "x86_64-w64-mingw32";
const specialName = "pre fix 'q;(x)*~";

const scratch: string[] = [];

function makeScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-phase-test-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    // Directories made unwritable by a case must be removable
    const fix = (p: string) => {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        fs.chmodSync(p, 0o755);
        for (const child of fs.readdirSync(p)) {
          fix(path.join(p, child));
        }
      }
    };
    fix(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Hand-made file headers ──────────────────────────────────

function elfHeader(eType: number, extra = ""): Buffer {
  const header = Buffer.alloc(64);
  header.write("\x7fELF", 0, "latin1");
  header[4] = 2; // 64-bit
  header[5] = 1; // little endian
  header[6] = 1; // version
  header.writeUInt16LE(eType, 16);
  header.writeUInt16LE(62, 18); // x86-64
  header.writeUInt32LE(1, 20);
  return Buffer.concat([header, Buffer.from(extra)]);
}

function peHeader(characteristics: number, extra = ""): Buffer {
  const buf = Buffer.alloc(0x200);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf.write("PE\0\0", 0x80, "latin1");
  buf.writeUInt16LE(0x8664, 0x84); // machine
  buf.writeUInt16LE(0xf0, 0x94); // size of optional header
  buf.writeUInt16LE(characteristics, 0x96);
  buf.writeUInt16LE(0x20b, 0x98); // PE32+ optional header magic
  return Buffer.concat([buf, Buffer.from(extra)]);
}

const arArchive = Buffer.from("!<arch>\n" + "libx.o/          0           0     0     644     4         `\nabcd");
const shellScript = Buffer.from("#!/bin/sh\necho hello\n");
const plainText = Buffer.from("just some text\n");

function writeFile(file: string, content: Buffer | string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
}

// ── outputKind ──────────────────────────────────────────────

describe("outputKind", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeScratch();
  });

  function write(name: string, content: Buffer): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  describe("native", () => {
    it("an ELF executable (e_type 2) is elfExecutable", () => {
      expect(outputKind(write("exe", elfHeader(2)), "native")).toBe("elfExecutable");
    });

    it("an ELF shared object (e_type 3) is elfShared", () => {
      expect(outputKind(write("lib.so", elfHeader(3)), "native")).toBe("elfShared");
    });

    it("an ELF object file (e_type 1) is not an output", () => {
      expect(outputKind(write("obj.o", elfHeader(1)), "native")).toBeNull();
    });

    it("an ar archive, a script and text are not outputs", () => {
      expect(outputKind(write("libx.a", arArchive), "native")).toBeNull();
      expect(outputKind(write("run.sh", shellScript), "native")).toBeNull();
      expect(outputKind(write("notes.txt", plainText), "native")).toBeNull();
    });

    it("a PE file is not an output for the native target", () => {
      expect(outputKind(write("tiny.exe", peHeader(0x0022)), "native")).toBeNull();
      expect(outputKind(write("tiny.dll", peHeader(0x2022)), "native")).toBeNull();
    });

    it("a truncated ELF header gives null without throwing", () => {
      expect(outputKind(write("short1", elfHeader(2).subarray(0, 10)), "native")).toBeNull();
      expect(outputKind(write("short2", elfHeader(2).subarray(0, 17)), "native")).toBeNull();
      expect(outputKind(write("magic-only", Buffer.from("\x7fELF", "latin1")), "native")).toBeNull();
    });

    it("an empty file gives null", () => {
      expect(outputKind(write("empty", Buffer.alloc(0)), "native")).toBeNull();
    });
  });

  describe("windows", () => {
    it("a PE with the executable flag and the DLL flag is peLibrary", () => {
      expect(outputKind(write("lib.dll", peHeader(0x2022)), "windows")).toBe("peLibrary");
    });

    it("a PE with the executable flag and without the DLL flag is peProgram", () => {
      expect(outputKind(write("tiny.exe", peHeader(0x0022)), "windows")).toBe("peProgram");
    });

    it("a PE without the executable-image flag (an object) is not an output", () => {
      expect(outputKind(write("obj.obj", peHeader(0x0000)), "windows")).toBeNull();
      expect(outputKind(write("obj-dll.obj", peHeader(0x2000)), "windows")).toBeNull();
    });

    it("an ELF file is not an output for the windows target", () => {
      expect(outputKind(write("exe", elfHeader(2)), "windows")).toBeNull();
      expect(outputKind(write("lib.so", elfHeader(3)), "windows")).toBeNull();
    });

    it("an ar archive, a script and text are not outputs", () => {
      expect(outputKind(write("libx.a", arArchive), "windows")).toBeNull();
      expect(outputKind(write("libx.dll.a", arArchive), "windows")).toBeNull();
      expect(outputKind(write("run.sh", shellScript), "windows")).toBeNull();
      expect(outputKind(write("notes.txt", plainText), "windows")).toBeNull();
    });

    it("an MZ file without the PE signature is not an output", () => {
      const buf = peHeader(0x0022);
      buf.write("XX\0\0", 0x80, "latin1");
      expect(outputKind(write("dos.exe", buf), "windows")).toBeNull();
    });

    it("a truncated PE header gives null without throwing", () => {
      expect(outputKind(write("short1", peHeader(0x0022).subarray(0, 2)), "windows")).toBeNull();
      expect(outputKind(write("short2", peHeader(0x0022).subarray(0, 0x40)), "windows")).toBeNull();
      // The header is announced at 0x80 but the file ends inside it
      expect(outputKind(write("short3", peHeader(0x0022).subarray(0, 0x90)), "windows")).toBeNull();
      // e_lfanew beyond the end of the file
      const far = peHeader(0x0022).subarray(0, 0x100);
      far.writeUInt32LE(0x7ffffff0, 0x3c);
      expect(outputKind(write("short4", Buffer.from(far)), "windows")).toBeNull();
    });
  });

  it("a file that cannot be opened throws naming it", () => {
    const missing = path.join(dir, "does-not-exist.so");
    expect(() => outputKind(missing, "native")).toThrow(missing);
    expect(() => outputKind(missing, "windows")).toThrow(missing);
  });

  it("reads the header of a large file without reading all of it", () => {
    const big = write("big.so", Buffer.concat([elfHeader(3), Buffer.alloc(8 * 1024 * 1024, 1)]));
    expect(outputKind(big, "native")).toBe("elfShared");
  });
});

// ── Stage helpers ───────────────────────────────────────────

interface TestStage {
  base: string;
  stageDir: string;
  configPrefix: string;
  prefix: string;
  root: string;
}

/** A stage for `target` whose configured prefix is `<scratch>/<prefixName>`; the root exists, empty. */
function makeStage(target: "native" | "windows", prefixName = "prefix"): TestStage {
  const base = makeScratch();
  const configPrefix = path.join(base, prefixName);
  const prefix = path.join(configPrefix, target === "native" ? nativeTriplet : windowsTriplet);
  const stageDir = path.join(base, "stage");
  const root = stageDir + prefix;
  fs.mkdirSync(root, { recursive: true });
  return { base, stageDir, configPrefix, prefix, root };
}

const unsigned: SigningOutcome = { kind: "unsigned", reason: "noScope" };
const signed: SigningOutcome = { kind: "signed", scope: "@test" };

// ── readStage ───────────────────────────────────────────────

describe("readStage", () => {
  it("root is the stage plus the prefix and the entries are depth first with directories before their contents", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    writeFile(path.join(s.root, "lib", "libx.so.1.0.0"), elfHeader(3), 0o755);
    fs.symlinkSync("libx.so.1.0.0", path.join(s.root, "lib", "libx.so"));
    writeFile(path.join(s.root, "include", "x.h"), "int x;\n");

    const tree = readStage(s.stageDir, s.configPrefix, "native");

    expect(tree.stageDir).toBe(s.stageDir);
    expect(tree.target).toBe("native");
    expect(tree.prefix).toBe(s.prefix);
    expect(tree.root).toBe(s.root);
    expect(tree.entries.map((e) => [e.relPath, e.type])).toEqual([
      ["bin", "dir"],
      ["bin/tiny", "file"],
      ["include", "dir"],
      ["include/x.h", "file"],
      ["lib", "dir"],
      ["lib/libx.so", "symlink"],
      ["lib/libx.so.1.0.0", "file"],
    ]);
    const link = tree.entries.find((e) => e.relPath === "lib/libx.so");
    expect(link?.linkTarget).toBe("libx.so.1.0.0");
    const tiny = tree.entries.find((e) => e.relPath === "bin/tiny");
    expect((tiny?.mode ?? 0) & 0o7777).toBe(0o755);
    expect(typeof tiny?.dev).toBe("number");
    expect(tiny?.ino).toBe(fs.lstatSync(path.join(s.root, "bin", "tiny")).ino);
  });

  it("finds the target of an incremental build from the stage", () => {
    const native = makeStage("native");
    writeFile(path.join(native.root, "bin", "tiny"), elfHeader(2), 0o755);
    expect(readStage(native.stageDir, native.configPrefix).target).toBe("native");

    const windows = makeStage("windows");
    writeFile(path.join(windows.root, "bin", "tiny.exe"), peHeader(0x22), 0o755);
    const tree = readStage(windows.stageDir, windows.configPrefix);
    expect(tree.target).toBe("windows");
    expect(tree.root).toBe(windows.root);
  });

  it("fails when both target prefixes were installed under", () => {
    const s = makeStage("native");
    const otherRoot = s.stageDir + path.join(s.configPrefix, windowsTriplet);
    writeFile(path.join(s.root, "bin", "a"), elfHeader(2), 0o755);
    writeFile(path.join(otherRoot, "bin", "b.exe"), peHeader(0x22), 0o755);

    expect(() => readStage(s.stageDir, s.configPrefix)).toThrow(/installed under both target prefixes/);
  });

  it("fails with the other-prefix message, naming both prefixes, when neither target root exists", () => {
    const base = makeScratch();
    const stageDir = path.join(base, "stage");
    const configPrefix = path.join(base, "prefix");
    writeFile(stageDir + "/somewhere/else/file", "x");

    let message = "";
    try {
      readStage(stageDir, configPrefix);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("the install step did not install under");
    expect(message).toContain(path.join(configPrefix, nativeTriplet));
    expect(message).toContain(path.join(configPrefix, windowsTriplet));
    expect(message).toContain("configured for another prefix");
    expect(message).toContain("the-seed build native or the-seed build windows");
  });

  it("fails with the other-prefix message when the given target's root does not exist", () => {
    const base = makeScratch();
    const stageDir = path.join(base, "stage");
    fs.mkdirSync(stageDir);
    expect(() => readStage(stageDir, path.join(base, "prefix"), "native")).toThrow(/configured for another prefix/);
  });

  it("a file, a link and a non-empty directory outside the prefix fail as OutsidePrefix, naming the installed paths", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    writeFile(s.stageDir + "/etc/tiny.conf", "x");
    fs.mkdirSync(s.stageDir + "/var", { recursive: true });
    fs.symlinkSync("/nowhere", s.stageDir + "/var/tiny.lnk");
    writeFile(s.stageDir + "/usr/share/tiny/data", "x");

    let error: Error | undefined;
    try {
      readStage(s.stageDir, s.configPrefix, "native");
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.name).toBe("OutsidePrefix");
    expect(error?.message).toContain("the install step writes outside the prefix " + s.prefix);
    expect(error?.message).toContain("/etc/tiny.conf");
    expect(error?.message).toContain("/var/tiny.lnk");
    expect(error?.message).toContain("/usr/share/tiny");
    // Installed form: the stage directory is not part of what is printed
    expect(error?.message).not.toContain(s.stageDir);
  });

  it("names at most ten outside paths and counts the rest", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    for (let i = 1; i <= 12; i++) {
      writeFile(s.stageDir + "/out/f" + String(i).padStart(2, "0"), "x");
    }

    let error: Error | undefined;
    try {
      readStage(s.stageDir, s.configPrefix, "native");
    } catch (err) {
      error = err as Error;
    }
    expect(error?.name).toBe("OutsidePrefix");
    expect(error?.message).toContain("/out/f01");
    expect(error?.message).toContain("/out/f10");
    expect(error?.message).not.toContain("/out/f11");
    expect(error?.message).not.toContain("/out/f12");
    expect(error?.message).toContain("and 2 more");
  });

  it("empty directories outside the prefix and the ancestors of the root are not outside paths", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    fs.mkdirSync(s.stageDir + "/empty/dir", { recursive: true });
    expect(() => readStage(s.stageDir, s.configPrefix, "native")).not.toThrow();
  });

  it("an install that wrote no file or link under the root fails as NothingStaged", () => {
    const s = makeStage("native");
    fs.mkdirSync(path.join(s.root, "bin"), { recursive: true });

    let error: Error | undefined;
    try {
      readStage(s.stageDir, s.configPrefix, "native");
    } catch (err) {
      error = err as Error;
    }
    expect(error?.name).toBe("NothingStaged");
    expect(error?.message).toContain("wrote nothing under DESTDIR");
  });

  it("reads a prefix containing a space, quote, semicolon, parentheses, asterisk and tilde exactly", () => {
    const s = makeStage("native", specialName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);

    const tree = readStage(s.stageDir, s.configPrefix);

    expect(tree.target).toBe("native");
    expect(tree.prefix).toBe(path.join(s.configPrefix, nativeTriplet));
    expect(tree.root).toBe(s.root);
    expect(tree.entries.map((e) => e.relPath)).toEqual(["bin", "bin/tiny"]);
  });
});

// ── groupOutputs ────────────────────────────────────────────

describe("groupOutputs", () => {
  it("a symlink chain is one group holding every name and both links with their readlink text", () => {
    const s = makeStage("native");
    const lib = path.join(s.root, "lib");
    writeFile(path.join(lib, "libx.so.0.0.0"), elfHeader(3), 0o755);
    fs.symlinkSync("libx.so.0.0.0", path.join(lib, "libx.so.0"));
    fs.symlinkSync("libx.so.0", path.join(lib, "libx.so"));

    const groups = groupOutputs(readStage(s.stageDir, s.configPrefix, "native"));

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.kind).toBe("elfShared");
    expect(group.file).toBe(path.join(lib, "libx.so.0.0.0"));
    expect([...group.names].sort()).toEqual(
      [path.join(lib, "libx.so"), path.join(lib, "libx.so.0"), path.join(lib, "libx.so.0.0.0")].sort()
    );
    expect([...group.links].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: path.join(lib, "libx.so"), target: "libx.so.0" },
      { path: path.join(lib, "libx.so.0"), target: "libx.so.0.0.0" },
    ]);
    expect(group.hardLinks).toEqual([]);
    expect(group.display).toBe(path.join(s.prefix, "lib", "libx.so.0.0.0"));
  });

  it("an absolute link target under the configured prefix is mapped into the stage and grouped", () => {
    const s = makeStage("native");
    const lib = path.join(s.root, "lib");
    writeFile(path.join(lib, "liby.so.1"), elfHeader(3), 0o755);
    const absolute = path.join(s.prefix, "lib", "liby.so.1");
    fs.symlinkSync(absolute, path.join(lib, "liby.so"));

    const groups = groupOutputs(readStage(s.stageDir, s.configPrefix, "native"));

    expect(groups).toHaveLength(1);
    expect([...groups[0].names].sort()).toEqual([path.join(lib, "liby.so"), path.join(lib, "liby.so.1")].sort());
    expect(groups[0].links).toEqual([{ path: path.join(lib, "liby.so"), target: absolute }]);
  });

  it("a link pointing outside the stage is not a name of anything", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    // /bin/sh is an ELF file on the machine, but it is not in the stage
    fs.symlinkSync("/bin/sh", path.join(s.root, "bin", "outside"));
    fs.symlinkSync("/nonexistent/target", path.join(s.root, "bin", "dangling"));

    const groups = groupOutputs(readStage(s.stageDir, s.configPrefix, "native"));

    expect(groups).toHaveLength(1);
    expect(groups[0].names).toEqual([path.join(s.root, "bin", "tiny")]);
    expect(groups[0].links).toEqual([]);
  });

  it("hard links are one group, the other names are in hardLinks", () => {
    const s = makeStage("native");
    const bin = path.join(s.root, "bin");
    writeFile(path.join(bin, "tool"), elfHeader(2), 0o755);
    fs.linkSync(path.join(bin, "tool"), path.join(bin, "tool-alias"));
    writeFile(path.join(bin, "other"), elfHeader(2, "different"), 0o755);

    const groups = groupOutputs(readStage(s.stageDir, s.configPrefix, "native"));

    expect(groups).toHaveLength(2);
    const pair = groups.find((g) => g.names.length === 2);
    expect(pair).toBeDefined();
    expect([...(pair?.names ?? [])].sort()).toEqual([path.join(bin, "tool"), path.join(bin, "tool-alias")]);
    expect(pair?.hardLinks).toHaveLength(1);
    expect(pair?.hardLinks).not.toContain(pair?.file);
    expect([pair?.file, ...(pair?.hardLinks ?? [])].sort()).toEqual([path.join(bin, "tool"), path.join(bin, "tool-alias")]);
    expect(pair?.links).toEqual([]);
  });

  it("archives, .la files, scripts, headers, .pc files and object files form no group", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "lib", "libx.a"), arArchive);
    writeFile(path.join(s.root, "lib", "libx.la"), "# libtool library\n");
    writeFile(path.join(s.root, "lib", "x.o"), elfHeader(1));
    writeFile(path.join(s.root, "bin", "run.sh"), shellScript, 0o755);
    writeFile(path.join(s.root, "include", "x.h"), "int x;\n");
    writeFile(path.join(s.root, "lib", "pkgconfig", "x.pc"), "Name: x\n");
    writeFile(path.join(s.root, "bin", "tiny.exe"), peHeader(0x22), 0o755);
    fs.symlinkSync("libx.a", path.join(s.root, "lib", "libx-link.a"));

    expect(groupOutputs(readStage(s.stageDir, s.configPrefix, "native"))).toEqual([]);
  });

  it("windows outputs are grouped by the PE rules", () => {
    const s = makeStage("windows");
    writeFile(path.join(s.root, "bin", "tiny.exe"), peHeader(0x22), 0o755);
    writeFile(path.join(s.root, "bin", "libx-0.dll"), peHeader(0x2022), 0o755);
    writeFile(path.join(s.root, "lib", "libx.dll.a"), arArchive);
    writeFile(path.join(s.root, "bin", "native-file"), elfHeader(2), 0o755);

    const groups = groupOutputs(readStage(s.stageDir, s.configPrefix, "windows"));

    expect(groups.map((g) => [path.basename(g.file), g.kind]).sort()).toEqual([
      ["libx-0.dll", "peLibrary"],
      ["tiny.exe", "peProgram"],
    ]);
  });

  it("display is the installed path in a prefix with special characters", () => {
    const s = makeStage("native", specialName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);

    const groups = groupOutputs(readStage(s.stageDir, s.configPrefix));

    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(path.join(s.root, "bin", "tiny"));
    expect(groups[0].display).toBe(path.join(s.configPrefix, nativeTriplet, "bin", "tiny"));
  });
});

// ── placeStaged (basic rules) ───────────────────────────────

describe.each([
  ["a plain prefix", "prefix"],
  ["a prefix with a space, quote, semicolon, parentheses, asterisk and tilde", specialName],
])("placeStaged in %s", (_title, prefixName) => {
  it("preserves the directory layout, file modes and symlinks with their exact readlink text", () => {
    const s = makeStage("native", prefixName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2, "program"), 0o755);
    writeFile(path.join(s.root, "share", "doc", "readme"), "read me\n", 0o640);
    writeFile(path.join(s.root, "lib", "libx.so.0.0.0"), elfHeader(3, "lib"), 0o755);
    fs.symlinkSync("libx.so.0.0.0", path.join(s.root, "lib", "libx.so.0"));
    fs.symlinkSync("../lib/libx.so.0", path.join(s.root, "share", "libx-link"));
    fs.symlinkSync("/some/absolute target", path.join(s.root, "share", "dangling"));
    fs.chmodSync(path.join(s.root, "share", "doc"), 0o750);
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    placeStaged(tree, groupOutputs(tree), unsigned);

    expect(fs.readFileSync(path.join(s.prefix, "bin", "tiny")).equals(elfHeader(2, "program"))).toBe(true);
    expect(fs.statSync(path.join(s.prefix, "bin", "tiny")).mode & 0o7777).toBe(0o755);
    expect(fs.readFileSync(path.join(s.prefix, "share", "doc", "readme"), "utf8")).toBe("read me\n");
    expect(fs.statSync(path.join(s.prefix, "share", "doc", "readme")).mode & 0o7777).toBe(0o640);
    expect(fs.statSync(path.join(s.prefix, "share", "doc")).mode & 0o7777).toBe(0o750);
    expect(fs.readlinkSync(path.join(s.prefix, "lib", "libx.so.0"))).toBe("libx.so.0.0.0");
    expect(fs.readlinkSync(path.join(s.prefix, "share", "libx-link"))).toBe("../lib/libx.so.0");
    expect(fs.readlinkSync(path.join(s.prefix, "share", "dangling"))).toBe("/some/absolute target");
    expect(fs.lstatSync(path.join(s.prefix, "lib", "libx.so.0")).isSymbolicLink()).toBe(true);
  });

  it("replaces an existing prefix file", () => {
    const s = makeStage("native", prefixName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2, "new"), 0o755);
    writeFile(path.join(s.prefix, "bin", "tiny"), "old contents", 0o644);
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    placeStaged(tree, groupOutputs(tree), unsigned);

    expect(fs.readFileSync(path.join(s.prefix, "bin", "tiny")).equals(elfHeader(2, "new"))).toBe(true);
    expect(fs.statSync(path.join(s.prefix, "bin", "tiny")).mode & 0o7777).toBe(0o755);
  });

  it("creates a missing prefix directory with the staged mode and leaves the mode of an existing one", () => {
    const s = makeStage("native", prefixName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    writeFile(path.join(s.root, "private", "secret"), "s", 0o600);
    fs.chmodSync(path.join(s.root, "private"), 0o700);
    fs.chmodSync(path.join(s.root, "bin"), 0o755);
    // The prefix root and bin exist already, with a mode of their own
    fs.mkdirSync(path.join(s.prefix, "bin"), { recursive: true });
    fs.chmodSync(path.join(s.prefix, "bin"), 0o711);
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    placeStaged(tree, groupOutputs(tree), unsigned);

    expect(fs.statSync(path.join(s.prefix, "private")).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(path.join(s.prefix, "bin")).mode & 0o7777).toBe(0o711);
    expect(fs.existsSync(path.join(s.prefix, "bin", "tiny"))).toBe(true);
  });

  it("places a hard-link group as hard links", () => {
    const s = makeStage("native", prefixName);
    writeFile(path.join(s.root, "bin", "tool"), elfHeader(2), 0o755);
    fs.linkSync(path.join(s.root, "bin", "tool"), path.join(s.root, "bin", "tool-alias"));
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    placeStaged(tree, groupOutputs(tree), unsigned);

    const a = fs.statSync(path.join(s.prefix, "bin", "tool"));
    const b = fs.statSync(path.join(s.prefix, "bin", "tool-alias"));
    expect(a.ino).toBe(b.ino);
    expect(a.dev).toBe(b.dev);
    expect(a.nlink).toBe(2);
  });

  it("places the .sig files and signature links created in the stage after the stage was read, beside their names", () => {
    const s = makeStage("native", prefixName);
    const lib = path.join(s.root, "lib");
    writeFile(path.join(lib, "libx.so.0.0.0"), elfHeader(3), 0o755);
    fs.symlinkSync("libx.so.0.0.0", path.join(lib, "libx.so.0"));
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    const tree = readStage(s.stageDir, s.configPrefix, "native");
    const groups = groupOutputs(tree);
    // Signing writes these into the stage after the stage was read
    writeFile(path.join(lib, "libx.so.0.0.0.sig"), "signature of the library");
    fs.symlinkSync("libx.so.0.0.0.sig", path.join(lib, "libx.so.0.sig"));
    writeFile(path.join(s.root, "bin", "tiny.sig"), "signature of the program");
    expect(tree.entries.some((e) => e.relPath.endsWith(".sig"))).toBe(false);

    placeStaged(tree, groups, signed);

    expect(fs.readFileSync(path.join(s.prefix, "lib", "libx.so.0.0.0.sig"), "utf8")).toBe("signature of the library");
    expect(fs.lstatSync(path.join(s.prefix, "lib", "libx.so.0.sig")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(s.prefix, "lib", "libx.so.0.sig"))).toBe("libx.so.0.0.0.sig");
    expect(fs.readFileSync(path.join(s.prefix, "bin", "tiny.sig"), "utf8")).toBe("signature of the program");
  });

  it("leaves files in the prefix that the stage does not contain untouched", () => {
    const s = makeStage("native", prefixName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    writeFile(path.join(s.prefix, "bin", "other"), "other program", 0o755);
    writeFile(path.join(s.prefix, "share", "keep.txt"), "keep", 0o600);
    fs.symlinkSync("keep.txt", path.join(s.prefix, "share", "keep-link"));
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    placeStaged(tree, groupOutputs(tree), unsigned);

    expect(fs.readFileSync(path.join(s.prefix, "bin", "other"), "utf8")).toBe("other program");
    expect(fs.readFileSync(path.join(s.prefix, "share", "keep.txt"), "utf8")).toBe("keep");
    expect(fs.statSync(path.join(s.prefix, "share", "keep.txt")).mode & 0o7777).toBe(0o600);
    expect(fs.readlinkSync(path.join(s.prefix, "share", "keep-link"))).toBe("keep.txt");
  });

  it("moves the files out of the stage", () => {
    const s = makeStage("native", prefixName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    placeStaged(tree, groupOutputs(tree), unsigned);

    expect(fs.existsSync(path.join(s.root, "bin", "tiny"))).toBe(false);
  });
});

describe("placeStaged errors", () => {
  it("names the destination as `cannot place <path>: <reason>`", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "lib", "libx.so.0.0.0"), elfHeader(3), 0o755);
    // A regular file stands where the staged directory has to be created
    writeFile(path.join(s.prefix, "lib"), "not a directory");
    const tree = readStage(s.stageDir, s.configPrefix, "native");

    let message = "";
    try {
      placeStaged(tree, groupOutputs(tree), unsigned);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^cannot place /);
    expect(message).toContain(path.join(s.prefix, "lib"));
    expect(message).toMatch(/^cannot place .+: .+/);
  });
});


// ── Fake tools ──────────────────────────────────────────────

const originalPath = process.env.PATH ?? "";

function readLines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
}

function octal(mode: number): string {
  return (mode & 0o7777).toString(8);
}

interface FakeStripOptions {
  /** The tool prints this on stderr and exits 1 */
  failWith?: string;
  /** The tool records the mode of the file it was given */
  recordMode?: boolean;
  /** The tool replaces the file by a copy, as the real tool does (a new inode) */
  replaceFile?: boolean;
  /** The tool overwrites the file with bytes that are no program */
  corrupt?: boolean;
}

/** Writes a recording strip tool under both target names; returns the file its calls are recorded in. */
function installFakeStrip(binDir: string, options: FakeStripOptions = {}): string {
  const log = path.join(binDir, "strip-calls.log");
  const lines = [
    "#!/bin/sh",
    "{",
    "  printf 'call\\n'",
    "  for a in \"$@\"; do printf 'arg:%s\\n' \"$a\"; done",
    options.recordMode ? "  printf 'mode:%s\\n' \"$(stat -c %a \"$2\")\"" : "",
    "} >> '" + log + "'",
    options.failWith ? "echo '" + options.failWith + "' >&2; exit 1" : "",
    options.replaceFile ? "cp \"$2\" \"$2.replacing\" && mv \"$2.replacing\" \"$2\"" : "",
    options.corrupt ? "printf 'garbage' > \"$2\"" : "",
    "exit 0",
    "",
  ];
  for (const name of ["strip", "x86_64-w64-mingw32-strip"]) {
    const tool = path.join(binDir, name);
    fs.writeFileSync(tool, lines.join("\n"));
    fs.chmodSync(tool, 0o755);
  }
  return log;
}

/** The files each recorded strip call was given, in order. */
function strippedFiles(log: string): string[] {
  return readLines(log)
    .filter((line) => line.startsWith("arg:") && line !== "arg:--strip-unneeded")
    .map((line) => line.slice(4));
}

function putOnPath(dir: string): void {
  process.env.PATH = dir + path.delimiter + originalPath;
}

/** A directory that holds no tool, used as the whole PATH. */
function useEmptyPath(): void {
  process.env.PATH = makeScratch();
}

afterEach(() => {
  process.env.PATH = originalPath;
  jest.restoreAllMocks();
});

/** The tests make PE files by hand; the addon does not have to recognise them. */
function recognisePeByMagic(): jest.SpyInstance {
  jest.spyOn(Signing.prototype, "removeEmbeddedSignature").mockReturnValue(false);
  return jest.spyOn(Signing.prototype, "detectBinaryFormat").mockImplementation((file: string) => {
    const head = fs.readFileSync(file).subarray(0, 2).toString("latin1");
    return { format: head === "MZ" ? "pe" : "other", subFormat: null };
  });
}

function groupsOf(s: TestStage, target: "native" | "windows"): OutputGroup[] {
  return groupOutputs(readStage(s.stageDir, s.configPrefix, target));
}

// ── stripOutputs ────────────────────────────────────────────

describe("stripOutputs", () => {
  let binDir: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);

  beforeEach(() => {
    binDir = makeScratch();
    lines = [];
  });

  it("with no groups looks up no tool and logs no lines, even with an empty PATH", async () => {
    useEmptyPath();
    await expect(stripOutputs([], "native", undefined, log)).resolves.toBeUndefined();
    await expect(stripOutputs([], "windows", undefined, log)).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it.each([
    ["native", "strip", "Install binutils (for example the binutils package) and try again."],
    ["windows", "x86_64-w64-mingw32-strip", "Install the MinGW binutils package (e.g., binutils-mingw-w64-x86-64) and try again."],
  ] as const)("reports a missing %s tool before any file is touched, with special characters in the paths", async (target, tool, hint) => {
    recognisePeByMagic();
    const s = makeStage(target, specialName);
    const program = target === "native" ? elfHeader(2, "program") : peHeader(0x22, "program");
    const file = path.join(s.root, "bin", "tiny");
    writeFile(file, program, 0o444);
    const groups = groupsOf(s, target);
    const before = fs.readFileSync(file);
    useEmptyPath();

    let message = "";
    try {
      await stripOutputs(groups, target, undefined, log);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("Strip tool '" + tool + "' not found on this system.");
    expect(message).toContain(hint);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o444);
    expect(lines).toEqual([]);
  });

  it("finds the tool through findOnPath and runs it with exactly the strip flag and the path, without a shell", async () => {
    const calls = installFakeStrip(binDir);
    putOnPath(binDir);
    expect(findOnPath("strip")).toBe(path.join(binDir, "strip"));
    // Characters a shell would expand or split
    const s = makeStage("native", specialName);
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    const groups = groupsOf(s, "native");

    await stripOutputs(groups, "native", undefined, log);

    expect(readLines(calls)).toEqual(["call", "arg:--strip-unneeded", "arg:" + path.join(s.root, "bin", "tiny")]);
  });

  it("strips each group once: a symlink chain and a hard-link pair are one call each", async () => {
    const calls = installFakeStrip(binDir);
    putOnPath(binDir);
    const s = makeStage("native");
    const lib = path.join(s.root, "lib");
    writeFile(path.join(lib, "libx.so.0.0.0"), elfHeader(3), 0o755);
    fs.symlinkSync("libx.so.0.0.0", path.join(lib, "libx.so.0"));
    fs.symlinkSync("libx.so.0", path.join(lib, "libx.so"));
    writeFile(path.join(s.root, "bin", "tool"), elfHeader(2, "tool"), 0o755);
    fs.linkSync(path.join(s.root, "bin", "tool"), path.join(s.root, "bin", "tool-alias"));
    const groups = groupsOf(s, "native");
    expect(groups).toHaveLength(2);

    await stripOutputs(groups, "native", undefined, log);

    expect(strippedFiles(calls).sort()).toEqual(groups.map((g) => g.file).sort());
    expect(readLines(calls).filter((line) => line === "call")).toHaveLength(2);
  });

  it("uses the mingw tool for the windows target", async () => {
    recognisePeByMagic();
    const calls = installFakeStrip(binDir);
    putOnPath(binDir);
    const s = makeStage("windows");
    writeFile(path.join(s.root, "bin", "tiny.exe"), peHeader(0x22), 0o755);

    await stripOutputs(groupsOf(s, "windows"), "windows", undefined, log);

    expect(lines[0]).toBe("Using strip tool: x86_64-w64-mingw32-strip");
    expect(strippedFiles(calls)).toEqual([path.join(s.root, "bin", "tiny.exe")]);
  });

  it("throws `strip failed on <display>: <message>` when the tool fails", async () => {
    installFakeStrip(binDir, { failWith: "File format not recognized" });
    putOnPath(binDir);
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2), 0o755);
    const groups = groupsOf(s, "native");

    let message = "";
    try {
      await stripOutputs(groups, "native", undefined, log);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message.startsWith("strip failed on " + path.join(s.prefix, "bin", "tiny") + ": ")).toBe(true);
    expect(message).toContain("File format not recognized");
    expect(lines.some((line) => line.startsWith("Stripped "))).toBe(false);
  });

  it("throws `Strip cancelled` when the signal is aborted between files and strips no further file", async () => {
    const calls = installFakeStrip(binDir);
    putOnPath(binDir);
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "a"), elfHeader(2, "a"), 0o755);
    writeFile(path.join(s.root, "bin", "b"), elfHeader(2, "b"), 0o755);
    const groups = groupsOf(s, "native");
    const controller = new AbortController();

    await expect(
      stripOutputs(groups, "native", controller.signal, (line) => {
        lines.push(line);
        if (line.startsWith("Stripping ") && line.endsWith("done")) {
          controller.abort();
        }
      })
    ).rejects.toThrow("Strip cancelled");

    expect(strippedFiles(calls)).toEqual([path.join(s.root, "bin", "a")]);
  });

  it("gives a read-only file owner write for the strip and its mode back", async () => {
    const calls = installFakeStrip(binDir, { recordMode: true });
    putOnPath(binDir);
    const s = makeStage("native");
    const file = path.join(s.root, "bin", "tiny");
    writeFile(file, elfHeader(2), 0o555);

    await stripOutputs(groupsOf(s, "native"), "native", undefined, log);

    const recorded = readLines(calls).find((line) => line.startsWith("mode:"))!;
    expect(parseInt(recorded.slice(5), 8) & 0o200).not.toBe(0);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o555);
  });

  it("gives a read-only file its mode back also when the tool fails", async () => {
    installFakeStrip(binDir, { failWith: "no" });
    putOnPath(binDir);
    const s = makeStage("native");
    const file = path.join(s.root, "bin", "tiny");
    writeFile(file, elfHeader(2), 0o555);

    await expect(stripOutputs(groupsOf(s, "native"), "native", undefined, log)).rejects.toThrow("strip failed on");

    expect(fs.statSync(file).mode & 0o7777).toBe(0o555);
  });

  it("makes a read-only PE with an embedded signature writable before its signature is removed, and removes it before the tool runs", async () => {
    const detect = recognisePeByMagic();
    const calls = installFakeStrip(binDir, { recordMode: true });
    putOnPath(binDir);
    const s = makeStage("windows");
    const file = path.join(s.root, "bin", "tiny.exe");
    writeFile(file, peHeader(0x22, "signed"), 0o555);
    const groups = groupsOf(s, "windows");
    const remove = jest.spyOn(Signing.prototype, "removeEmbeddedSignature").mockImplementation((target: string) => {
      fs.appendFileSync(calls, "remove:" + octal(fs.statSync(target).mode) + "\n");
      return true;
    });

    await stripOutputs(groups, "windows", undefined, log);

    expect(remove).toHaveBeenCalledWith(file);
    const recorded = readLines(calls);
    expect(recorded[0].startsWith("remove:")).toBe(true);
    expect(parseInt(recorded[0].slice(7), 8) & 0o200).not.toBe(0);
    expect(recorded.indexOf("call")).toBeGreaterThan(0);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o555);
    expect(detect).toHaveBeenCalled();
  });

  it("throws when a PE is no longer a PE after stripping", async () => {
    recognisePeByMagic();
    installFakeStrip(binDir, { corrupt: true });
    putOnPath(binDir);
    const s = makeStage("windows");
    writeFile(path.join(s.root, "bin", "tiny.exe"), peHeader(0x22), 0o755);
    const groups = groupsOf(s, "windows");

    await expect(stripOutputs(groups, "windows", undefined, log)).rejects.toThrow(
      "strip failed on " + path.join(s.prefix, "bin", "tiny.exe") + ": the result is not a valid PE file"
    );
  });

  it("re-creates a hard link the tool broke", async () => {
    const calls = installFakeStrip(binDir, { replaceFile: true });
    putOnPath(binDir);
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tool"), elfHeader(2, "tool"), 0o755);
    fs.linkSync(path.join(s.root, "bin", "tool"), path.join(s.root, "bin", "tool-alias"));
    const groups = groupsOf(s, "native");
    expect(groups).toHaveLength(1);

    await stripOutputs(groups, "native", undefined, log);

    expect(readLines(calls).filter((line) => line === "call")).toHaveLength(1);
    const a = fs.statSync(path.join(s.root, "bin", "tool"));
    const b = fs.statSync(path.join(s.root, "bin", "tool-alias"));
    expect(a.ino).toBe(b.ino);
    expect(a.nlink).toBe(2);
  });

  it("reports the tool, each file and the count through the line logger", async () => {
    installFakeStrip(binDir);
    putOnPath(binDir);
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "a"), elfHeader(2, "a"), 0o755);
    writeFile(path.join(s.root, "bin", "b"), elfHeader(2, "b"), 0o755);
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

    await stripOutputs(groupsOf(s, "native"), "native", undefined, log);

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "Using strip tool: strip",
      "Stripping " + path.join(s.prefix, "bin", "a") + "... done",
      "Stripping " + path.join(s.prefix, "bin", "b") + "... done",
      "Stripped 2 file(s)",
    ]);
  });
});

// ── A scratch certificate ───────────────────────────────────

describe("with a scratch certificate", () => {
  const scope = "@t";
  let certDir: string;

  beforeAll(async () => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-phase-cert-"));
    fs.writeFileSync(
      path.join(certDir, "config.json"),
      JSON.stringify({ prefix: "/unused", scopes: { [scope]: { author: { name: "Test User", email: "t@example.invalid", url: "" } } } })
    );
    await new Signing(certDir).createCert({ validityDays: 365, scope });
  });

  afterAll(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  // ── signOutputs ───────────────────────────────────────────

  describe("signOutputs", () => {
    let lines: string[];
    const log = (line: string) => lines.push(line);

    beforeEach(() => {
      lines = [];
    });

    /** A native stage with a library (a link chain), a program and a hard-link pair. */
    function nativeStage(): TestStage {
      const s = makeStage("native");
      const lib = path.join(s.root, "lib");
      writeFile(path.join(lib, "libx.so.0.0.0"), elfHeader(3, "lib"), 0o755);
      fs.symlinkSync("libx.so.0.0.0", path.join(lib, "libx.so.0"));
      fs.symlinkSync("libx.so.0", path.join(lib, "libx.so"));
      writeFile(path.join(s.root, "bin", "tool"), elfHeader(2, "tool"), 0o755);
      fs.linkSync(path.join(s.root, "bin", "tool"), path.join(s.root, "bin", "tool-alias"));
      return s;
    }

    it("signs each group once with a detached signature and gives every link name a signature link", async () => {
      const s = nativeStage();
      const groups = groupsOf(s, "native");
      const signFile = jest.spyOn(Signing.prototype, "signFile");
      const lib = path.join(s.root, "lib");
      const bin = path.join(s.root, "bin");

      await signOutputs(groups, scope, certDir, "native", undefined, log);

      expect(signFile).toHaveBeenCalledTimes(2);
      expect(signFile.mock.calls.map((call) => call[0]).sort()).toEqual(groups.map((g) => g.file).sort());
      for (const call of signFile.mock.calls) {
        expect(call[1]).toEqual(expect.objectContaining({ scope }));
      }
      expect(fs.lstatSync(path.join(lib, "libx.so.0.0.0.sig")).isFile()).toBe(true);
      expect(fs.lstatSync(path.join(lib, "libx.so.0.sig")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(lib, "libx.so.0.sig"))).toBe("libx.so.0.0.0.sig");
      expect(fs.lstatSync(path.join(lib, "libx.so.sig")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(lib, "libx.so.sig"))).toBe("libx.so.0.sig");
      const tool = groups.find((g) => g.hardLinks.length === 1)!;
      const names = [path.join(bin, "tool"), path.join(bin, "tool-alias")];
      const ino = names.map((name) => fs.statSync(name + ".sig").ino);
      expect(ino[0]).toBe(ino[1]);
      expect(fs.lstatSync(names[0] + ".sig").isSymbolicLink()).toBe(false);
      expect(tool.names.sort()).toEqual(names);
    });

    it("replaces a signature file or link that is already there", async () => {
      const s = nativeStage();
      const groups = groupsOf(s, "native");
      const lib = path.join(s.root, "lib");
      const bin = path.join(s.root, "bin");
      writeFile(path.join(lib, "libx.so.0.sig"), "stale file");
      fs.symlinkSync("elsewhere", path.join(lib, "libx.so.sig"));
      writeFile(path.join(bin, "tool-alias.sig"), "stale");

      await signOutputs(groups, scope, certDir, "native", undefined, log);

      expect(fs.readlinkSync(path.join(lib, "libx.so.0.sig"))).toBe("libx.so.0.0.0.sig");
      expect(fs.readlinkSync(path.join(lib, "libx.so.sig"))).toBe("libx.so.0.sig");
      expect(fs.readFileSync(path.join(bin, "tool-alias.sig"), "utf8")).toBe(fs.readFileSync(path.join(bin, "tool.sig"), "utf8"));
      expect(fs.statSync(path.join(bin, "tool-alias.sig")).ino).toBe(fs.statSync(path.join(bin, "tool.sig")).ino);
    });

    it("leaves every name of every group verifying VALID", async () => {
      const s = nativeStage();
      const groups = groupsOf(s, "native");

      await signOutputs(groups, scope, certDir, "native", undefined, log);

      const signing = new Signing(certDir);
      const names = groups.flatMap((g) => g.names);
      expect(names).toHaveLength(5);
      for (const name of names) {
        const result = await signing.verifyFile(name);
        expect([name, result.status, result.reason]).toEqual([name, "VALID", undefined]);
      }
    });

    it("gives a read-only file its mode back", async () => {
      const s = makeStage("native");
      const file = path.join(s.root, "bin", "tiny");
      writeFile(file, elfHeader(2, "ro"), 0o555);

      await signOutputs(groupsOf(s, "native"), scope, certDir, "native", undefined, log);

      expect(fs.statSync(file).mode & 0o7777).toBe(0o555);
      expect(fs.existsSync(file + ".sig")).toBe(true);
      expect((await new Signing(certDir).verifyFile(file)).status).toBe("VALID");
    });

    it("makes a hard-link pair one inode again after a signature that replaces the file", async () => {
      recognisePeByMagic();
      const s = makeStage("windows");
      const bin = path.join(s.root, "bin");
      writeFile(path.join(bin, "tool.exe"), peHeader(0x22, "tool"), 0o755);
      fs.linkSync(path.join(bin, "tool.exe"), path.join(bin, "tool-alias.exe"));
      const groups = groupsOf(s, "windows");
      expect(groups).toHaveLength(1);
      // As the library does for an embedded signature: the file is replaced, so other names no longer share it
      jest.spyOn(Signing.prototype, "signFile").mockImplementation(async (file: string) => {
        const replacement = file + ".new";
        fs.writeFileSync(replacement, peHeader(0x22, "signed"));
        fs.renameSync(replacement, file);
        return { filePath: file, signaturePath: null, fingerprint: "SHA256:x", signatureType: "embedded", warnings: [] };
      });

      await signOutputs(groups, scope, certDir, "windows", undefined, log);

      const a = fs.statSync(path.join(bin, "tool.exe"));
      const b = fs.statSync(path.join(bin, "tool-alias.exe"));
      expect(a.ino).toBe(b.ino);
      expect(a.nlink).toBe(2);
      expect(fs.readFileSync(path.join(bin, "tool-alias.exe")).equals(peHeader(0x22, "signed"))).toBe(true);
      expect(fs.existsSync(path.join(bin, "tool.exe.sig"))).toBe(false);
    });

    it("logs `Signed (detached): <display> → <basename>.sig` and the count", async () => {
      const s = nativeStage();
      const groups = groupsOf(s, "native");

      await signOutputs(groups, scope, certDir, "native", undefined, log);

      const display = (file: string) => groups.find((g) => g.file === file)!.display;
      const lib = path.join(s.root, "lib", "libx.so.0.0.0");
      const tool = groups.find((g) => g.hardLinks.length === 1)!.file;
      expect(lines).toEqual([
        "Signed (detached): " + display(tool) + " → " + path.basename(tool) + ".sig",
        "Signed (detached): " + display(lib) + " → libx.so.0.0.0.sig",
        "Auto-signed 2 file(s) using scope '@t'",
      ]);
    });

    it("logs `Signed (embedded): <display>` for an embedded result of a windows output", async () => {
      recognisePeByMagic();
      const s = makeStage("windows");
      const file = path.join(s.root, "bin", "tiny.exe");
      writeFile(file, peHeader(0x22), 0o755);
      jest.spyOn(Signing.prototype, "signFile").mockResolvedValue({
        filePath: file,
        signaturePath: null,
        fingerprint: "SHA256:x",
        signatureType: "embedded",
        warnings: [],
      });

      await signOutputs(groupsOf(s, "windows"), scope, certDir, "windows", undefined, log);

      expect(lines).toEqual([
        "Signed (embedded): " + path.join(s.prefix, "bin", "tiny.exe"),
        "Auto-signed 1 file(s) using scope '@t'",
      ]);
      expect(fs.existsSync(file + ".sig")).toBe(false);
    });
  });
});

// ── runInstallPhase ─────────────────────────────────────────

describe("runInstallPhase", () => {
  const scope = "@t";
  let certDir: string;

  beforeAll(async () => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-phase-run-cert-"));
    fs.writeFileSync(
      path.join(certDir, "config.json"),
      JSON.stringify({ prefix: "/unused", scopes: { [scope]: { author: { name: "Test User", email: "t@example.invalid", url: "" } } } })
    );
    await new Signing(certDir).createCert({ validityDays: 365, scope });
  });

  afterAll(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  interface PhaseCase {
    base: string;
    configPrefix: string;
    prefix: string;
    /** What the fake make copies into the stage, laid out under the real prefix path */
    payloadRoot: string;
    makeDir: string;
    makeRecord: string;
    stripDir: string;
    stripLog: string;
    projectDir: string;
    emptyConfigDir: string;
    lines: string[];
  }

  function makeCase(target: "native" | "windows", prefixName = "prefix"): PhaseCase {
    const base = makeScratch();
    const configPrefix = path.join(base, prefixName);
    const prefix = path.join(configPrefix, target === "native" ? nativeTriplet : windowsTriplet);
    const makeDir = path.join(base, "make-bin");
    const stripDir = path.join(base, "strip-bin");
    fs.mkdirSync(makeDir);
    fs.mkdirSync(stripDir);
    const projectDir = path.join(base, "project");
    fs.mkdirSync(projectDir);
    const emptyConfigDir = path.join(base, "empty-config");
    fs.mkdirSync(emptyConfigDir);
    const c: PhaseCase = {
      base,
      configPrefix,
      prefix,
      payloadRoot: path.join(base, "payload"),
      makeDir,
      makeRecord: path.join(base, "make-args.log"),
      stripDir,
      stripLog: installFakeStrip(stripDir),
      projectDir,
      emptyConfigDir,
      lines: [],
    };
    putOnPath(stripDir);
    return c;
  }

  /** Writes a file the fake make will install, relative to the prefix. */
  function payload(c: PhaseCase, rel: string, content: Buffer | string, mode = 0o755): string {
    const file = path.join(c.payloadRoot + c.prefix, rel);
    writeFile(file, content, mode);
    return file;
  }

  /** Puts a `make` on a directory the case's env names; `DESTDIR` is read from its arguments. */
  function fakeMake(c: PhaseCase, failWith?: string): void {
    const script = [
      "#!/bin/sh",
      "stage=\"\"",
      "for a in \"$@\"; do case \"$a\" in DESTDIR=*) stage=\"${a#DESTDIR=}\";; esac; done",
      "{",
      "  for a in \"$@\"; do printf 'arg:%s\\n' \"$a\"; done",
      "  printf 'stage:%s\\n' \"$stage\"",
      "  printf 'stagemode:%s\\n' \"$(stat -c %a \"$stage\")\"",
      "  printf 'envdestdir:%s\\n' \"${DESTDIR-unset}\"",
      "} > '" + c.makeRecord + "'",
      failWith ? "echo '" + failWith + "' >&2; exit 2" : "cp -a '" + c.payloadRoot + "'/. \"$stage\"/",
      "",
    ].join("\n");
    const make = path.join(c.makeDir, "make");
    fs.writeFileSync(make, script);
    fs.chmodSync(make, 0o755);
  }

  function options(c: PhaseCase, extra: Partial<InstallPhaseOptions> = {}): InstallPhaseOptions {
    return {
      projectDir: c.projectDir,
      configPrefix: c.configPrefix,
      configDir: c.emptyConfigDir,
      target: "native",
      release: false,
      installStep: { label: "install", program: "make", args: ["install"] },
      env: { PATH: c.makeDir + path.delimiter + originalPath, HOME: c.base },
      output: { mode: "capture" },
      log: (line) => c.lines.push(line),
      ...extra,
    };
  }

  function markSigned(c: PhaseCase): void {
    fs.writeFileSync(path.join(c.projectDir, "package.json"), JSON.stringify({ name: "@t/proj" }));
  }

  /** The values the fake make recorded */
  function recorded(c: PhaseCase): Record<string, string> & { args: string } {
    const out: Record<string, string> = {};
    const args: string[] = [];
    for (const line of readLines(c.makeRecord)) {
      if (line.startsWith("arg:")) {
        args.push(line.slice(4));
      } else {
        const colon = line.indexOf(":");
        out[line.slice(0, colon)] = line.slice(colon + 1);
      }
    }
    return Object.assign(out, { args: JSON.stringify(args) }) as Record<string, string> & { args: string };
  }

  function expectCompleted(result: InstallPhaseResult): Extract<InstallPhaseResult, { status: "completed" }> {
    if (result.status !== "completed") {
      throw new Error("expected completed, got " + JSON.stringify(result));
    }
    return result;
  }

  it("appends DESTDIR=<stage> as the last install argument, with the stage under .the-seed-staging with mode 0700 and no DESTDIR in the environment", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    const seen = recorded(c);
    const args = JSON.parse(seen.args) as string[];
    expect(args.slice(0, -1)).toEqual(["install"]);
    expect(args[args.length - 1]).toBe("DESTDIR=" + seen.stage);
    expect(path.dirname(seen.stage)).toBe(path.join(c.configPrefix, ".the-seed-staging"));
    expect(path.basename(seen.stage).startsWith("stage-")).toBe(true);
    expect(seen.stagemode).toBe("700");
    expect(seen.envdestdir).toBe("unset");
  });

  it("moves the staged files into the prefix", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2, "program"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "lib"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    payload(c, "include/x.h", "int x;\n", 0o644);
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny")).equals(elfHeader(2, "program"))).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "lib", "libx.so.0.0.0")).equals(elfHeader(3, "lib"))).toBe(true);
    expect(fs.readlinkSync(path.join(c.prefix, "lib", "libx.so.0"))).toBe("libx.so.0.0.0");
    expect(fs.readFileSync(path.join(c.prefix, "include", "x.h"), "utf8")).toBe("int x;\n");
  });

  it("works for a prefix with a space, quote, semicolon, parentheses, asterisk and tilde", async () => {
    const c = makeCase("native", specialName);
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    expect(fs.existsSync(path.join(c.configPrefix, nativeTriplet, "bin", "tiny"))).toBe(true);
  });

  it("removes the stage and the empty .the-seed-staging after success", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    expect(fs.existsSync(recorded(c).stage)).toBe(false);
    expect(fs.existsSync(path.join(c.configPrefix, ".the-seed-staging"))).toBe(false);
  });

  it("calls onInstalled once, after the install step and before anything is placed", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);
    const seen: boolean[] = [];

    expectCompleted(
      await runInstallPhase(
        options(c, {
          onInstalled: () => seen.push(fs.existsSync(c.makeRecord) && !fs.existsSync(path.join(c.prefix, "bin", "tiny"))),
        })
      )
    );

    expect(seen).toEqual([true]);
  });

  it("strips the staged outputs with release and a target", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3));
    payload(c, "include/x.h", "int x;\n", 0o644);
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true })));

    const stage = recorded(c).stage;
    expect(strippedFiles(c.stripLog).sort()).toEqual(
      [path.join(stage + c.prefix, "bin", "tiny"), path.join(stage + c.prefix, "lib", "libx.so.0.0.0")].sort()
    );
    expect(result.report.stripped.sort()).toEqual([path.join(c.prefix, "bin", "tiny"), path.join(c.prefix, "lib", "libx.so.0.0.0")].sort());
    expect(c.lines).toContain("Stripped 2 file(s)");
  });

  it("does not strip with release and no target (an incremental build)", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true, target: undefined })));

    expect(readLines(c.stripLog)).toEqual([]);
    expect(result.report.stripped).toEqual([]);
    expect(c.lines.some((line) => line.includes("Stripping") || line.includes("strip tool"))).toBe(false);
  });

  it("does not strip without release", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c, { release: false })));

    expect(readLines(c.stripLog)).toEqual([]);
  });

  it("signs with a scope that has a valid certificate, placing the signatures beside the installed files", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "bin/tiny", elfHeader(2, "program"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "lib"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { configDir: certDir })));

    const signing = new Signing(certDir);
    for (const rel of ["bin/tiny", "lib/libx.so.0.0.0", "lib/libx.so.0"]) {
      expect(fs.existsSync(path.join(c.prefix, rel + ".sig"))).toBe(true);
      expect((await signing.verifyFile(path.join(c.prefix, rel))).status).toBe("VALID");
    }
    expect(fs.readlinkSync(path.join(c.prefix, "lib", "libx.so.0.sig"))).toBe("libx.so.0.0.0.sig");
    expect(result.report.outcome).toEqual({ kind: "signed", scope });
    expect(result.report.signed.map((entry) => entry.display).sort()).toEqual(
      [path.join(c.prefix, "bin", "tiny"), path.join(c.prefix, "lib", "libx.so.0.0.0")].sort()
    );
    for (const entry of result.report.signed) {
      expect(entry.form).toBe("detached");
    }
    expect(c.lines).toContain("Auto-signed 2 file(s) using scope '@t'");
  });

  it("installs unsigned when the project has no package.json, no scope or no certificate", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c);

    // No package.json
    let result = expectCompleted(await runInstallPhase(options(c, { configDir: certDir })));
    expect(result.report.outcome.kind).toBe("unsigned");
    expect(fs.existsSync(path.join(c.prefix, "bin", "tiny"))).toBe(true);
    expect(fs.existsSync(path.join(c.prefix, "bin", "tiny.sig"))).toBe(false);

    // A scope without a certificate
    fs.writeFileSync(path.join(c.projectDir, "package.json"), JSON.stringify({ name: "@nocert/proj" }));
    result = expectCompleted(await runInstallPhase(options(c, { configDir: certDir })));
    expect(result.report.outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "noCertificate" }));
    expect(fs.existsSync(path.join(c.prefix, "bin", "tiny.sig"))).toBe(false);
    expect(result.report.signed).toEqual([]);
  });

  it("logs `Installed <n> file(s) into <prefix>` with the number of files and links placed", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    payload(c, "include/x.h", "int x;\n", 0o644);
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c)));

    expect(c.lines[c.lines.length - 1]).toBe("Installed 4 file(s) into " + c.prefix);
    expect(result.report.installed).toBe(4);
    expect(result.report.prefix).toBe(c.prefix);
  });

  it("finds the target of an incremental build from the stage", async () => {
    const c = makeCase("windows");
    payload(c, "bin/tiny.exe", peHeader(0x22));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { target: undefined })));

    expect(result.report.prefix).toBe(c.prefix);
    expect(fs.existsSync(path.join(c.prefix, "bin", "tiny.exe"))).toBe(true);
  });

  it("places the .sig files the install step staged beside their names", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    payload(c, "bin/tiny.sig", "a signature the install step wrote", 0o644);
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny.sig"), "utf8")).toBe("a signature the install step wrote");
  });

  it("places a stage with only a header and a data file without looking for a strip tool or mentioning signing", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "include/x.h", "int x;\n", 0o644);
    payload(c, "share/x/data.txt", "data\n", 0o644);
    fakeMake(c);
    // Neither a strip tool nor a certificate is needed for such a project
    useEmptyPath();

    const result = expectCompleted(await runInstallPhase(options(c, { release: true, configDir: certDir })));

    expect(c.lines.filter((line) => /strip|sign/i.test(line))).toEqual([]);
    expect(c.lines).toContain("Installed 2 file(s) into " + c.prefix);
    expect(result.report.stripped).toEqual([]);
    expect(result.report.signed).toEqual([]);
    expect(fs.readFileSync(path.join(c.prefix, "include", "x.h"), "utf8")).toBe("int x;\n");
  });

  it("fails at install when make fails, with the captured output in capture mode", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2));
    fakeMake(c, "make: *** deliberate failure");

    const result = await runInstallPhase(options(c));

    expect(result.status).toBe("failed");
    const failed = result as Extract<InstallPhaseResult, { status: "failed" }>;
    expect(failed.step).toBe("install");
    expect(failed.output).toContain("make: *** deliberate failure");
    expect(fs.existsSync(path.join(c.prefix, "bin", "tiny"))).toBe(false);
  });
});
