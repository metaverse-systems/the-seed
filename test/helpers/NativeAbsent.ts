import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Absolute path of the native component, as the source modules resolve it. */
export const nativeComponentPath = path.resolve(__dirname, "..", "..", "native", "build", "Release", "the_seed_native.node");

const sharedLibraryError = "libthe-seed.so.1: cannot open shared object file: No such file or directory";

/**
 * Runs load with the native component made unavailable inside an isolated module registry, and returns what load returns.
 * "absent" makes requiring the component fail as if the file did not exist; "fails-to-load" makes it fail as if the
 * file existed but its shared library could not be found. Callers remove the mock afterwards with
 * jest.dontMock(nativeComponentPath).
 */
export function withoutNativeComponent<T>(load: () => T, mode: "absent" | "fails-to-load" = "absent"): T {
  let result: T | undefined;
  jest.isolateModules(() => {
    jest.doMock(
      nativeComponentPath,
      () => {
        if (mode === "absent") {
          throw Object.assign(new Error("Cannot find module '" + nativeComponentPath + "'"), { code: "MODULE_NOT_FOUND" });
        }
        throw new Error(sharedLibraryError);
      },
      { virtual: true }
    );
    result = load();
  });
  return result as T;
}

/** SHA-256 hex digest of a file's bytes, for asserting that a file is unchanged. */
export function fileDigest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
