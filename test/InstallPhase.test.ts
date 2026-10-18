import fs from "fs";
import os from "os";
import path from "path";
import { buildTreeCopies, groupOutputs, notice, outputKind, placeStaged, readStage, runInstallPhase, signingOutcome, signOutputs, stripOutputs } from "../src/InstallPhase";
import Signing from "../src/Signing";
import { findOnPath } from "../src/ProcessRunner";
import { optionalExternalCheck } from "./helpers/ExternalTools";
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
// - `buildTreeCopies(projectDir, stagedGroups, target)` is synchronous and returns `OutputGroup[]`; its
//   `display` is the project-relative path of the group's `file` with "/" separators (`src/.libs/tiny`),
//   and `file` is the first name in name order that is a regular file, as for staged groups.
// - In `runInstallPhase`, `report.stripped` and `report.signed[].display` list the installed paths first
//   and then the build-tree display paths; the `Signed (detached): <display>` lines are in the same order.

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

// ── buildTreeCopies ─────────────────────────────────────────

describe("buildTreeCopies", () => {
  /** A project directory next to a stage with the given staged outputs (relative to the prefix); returns both. */
  function treeCase(target: "native" | "windows", staged: Array<[string, Buffer]>) {
    const s = makeStage(target);
    for (const [rel, content] of staged) {
      writeFile(path.join(s.root, rel), content, 0o755);
    }
    const projectDir = path.join(s.base, "project");
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    const stagedGroups = groupOutputs(readStage(s.stageDir, s.configPrefix, target));
    return { s, projectDir, stagedGroups };
  }

  it("takes src/.libs/<name> and not the wrapper script in src/ (native)", () => {
    const { projectDir, stagedGroups } = treeCase("native", [["bin/tiny", elfHeader(2, "installed")]]);
    writeFile(path.join(projectDir, "src", ".libs", "tiny"), elfHeader(2, "built"), 0o755);
    writeFile(path.join(projectDir, "src", "tiny"), shellScript, 0o755);

    const groups = buildTreeCopies(projectDir, stagedGroups, "native");

    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(path.join(projectDir, "src", ".libs", "tiny"));
    expect(groups[0].kind).toBe("elfExecutable");
    expect(groups[0].names).toEqual([path.join(projectDir, "src", ".libs", "tiny")]);
    expect(groups[0].display).toBe("src/.libs/tiny");
  });

  it("takes src/.libs/<name> and not the PE wrapper program in src/ (windows)", () => {
    const { projectDir, stagedGroups } = treeCase("windows", [["bin/tiny.exe", peHeader(0x22, "installed")]]);
    writeFile(path.join(projectDir, "src", ".libs", "tiny.exe"), peHeader(0x22, "built"), 0o755);
    // The libtool wrapper for a cross build is itself a PE program
    writeFile(path.join(projectDir, "src", "tiny.exe"), peHeader(0x22, "wrapper"), 0o755);

    const groups = buildTreeCopies(projectDir, stagedGroups, "windows");

    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(path.join(projectDir, "src", ".libs", "tiny.exe"));
    expect(groups[0].kind).toBe("peProgram");
    expect(groups[0].display).toBe("src/.libs/tiny.exe");
  });

  it("falls back to src/<name> when src/.libs has no copy", () => {
    const { projectDir, stagedGroups } = treeCase("native", [["bin/tiny", elfHeader(2, "installed")]]);
    writeFile(path.join(projectDir, "src", "tiny"), elfHeader(2, "built"), 0o755);
    fs.mkdirSync(path.join(projectDir, "src", ".libs"));

    const groups = buildTreeCopies(projectDir, stagedGroups, "native");

    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(path.join(projectDir, "src", "tiny"));
    expect(groups[0].display).toBe("src/tiny");
  });

  it("falls back to src/<name> when src/.libs does not exist", () => {
    const { projectDir, stagedGroups } = treeCase("native", [["bin/tiny", elfHeader(2, "installed")]]);
    writeFile(path.join(projectDir, "src", "tiny"), elfHeader(2, "built"), 0o755);

    const groups = buildTreeCopies(projectDir, stagedGroups, "native");

    expect(groups.map((g) => g.display)).toEqual(["src/tiny"]);
  });

  it("drops copies that are not outputs and names with no build-tree copy", () => {
    const { projectDir, stagedGroups } = treeCase("native", [
      ["bin/tiny", elfHeader(2, "a")],
      ["bin/script-tool", elfHeader(2, "b")],
      ["lib/libx.so.0.0.0", elfHeader(3, "c")],
      ["bin/missing", elfHeader(2, "d")],
    ]);
    writeFile(path.join(projectDir, "src", ".libs", "tiny"), elfHeader(2, "built"), 0o755);
    // A script, an object file and an archive are not outputs
    writeFile(path.join(projectDir, "src", ".libs", "script-tool"), shellScript, 0o755);
    writeFile(path.join(projectDir, "src", ".libs", "libx.so.0.0.0"), arArchive);
    // Files with no installed counterpart are never taken
    writeFile(path.join(projectDir, "src", ".libs", "unrelated"), elfHeader(2, "e"), 0o755);

    const groups = buildTreeCopies(projectDir, stagedGroups, "native");

    expect(groups.map((g) => g.display)).toEqual(["src/.libs/tiny"]);
  });

  it("a PE copy is not an output for native and an ELF copy is not an output for windows", () => {
    const native = treeCase("native", [["bin/tiny", elfHeader(2, "a")]]);
    writeFile(path.join(native.projectDir, "src", ".libs", "tiny"), peHeader(0x22), 0o755);
    expect(buildTreeCopies(native.projectDir, native.stagedGroups, "native")).toEqual([]);

    const windows = treeCase("windows", [["bin/tiny.exe", peHeader(0x22, "a")]]);
    writeFile(path.join(windows.projectDir, "src", ".libs", "tiny.exe"), elfHeader(2), 0o755);
    expect(buildTreeCopies(windows.projectDir, windows.stagedGroups, "windows")).toEqual([]);
  });

  it("a link chain in src/.libs is one group with its links", () => {
    const { s, projectDir, stagedGroups } = treeCase("native", [["lib/libx.so.0.0.0", elfHeader(3, "installed")]]);
    fs.symlinkSync("libx.so.0.0.0", path.join(s.root, "lib", "libx.so.0"));
    fs.symlinkSync("libx.so.0", path.join(s.root, "lib", "libx.so"));
    const libs = path.join(projectDir, "src", ".libs");
    writeFile(path.join(libs, "libx.so.0.0.0"), elfHeader(3, "built"), 0o755);
    fs.symlinkSync("libx.so.0.0.0", path.join(libs, "libx.so.0"));
    fs.symlinkSync("libx.so.0", path.join(libs, "libx.so"));
    // libtool also leaves a .la file and a wrapper-free libx.a beside them; neither is an output
    writeFile(path.join(libs, "libx.a"), arArchive);

    const groups = buildTreeCopies(projectDir, groupOutputs(readStage(s.stageDir, s.configPrefix, "native")), "native");
    expect(stagedGroups).toHaveLength(1);

    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(path.join(libs, "libx.so.0.0.0"));
    expect([...groups[0].names].sort()).toEqual(
      [path.join(libs, "libx.so"), path.join(libs, "libx.so.0"), path.join(libs, "libx.so.0.0.0")].sort()
    );
    expect([...groups[0].links].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: path.join(libs, "libx.so"), target: "libx.so.0" },
      { path: path.join(libs, "libx.so.0"), target: "libx.so.0.0.0" },
    ]);
    expect(groups[0].display).toBe("src/.libs/libx.so.0.0.0");
  });

  it("looks at nothing outside src/ and src/.libs/", () => {
    const { projectDir, stagedGroups } = treeCase("native", [
      ["lib/libfoo.so.0.0.0", elfHeader(3, "installed")],
      ["bin/tiny", elfHeader(2, "installed")],
    ]);
    writeFile(path.join(projectDir, "lib", "foo", ".libs", "libfoo.so.0.0.0"), elfHeader(3, "built"), 0o755);
    writeFile(path.join(projectDir, "libfoo.so.0.0.0"), elfHeader(3, "top"), 0o755);
    writeFile(path.join(projectDir, ".libs", "tiny"), elfHeader(2, "top"), 0o755);
    writeFile(path.join(projectDir, "tiny"), elfHeader(2, "top"), 0o755);
    writeFile(path.join(projectDir, "src", "sub", "tiny"), elfHeader(2, "deeper"), 0o755);
    writeFile(path.join(projectDir, "src", "sub", ".libs", "tiny"), elfHeader(2, "deeper"), 0o755);

    expect(buildTreeCopies(projectDir, stagedGroups, "native")).toEqual([]);
  });

  it("the display is project-relative also for a project directory with special characters", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2, "installed"), 0o755);
    const projectDir = path.join(s.base, specialName);
    writeFile(path.join(projectDir, "src", ".libs", "tiny"), elfHeader(2, "built"), 0o755);

    const groups = buildTreeCopies(projectDir, groupOutputs(readStage(s.stageDir, s.configPrefix, "native")), "native");

    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(path.join(projectDir, "src", ".libs", "tiny"));
    expect(groups[0].display).toBe("src/.libs/tiny");
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


