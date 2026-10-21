/*
 * The methods of the tool's seven classes are ordinary methods: they live on the prototype, and no
 * code in the tool or its tests depends on a method being bound to its instance.
 *
 * Interfaces fixed here:
 * - The scan (`test/helpers/DetachedUse.ts`) uses the TypeScript compiler API over the program of
 *   `tsconfig.test.json` (every `.ts` file under `src` and `test`) and resolves members through the
 *   type checker. It reports a reference to a function member of Build, Config, Scopes, Package,
 *   Template, ResourcePak or Installer that is not the callee of a call, a destructured member and
 *   a spread instance. Assignment to a member and access through `X.prototype` are not reported.
 *   The scan also runs over a small scratch program with known uses, so that a scan that finds
 *   nothing cannot pass by being broken, and it counts the references it examined per class.
 * - The public methods of each class are listed below by name. Private methods are covered by
 *   the case that an instance holds no function of its own.
 * - Instances are built with a scratch configuration directory.
 */
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";
import Build from "../src/Build";
import Config from "../src/Config";
import Installer from "../src/Installer";
import Package from "../src/Package";
import ResourcePak from "../src/ResourcePak";
import Scopes from "../src/Scopes";
import Template from "../src/Template";
import { describeUse, findDetachedUses, METHOD_CLASSES, programFromConfig } from "./helpers/DetachedUse";
import type { DetachedUseScan } from "./helpers/DetachedUse";

const PACKAGE_ROOT = path.resolve(__dirname, "..");

describe("method form", () => {
  let scratch: string;
  let config: Config;

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "method-form-")));
    config = new Config(path.join(scratch, "config"));
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe("detached use", () => {
    it("finds a method used without a call in a scratch program", () => {
      const dir = path.join(scratch, "program");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "Build.ts"),
        [
          "export default class Build {",
          "  field = (): number => 1;",
          "  method(): number { return 2; }",
          "  other = 3;",
          "}",
          "",
        ].join("\n")
      );
      fs.writeFileSync(
        path.join(dir, "use.ts"),
        [
          "import Build from \"./Build\";",
          "const build = new Build();",
          "export const called = [build.field(), build.method(), (build.method)(), build.other];",
          "export const read = build.field;",
          "export const passed = [1].map(build.method);",
          "export const bound = build.method.bind(build);",
          "export const indexed = build[\"field\"];",
          "export const { method } = build;",
          "export const copy = { ...build };",
          "export const viaPrototype = Build.prototype.method;",
          "build.field = (): number => 4;",
          "",
        ].join("\n")
      );
      const program = ts.createProgram([path.join(dir, "Build.ts"), path.join(dir, "use.ts")], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2015,
        module: ts.ModuleKind.CommonJS,
      });

      const scan = findDetachedUses(program, [dir]);

      const found = scan.detached.map((use) => path.basename(use.file) + ":" + use.line + " " + use.member + " " + use.how);
      expect(found).toEqual([
        "use.ts:4 Build.field used without a call",
        "use.ts:5 Build.method used without a call",
        "use.ts:6 Build.method used without a call",
        "use.ts:7 Build.field used without a call",
        "use.ts:8 Build.method destructured",
        "use.ts:9 an instance spread",
      ]);
    });

    describe("over the tool's sources and tests", () => {
      let scan: DetachedUseScan;

      beforeAll(() => {
        const program = programFromConfig(path.join(PACKAGE_ROOT, "tsconfig.test.json"));
        scan = findDetachedUses(program, [path.join(PACKAGE_ROOT, "src"), path.join(PACKAGE_ROOT, "test")]);
      }, 180000);

      it("finds no method of the seven classes used without a call", () => {
        expect(scan.detached.map(describeUse)).toEqual([]);
      });

      it.each(METHOD_CLASSES)("examined references to the members of %s", (name) => {
        expect(scan.examined[name]).toBeGreaterThan(0);
      });
    });
  });

  describe("prototype", () => {
    const PUBLIC_METHODS: Array<[string, new (config: Config) => object, string[]]> = [
      ["Build", Build, ["buildProject", "getSteps", "getInstallPrefix"]],
      ["Scopes", Scopes, [
        "askWhichScope",
        "askNewScope",
        "askEditScope",
        "createOrEditScope",
        "deleteScope",
        "getScopes",
        "getScope",
        "getQuestions",
      ]],
      ["Package", Package, ["getSearchPaths", "parseMakefileAm", "resolveBinaryPaths", "resolveDependencies", "plan", "run"]],
      ["Template", Template, ["askName", "createPackage"]],
      ["ResourcePak", ResourcePak, ["askName", "createPackage", "addResource", "readProject", "build"]],
      [
        "Installer",
        Installer,
        ["checkWixl", "readProjectMetadata", "ensureDist", "generateWxs", "compileMsi", "run"],
      ],
    ];
    const CONFIG_METHODS = ["loadConfig", "saveConfig", "getQuestions", "parseAnswers"];

    function expectOnPrototype(Class: { prototype: object }, instance: object, methods: string[]): void {
      for (const name of methods) {
        const own = Object.getOwnPropertyDescriptor(Class.prototype, name);
        expect({ name, onPrototype: typeof own?.value }).toEqual({ name, onPrototype: "function" });
        expect({ name, ownProperty: Object.prototype.hasOwnProperty.call(instance, name) }).toEqual({
          name,
          ownProperty: false,
        });
      }
    }

    function ownFunctions(instance: object): string[] {
      return Object.getOwnPropertyNames(instance).filter(
        (name) => typeof (instance as Record<string, unknown>)[name] === "function"
      );
    }

    it("Config: every public method is on the prototype and not an own property", () => {
      expectOnPrototype(Config, config, CONFIG_METHODS);
    });

    it.each(PUBLIC_METHODS)("%s: every public method is on the prototype and not an own property", (_name, Class, methods) => {
      expectOnPrototype(Class, new Class(config), methods);
    });

    it("Config: an instance holds no function of its own", () => {
      expect(ownFunctions(config)).toEqual([]);
    });

    it.each(PUBLIC_METHODS)("%s: an instance holds no function of its own", (_name, Class) => {
      expect(ownFunctions(new Class(config))).toEqual([]);
    });

    it("ResourcePak: the static helpers are methods (not enumerable), not fields", () => {
      for (const name of ["wellFormed", "inside", "writeAll"]) {
        const own = Object.getOwnPropertyDescriptor(ResourcePak, name);
        expect({ name, kind: typeof own?.value, enumerable: own?.enumerable }).toEqual({
          name,
          kind: "function",
          enumerable: false,
        });
      }
    });
  });
});
