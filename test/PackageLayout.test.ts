import fs from "fs";
import os from "os";
import path from "path";
import Config from "../src/Config";
import Package from "../src/Package";
import Signing from "../src/Signing";
import { walkDependencies } from "../src/DependencyWalker";
import type { PackageResult } from "../src/types";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { haveCc, haveMingw, buildLibrary, buildProgram, buildWindows } from "./helpers/NativeTree";
import { writeProject, linkModule, readBound } from "./helpers/ScratchProjects";

// Packaging against scratch trees with the real addon. The libraries and programs are
// compiled directly with cc (or x86_64-w64-mingw32-gcc) into a cache directory once per
// distinct shape and copied into each case's tree, so no case compiles more than it must
// and no autotools build runs. Every package run is under a hard bound of 200 file reads.
//
// Choices the implementation has to match:
//  - a refusal resolves { success: false, message } and the message is also printed as
//    "Error: <message>";
//  - the signature of a packaged library is found beside the real file it resolves to, or
//    beside the name it was reached by (libtool-style links to it), and is written as
//    "<packaged name>.sig".

const BOUND_TIMEOUT = 5000;
const SCOPE = "@t";
const GREETING = "hello from greet";
const GREET_LIB = "lib_LTLIBRARIES = libgreet.la\n";
const HELLO_PROGRAM = "bin_PROGRAMS = hello\n";

const ccReason = "cc not found";
const mingwReason = "x86_64-w64-mingw32-gcc not found";
const ccAvailable = (): boolean => optionalExternalCheck("package-layout", haveCc(), ccReason);
const mingwAvailable = (): boolean => optionalExternalCheck("package-layout", haveMingw(), mingwReason);

interface LibrarySpec {
  libName: string;
  soname?: string;
  version: string;
  text: string;
}