// ── placeStaged (pre-check and cross-device fallback) ───────

// Choices: the pre-check names either the offending directory or a path inside it in `cannot place <path>: <reason>`
// (the tests only require the directory's path to appear in the message); a failed pre-check moves nothing.
describe("placeStaged pre-check", () => {
  const notRoot = process.getuid !== undefined && process.getuid() === 0 ? it.skip : it;

  function stageTree(s: TestStage): void {
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2, "new"), 0o755);
    writeFile(path.join(s.root, "lib", "libx.so.0.0.0"), elfHeader(3, "new"), 0o755);
    writeFile(path.join(s.root, "share", "thing"), "staged file\n", 0o644);
  }

  function attempt(s: TestStage): string {
    const tree = readStage(s.stageDir, s.configPrefix, "native");
    try {
      placeStaged(tree, groupOutputs(tree), unsigned);
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  }

  function expectNothingMoved(s: TestStage): void {
    expect(fs.existsSync(path.join(s.prefix, "bin", "tiny"))).toBe(false);
    expect(fs.existsSync(path.join(s.root, "bin", "tiny"))).toBe(true);
    expect(fs.existsSync(path.join(s.root, "lib", "libx.so.0.0.0"))).toBe(true);
  }

  notRoot("refuses an unwritable existing destination directory before anything is moved", () => {
    const s = makeStage("native");
    stageTree(s);
    // bin sorts before lib, so a check done lazily would already have moved bin/tiny
    fs.mkdirSync(path.join(s.prefix, "lib"), { recursive: true });
    fs.chmodSync(path.join(s.prefix, "lib"), 0o555);

    const message = attempt(s);

    expect(message).toMatch(/^cannot place .+: .+/);
    expect(message).toContain(path.join(s.prefix, "lib"));
    expectNothingMoved(s);
    expect(fs.readdirSync(path.join(s.prefix, "lib"))).toEqual([]);
  });

  it("refuses a directory where the stage has a file, before anything is moved", () => {
    const s = makeStage("native");
    stageTree(s);
    writeFile(path.join(s.prefix, "share", "thing", "inner"), "prefix file\n", 0o644);

    const message = attempt(s);

    expect(message).toMatch(/^cannot place .+: .+/);
    expect(message).toContain(path.join(s.prefix, "share", "thing"));
    expectNothingMoved(s);
    expect(fs.readFileSync(path.join(s.prefix, "share", "thing", "inner"), "utf8")).toBe("prefix file\n");
  });

  it("refuses a file where the stage has a directory, before anything is moved", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2, "new"), 0o755);
    writeFile(path.join(s.root, "lib", "libx.so.0.0.0"), elfHeader(3, "new"), 0o755);
    writeFile(path.join(s.root, "share", "thing", "inner"), "staged file\n", 0o644);
    writeFile(path.join(s.prefix, "share", "thing"), "prefix file\n", 0o644);

    const message = attempt(s);

    expect(message).toMatch(/^cannot place .+: .+/);
    expect(message).toContain(path.join(s.prefix, "share", "thing"));
    expectNothingMoved(s);
    expect(fs.readFileSync(path.join(s.prefix, "share", "thing"), "utf8")).toBe("prefix file\n");
    expect(fs.existsSync(path.join(s.prefix, "lib"))).toBe(false);
  });
});

