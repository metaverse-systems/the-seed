import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { withoutNativeComponent, nativeComponentPath } from "./helpers/NativeAbsent";
import { requiredLibTheSeedVersion } from "../src/Dependencies";

interface NativeComponentModule {
  NATIVE_COMPONENT_STEP: string;
  NATIVE_COMPONENT_PATH: string;
  packageRoot(): string;
  nativeComponentMessage(loadError?: string | null): string;
  NativeComponentMissingError: new (loadError?: string | null) => Error & { loadError: string | null };
  loadNativeComponent<T = unknown>(): T;
  requireNativeComponent(): void;
  resetNativeComponentForTests(): void;
}

const sharedLibraryError = "libthe-seed.so.1: cannot open shared object file: No such file or directory";
const root = path.resolve(__dirname, "..");

const expectedMessage =
  "The native component is not built; it is needed to sign or verify Windows programs, Mac programs and installers, to package, and for Windows builds. " +
  "Build it with: cd \"" +
  root +
  "\" && npm run build-addon (it needs a C++ compiler, make, python3, pkg-config and libthe-seed " +
  requiredLibTheSeedVersion +
  " or later, which \"the-seed dependencies install\" puts in the prefix).";

function loadModule(): NativeComponentModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded again inside each isolated registry
  return require("../src/NativeComponent") as NativeComponentModule;
}

function thrownBy(action: () => unknown): Error & { loadError?: string | null } {
  try {
    action();
  } catch (error) {
    return error as Error & { loadError?: string | null };
  }
  throw new Error("expected the call to throw");
}

