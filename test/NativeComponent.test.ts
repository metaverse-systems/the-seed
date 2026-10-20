import path from "path";
import { withoutNativeComponent, nativeComponentPath } from "./helpers/NativeAbsent";
import { requiredLibTheSeedVersion } from "../src/Dependencies";

interface NativeComponentModule {
  NATIVE_COMPONENT_STEP: string;
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
        real = require("../native/build/Release/dependency_lister.node");
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

  it("caches a failure and clears it with resetNativeComponentForTests", () => {
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
      expect(second.message).toBe(first.message);
      expect(requires).toBe(1);
      mod.resetNativeComponentForTests();
      const third = thrownBy(() => mod.loadNativeComponent());
      expect(third.message).toBe(first.message);
      expect(requires).toBe(2);
      mod.resetNativeComponentForTests();
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
});