describe("placeStaged across file systems", () => {
  it("falls back to a copy when rename fails with EXDEV once, keeps the mode and leaves no temporary file", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "bin", "tiny"), elfHeader(2, "new"), 0o751);
    writeFile(path.join(s.prefix, "bin", "tiny"), "old contents", 0o644);
    const tree = readStage(s.stageDir, s.configPrefix, "native");
    const groups = groupOutputs(tree);
    const realRename = fs.renameSync;
    let failures = 0;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (failures === 0) {
        failures++;
        throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), { code: "EXDEV" });
      }
      return realRename(from, to);
    });

    placeStaged(tree, groups, unsigned);

    expect(failures).toBe(1);
    expect(fs.readFileSync(path.join(s.prefix, "bin", "tiny")).equals(elfHeader(2, "new"))).toBe(true);
    expect(fs.statSync(path.join(s.prefix, "bin", "tiny")).mode & 0o7777).toBe(0o751);
    expect(fs.readdirSync(path.join(s.prefix, "bin")).filter((name) => name.includes(".the-seed-"))).toEqual([]);
  });

  it("re-creates a symlink with its exact target after EXDEV", () => {
    const s = makeStage("native");
    writeFile(path.join(s.root, "lib", "libx.so.0.0.0"), elfHeader(3), 0o755);
    fs.symlinkSync("libx.so.0.0.0", path.join(s.root, "lib", "libx.so.0"));
    const tree = readStage(s.stageDir, s.configPrefix, "native");
    const groups = groupOutputs(tree);
    const realRename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // Every move from the stage fails once; the temporary names in the prefix rename normally
      if (String(from).startsWith(s.stageDir)) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), { code: "EXDEV" });
      }
      return realRename(from, to);
    });

    placeStaged(tree, groups, unsigned);

    expect(fs.readlinkSync(path.join(s.prefix, "lib", "libx.so.0"))).toBe("libx.so.0.0.0");
    expect(fs.readdirSync(path.join(s.prefix, "lib")).filter((name) => name.includes(".the-seed-"))).toEqual([]);
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

  // ── Build-tree copies ─────────────────────────────────────

  /** A hand-made build-tree file under the case's project directory. */
  function buildTreeFile(c: PhaseCase, rel: string, content: Buffer | string, mode = 0o755): string {
    const file = path.join(c.projectDir, rel);
    writeFile(file, content, mode);
    return file;
  }

  it("strips and signs the build-tree copies after the staged ones, each as its own file", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "bin/tiny", elfHeader(2, "installed program"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "installed library"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    const builtProgram = buildTreeFile(c, "src/.libs/tiny", elfHeader(2, "built program"));
    const builtLibrary = buildTreeFile(c, "src/.libs/libx.so.0.0.0", elfHeader(3, "built library"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.projectDir, "src", ".libs", "libx.so.0"));
    // The wrapper script and a file with no installed counterpart are left alone
    const wrapper = buildTreeFile(c, "src/tiny", shellScript);
    buildTreeFile(c, "src/.libs/unrelated", elfHeader(2, "unrelated"));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true, configDir: certDir })));

    const stage = recorded(c).stage;
    const stripped = strippedFiles(c.stripLog);
    const stagedStripped = [path.join(stage + c.prefix, "bin", "tiny"), path.join(stage + c.prefix, "lib", "libx.so.0.0.0")];
    expect(stripped.slice(0, 2).sort()).toEqual(stagedStripped.sort());
    expect(stripped.slice(2).sort()).toEqual([builtLibrary, builtProgram].sort());
    expect(stripped).toHaveLength(4);

    // Installed display paths first, then project-relative ones, in the report and in the log
    const installedDisplays = [path.join(c.prefix, "bin", "tiny"), path.join(c.prefix, "lib", "libx.so.0.0.0")];
    const buildDisplays = ["src/.libs/libx.so.0.0.0", "src/.libs/tiny"];
    expect(result.report.stripped.slice(0, 2).sort()).toEqual(installedDisplays.sort());
    expect(result.report.stripped.slice(2).sort()).toEqual(buildDisplays);
    expect(result.report.signed.slice(0, 2).map((entry) => entry.display).sort()).toEqual(installedDisplays.sort());
    expect(result.report.signed.slice(2).map((entry) => entry.display).sort()).toEqual(buildDisplays);
    const signedLines = c.lines.filter((line) => line.startsWith("Signed (detached): "));
    expect(signedLines).toHaveLength(4);
    expect(signedLines.slice(0, 2).every((line) => line.includes(c.prefix))).toBe(true);
    expect(signedLines.slice(2).every((line) => line.startsWith("Signed (detached): src/.libs/"))).toBe(true);
    expect(c.lines).toContain("Stripped 4 file(s)");
    expect(c.lines).toContain("Auto-signed 4 file(s) using scope '@t'");

    // Each copy has its own signature and verifies against its own bytes
    const signing = new Signing(certDir);
    for (const file of [path.join(c.prefix, "bin", "tiny"), path.join(c.prefix, "lib", "libx.so.0.0.0"), builtProgram, builtLibrary]) {
      expect([file, fs.lstatSync(file + ".sig").isFile()]).toEqual([file, true]);
      expect([file, (await signing.verifyFile(file)).status]).toEqual([file, "VALID"]);
    }
    expect(fs.readFileSync(builtProgram + ".sig").equals(fs.readFileSync(path.join(c.prefix, "bin", "tiny.sig")))).toBe(false);

    // The build-tree signature links are written in the build tree
    const libs = path.join(c.projectDir, "src", ".libs");
    expect(fs.readlinkSync(path.join(libs, "libx.so.0.sig"))).toBe("libx.so.0.0.0.sig");
    expect((await signing.verifyFile(path.join(libs, "libx.so.0"))).status).toBe("VALID");
    expect(fs.readFileSync(wrapper, "utf8")).toBe(shellScript.toString());
    expect(fs.existsSync(wrapper + ".sig")).toBe(false);
    expect(fs.existsSync(path.join(libs, "unrelated.sig"))).toBe(false);
  });

  it("falls back to src/<name> for the build-tree copy and processes it", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "bin/tiny", elfHeader(2, "installed"));
    const built = buildTreeFile(c, "src/tiny", elfHeader(2, "built"));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true, configDir: certDir })));

    expect(result.report.stripped).toEqual([path.join(c.prefix, "bin", "tiny"), "src/tiny"]);
    expect(strippedFiles(c.stripLog).pop()).toBe(built);
    expect((await new Signing(certDir).verifyFile(built)).status).toBe("VALID");
  });

  it("strips the build-tree copies of an unsigned project with release and leaves them unsigned", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2, "installed"));
    const built = buildTreeFile(c, "src/.libs/tiny", elfHeader(2, "built"));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true })));

    expect(strippedFiles(c.stripLog).pop()).toBe(built);
    expect(result.report.stripped).toEqual([path.join(c.prefix, "bin", "tiny"), "src/.libs/tiny"]);
    expect(result.report.signed).toEqual([]);
    expect(fs.existsSync(built + ".sig")).toBe(false);
  });

  it("does not strip the build-tree copies without release, but signs them", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "bin/tiny", elfHeader(2, "installed"));
    const built = buildTreeFile(c, "src/.libs/tiny", elfHeader(2, "built"));
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: false, configDir: certDir })));

    expect(readLines(c.stripLog)).toEqual([]);
    expect(result.report.stripped).toEqual([]);
    expect(result.report.signed.map((entry) => entry.display)).toEqual([path.join(c.prefix, "bin", "tiny"), "src/.libs/tiny"]);
    expect((await new Signing(certDir).verifyFile(built)).status).toBe("VALID");
  });

  it("does not touch build-tree outputs when the install step installed no program or library", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "include/x.h", "int x;\n", 0o644);
    const built = buildTreeFile(c, "src/.libs/tiny", elfHeader(2, "built"));
    const before = fs.readFileSync(built);
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true, configDir: certDir })));

    expect(result.report.stripped).toEqual([]);
    expect(result.report.signed).toEqual([]);
    expect(fs.readFileSync(built).equals(before)).toBe(true);
    expect(fs.existsSync(built + ".sig")).toBe(false);
  });

  // ── Failures, notices and stale signatures ────────────────

  /** Every path under `dir` with its type, size, mode and link text, for before/after comparisons. */
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      const st = fs.lstatSync(current);
      const rel = path.relative(dir, current);
      if (st.isSymbolicLink()) {
        out.push(`${rel} link ${fs.readlinkSync(current)}`);
      } else if (st.isDirectory()) {
        out.push(`${rel} dir ${octal(st.mode)}`);
        for (const name of fs.readdirSync(current).sort()) {
          walk(path.join(current, name));
        }
      } else {
        out.push(`${rel} file ${st.size} ${octal(st.mode)}`);
      }
    };
    walk(dir);
    return out;
  }

  /** A prefix that already holds an installed file, so "unchanged" has something to compare. */
  function prefixWithOldFile(c: PhaseCase): void {
    writeFile(path.join(c.prefix, "bin", "old"), elfHeader(2, "old"), 0o755);
    writeFile(path.join(c.prefix, "bin", "tiny"), elfHeader(2, "old tiny"), 0o755);
  }

  function expectFailedAt(result: InstallPhaseResult, step: string): Extract<InstallPhaseResult, { status: "failed" }> {
    if (result.status !== "failed") {
      throw new Error("expected failed, got " + JSON.stringify(result));
    }
    expect(result.step).toBe(step);
    return result;
  }

  it("fails at strip naming the installed file when the strip tool fails, with the prefix unchanged and no stage left", async () => {
    const c = makeCase("native");
    installFakeStrip(c.stripDir, { failWith: "strip: deliberate failure" });
    prefixWithOldFile(c);
    payload(c, "bin/tiny", elfHeader(2, "new tiny"));
    fakeMake(c);
    const before = snapshot(c.configPrefix);

    const failed = expectFailedAt(await runInstallPhase(options(c, { release: true })), "strip");

    expect(failed.message).toContain("strip failed on " + path.join(c.prefix, "bin", "tiny") + ": ");
    expect(failed.message).toContain("strip: deliberate failure");
    expect(snapshot(c.configPrefix)).toEqual(before);
    expect(fs.existsSync(path.join(c.configPrefix, ".the-seed-staging"))).toBe(false);
  });

  it("fails at sign naming the file when signing fails, with the prefix unchanged and no stage left", async () => {
    const c = makeCase("native");
    markSigned(c);
    prefixWithOldFile(c);
    payload(c, "bin/tiny", elfHeader(2, "new tiny"));
    fakeMake(c);
    const before = snapshot(c.configPrefix);
    // The signer fails for the staged program, as it would for a key it cannot use
    jest.spyOn(Signing.prototype, "signFile").mockRejectedValue(new Error("deliberate signer failure"));

    const failed = expectFailedAt(await runInstallPhase(options(c, { configDir: certDir })), "sign");

    expect(failed.message).toBe("signing failed on " + path.join(c.prefix, "bin", "tiny") + ": deliberate signer failure");
    expect(snapshot(c.configPrefix)).toEqual(before);
    expect(fs.existsSync(path.join(c.configPrefix, ".the-seed-staging"))).toBe(false);
  });

  it("fails at sign with `<certificate path>: <reason>` for a certificate that cannot be parsed, with the prefix unchanged and no stage left", async () => {
    const c = makeCase("native");
    markSigned(c);
    prefixWithOldFile(c);
    payload(c, "bin/tiny", elfHeader(2, "new tiny"));
    fakeMake(c);
    const brokenConfig = path.join(c.base, "broken-config");
    const certPath = new Signing(brokenConfig).scopeCertPath(scope);
    writeFile(certPath, "this is not a certificate\n", 0o644);
    const before = snapshot(c.configPrefix);

    const failed = expectFailedAt(await runInstallPhase(options(c, { configDir: brokenConfig })), "sign");

    expect(failed.message.startsWith(certPath + ": ")).toBe(true);
    expect(failed.message.length).toBeGreaterThan(certPath.length + 2);
    expect(snapshot(c.configPrefix)).toEqual(before);
    expect(fs.existsSync(path.join(c.configPrefix, ".the-seed-staging"))).toBe(false);
  });

  it("prints the notice of an unsigned project exactly once, however many outputs it has", async () => {
    const c = makeCase("native");
    payload(c, "bin/tiny", elfHeader(2, "installed"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "installed library"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    writeFile(path.join(c.projectDir, "src", ".libs", "tiny"), elfHeader(2, "built"), 0o755);
    writeFile(path.join(c.projectDir, "src", ".libs", "libx.so.0.0.0"), elfHeader(3, "built library"), 0o755);
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true })));

    const notices = c.lines.filter((line) => /^(Not signed|Warning: not signed):/.test(line));
    expect(notices).toEqual([notice(result.report.outcome, c.projectDir)]);
    expect(notices).toHaveLength(1);
  });

  it("prints no notice when an unsigned project installs only headers and data", async () => {
    const c = makeCase("native");
    payload(c, "include/x.h", "int x;\n", 0o644);
    payload(c, "share/x/data.txt", "data\n", 0o644);
    writeFile(path.join(c.projectDir, "src", ".libs", "stray"), elfHeader(2, "built"), 0o755);
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    expect(c.lines.filter((line) => /not signed/i.test(line))).toEqual([]);
  });

  it("removes <name>.sig beside every build-tree name of an unsigned project and the prefix's <name>.sig for every installed name", async () => {
    const c = makeCase("native");
    // Signatures an earlier signed build left in the prefix, for a program, a library and a link name
    writeFile(path.join(c.prefix, "bin", "tiny"), elfHeader(2, "old"), 0o755);
    writeFile(path.join(c.prefix, "bin", "tiny.sig"), "stale", 0o644);
    writeFile(path.join(c.prefix, "lib", "libx.so.0.0.0"), elfHeader(3, "old"), 0o755);
    writeFile(path.join(c.prefix, "lib", "libx.so.0.0.0.sig"), "stale", 0o644);
    fs.symlinkSync("libx.so.0.0.0.sig", path.join(c.prefix, "lib", "libx.so.0.sig"));
    // ... and one beside a file that is not an output
    writeFile(path.join(c.prefix, "lib", "liby.a.sig"), "kept", 0o644);
    payload(c, "bin/tiny", elfHeader(2, "new"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "new"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    payload(c, "lib/liby.a", arArchive, 0o644);
    // Build-tree names with stale signatures: the real file, a link name and a copy without an installed counterpart
    const libs = path.join(c.projectDir, "src", ".libs");
    writeFile(path.join(libs, "tiny"), elfHeader(2, "built"), 0o755);
    writeFile(path.join(libs, "tiny.sig"), "stale", 0o644);
    writeFile(path.join(libs, "libx.so.0.0.0"), elfHeader(3, "built"), 0o755);
    writeFile(path.join(libs, "libx.so.0.0.0.sig"), "stale", 0o644);
    fs.symlinkSync("libx.so.0.0.0", path.join(libs, "libx.so.0"));
    fs.symlinkSync("libx.so.0.0.0.sig", path.join(libs, "libx.so.0.sig"));
    writeFile(path.join(libs, "libz.a"), arArchive, 0o644);
    writeFile(path.join(libs, "libz.a.sig"), "kept", 0o644);
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c)));

    for (const stale of [
      path.join(libs, "tiny.sig"),
      path.join(libs, "libx.so.0.0.0.sig"),
      path.join(libs, "libx.so.0.sig"),
      path.join(c.prefix, "bin", "tiny.sig"),
      path.join(c.prefix, "lib", "libx.so.0.0.0.sig"),
      path.join(c.prefix, "lib", "libx.so.0.sig"),
    ]) {
      expect([stale, fs.existsSync(stale) || isLink(stale)]).toEqual([stale, false]);
    }
    // Signature files beside anything that is not an identified output stay
    expect(fs.readFileSync(path.join(c.prefix, "lib", "liby.a.sig"), "utf8")).toBe("kept");
    expect(fs.readFileSync(path.join(libs, "libz.a.sig"), "utf8")).toBe("kept");
  });

  it("replaces the prefix's <name>.sig by the staged signature (or signature link) of a signed project", async () => {
    const c = makeCase("native");
    markSigned(c);
    writeFile(path.join(c.prefix, "bin", "tiny.sig"), "stale", 0o644);
    writeFile(path.join(c.prefix, "lib", "libx.so.0.sig"), "stale file where a link now goes", 0o644);
    payload(c, "bin/tiny", elfHeader(2, "new"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "new"));
    fs.symlinkSync("libx.so.0.0.0", path.join(c.payloadRoot + c.prefix, "lib", "libx.so.0"));
    fakeMake(c);

    expectCompleted(await runInstallPhase(options(c, { configDir: certDir })));

    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny.sig"), "utf8")).not.toBe("stale");
    expect(fs.lstatSync(path.join(c.prefix, "lib", "libx.so.0.sig")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(c.prefix, "lib", "libx.so.0.sig"))).toBe("libx.so.0.0.0.sig");
    const signing = new Signing(certDir);
    for (const rel of ["bin/tiny", "lib/libx.so.0.0.0", "lib/libx.so.0"]) {
      expect([rel, (await signing.verifyFile(path.join(c.prefix, rel))).status]).toEqual([rel, "VALID"]);
    }
  });

  it("removes the prefix's <name>.sig for an output that is signed with an embedded signature", async () => {
    recognisePeByMagic();
    const c = makeCase("windows");
    markSigned(c);
    writeFile(path.join(c.prefix, "bin", "tiny.exe"), peHeader(0x22, "old"), 0o755);
    writeFile(path.join(c.prefix, "bin", "tiny.exe.sig"), "stale detached signature", 0o644);
    payload(c, "bin/tiny.exe", peHeader(0x22, "new"));
    fakeMake(c);
    // The signer embeds the signature by replacing the file
    jest.spyOn(Signing.prototype, "signFile").mockImplementation(async (file: string) => {
      const replacement = file + ".new";
      fs.writeFileSync(replacement, peHeader(0x22, "signed"));
      fs.renameSync(replacement, file);
      return { filePath: file, signaturePath: null, fingerprint: "SHA256:x", signatureType: "embedded", warnings: [] };
    });

    const result = expectCompleted(await runInstallPhase(options(c, { target: "windows", configDir: certDir })));

    expect(result.report.signed.map((entry) => entry.form)).toEqual(["embedded"]);
    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny.exe")).equals(peHeader(0x22, "signed"))).toBe(true);
    expect(fs.existsSync(path.join(c.prefix, "bin", "tiny.exe.sig"))).toBe(false);
  });

  /** The `.sig` files under a directory (files and links), as sorted paths relative to it */
  function sigFilesUnder(dir: string): string[] {
    const found: string[] = [];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.name.endsWith(".sig")) {
          found.push(child);
        }
      }
    };
    walk("");
    return found.sort();
  }

  // Choice: the prefix's other-project library is a plain ELF shared object at lib/libother.so.0.0.0 with its own
  // .sig; the old-version leftover is lib/libtinygreet.a.sig in both the prefix and the build tree.
  it("processes only the real output of a native stage, and leaves other projects' files and old .a.sig files alone", async () => {
    const c = makeCase("native");
    markSigned(c);
    payload(c, "bin/tiny", elfHeader(2, "program"));
    payload(c, "lib/libtinygreet.a", arArchive, 0o644);
    payload(c, "lib/libtinygreet.dll.a", arArchive, 0o644);
    payload(c, "lib/libtinygreet.la", "# libtool archive\n", 0o644);
    payload(c, "include/tinygreet.h", "int greet(void);\n", 0o644);
    payload(c, "lib/pkgconfig/tinygreet.pc", "Name: tinygreet\n", 0o644);
    payload(c, "bin/tiny-config", shellScript);
    payload(c, "share/tiny/data.bin", plainText, 0o644);
    // A PE file in a native stage is not an output
    payload(c, "share/tiny/stray.exe", peHeader(0x0022), 0o644);
    // Another project's library and signature are already in the prefix
    const otherLib = path.join(c.prefix, "lib", "libother.so.0.0.0");
    const otherSig = otherLib + ".sig";
    writeFile(otherLib, elfHeader(3, "other project's library"), 0o755);
    writeFile(otherSig, "other project's signature", 0o644);
    // Signatures an earlier version left beside archives
    const oldPrefixSig = path.join(c.prefix, "lib", "libtinygreet.a.sig");
    const oldTreeSig = path.join(c.projectDir, "src", ".libs", "libtinygreet.a.sig");
    writeFile(oldPrefixSig, "old signature", 0o644);
    writeFile(oldTreeSig, "old signature", 0o644);
    buildTreeFile(c, "src/.libs/libtinygreet.a", arArchive, 0o644);
    fakeMake(c);

    const result = expectCompleted(await runInstallPhase(options(c, { release: true, configDir: certDir })));

    const stage = recorded(c).stage;
    expect(strippedFiles(c.stripLog)).toEqual([path.join(stage + c.prefix, "bin", "tiny")]);
    expect(result.report.signed.map((entry) => entry.display)).toEqual([path.join(c.prefix, "bin", "tiny")]);
    expect((await new Signing(certDir).verifyFile(path.join(c.prefix, "bin", "tiny"))).status).toBe("VALID");
    const sigs = sigFilesUnder(c.prefix);
    expect(sigs).toEqual(["bin/tiny.sig", "lib/libother.so.0.0.0.sig", "lib/libtinygreet.a.sig"]);
    expect(sigFilesUnder(c.projectDir)).toEqual([
      path.join("src", ".libs", "libtinygreet.a.sig"),
    ]);
    // Everything else arrived unchanged
    expect(fs.readFileSync(path.join(c.prefix, "lib", "libtinygreet.a")).equals(arArchive)).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "lib", "libtinygreet.dll.a")).equals(arArchive)).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny-config"), "utf8")).toBe(shellScript.toString());
    expect(fs.readFileSync(path.join(c.prefix, "share", "tiny", "stray.exe")).equals(peHeader(0x0022))).toBe(true);
    expect(fs.readFileSync(otherLib).equals(elfHeader(3, "other project's library"))).toBe(true);
    expect(fs.readFileSync(otherSig, "utf8")).toBe("other project's signature");
    expect(fs.readFileSync(oldPrefixSig, "utf8")).toBe("old signature");
    expect(fs.readFileSync(oldTreeSig, "utf8")).toBe("old signature");
  });

  it("processes only the real output of a windows stage", async () => {
    recognisePeByMagic();
    const c = makeCase("windows");
    markSigned(c);
    payload(c, "bin/tiny.exe", peHeader(0x0022, "program"));
    payload(c, "bin/libtinygreet-0.dll", peHeader(0x2022, "library"));
    payload(c, "lib/libtinygreet.dll.a", arArchive, 0o644);
    payload(c, "lib/libtinygreet.a", arArchive, 0o644);
    payload(c, "lib/libtinygreet.la", "# libtool archive\n", 0o644);
    payload(c, "include/tinygreet.h", "int greet(void);\n", 0o644);
    payload(c, "lib/pkgconfig/tinygreet.pc", "Name: tinygreet\n", 0o644);
    payload(c, "bin/tiny-config", shellScript);
    payload(c, "share/tiny/data.bin", plainText, 0o644);
    // An ELF file in a windows stage is not an output
    payload(c, "share/tiny/stray", elfHeader(2), 0o755);
    // A PE object file is not an output either
    payload(c, "share/tiny/obj.obj", peHeader(0x0000), 0o644);
    fakeMake(c);
    const signedFiles: string[] = [];
    jest.spyOn(Signing.prototype, "signFile").mockImplementation(async (file: string) => {
      signedFiles.push(file);
      return { filePath: file, signaturePath: null, fingerprint: "SHA256:x", signatureType: "embedded", warnings: [] };
    });

    const result = expectCompleted(await runInstallPhase(options(c, { target: "windows", release: true, configDir: certDir })));

    const stage = recorded(c).stage;
    expect(strippedFiles(c.stripLog).sort()).toEqual(
      [path.join(stage + c.prefix, "bin", "tiny.exe"), path.join(stage + c.prefix, "bin", "libtinygreet-0.dll")].sort()
    );
    expect(result.report.signed.map((entry) => entry.display).sort()).toEqual(
      [path.join(c.prefix, "bin", "tiny.exe"), path.join(c.prefix, "bin", "libtinygreet-0.dll")].sort()
    );
    expect(signedFiles.every((file) => /tiny\.exe$|libtinygreet-0\.dll$/.test(file))).toBe(true);
    expect(signedFiles).toHaveLength(2);
    expect(fs.readFileSync(path.join(c.prefix, "lib", "libtinygreet.dll.a")).equals(arArchive)).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "share", "tiny", "stray")).equals(elfHeader(2))).toBe(true);
    expect(sigFilesUnder(c.prefix)).toEqual([]);
  });

  // ── All or nothing: cancellation and refusals ─────────────

  // Choices: the existing `snapshot` (type, size, mode, link text) of the configured prefix, staging area included,
  // is compared, so an unchanged snapshot also proves that no `.the-seed-staging` is left. A forced abort
  // during the install step is made by a fake make that creates a marker file and then waits; the case aborts when
  // the marker appears. Aborts between files are made from the `log` callback on the line of the first file's result.
  /** A prefix that earlier builds populated, including a file the new install overwrites. */
  function populatePrefix(c: PhaseCase): string[] {
    writeFile(path.join(c.prefix, "bin", "tiny"), elfHeader(2, "old program"), 0o755);
    writeFile(path.join(c.prefix, "lib", "libold.so.0.0.0"), elfHeader(3, "old library"), 0o755);
    fs.symlinkSync("libold.so.0.0.0", path.join(c.prefix, "lib", "libold.so.0"));
    writeFile(path.join(c.prefix, "share", "doc", "readme"), "old readme\n", 0o640);
    return snapshot(c.configPrefix);
  }

  function stageNothingLeft(c: PhaseCase): void {
    expect(fs.existsSync(path.join(c.configPrefix, ".the-seed-staging"))).toBe(false);
  }

  /** Payload with two programs and a library for the cancellation cases. */
  function payloadForCancel(c: PhaseCase): void {
    payload(c, "bin/tiny", elfHeader(2, "new program"));
    payload(c, "bin/tiny2", elfHeader(2, "second new program"));
    payload(c, "lib/libx.so.0.0.0", elfHeader(3, "new library"));
  }

  async function waitForFile(file: string): Promise<void> {
    for (let i = 0; i < 500 && !fs.existsSync(file); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(file)).toBe(true);
  }

  it("returns interrupted for an already aborted signal and creates nothing", async () => {
    const c = makeCase("native");
    payloadForCancel(c);
    fakeMake(c);
    const controller = new AbortController();
    controller.abort();

    const result = await runInstallPhase(options(c, { signal: controller.signal }));

    expect(result).toEqual({ status: "interrupted" });
    expect(fs.existsSync(c.configPrefix)).toBe(false);
    expect(fs.existsSync(c.makeRecord)).toBe(false);
  });

  it("a forced abort during the install step leaves the prefix as it was and no stage", async () => {
    const c = makeCase("native");
    const before = populatePrefix(c);
    payloadForCancel(c);
    const started = path.join(c.base, "install-started");
    const script = [
      "#!/bin/sh",
      "stage=\"\"",
      "for a in \"$@\"; do case \"$a\" in DESTDIR=*) stage=\"${a#DESTDIR=}\";; esac; done",
      "cp -a '" + c.payloadRoot + "'/. \"$stage\"/",
      "touch '" + started + "'",
      "exec sleep 30",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(c.makeDir, "make"), script);
    fs.chmodSync(path.join(c.makeDir, "make"), 0o755);
    const controller = new AbortController();

    const running = runInstallPhase(options(c, { signal: controller.signal }));
    await waitForFile(started);
    controller.abort();
    const result = await running;

    expect(result).toEqual({ status: "interrupted" });
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("a forced abort between strip files gives interrupted, an unchanged prefix and no stage", async () => {
    const c = makeCase("native");
    const before = populatePrefix(c);
    payloadForCancel(c);
    fakeMake(c);
    const controller = new AbortController();

    const result = await runInstallPhase(
      options(c, {
        release: true,
        signal: controller.signal,
        log: (line) => {
          c.lines.push(line);
          if (/^Stripping .* done$/.test(line)) {
            controller.abort();
          }
        },
      })
    );

    expect(result).toEqual({ status: "interrupted" });
    expect(strippedFiles(c.stripLog)).toHaveLength(1);
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("a forced abort between sign files gives interrupted, an unchanged prefix and no stage", async () => {
    const c = makeCase("native");
    markSigned(c);
    const before = populatePrefix(c);
    payloadForCancel(c);
    fakeMake(c);
    const controller = new AbortController();
    let signedLines = 0;

    const result = await runInstallPhase(
      options(c, {
        configDir: certDir,
        signal: controller.signal,
        log: (line) => {
          c.lines.push(line);
          if (line.startsWith("Signed (")) {
            signedLines++;
            controller.abort();
          }
        },
      })
    );

    expect(result).toEqual({ status: "interrupted" });
    expect(signedLines).toBe(1);
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("checks the signal once more right before placement", async () => {
    const c = makeCase("native");
    markSigned(c);
    const before = populatePrefix(c);
    payload(c, "bin/tiny", elfHeader(2, "new program"));
    fakeMake(c);
    const controller = new AbortController();

    // Only one file is signed, so no between-files check follows the abort
    const result = await runInstallPhase(
      options(c, {
        configDir: certDir,
        signal: controller.signal,
        log: (line) => {
          c.lines.push(line);
          if (line.startsWith("Signed (")) {
            controller.abort();
          }
        },
      })
    );

    expect(result).toEqual({ status: "interrupted" });
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("does not stop placement when the signal is aborted during it", async () => {
    const c = makeCase("native");
    populatePrefix(c);
    payloadForCancel(c);
    payload(c, "include/x.h", "int x;\n", 0o644);
    fakeMake(c);
    const controller = new AbortController();
    const realRename = fs.renameSync;
    let aborted = false;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!aborted && String(to).startsWith(c.prefix + path.sep)) {
        aborted = true;
        controller.abort();
      }
      return realRename(from, to);
    });

    const result = await runInstallPhase(options(c, { signal: controller.signal }));

    expect(aborted).toBe(true);
    expectCompleted(result);
    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny")).equals(elfHeader(2, "new program"))).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "bin", "tiny2")).equals(elfHeader(2, "second new program"))).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "lib", "libx.so.0.0.0")).equals(elfHeader(3, "new library"))).toBe(true);
    expect(fs.readFileSync(path.join(c.prefix, "include", "x.h"), "utf8")).toBe("int x;\n");
    stageNothingLeft(c);
  });

  // The refusals of the install phase: the messages are those of readStage; nothing is placed.
  it("refuses an install that writes outside the prefix (fake make writing $DESTDIR/etc/tiny.conf)", async () => {
    const c = makeCase("native");
    const before = populatePrefix(c);
    payload(c, "bin/tiny", elfHeader(2, "new program"));
    writeFile(path.join(c.payloadRoot, "etc", "tiny.conf"), "setting\n", 0o644);
    fakeMake(c);

    const result = await runInstallPhase(options(c));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.step).toBe("install");
      expect(result.message).toContain("the install step writes outside the prefix " + c.prefix);
      expect(result.message).toContain("/etc/tiny.conf");
    }
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("refuses an install that ignores DESTDIR (nothing under the stage)", async () => {
    const c = makeCase("native");
    const before = populatePrefix(c);
    const elsewhere = path.join(c.base, "elsewhere");
    const script = ["#!/bin/sh", "mkdir -p '" + elsewhere + "'", "echo installed > '" + elsewhere + "/tiny'", ""].join("\n");
    fs.writeFileSync(path.join(c.makeDir, "make"), script);
    fs.chmodSync(path.join(c.makeDir, "make"), 0o755);

    const result = await runInstallPhase(options(c));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.step).toBe("install");
      // No staged root exists at all, so the message is the one for an install under another prefix
      expect(result.message).toContain("the install step did not install under " + c.prefix);
      expect(result.message).toContain("configured for another prefix");
    }
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("refuses an incremental build whose install is staged under another prefix", async () => {
    const c = makeCase("native");
    const before = populatePrefix(c);
    writeFile(path.join(c.payloadRoot + c.configPrefix, "aarch64-linux-gnu", "bin", "tiny"), elfHeader(2), 0o755);
    fakeMake(c);

    const result = await runInstallPhase(options(c, { target: undefined }));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.step).toBe("install");
      expect(result.message).toContain("configured for another prefix");
    }
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });

  it("a failing install step leaves the prefix as it was and no stage", async () => {
    const c = makeCase("native");
    const before = populatePrefix(c);
    payload(c, "bin/tiny", elfHeader(2, "new program"));
    fakeMake(c, "no rule to make install");

    const result = await runInstallPhase(options(c));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.step).toBe("install");
    }
    expect(snapshot(c.configPrefix)).toEqual(before);
    stageNothingLeft(c);
  });
});

