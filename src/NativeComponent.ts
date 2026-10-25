import path from "path";

/** The command that builds the native component. */
export const NATIVE_COMPONENT_STEP = "npm run build-addon";

/** The native component's file, relative to the package directory. */
export const NATIVE_COMPONENT_PATH = path.join("native", "build", "Release", "the_seed_native.node");

/** Absolute path of the package directory (the directory holding package.json and native/). */
export function packageRoot(): string {
  return path.resolve(__dirname, "..");
}

/**
 * The one-line message shown wherever the native component is needed and missing.
 * When the component file exists but does not load, loadError (the first line of the loading error) is appended.
 */
export function nativeComponentMessage(loadError?: string | null): string {
  // Read when the message is made: Dependencies reaches the build modules, which load this module
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded late to keep the modules from importing each other in a cycle
  const { requiredLibTheSeedVersion } = require("./Dependencies") as typeof import("./Dependencies");
  const message =
    "The native component is not built; it is needed to sign or verify Windows programs, Mac programs and installers, to package, and for Windows builds. " +
    "Build it with: cd \"" +
    packageRoot() +
    "\" && " +
    NATIVE_COMPONENT_STEP +
    " (it needs a C++ compiler, make, python3, pkg-config and libthe-seed " +
    requiredLibTheSeedVersion +
    " or later, which \"the-seed dependencies install\" puts in the prefix).";
  return loadError ? message + " Loading error: " + loadError : message;
}

/** Thrown when the native component is absent or cannot be loaded. */
export class NativeComponentMissingError extends Error {
  /** First line of the loading error, or null when the component is absent. */
  readonly loadError: string | null;

  constructor(loadError: string | null = null) {
    super(nativeComponentMessage(loadError));
    Object.setPrototypeOf(this, NativeComponentMissingError.prototype);
    this.name = "NativeComponentMissingError";
    this.loadError = loadError;
  }
}

let cachedComponent: unknown = null;

/**
 * Loads the native component. A successful load is kept and returned by every later call; a failed load is
 * not kept, so the next call tries again and picks up a component built since (by "npm run build-addon")
 * in the same process.
 * Throws NativeComponentMissingError when the component is absent or fails to load.
 */
export function loadNativeComponent<T = unknown>(): T {
  if (cachedComponent !== null) {
    return cachedComponent as T;
  }
  try {
    // Node keeps no record of a failed require of the file (absent or failing to load), so a retry loads it afresh
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native component has no type declarations and is loaded on first use
    cachedComponent = require(path.join(packageRoot(), NATIVE_COMPONENT_PATH));
    return cachedComponent as T;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure && failure.code === "MODULE_NOT_FOUND") {
      throw new NativeComponentMissingError(null);
    }
    const text = failure && failure.message !== undefined ? String(failure.message) : String(error);
    throw new NativeComponentMissingError(text.split(/\r?\n/)[0]);
  }
}

/**
 * Loads the native component now, without throwing. Modules that need the component call this when they
 * are loaded, so that a component that loads is kept from then on; a failure is not kept, and the next
 * loadNativeComponent() call tries again.
 */
export function preloadNativeComponent(): void {
  try {
    loadNativeComponent();
  } catch {
    // Not kept: the next loadNativeComponent() call tries the load again
  }
}

/** Loads the native component for its effect: throws NativeComponentMissingError when it is unavailable. */
export function requireNativeComponent(): void {
  loadNativeComponent();
}

/** Clears the kept component so the next load requires it again. */
export function resetNativeComponentForTests(): void {
  cachedComponent = null;
}
