/*
 * The declared public surface of the package: the `exports` map of package.json.
 *
 * Interfaces fixed here:
 * - The expected keys are written out in this file. Adding a public module means adding it to
 *   `EXPECTED_SUBPATHS`, to the README table and to `package.json` in one change.
 * - Every module key maps to `{ "types": "./dist/<X>.d.ts", "default": "./dist/<X>.js" }`;
 *   `./Hints` maps to `dist/cli/Hints`; `./package.json` maps to the file itself.
 * - The suite needs a built tree (`dist/index.js`), as the packed-file suite does; it fails with a
 *   message saying so when the build is missing.
 * - Resolution is tested the way a consumer meets it: a scratch directory whose
 *   `node_modules/@metaverse-systems/the-seed` is a symbolic link to this package. A child `node`
 *   process requires each subpath (runtime), and the TypeScript compiler API compiles a file that
 *   imports each subpath with `module` and `moduleResolution` set to `node16` and `strict` (types).
 * - `EXTENSION_MODULES` is the list of modules the VS Code extension (the-seed-vscode) imports.
 *   The public modules, apart from the entry point and the manifest, must equal it; the extension's
 *   own compile is the live check of the other direction.
 * - Cases that must fail on a tree without `exports`: keys, targets, refusal at run time and
 *   refusal at compile time. The extension list case is a guard.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import * as ts from "typescript";

const packageRoot = path.resolve(__dirname, "..");
const PACKAGE_NAME = "@metaverse-systems/the-seed";

const MODULES = [
  "Build",
  "Config",
  "Dependencies",
  "DependencyWalker",
  "Hints",
  "Installer",
  "NativeComponent",
  "Package",
  "ProjectError",
  "RecursiveBuild",
  "ResourcePak",
  "Scopes",
  "Signing",
  "Template",
  "types",
];

/** The modules the editor extension (the-seed-vscode) imports from the package. */
const EXTENSION_MODULES = [...MODULES];

const EXPECTED_SUBPATHS = [".", ...MODULES.map((name) => "./" + name), "./package.json"];

/** Where a subpath's compiled file lives below `dist/`. */
function distName(subpath: string): string {
  if (subpath === ".") return "index";
  const name = subpath.slice(2);
  return name === "Hints" ? "cli/Hints" : name;
}

/** The specifier a consumer writes for a subpath. */
function specifier(subpath: string): string {
  return subpath === "." ? PACKAGE_NAME : PACKAGE_NAME + "/" + subpath.slice(2);
}

const REFUSED = ["dist/Config", "dist/StepRunner", "dist/cli/Hints"];

interface PackageJson {
  exports?: Record<string, unknown>;
}

function readPackage(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as PackageJson;
}

const scratchDirs: string[] = [];

function consumerDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-surface-"));
  scratchDirs.push(dir);
  fs.mkdirSync(path.join(dir, "node_modules", "@metaverse-systems"), { recursive: true });
  fs.symlinkSync(packageRoot, path.join(dir, "node_modules", PACKAGE_NAME), "dir");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  return dir;
}

interface LoadResult {
  ok: boolean;
  code: string | null;
}

/** Requires each specifier in a child process started in `cwd`; reports success or the error code. */
function requireAll(cwd: string, specifiers: string[]): Record<string, LoadResult> {
  const script =
    "const out = {};" +
    "for (const s of JSON.parse(process.argv[1])) {" +
    "  try { require(s); out[s] = { ok: true, code: null }; }" +
    "  catch (e) { out[s] = { ok: false, code: (e && e.code) || String(e) }; }" +
    "}" +
    "process.stdout.write(JSON.stringify(out));";
  const result = spawnSync(process.execPath, ["-e", script, JSON.stringify(specifiers)], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("child node failed: " + result.stderr);
  return JSON.parse(result.stdout) as Record<string, LoadResult>;
}

/** Compiles one file of imports with node16 resolution and returns the diagnostics' codes. */
function compileImports(cwd: string, name: string, specifiers: string[]): number[] {
  const file = path.join(cwd, name);
  fs.writeFileSync(file, specifiers.map((s, index) => `import * as m${index} from "${s}";\nvoid m${index};\n`).join(""));
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
  });
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error("the consumer file could not be read");
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map((diagnostic) => diagnostic.code);
}