// ── signingOutcome and notice ───────────────────────────────

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("signingOutcome and notice", () => {
  // Choices: `notice` returns the single line of the research table, with `<projectDir>/package.json`
  // joined by "/" and the expired date as the UTC calendar date (`toISOString().slice(0, 10)`);
  // for an unreadable package.json `outcome.detail` is the reason that goes between the parentheses.
  const scope = "@t";
  let certDir: string;
  let projectDir: string;

  beforeAll(async () => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-phase-outcome-cert-"));
    fs.writeFileSync(
      path.join(certDir, "config.json"),
      JSON.stringify({ prefix: "/unused", scopes: { [scope]: { author: { name: "Test User", email: "t@example.invalid", url: "" } } } })
    );
    await new Signing(certDir).createCert({ validityDays: 365, scope });
  });

  afterAll(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    projectDir = makeScratch();
  });

  function writePackage(name?: unknown): void {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify(name === undefined ? {} : { name }));
  }

  it("says the project has no scope when there is no package.json", () => {
    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "noPackageJson" }));
    expect(notice(outcome, projectDir)).toBe(`Not signed: ${projectDir} has no package.json, so the project has no scope.`);
  });

  it("gives the reason when package.json is not JSON", () => {
    fs.writeFileSync(path.join(projectDir, "package.json"), "{ not json");

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "unreadablePackageJson" }));
    const detail = (outcome as { detail?: string }).detail;
    expect(typeof detail).toBe("string");
    expect(detail).not.toBe("");
    expect(notice(outcome, projectDir)).toBe(`Not signed: ${projectDir}/package.json could not be read (${detail}), so the project has no scope.`);
  });

  it("gives the reason when package.json cannot be read", () => {
    fs.mkdirSync(path.join(projectDir, "package.json"));

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "unreadablePackageJson" }));
    const detail = (outcome as { detail?: string }).detail;
    expect(notice(outcome, projectDir)).toBe(`Not signed: ${projectDir}/package.json could not be read (${detail}), so the project has no scope.`);
    expect(detail).toContain("EISDIR");
  });

  it("says the package name has no scope", () => {
    writePackage("plain-name");

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "noScope" }));
    expect(notice(outcome, projectDir)).toBe("Not signed: the package name \"plain-name\" has no scope (expected @scope/name).");
  });

  it("says there is no scope when package.json has no name", () => {
    writePackage();

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "noScope" }));
    expect(notice(outcome, projectDir)).toMatch(/^Not signed: .* has no scope \(expected @scope\/name\)\.$/);
  });

  it("says there is no certificate for the scope", () => {
    writePackage("@other/proj");

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "noCertificate", scope: "@other" }));
    expect(notice(outcome, projectDir)).toBe(
      "Not signed: no signing certificate for scope '@other'. Create one with \"the-seed signing create-cert\"."
    );
  });

  it("names the date an expired certificate expired", () => {
    writePackage("@t/proj");
    jest.spyOn(Signing.prototype, "getCertInfo").mockReturnValue({
      isExpired: true,
      notAfter: new Date("2024-03-05T12:00:00Z"),
    } as unknown as ReturnType<Signing["getCertInfo"]>);

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual(expect.objectContaining({ kind: "unsigned", reason: "expired", scope: "@t" }));
    expect(notice(outcome, projectDir)).toBe(
      "Warning: not signed: the signing certificate for scope '@t' expired on 2024-03-05. Create a new one with \"the-seed signing create-cert --force\"."
    );
  });

  it("is signed, with no notice, for a scope with a valid certificate", () => {
    writePackage("@t/proj");

    const outcome = signingOutcome(projectDir, certDir);

    expect(outcome).toEqual({ kind: "signed", scope });
    expect(notice(outcome, projectDir)).toBeNull();
  });

  it("throws naming the certificate path when the certificate file cannot be parsed", () => {
    writePackage("@t/proj");
    const brokenConfig = makeScratch();
    const certPath = new Signing(brokenConfig).scopeCertPath(scope);
    writeFile(certPath, "this is not a certificate\n", 0o644);

    expect(() => signingOutcome(projectDir, brokenConfig)).toThrow(certPath);
  });

  it("throws naming the certificate path when the certificate file is empty", () => {
    writePackage("@t/proj");
    const brokenConfig = makeScratch();
    const certPath = new Signing(brokenConfig).scopeCertPath(scope);
    writeFile(certPath, "", 0o644);

    expect(() => signingOutcome(projectDir, brokenConfig)).toThrow(certPath);
  });

  it("throws naming the certificate path when the certificate file cannot be read", () => {
    if (!optionalExternalCheck("install-phase-unreadable-certificate", process.getuid?.() !== 0, "running as root, which can read any file")) return;
    writePackage("@t/proj");
    const brokenConfig = makeScratch();
    const certPath = new Signing(brokenConfig).scopeCertPath(scope);
    writeFile(certPath, fs.readFileSync(new Signing(certDir).scopeCertPath(scope)), 0o000);

    expect(() => signingOutcome(projectDir, brokenConfig)).toThrow(certPath);
  });
});