describe("package layout", () => {
  let root: string;
  let cacheDir: string;
  let home: string;
  let configDir: string;
  let prefix: string;
  let prefixLib: string;
  let output: string;
  let originalHome: string | undefined;
  let pkg: Package;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let cached = 0;

  const greetDir = (): string => path.join(root, "greet");
  const helloDir = (): string => path.join(root, "hello");
  const logged = (): string[] => logSpy.mock.calls.map((call) => call.map(String).join(" "));
  const errored = (): string[] => errorSpy.mock.calls.map((call) => call.map(String).join(" "));
  const names = (dir: string): string[] => fs.readdirSync(dir).sort();

  // ── compiled trees, built once per shape in the cache ─────────────────

  const libraryCache = new Map<string, string>();
  const programCache = new Map<string, string>();

  /** A project directory in the cache holding src/.libs built from the spec. */
  function builtLibrary(spec: LibrarySpec): string {
    const key = JSON.stringify(spec);
    let dir = libraryCache.get(key);
    if (dir === undefined) {
      dir = path.join(cacheDir, "lib" + cached++);
      buildLibrary(dir, spec);
      libraryCache.set(key, dir);
    }
    return dir;
  }

  /** Path of a program in the cache that prints the text of each library it is linked against. */
  function builtProgram(program: string, library?: LibrarySpec): string {
    const key = program + JSON.stringify(library ?? null);
    let file = programCache.get(key);
    if (file === undefined) {
      const dir = path.join(cacheDir, "prog" + cached++);
      const libDirs = library ? [path.join(builtLibrary(library), "src", ".libs")] : [];
      file = buildProgram(dir, { program, libDirs, libs: library ? [library.libName] : [] });
      programCache.set(key, file);
    }
    return file;
  }

  const GREET_SPEC: LibrarySpec = { libName: "greet", soname: "libgreet.so.0", version: "0.0.0", text: GREETING };

  /** Copies a cached tree's src/.libs into a project, keeping links as links. */
  function copyLibs(from: string, to: string): void {
    const target = path.join(to, "src", ".libs");
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(path.join(from, "src", ".libs"), { withFileTypes: true })) {
      const source = path.join(from, "src", ".libs", entry.name);
      if (entry.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(source), path.join(target, entry.name));
      } else {
        fs.copyFileSync(source, path.join(target, entry.name));
      }
    }
  }

  /** The library project @t/greet (or another project) with a compiled library. */
  function writeLibraryProject(dir: string, packageName: string, spec: LibrarySpec, dependencies?: Record<string, string>): string {
    writeProject(dir, { name: packageName, makefileAm: `lib_LTLIBRARIES = lib${spec.libName}.la\n`, dependencies });
    copyLibs(builtLibrary(spec), dir);
    return path.join(dir, "src", ".libs");
  }

  /** The program project @t/hello with a compiled program linked against the library, when given. */
  function writeProgramProject(dir: string, dependencies: Record<string, string> | undefined, library?: LibrarySpec): string {
    writeProject(dir, { name: "@t/" + path.basename(dir), makefileAm: `bin_PROGRAMS = ${path.basename(dir)}\n`, dependencies });
    const libs = path.join(dir, "src", ".libs");
    fs.mkdirSync(libs, { recursive: true });
    const program = builtProgram(path.basename(dir), library);
    fs.copyFileSync(program, path.join(libs, path.basename(dir)));
    fs.chmodSync(path.join(libs, path.basename(dir)), 0o755);
    return path.join(libs, path.basename(dir));
  }

  // ── signing ──────────────────────────────────────────────────────────

  let signing: Signing | undefined;

  async function signer(): Promise<Signing> {
    if (signing === undefined) {
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ prefix, scopes: { [SCOPE]: { author: { name: "Test User", email: "t@example.invalid", url: "" } } } })
      );
      signing = new Signing(configDir);
      await signing.createCert({ validityDays: 365, scope: SCOPE });
      pkg = new Package(new Config(configDir));
    }
    return signing;
  }

  /** Signs the real library file in a .libs directory and makes the signature links beside its other names. */
  async function signLibrary(libs: string, realName: string, otherNames: string[]): Promise<void> {
    const signed = await (await signer()).signFile(path.join(libs, realName), { scope: SCOPE });
    expect(signed.signatureType).toBe("detached");
    for (const name of otherNames) {
      fs.symlinkSync(realName + ".sig", path.join(libs, name + ".sig"));
    }
  }

  // ── discovery as the recursive build sees it ─────────────────────────

  /** Runs the packaging under the hard bound of 200 file reads. */
  async function packageRun(dirs: string[]): Promise<PackageResult> {
    const bound = readBound(200);
    try {
      return await pkg.run(output, dirs);
    } finally {
      bound.restore();
    }
  }

  /**
   * The projects packaging reports equal the real locations walkDependencies finds from each
   * given project directory, merged in order and de-duplicated, with no project twice.
   */
  async function expectSameProjects(result: { projects: string[] }, dirs: string[]): Promise<void> {
    const expected: string[] = [];
    const bound = readBound(200);
    try {
      for (const dir of dirs) {
        const graph = await walkDependencies(dir);
        for (const project of graph.projects.keys()) {
          if (!expected.includes(project)) {
            expected.push(project);
          }
        }
      }
    } finally {
      bound.restore();
    }
    expect(result.projects).toEqual(expected);
    expect(new Set(result.projects).size).toBe(result.projects.length);
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pkglayout-")));
    cacheDir = path.join(root, "cache");
    home = path.join(root, "home");
    configDir = path.join(root, "config");
    prefix = path.join(root, "prefix");
    prefixLib = path.join(prefix, "x86_64-linux-gnu", "lib");
    output = path.join(root, "out");
    fs.mkdirSync(home);
    fs.mkdirSync(configDir);
    fs.mkdirSync(cacheDir);
    fs.mkdirSync(prefixLib, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix, scopes: {} }));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    libraryCache.clear();
    programCache.clear();
    signing = undefined;
    pkg = new Package(new Config(configDir));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── a program and its library ────────────────────────────────────────

  /** The package holds the program and exactly one library file: the content of greet's build. */
  function expectProgramAndGreetBuild(): void {
    const all = names(output);
    expect(all).toHaveLength(2);
    expect(all).toContain("hello");
    const library = all.filter((name) => name !== "hello")[0];
    const built = path.join(greetDir(), "src", ".libs", "libgreet.so.0.0.0");
    expect(fs.readFileSync(path.join(output, library)).equals(fs.readFileSync(built))).toBe(true);
  }

  it("packages a program with its library declared by local path and not installed, and the package holds both", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expectProgramAndGreetBuild();
    expect(result.projects).toEqual(expect.arrayContaining([helloDir(), greetDir()]));
    await expectSameProjects(result, [helloDir()]);
  }, BOUND_TIMEOUT);

  it("packages a program with its library declared through a node_modules link, and the package holds both", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "^0.0.0" }, GREET_SPEC);
    linkModule(helloDir(), "@t/greet", "../../../greet");

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expectProgramAndGreetBuild();
    expect(result.projects).toEqual(expect.arrayContaining([helloDir(), greetDir()]));
    await expectSameProjects(result, [helloDir()]);
  }, BOUND_TIMEOUT);

  it("packages the library once, and lists the project once, when it is declared both ways to one directory", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet", "@t/greet-link": "^0.0.0" }, GREET_SPEC);
    linkModule(helloDir(), "@t/greet-link", "../../../greet");

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expectProgramAndGreetBuild();
    expect(result.projects.filter((project) => project === greetDir())).toHaveLength(1);
    await expectSameProjects(result, [helloDir()]);
  }, BOUND_TIMEOUT);

  it("merges given directories by real location: a library declared by the program and also given is listed once", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);

    const result = await packageRun([helloDir(), greetDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(result.projects.filter((project) => project === greetDir())).toHaveLength(1);
    expectProgramAndGreetBuild();
    await expectSameProjects(result, [helloDir(), greetDir()]);
  }, BOUND_TIMEOUT);

  // ── the same projects as the recursive build ─────────────────────────

  it("packages a diamond tree from its root with the shared component once, and the same projects the walker finds", async () => {
    if (!ccAvailable()) return;
    const root0 = helloDir();
    writeProgramProject(root0, { "@t/s1": "file:../s1", "@t/s2": "file:../s2" });
    writeProject(path.join(root, "s1"), { name: "@t/s1", makefileAm: "lib_LTLIBRARIES = libs1.la\n", dependencies: { "@t/comp": "file:../comp" } });
    writeProject(path.join(root, "s2"), { name: "@t/s2", makefileAm: "lib_LTLIBRARIES = libs2.la\n", dependencies: { "@t/comp": "file:../comp" } });
    writeProject(path.join(root, "comp"), { name: "@t/comp", makefileAm: "lib_LTLIBRARIES = libcomp.la\n" });

    const result = await packageRun([root0]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(result.projects).toHaveLength(4);
    expect(result.projects.filter((project) => project === path.join(root, "comp"))).toHaveLength(1);
    await expectSameProjects(result, [root0]);
  }, BOUND_TIMEOUT);

  it("refuses a local-path library and a separate copy under one name, naming both real locations, and writes nothing", async () => {
    // No compiled file is needed: discovery refuses before any output is looked for.
    writeProject(greetDir(), { name: "@t/greet", makefileAm: GREET_LIB });
    writeProject(helloDir(), {
      name: "@t/hello",
      makefileAm: HELLO_PROGRAM,
      dependencies: { "greet-local": "file:../greet", "@t/greet": "^0.0.0" },
    });
    const copy = path.join(helloDir(), "node_modules", "@t", "greet");
    writeProject(copy, { name: "@t/greet", makefileAm: GREET_LIB });

    const result = await packageRun([helloDir()]);

    expect(result.success).toBe(false);
    const message = result.message ?? "";
    expect(message).toContain("@t/greet");
    expect(message).toContain(greetDir());
    expect(message).toContain(copy);
    expect(message.indexOf(greetDir())).toBeLessThan(message.indexOf(copy));
    expect(errored()).toEqual(["Error: " + message]);
    expect(fs.existsSync(output)).toBe(false);
  }, BOUND_TIMEOUT);

  // ── cycles and self-declaration through packaging ────────────────────

  it("refuses a three-project cycle, partly through a node_modules link, naming the three, and writes nothing", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const c = path.join(root, "c");
    writeProject(a, { name: "@t/a", makefileAm: GREET_LIB, dependencies: { "@t/b": "file:../b" } });
    writeProject(b, { name: "@t/b", makefileAm: GREET_LIB, dependencies: { "@t/c": "^1.0.0" } });
    writeProject(c, { name: "@t/c", makefileAm: GREET_LIB, dependencies: { "@t/a": "file:../a" } });
    linkModule(b, "@t/c", "../../../c");

    const result = await packageRun([a]);

    expect(result.success).toBe(false);
    const message = result.message ?? "";
    expect(message.split("\n")[0]).toBe("Dependency cycle: @t/a → @t/b → @t/c → @t/a");
    expect(errored()).toEqual(["Error: " + message]);
    expect(fs.existsSync(output)).toBe(false);
  }, BOUND_TIMEOUT);

  it("refuses a project that declares itself with the cycle-of-one text and writes nothing", async () => {
    const s = path.join(root, "s");
    writeProject(s, { name: "@t/s", makefileAm: GREET_LIB, dependencies: { "@t/s": "file:." } });

    const result = await packageRun([s]);

    expect(result.success).toBe(false);
    expect((result.message ?? "").split("\n")[0]).toBe("Dependency cycle: @t/s → @t/s");
    expect(fs.existsSync(output)).toBe(false);
  }, BOUND_TIMEOUT);

  // ── the count ────────────────────────────────────────────────────────

  it("counts every entry in the output directory, signatures included, in the result and the summary line", async () => {
    if (!ccAvailable()) return;
    const libs = writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    await signLibrary(libs, "libgreet.so.0.0.0", ["libgreet.so.0", "libgreet.so"]);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toHaveLength(3);
    expect(names(output)).toContain("hello");
    expect(result.fileCount).toBe(fs.readdirSync(output).length);
    expect(result.fileCount).toBe(3);
    expect(result.signatures).toBe(1);
    expect(logged()).toContain(`Packaged 3 files into ${output}/ (1 signature included)`);
    await expectSameProjects(result, [helloDir()]);
  }, 20000);

  // ── Windows names ────────────────────────────────────────────────────

  it("keeps the Windows names: the DLL project packages as libgreet-0.dll and the program as hello.exe (guard)", async () => {
    if (!mingwAvailable()) return;
    writeProject(greetDir(), { name: "@t/greet", makefileAm: GREET_LIB });
    buildWindows(greetDir(), { libName: "greet", text: GREETING });
    writeProject(helloDir(), { name: "@t/hello", makefileAm: HELLO_PROGRAM, dependencies: { "@t/greet": "^0.0.0" } });
    linkModule(helloDir(), "@t/greet", "../../../greet");
    // The program is linked against its own copy of the library built beside it; only the program is kept
    const scratch = path.join(cacheDir, "windows");
    const built = buildWindows(scratch, { libName: "greet", text: GREETING, program: "hello" });
    fs.mkdirSync(path.join(helloDir(), "src", ".libs"), { recursive: true });
    fs.copyFileSync(built.exe as string, path.join(helloDir(), "src", ".libs", "hello.exe"));

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello.exe", "libgreet-0.dll"]);
    await expectSameProjects(result, [helloDir()]);
  }, BOUND_TIMEOUT);
});