describe("public surface", () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(packageRoot, "dist", "index.js"))) {
      throw new Error("dist/index.js is missing: run `npm run build` before this suite");
    }
  });

  afterAll(() => {
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("exports declares exactly the entry point, the public modules and the manifest", () => {
    const exportsMap = readPackage().exports;
    expect(exportsMap).toBeDefined();
    expect(Object.keys(exportsMap ?? {})).toEqual(EXPECTED_SUBPATHS);
  });

  test("every module entry names its declaration file and its compiled file", () => {
    const exportsMap = readPackage().exports ?? {};
    for (const subpath of EXPECTED_SUBPATHS) {
      if (subpath === "./package.json") {
        expect({ subpath, entry: exportsMap[subpath] }).toEqual({ subpath, entry: "./package.json" });
        continue;
      }
      const base = "./dist/" + distName(subpath);
      expect({ subpath, entry: exportsMap[subpath] }).toEqual({ subpath, entry: { types: base + ".d.ts", default: base + ".js" } });
    }
  });

  test("every target exists after a build", () => {
    const exportsMap = readPackage().exports ?? {};
    const targets: string[] = [];
    for (const entry of Object.values(exportsMap)) {
      if (typeof entry === "string") targets.push(entry);
      else if (entry !== null && typeof entry === "object") {
        for (const target of Object.values(entry as Record<string, unknown>)) if (typeof target === "string") targets.push(target);
      }
    }
    expect(targets.length).toBeGreaterThan(0);
    const missing = targets.filter((target) => !fs.existsSync(path.join(packageRoot, target)));
    expect(missing).toEqual([]);
  });

  test("every public subpath loads from a consumer directory", () => {
    const results = requireAll(consumerDirectory(), EXPECTED_SUBPATHS.map(specifier));
    const failed = Object.entries(results)
      .filter(([, result]) => !result.ok)
      .map(([name, result]) => `${name}: ${result.code}`);
    expect(failed).toEqual([]);
    expect(Object.keys(results)).toHaveLength(EXPECTED_SUBPATHS.length);
  });

  test("paths under dist are refused at run time", () => {
    const results = requireAll(
      consumerDirectory(),
      REFUSED.map((name) => PACKAGE_NAME + "/" + name),
    );
    for (const name of REFUSED) {
      expect({ name, result: results[PACKAGE_NAME + "/" + name] }).toEqual({
        name,
        result: { ok: false, code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
      });
    }
  });

  test("a file importing every public subpath compiles with node16 resolution", () => {
    const codes = compileImports(consumerDirectory(), "all.ts", EXPECTED_SUBPATHS.filter((s) => s !== "./package.json").map(specifier));
    expect(codes).toEqual([]);
  });

  test("a file importing a path under dist does not compile (TS2307)", () => {
    for (const name of REFUSED) {
      const codes = compileImports(consumerDirectory(), "refused.ts", [PACKAGE_NAME + "/" + name]);
      expect({ name, codes }).toEqual({ name, codes: [2307] });
    }
  });

  test("the public modules are the modules the extension imports", () => {
    const exportsMap = readPackage().exports ?? {};
    const modules = Object.keys(exportsMap)
      .filter((subpath) => subpath !== "." && subpath !== "./package.json")
      .map((subpath) => subpath.slice(2))
      .sort();
    expect(modules).toEqual([...EXTENSION_MODULES].sort());
  });

  test("the extension's imports, read from its source, are the listed modules (before and after its import lines change)", () => {
    const extensionSrc = path.resolve(packageRoot, "..", "the-seed-vscode", "src");
    if (!fs.existsSync(extensionSrc)) return;
    const found = new Set<string>();
    const pattern = /from\s+['"]@metaverse-systems\/the-seed\/(?:dist\/)?(?:cli\/)?([A-Za-z]+)['"]/g;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          for (const match of fs.readFileSync(full, "utf-8").matchAll(pattern)) found.add(match[1]);
        }
      }
    };
    walk(extensionSrc);
    expect([...found].sort()).toEqual([...EXTENSION_MODULES].sort());
  });
});