// ── signOutputs failures ────────────────────────────────────

describe("signOutputs failures", () => {
  const scope = "@t";
  let certDir: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);

  beforeAll(async () => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-phase-failure-cert-"));
    fs.writeFileSync(
      path.join(certDir, "config.json"),
      JSON.stringify({ prefix: "/unused", scopes: { [scope]: { author: { name: "Test User", email: "t@example.invalid", url: "" } } } })
    );
    await new Signing(certDir).createCert({ validityDays: 365, scope });
  });

  afterAll(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    lines = [];
  });

  it("a signing error fails at sign naming the file", async () => {
    if (!optionalExternalCheck("install-phase-unreadable-key", process.getuid?.() !== 0, "running as root, which can read any file")) return;
    // A copy of the certificate whose key file nobody can read
    const config = makeScratch();
    fs.cpSync(certDir, config, { recursive: true });
    const keyPath = new Signing(config).scopeKeyPath(scope);
    fs.chmodSync(keyPath, 0o000);
    const s = makeStage("native");
    const file = path.join(s.root, "bin", "tiny");
    writeFile(file, elfHeader(2, "tool"), 0o755);

    let error: Error | undefined;
    try {
      await signOutputs(groupsOf(s, "native"), scope, config, "native", undefined, log);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message.startsWith("signing failed on " + path.join(s.prefix, "bin", "tiny") + ": ")).toBe(true);
    expect(error!.message.length).toBeGreaterThan(("signing failed on " + path.join(s.prefix, "bin", "tiny") + ": ").length);
    expect(fs.existsSync(file + ".sig")).toBe(false);
  });

  it("a windows output that comes back with a detached signature throws naming the file", async () => {
    recognisePeByMagic();
    const s = makeStage("windows");
    const file = path.join(s.root, "bin", "tiny.exe");
    writeFile(file, peHeader(0x22), 0o755);
    jest.spyOn(Signing.prototype, "signFile").mockResolvedValue({
      filePath: file,
      signaturePath: file + ".sig",
      fingerprint: "SHA256:x",
      signatureType: "detached",
      warnings: [],
    });

    await expect(signOutputs(groupsOf(s, "windows"), scope, certDir, "windows", undefined, log)).rejects.toThrow(
      new Error("signing failed on " + path.join(s.prefix, "bin", "tiny.exe") + ": expected an embedded signature, got detached")
    );
  });

  it("adds that the file is not a valid PE file, and that a full build rebuilds it, when the addon does not recognise it", async () => {
    const s = makeStage("windows");
    const file = path.join(s.root, "bin", "tiny.exe");
    writeFile(file, peHeader(0x22), 0o755);
    jest.spyOn(Signing.prototype, "removeEmbeddedSignature").mockReturnValue(false);
    jest.spyOn(Signing.prototype, "detectBinaryFormat").mockReturnValue({ format: "other", subFormat: null });
    jest.spyOn(Signing.prototype, "signFile").mockResolvedValue({
      filePath: file,
      signaturePath: file + ".sig",
      fingerprint: "SHA256:x",
      signatureType: "detached",
      warnings: [],
    });

    let error: Error | undefined;
    try {
      await signOutputs(groupsOf(s, "windows"), scope, certDir, "windows", undefined, log);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    const display = path.join(s.prefix, "bin", "tiny.exe");
    expect(error!.message.startsWith("signing failed on " + display + ": expected an embedded signature, got detached")).toBe(true);
    expect(error!.message).toContain("not recognised as a valid PE file");
    expect(error!.message).toContain("a full build rebuilds it");
  });
});