describe("NativeComponent", () => {
  afterEach(() => {
    jest.dontMock(nativeComponentPath);
  });

  it("throws NativeComponentMissingError with the missing-component message when the component is absent", () => {
    withoutNativeComponent(() => {
      const mod = loadModule();
      mod.resetNativeComponentForTests();
      const error = thrownBy(() => mod.loadNativeComponent());
      expect(error).toBeInstanceOf(mod.NativeComponentMissingError);
      expect(error.name).toBe("NativeComponentMissingError");
      expect(error.message).toBe(mod.nativeComponentMessage());
      expect(error.loadError).toBeNull();
      mod.resetNativeComponentForTests();
    });
  });

  it("appends the first line of the loading error when the component fails to load", () => {
    withoutNativeComponent(() => {
      const mod = loadModule();
      mod.resetNativeComponentForTests();
      const error = thrownBy(() => mod.loadNativeComponent());
      expect(error).toBeInstanceOf(mod.NativeComponentMissingError);
      expect(error.message).toBe(expectedMessage + " Loading error: " + sharedLibraryError);
      expect(error.loadError).toBe(sharedLibraryError);
      mod.resetNativeComponentForTests();
    }, "fails-to-load");
  });

  it("uses only the first line of a multi-line loading error", () => {
    jest.isolateModules(() => {
      jest.doMock(
        nativeComponentPath,
        () => {
          throw new Error(sharedLibraryError + "\nRequire stack:\n- /somewhere/NativeComponent.js");
        },
        { virtual: true }
      );
      const mod = loadModule();
      mod.resetNativeComponentForTests();
      const error = thrownBy(() => mod.loadNativeComponent());
      expect(error.message).toBe(mod.nativeComponentMessage(sharedLibraryError));
      expect(error.message).toBe(expectedMessage + " Loading error: " + sharedLibraryError);
      expect(error.message).not.toContain("Require stack");
      expect(error.message).not.toContain("\n");
      expect(error.loadError).toBe(sharedLibraryError);
      mod.resetNativeComponentForTests();
    });
  });

  it("returns the real module when present, the same object on a second call, and requireNativeComponent does not throw", () => {
    jest.isolateModules(() => {
      let real: unknown = null;
      try {
        real = require(nativeComponentPath);
      } catch {
        // Where the component is not built, a stand-in module takes its place.
        const standIn = { listDependencies: () => [] };
        jest.doMock(nativeComponentPath, () => standIn, { virtual: true });
        real = standIn;
      }
      const mod = loadModule();
      mod.resetNativeComponentForTests();
      const first = mod.loadNativeComponent<unknown>();
      expect(first).toBe(real);
      expect(mod.loadNativeComponent<unknown>()).toBe(first);
      expect(() => mod.requireNativeComponent()).not.toThrow();
      mod.resetNativeComponentForTests();
    });
  });

  it("gives a one-line message naming the build step, the package root, the required version and the install command", () => {
    withoutNativeComponent(() => {
      const mod = loadModule();
      const message = mod.nativeComponentMessage();
      expect(message).not.toContain("\n");
      expect(message).toContain("npm run build-addon");
      expect(mod.NATIVE_COMPONENT_STEP).toBe("npm run build-addon");
      expect(mod.packageRoot()).toBe(root);
      expect(path.isAbsolute(mod.packageRoot())).toBe(true);
      expect(message).toContain("cd \"" + root + "\"");
      expect(message).toContain(requiredLibTheSeedVersion);
      expect(message).toContain("the-seed dependencies install");
      expect(message).toBe(expectedMessage);
    });
  });

  it("tries the load again on each call after a failure, and after resetNativeComponentForTests", () => {
    jest.isolateModules(() => {
      let requires = 0;
      jest.doMock(
        nativeComponentPath,
        () => {
          requires++;
          throw Object.assign(new Error("Cannot find module '" + nativeComponentPath + "'"), { code: "MODULE_NOT_FOUND" });
        },
        { virtual: true }
      );
      const mod = loadModule();
      mod.resetNativeComponentForTests();
      const first = thrownBy(() => mod.loadNativeComponent());
      const second = thrownBy(() => mod.loadNativeComponent());
      expect(second).toBeInstanceOf(mod.NativeComponentMissingError);
      expect(second.message).toBe(first.message);
      expect(requires).toBe(2);
      mod.resetNativeComponentForTests();
      const third = thrownBy(() => mod.loadNativeComponent());
      expect(third.message).toBe(first.message);
      expect(requires).toBe(3);
      mod.resetNativeComponentForTests();
    });
  });

  describe("in one long-running process", () => {
    // Runs the built module in a fresh Node process from a scratch copy of the package, so that the component
    // file can be absent at first and appear later, as when "npm run build-addon" runs while an editor is open.
    function scratchPackage(): string {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "native-retry-"));
      fs.cpSync(path.join(root, "dist"), path.join(scratch, "dist"), { recursive: true });
      fs.symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
      return scratch;
    }

    const NATIVE_RELATIVE = path.join("native", "build", "Release", "the_seed_native.node");

    interface Attempt {
      threw: boolean;
      name?: string;
      loadError?: string | null;
      message?: string;
      expected?: string;
      keys?: string[];
      same?: boolean;
    }

    // stages: the file to put in place before each attempt ("absent" removes it, "keep" leaves it as it is, since
    // a loaded component file must not be rewritten in place); the script counts the requires of the component
    // file and reports each attempt.
    function run(scratch: string, stages: Array<{ put: "absent" | "keep" | "garbage" | "stub" | "real" }>, stubLoader: boolean): { attempts: Attempt[]; requires: number } {
      const built = path.join(root, NATIVE_RELATIVE);
      const script =
        "const fs = require('fs'); const path = require('path'); const Module = require('module');" +
        "const scratch = " + JSON.stringify(scratch) + ";" +
        "const file = path.join(scratch, " + JSON.stringify(NATIVE_RELATIVE) + ");" +
        "fs.mkdirSync(path.dirname(file), { recursive: true });" +
        (stubLoader
          ? "Module._extensions['.node'] = (module, filename) => { const text = fs.readFileSync(filename, 'utf8');" +
            " if (!text.startsWith('stub')) { throw new Error(filename + ': invalid ELF header'); } module.exports = { stubOperation: () => 1 }; };"
          : "") +
        "let requires = 0; const load = Module._load;" +
        "Module._load = function (request, ...rest) { if (path.resolve(request) === file) { requires++; } return load.call(this, request, ...rest); };" +
        "const m = require(path.join(scratch, 'dist', 'NativeComponent.js'));" +
        "const stages = " + JSON.stringify(stages) + "; const attempts = []; let previous = null;" +
        "for (const stage of stages) {" +
        "  if (stage.put === 'keep') { }" +
        "  else if (stage.put === 'absent') { fs.rmSync(file, { force: true }); }" +
        "  else if (stage.put === 'garbage') { fs.writeFileSync(file, 'garbage'); }" +
        "  else if (stage.put === 'stub') { fs.writeFileSync(file, 'stub'); }" +
        "  else { fs.copyFileSync(" + JSON.stringify(built) + ", file); }" +
        "  try { const c = m.loadNativeComponent(); attempts.push({ threw: false, keys: Object.keys(c).sort(), same: previous === c }); previous = c; }" +
        "  catch (e) { attempts.push({ threw: true, name: e.name, loadError: e.loadError, message: e.message, expected: new m.NativeComponentMissingError(e.loadError).message }); }" +
        "}" +
        "console.log(JSON.stringify({ attempts, requires }));";
      const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      expect({ stderr: result.stderr, signal: result.signal }).toEqual({ stderr: "", signal: null });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as { attempts: Attempt[]; requires: number };
    }

    function expectMissing(attempt: Attempt, scratch: string, loadError: string | null): void {
      expect(attempt.threw).toBe(true);
      expect(attempt.name).toBe("NativeComponentMissingError");
      expect(attempt.message).toBe(attempt.expected);
      expect(attempt.message).toContain("The native component is not built");
      expect(attempt.message).toContain("cd \"" + scratch + "\" && npm run build-addon");
      if (loadError === null) {
        expect(attempt.loadError).toBeNull();
      } else {
        expect(attempt.loadError).toContain(loadError);
      }
    }

    it("loads the component once it appears after a failed load, and keeps it without requiring it again", () => {
      const scratch = scratchPackage();
      try {
        const outcome = run(scratch, [{ put: "absent" }, { put: "absent" }, { put: "stub" }, { put: "stub" }, { put: "absent" }], true);
        expect(outcome.attempts).toHaveLength(5);
        expectMissing(outcome.attempts[0], scratch, null);
        expectMissing(outcome.attempts[1], scratch, null);
        expect(outcome.attempts[2]).toEqual({ threw: false, keys: ["stubOperation"], same: false });
        expect(outcome.attempts[3]).toEqual({ threw: false, keys: ["stubOperation"], same: true });
        // Kept once loaded, even when the file goes away afterwards
        expect(outcome.attempts[4]).toEqual({ threw: false, keys: ["stubOperation"], same: true });
        // Two failed attempts and one successful load; the later calls answer from the kept component
        expect(outcome.requires).toBe(3);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("loads the component once a file that failed to load is replaced by one that loads", () => {
      const scratch = scratchPackage();
      try {
        const outcome = run(scratch, [{ put: "garbage" }, { put: "stub" }, { put: "stub" }], true);
        expectMissing(outcome.attempts[0], scratch, "invalid ELF header");
        expect(outcome.attempts[1]).toEqual({ threw: false, keys: ["stubOperation"], same: false });
        expect(outcome.attempts[2]).toEqual({ threw: false, keys: ["stubOperation"], same: true });
        expect(outcome.requires).toBe(2);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("loads the real built component after it was absent and after a file that failed to load", () => {
      const built = path.join(root, NATIVE_RELATIVE);
      if (!optionalExternalCheck("native-component", fs.existsSync(built), "native component not built")) return;
      const scratch = scratchPackage();
      try {
        const outcome = run(scratch, [{ put: "absent" }, { put: "garbage" }, { put: "real" }, { put: "keep" }], false);
        expectMissing(outcome.attempts[0], scratch, null);
        expect(outcome.attempts[1].threw).toBe(true);
        expect(outcome.attempts[1].name).toBe("NativeComponentMissingError");
        expect(outcome.attempts[1].loadError).toEqual(expect.any(String));
        expect(outcome.attempts[1].message).toBe(outcome.attempts[1].expected);
        expect(outcome.attempts[2].threw).toBe(false);
        expect(outcome.attempts[2].keys).toContain("listDependencies");
        expect(outcome.attempts[3]).toEqual({ threw: false, keys: outcome.attempts[2].keys, same: true });
        expect(outcome.requires).toBe(3);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  });

  it("gives the same build step as the report of the build helper", () => {
    withoutNativeComponent(() => {
      const mod = loadModule();
      const build = jest.requireActual<{ renderReport: (report: unknown) => string }>("../native/build.js");
      const text = build.renderReport({
        built: false,
        libraryVersion: null,
        libraryDir: null,
        missing: [{ name: "libthe-seed", state: "missing", detail: "", found: null }],
        buildOutput: null,
        prefix: { prefix: "/p", source: "default", configPath: "/p/config.json", note: null },
        packageRoot: mod.packageRoot(),
        requiredVersion: requiredLibTheSeedVersion
      });
      const stepLine = text.split("\n").find((line) => line.includes("To build it:"));
      expect(stepLine).toBeDefined();
      const reportStep = (stepLine as string).slice((stepLine as string).indexOf("then: ") + "then: ".length);
      expect(reportStep).toBe("cd \"" + mod.packageRoot() + "\" && " + mod.NATIVE_COMPONENT_STEP);
      expect(mod.nativeComponentMessage()).toContain(reportStep);
    });
  });

  describe("the component's operations and name", () => {
    const operations = [
      "listDependencies",
      "readResourcePak",
      "detectBinaryFormat",
      "peComputeDigest",
      "peEmbedSignature",
      "peExtractSignature",
      "peHasEmbeddedSignature",
      "peStripSignature",
      "machoPrepareSignature",
      "machoCompleteSignature",
      "machoStripSignature",
      "machoExtractSignature",
      "machoHasEmbeddedSignature",
      "machoListSlices",
      "msiComputeDigest",
      "msiEmbedSignature",
      "msiCheckSignature",
      "msiStripSignature",
      "msiExtractSignature",
      "msiHasEmbeddedSignature"
    ];
    const ownName = path.basename(__filename);

    function componentFile(): string {
      const relative = loadModule().NATIVE_COMPONENT_PATH;
      if (typeof relative !== "string") {
        throw new Error("NATIVE_COMPONENT_PATH is not exported by src/NativeComponent");
      }
      return path.resolve(root, relative);
    }

    function sourceFiles(directory: string): string[] {
      const found: string[] = [];
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          found.push(...sourceFiles(full));
        } else if (/\.(ts|js)$/.test(entry.name) && entry.name !== ownName) {
          found.push(full);
        }
      }
      return found;
    }

    function trackedFiles(): string[] {
      const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (listed.status === 0 && listed.stdout.length > 0) {
        return listed.stdout.split("\0").filter((name) => name.length > 0);
      }
      const walked: string[] = [];
      const walk = (relative: string): void => {
        const full = path.join(root, relative);
        if (!fs.existsSync(full)) {
          return;
        }
        if (fs.statSync(full).isDirectory()) {
          for (const entry of fs.readdirSync(full)) {
            if (entry !== "node_modules" && entry !== "build") {
              walk(path.join(relative, entry));
            }
          }
        } else {
          walked.push(relative);
        }
      };
      for (const top of ["src", "test", "scripts", "native", ".github", "README.md", "structure.md", "package.json"]) {
        walk(top);
      }
      return walked;
    }

    it("exports exactly the twenty operations", () => {
      const file = componentFile();
      if (!optionalExternalCheck("native-component", fs.existsSync(file), "native component not built")) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native component has no type declarations
      const component = require(file) as Record<string, unknown>;
      expect(Object.keys(component).sort()).toEqual([...operations].sort());
    });

    it("uses every operation of the loaded component as a property in src or test, not only declares it", () => {
      const file = componentFile();
      if (!optionalExternalCheck("native-component", fs.existsSync(file), "native component not built")) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native component has no type declarations
      const exported = Object.keys(require(file) as Record<string, unknown>).sort();
      expect(exported.length).toBeGreaterThan(0);
      const unused = exported.filter((name) => {
        const pattern = new RegExp("\\." + name + "\\b|\\[\\s*[\"']" + name + "[\"']\\s*\\]");
        return !["src", "test"].some((directory) =>
          sourceFiles(path.join(root, directory)).some((file) => pattern.test(fs.readFileSync(file, "utf8")))
        );
      });
      expect(unused).toEqual([]);
    });

    it("leaves no tracked file naming the old component", () => {
      const oldName = ["dependency", "lister"].join("_");
      const offenders = trackedFiles().filter((name) => {
        if (name === path.join("test", ownName)) {
          return false;
        }
        const full = path.join(root, name);
        return fs.existsSync(full) && fs.statSync(full).isFile() && fs.readFileSync(full).includes(oldName);
      });
      expect(offenders).toEqual([]);
    });

    it("reports the component missing in a tree that holds only the old-named file", () => {
      const built = fs.existsSync(path.join(root, "native", "build", "Release"))
        ? fs.readdirSync(path.join(root, "native", "build", "Release")).filter((name) => name.endsWith(".node"))
        : [];
      if (!optionalExternalCheck("native-component", built.length > 0, "native component not built")) return;
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "native-old-only-"));
      try {
        fs.cpSync(path.join(root, "dist"), path.join(scratch, "dist"), { recursive: true });
        fs.symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
        fs.mkdirSync(path.join(scratch, "native", "build", "Release"), { recursive: true });
        fs.copyFileSync(
          path.join(root, "native", "build", "Release", built[0]),
          path.join(scratch, "native", "build", "Release", ["dependency", "lister"].join("_") + ".node")
        );
        const script =
          "const m = require(" + JSON.stringify(path.join(scratch, "dist", "NativeComponent.js")) + ");" +
          "try { m.loadNativeComponent(); console.log(JSON.stringify({ threw: false })); }" +
          "catch (e) { console.log(JSON.stringify({ threw: true, name: e.name, loadError: e.loadError, message: e.message, expected: new m.NativeComponentMissingError(null).message })); }";
        const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
        expect(run.status).toBe(0);
        const outcome = JSON.parse(run.stdout) as { threw: boolean; name: string; loadError: string | null; message: string; expected: string };
        expect(outcome.threw).toBe(true);
        expect(outcome.name).toBe("NativeComponentMissingError");
        expect(outcome.loadError).toBeNull();
        expect(outcome.message).toBe(outcome.expected);
        expect(outcome.message).toContain("The native component is not built");
        expect(outcome.message).toContain("cd \"" + scratch + "\" && npm run build-addon");
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
});
