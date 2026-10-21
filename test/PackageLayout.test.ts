import fs from "fs";
import os from "os";
import path from "path";
import Config from "../src/Config";
import Package from "../src/Package";
import Signing from "../src/Signing";
import { walkDependencies } from "../src/DependencyWalker";
import type { PackageResult } from "../src/types";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { haveCc, haveMingw, buildLibrary, buildProgram, buildWindows, installLibrary, runFrom } from "./helpers/NativeTree";
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
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── a program and its library ────────────────────────────────────────

  /** After the package is written, the project directories and the prefix are moved away and the program is run from the package. */
  function expectRunsFromPackage(): void {
    for (const [directory, moved] of [[greetDir(), "moved-greet"], [helloDir(), "moved-hello"], [prefix, "moved-prefix"]]) {
      if (fs.existsSync(directory)) {
        fs.renameSync(directory, path.join(root, moved));
      }
    }
    expect(runFrom(output, "hello")).toEqual({ status: 0, output: GREETING + "\n" });
  }

  /** Installs a cached library in the scratch prefix with the links libtool's install makes. */
  function installInPrefix(spec: LibrarySpec, links: string[]): string {
    const real = path.join(builtLibrary(spec), "src", ".libs", `lib${spec.libName}.so.${spec.version}`);
    return installLibrary(prefixLib, real, links);
  }

  /** Two library projects @t/a and @t/b building libfoo.so.1, declared by the program hello. */
  function writeTwoFooProjects(textA: string, textB: string): { a: string; b: string; libsA: string; libsB: string } {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const libsA = writeLibraryProject(a, "@t/a", { libName: "foo", soname: "libfoo.so.1", version: "1.0.0", text: textA });
    const libsB = writeLibraryProject(b, "@t/b", { libName: "foo", soname: "libfoo.so.1", version: "1.0.0", text: textB });
    writeProgramProject(helloDir(), { "@t/a": "file:../a", "@t/b": "file:../b" });
    return { a, b, libsA, libsB };
  }

  it("packages a program with its library declared by local path and not installed, and the package runs on its own", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(result.projects).toEqual(expect.arrayContaining([helloDir(), greetDir()]));
    await expectSameProjects(result, [helloDir()]);
    expectRunsFromPackage();
  }, BOUND_TIMEOUT);

  it("packages a program with its library declared through a node_modules link, and the package runs on its own", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "^0.0.0" }, GREET_SPEC);
    linkModule(helloDir(), "@t/greet", "../../../greet");

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(result.projects).toEqual(expect.arrayContaining([helloDir(), greetDir()]));
    await expectSameProjects(result, [helloDir()]);
    expectRunsFromPackage();
  }, BOUND_TIMEOUT);

  it("packages the library once, and lists the project once, when it is declared both ways to one directory", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet", "@t/greet-link": "^0.0.0" }, GREET_SPEC);
    linkModule(helloDir(), "@t/greet-link", "../../../greet");

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(result.projects.filter((project) => project === greetDir())).toHaveLength(1);
    await expectSameProjects(result, [helloDir()]);
    expectRunsFromPackage();
  }, BOUND_TIMEOUT);

  it("merges given directories by real location: a library declared by the program and also given is listed once", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);

    const result = await packageRun([helloDir(), greetDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(result.projects.filter((project) => project === greetDir())).toHaveLength(1);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    await expectSameProjects(result, [helloDir(), greetDir()]);
  }, BOUND_TIMEOUT);

  it("packages a library project under its soname as a regular file with the library's content", async () => {
    if (!ccAvailable()) return;
    const libs = writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);

    const result = await packageRun([greetDir()]);

    expect(result.success).toBe(true);
    expect(names(output)).toEqual(["libgreet.so.0"]);
    const packaged = path.join(output, "libgreet.so.0");
    expect(fs.lstatSync(packaged).isFile()).toBe(true);
    expect(fs.readFileSync(packaged).equals(fs.readFileSync(path.join(libs, "libgreet.so.0.0.0")))).toBe(true);
    expect(result.fileCount).toBe(1);
    await expectSameProjects(result, [greetDir()]);
  }, BOUND_TIMEOUT);

  it("packages a library without a soname as libgreet.so (guard: names without a soname are kept)", async () => {
    if (!ccAvailable()) return;
    const spec: LibrarySpec = { libName: "greet", version: "0.0.0", text: GREETING };
    const libs = writeLibraryProject(greetDir(), "@t/greet", spec);

    const result = await packageRun([greetDir()]);

    expect(result.success).toBe(true);
    expect(names(output)).toEqual(["libgreet.so"]);
    expect(fs.lstatSync(path.join(output, "libgreet.so")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(output, "libgreet.so")).equals(fs.readFileSync(path.join(libs, "libgreet.so.0.0.0")))).toBe(true);
  }, BOUND_TIMEOUT);

  it("packages a library installed in the prefix under its soname, not its fully versioned name", async () => {
    if (!ccAvailable()) return;
    writeProgramProject(helloDir(), undefined, GREET_SPEC);
    installInPrefix(GREET_SPEC, ["libgreet.so.0", "libgreet.so"]);

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(fs.lstatSync(path.join(output, "libgreet.so.0")).isFile()).toBe(true);
    await expectSameProjects(result, [helloDir()]);
    expectRunsFromPackage();
  }, BOUND_TIMEOUT);

  it("packages a program and a library project given together, with the library installed too, once and without a collision", async () => {
    if (!ccAvailable()) return;
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), undefined, GREET_SPEC);
    installInPrefix(GREET_SPEC, ["libgreet.so.0", "libgreet.so"]);

    const result = await packageRun([helloDir(), greetDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(errored()).toEqual([]);
    await expectSameProjects(result, [helloDir(), greetDir()]);
    expectRunsFromPackage();
  }, BOUND_TIMEOUT);

  it("packages only the file the soname resolves to when several version names exist", async () => {
    if (!ccAvailable()) return;
    const previousBuild: LibrarySpec = { libName: "greet", soname: "libgreet.so.1", version: "1.0.0", text: "from an earlier build" };
    const olderInstall: LibrarySpec = { libName: "greet", soname: "libgreet.so.0", version: "0.0.1", text: "older than the current one" };
    const libs = writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    // An earlier build's real file, with no link to it
    fs.copyFileSync(path.join(builtLibrary(previousBuild), "src", ".libs", "libgreet.so.1.0.0"), path.join(libs, "libgreet.so.1.0.0"));
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);
    // The prefix: the current library linked from its soname, beside an unlinked older one
    installInPrefix(GREET_SPEC, ["libgreet.so.0", "libgreet.so"]);
    installInPrefix(olderInstall, []);

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(fs.readFileSync(path.join(output, "libgreet.so.0")).equals(fs.readFileSync(path.join(libs, "libgreet.so.0.0.0")))).toBe(true);
    await expectSameProjects(result, [helloDir()]);
    expectRunsFromPackage();
  }, BOUND_TIMEOUT);

  it("copies a signed library's signature under the loadable name and the copy verifies", async () => {
    if (!ccAvailable()) return;
    const libs = writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    await signLibrary(libs, "libgreet.so.0.0.0", ["libgreet.so.0", "libgreet.so"]);

    const result = await packageRun([greetDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["libgreet.so.0", "libgreet.so.0.sig"]);
    expect((await (await signer()).verifyFile(path.join(output, "libgreet.so.0"))).status).toBe("VALID");
    expect(result.signatures).toBe(1);
  }, 20000);

  it("lists the libraries a program needs that are neither installed nor declared, and prints them", async () => {
    if (!ccAvailable()) return;
    writeProgramProject(helloDir(), undefined, GREET_SPEC);

    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello"]);
    expect(result.notPackaged).toEqual(expect.arrayContaining([{ name: "libgreet.so.0", neededBy: "hello" }]));
    expect(result.notPackaged.some((library) => library.name === "libc.so.6")).toBe(true);
    const lines = logged();
    const heading = lines.indexOf("Not packaged (expected on the target system):");
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(lines.slice(heading + 1)).toContain("  libgreet.so.0 (needed by hello)");
  }, BOUND_TIMEOUT);

  it("prints the not-packaged lines after the summary, sorted by name, and does not list a library declared by local path", async () => {
    if (!ccAvailable()) return;
    writeProgramProject(helloDir(), undefined, GREET_SPEC);

    const missing = await packageRun([helloDir()]);

    expect(missing.success).toBe(true);
    const lines = logged();
    const summary = lines.findIndex((line) => line.startsWith("Packaged "));
    const heading = lines.indexOf("Not packaged (expected on the target system):");
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(heading).toBeGreaterThan(summary);
    const listed = lines.slice(heading + 1).filter((line) => /^ {2}\S+ \(needed by /.test(line));
    expect(listed.length).toBe(missing.notPackaged.length);
    expect(listed.map((line) => line.trim().split(" ")[0])).toEqual(missing.notPackaged.map((library) => library.name));
    expect(missing.notPackaged.map((library) => library.name)).toEqual(missing.notPackaged.map((library) => library.name).sort());

    fs.rmSync(output, { recursive: true, force: true });
    logSpy.mockClear();
    writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);

    const declared = await packageRun([helloDir()]);

    expect([declared.success, declared.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libgreet.so.0"]);
    expect(declared.notPackaged.some((library) => library.name === "libgreet.so.0")).toBe(false);
    expect(logged().some((line) => line.includes("libgreet.so.0 (needed by"))).toBe(false);
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

  // ── name collisions ───────────────────────────────────────────────────

  it("refuses two projects building different files named libfoo.so.1, naming both sources, and writes nothing", async () => {
    if (!ccAvailable()) return;
    const { libsA, libsB } = writeTwoFooProjects("foo from a", "foo from b");

    const result = await packageRun([helloDir()]);

    expect(result.success).toBe(false);
    const message = result.message ?? "";
    expect(message).toContain("Two different files would be packaged as libfoo.so.1:");
    expect(message).toContain(`${path.join(libsA, "libfoo.so.1.0.0")} (build of @t/a)`);
    expect(message).toContain(`${path.join(libsB, "libfoo.so.1.0.0")} (build of @t/b)`);
    expect(message.trimEnd().endsWith("Nothing was written.")).toBe(true);
    expect(errored()).toEqual(["Error: " + message]);
    expect(fs.existsSync(output)).toBe(false);
  }, BOUND_TIMEOUT);

  it("packages identical content under one name from two projects once, with the first project's source and signature (guard: no false collision)", async () => {
    if (!ccAvailable()) return;
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const spec: LibrarySpec = { libName: "foo", soname: "libfoo.so.1", version: "1.0.0", text: "foo" };
    const libsA = writeLibraryProject(a, "@t/a", spec);
    // The second project's .libs is a byte copy of the first's, links included, made before the first is signed
    const libsB = writeLibraryProject(b, "@t/b", spec);
    await signLibrary(libsA, "libfoo.so.1.0.0", ["libfoo.so.1", "libfoo.so"]);
    writeProgramProject(helloDir(), { "@t/a": "file:../a", "@t/b": "file:../b" });

    const plan = await pkg.plan([helloDir()]);
    const result = await packageRun([helloDir()]);

    expect([result.success, result.message]).toEqual([true, null]);
    expect(names(output)).toEqual(["hello", "libfoo.so.1", "libfoo.so.1.sig"]);
    if (!plan.ok) {
      throw new Error("plan refused: " + plan.message);
    }
    const planned = plan.files.filter((file) => file.name === "libfoo.so.1");
    expect(planned).toHaveLength(1);
    expect(planned[0].source).toBe(path.join(libsA, "libfoo.so.1.0.0"));
    expect(planned[0].origin).toEqual({ kind: "project", project: "@t/a", location: a });
    expect(fs.existsSync(path.join(libsB, "libfoo.so.1.0.0.sig"))).toBe(false);
    await expectSameProjects(result, [helloDir()]);
  }, 20000);

  it("refuses a build-tree copy that differs from the installed copy, naming both and the stale installed copy", async () => {
    if (!ccAvailable()) return;
    const stale: LibrarySpec = { ...GREET_SPEC, text: "an older greeting" };
    const libs = writeLibraryProject(greetDir(), "@t/greet", GREET_SPEC);
    writeProgramProject(helloDir(), { "@t/greet": "file:../greet" }, GREET_SPEC);
    const installed = installInPrefix(stale, ["libgreet.so.0", "libgreet.so"]);

    const result = await packageRun([helloDir()]);

    expect(result.success).toBe(false);
    const message = result.message ?? "";
    expect(message).toContain("Two different files would be packaged as libgreet.so.0:");
    expect(message).toContain(path.join(libs, "libgreet.so.0.0.0"));
    expect(message).toContain(installed);
    expect(message).toContain("The installed copy differs from the build of @t/greet");
    expect(message).toContain("install it again with \"the-seed build native\" in " + greetDir());
    expect(message).not.toContain("\\\"");
    expect(message.trimEnd().endsWith("Nothing was written.")).toBe(true);
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
    expect(names(output)).toEqual(["hello", "libgreet.so.0", "libgreet.so.0.sig"]);
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
