import fs from "fs";
import os from "os";
import path from "path";
import { readElfNames } from "../src/ElfNames";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { elfImage, ElfImageOptions } from "./helpers/ElfImage";
import { haveCc, buildLibrary, buildProgram } from "./helpers/NativeTree";

// Reading loadable names from ELF files.
//
// Choices the implementation has to match:
//  - the error for a malformed file starts with "<path>: ELF " and then names the structure that
//    is out of bounds: "program header table" for a table offset past the end of the file,
//    "string table" for a string table address no segment covers, and "name" for a name offset
//    outside the string table (matched case-insensitively);
//  - a file that is not ELF (no magic) gives null without reading further.

const BINARIES = path.join(__dirname, "fixtures", "binaries");

describe("readElfNames", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elfnames-")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(name: string, content: Buffer | string): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, content);
    return file;
  }

  const shapes: [string, ElfImageOptions["bits"], ElfImageOptions["endian"]][] = [
    ["ELF64 little-endian", 64, "little"],
    ["ELF32 little-endian", 32, "little"],
    ["ELF64 big-endian", 64, "big"],
  ];

  describe.each(shapes)("%s", (_title, bits, endian) => {
    it("reads the soname and the needed names in order", () => {
      const file = write("lib.so", elfImage({ bits, endian, type: "dyn", soname: "libgreet.so.0", needed: ["libz.so.1", "libc.so.6", "libm.so.6"] }));

      expect(readElfNames(file)).toEqual({ soname: "libgreet.so.0", needed: ["libz.so.1", "libc.so.6", "libm.so.6"] });
    });

    it("gives a null soname when there is none and keeps the needed names in order", () => {
      const file = write("prog", elfImage({ bits, endian, type: "exec", needed: ["libgreet.so.0", "libc.so.6"] }));

      expect(readElfNames(file)).toEqual({ soname: null, needed: ["libgreet.so.0", "libc.so.6"] });
    });

    it("gives a null soname and no needed names when the dynamic section is empty of names", () => {
      const file = write("bare.so", elfImage({ bits, endian, type: "dyn" }));

      expect(readElfNames(file)).toEqual({ soname: null, needed: [] });
    });

    it("gives { soname: null, needed: [] } when there is no dynamic segment", () => {
      const file = write("static", elfImage({ bits, endian, type: "exec", dynamic: false }));

      expect(readElfNames(file)).toEqual({ soname: null, needed: [] });
    });

    it.each(["phoff", "strtab", "name"] as const)("throws an error naming the file and the structure for a corrupt %s", (corrupt) => {
      const file = write("broken.so", elfImage({ bits, endian, type: "dyn", soname: "libgreet.so.0", needed: ["libc.so.6"], corrupt }));
      const structure = { phoff: /program header/i, strtab: /string table/i, name: /name/i }[corrupt];

      let thrown: unknown;
      try {
        readElfNames(file);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith(file + ": ELF ")).toBe(true);
      expect(message).toMatch(structure);
    });
  });

  describe("files that are not ELF", () => {
    it("gives null for a text file", () => {
      expect(readElfNames(write("notes.txt", "just some text, not a binary\n"))).toBeNull();
    });

    it("gives null for an empty file", () => {
      expect(readElfNames(write("empty", ""))).toBeNull();
    });

    it("gives null for the PE fixture", () => {
      expect(readElfNames(path.join(BINARIES, "tiny.exe"))).toBeNull();
    });

    it("gives null for a Mach-O fixture", () => {
      expect(readElfNames(path.join(BINARIES, "genuine", "tiny-macho-x86_64"))).toBeNull();
    });
  });

  describe("files built by cc", () => {
    it("reads the given soname from a library and the needed names a program records, equal to the addon's bare keys", () => {
      if (!optionalExternalCheck("elf-names", haveCc(), "cc not found")) return;
      const libraryDir = path.join(root, "greet");
      const programDir = path.join(root, "hello");
      buildLibrary(libraryDir, { libName: "greet", soname: "libgreet.so.0", version: "0.0.0", text: "hello from greet" });
      const program = buildProgram(programDir, { program: "hello", libDirs: [path.join(libraryDir, "src", ".libs")], libs: ["greet"] });

      const library = readElfNames(path.join(libraryDir, "src", ".libs", "libgreet.so.0.0.0"));
      const names = readElfNames(program);

      expect(library?.soname).toBe("libgreet.so.0");
      expect(names?.soname).toBeNull();
      // With an empty search path the addon reports each needed name as a bare key.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require("../native/build/Release/dependency_lister.node") as {
        listDependencies(binaryPaths: string[], searchPaths: string[]): { dependencies: Record<string, string[]> };
      };
      const keys = Object.keys(addon.listDependencies([program], []).dependencies).sort();
      expect([...(names?.needed ?? [])].sort()).toEqual(keys);
      expect(names?.needed).toContain("libgreet.so.0");
    });
  });
});
