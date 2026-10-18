import path from "path";

/** Directories where the mingw-w64 toolchain keeps the descriptions of its own Windows libraries. */
export const WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS: string[] = [
  "/usr/local/x86_64-w64-mingw32/lib/pkgconfig",
  "/usr/x86_64-w64-mingw32/lib/pkgconfig",
];

const NATIVE_TRIPLET = "x86_64-linux-gnu";
const WINDOWS_TRIPLET = "x86_64-w64-mingw32";

/**
 * The pkg-config settings for a library lookup or configure step.
 *
 * Native: the prefix is searched first, then the user's own PKG_CONFIG_PATH.
 * Windows: only the Windows prefix and the toolchain directories are searched,
 * so a native-only library can never satisfy a Windows build.
 *
 * @param prefix - the configured install prefix (not the target directory)
 * @param target - 'native' or 'windows'
 * @param inherited - the environment whose PKG_CONFIG_PATH is extended
 */
export function librarySearchEnv(
  prefix: string,
  target: string,
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (target === "native") {
    const own = path.join(prefix, NATIVE_TRIPLET, "lib", "pkgconfig");
    const user = inherited.PKG_CONFIG_PATH;
    return { PKG_CONFIG_PATH: user ? own + ":" + user : own };
  }
  if (target === "windows") {
    return {
      PKG_CONFIG_PATH: "",
      PKG_CONFIG_LIBDIR: [path.join(prefix, WINDOWS_TRIPLET, "lib", "pkgconfig"), ...WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS].join(":"),
    };
  }
  throw new Error("Unknown build target " + target);
}
