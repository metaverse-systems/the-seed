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
let cachedFailure: NativeComponentMissingError | null = null;

/**
 * Loads the native component once. The result, success or failure, is cached.
 * Throws NativeComponentMissingError when the component is absent or fails to load.
 */
export function loadNativeComponent<T = unknown>(): T {
  if (cachedComponent !== null) {
    return cachedComponent as T;
  }
  if (cachedFailure !== null) {
    throw cachedFailure;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native component has no type declarations and is loaded on first use
    cachedComponent = require(path.join(packageRoot(), NATIVE_COMPONENT_PATH));
    return cachedComponent as T;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure && failure.code === "MODULE_NOT_FOUND") {
      cachedFailure = new NativeComponentMissingError(null);
    } else {
      const text = failure && failure.message !== undefined ? String(failure.message) : String(error);
      cachedFailure = new NativeComponentMissingError(text.split(/\r?\n/)[0]);
    }
    throw cachedFailure;
  }
}

/**
 * Loads the native component now if it has not been tried yet, and keeps the outcome without throwing.
 * Modules that need the component call this when they are loaded, so that its availability is settled once
 * for them; loadNativeComponent() then answers from the kept outcome.
 */
export function preloadNativeComponent(): void {
  try {
    loadNativeComponent();
  } catch {
    // The failure is kept and thrown by the next loadNativeComponent() call
  }
}

/** Loads the native component for its effect: throws NativeComponentMissingError when it is unavailable. */
export function requireNativeComponent(): void {
  loadNativeComponent();
}

/** Clears the cached result so the next load requires the component again. */
export function resetNativeComponentForTests(): void {
  cachedComponent = null;
  cachedFailure = null;
}
