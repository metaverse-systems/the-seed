import fs from "fs";
import os from "os";
import path from "path";
import { groupOutputs, outputKind, placeStaged, readStage } from "../src/InstallPhase";
import { SigningOutcome } from "../src/types";

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
