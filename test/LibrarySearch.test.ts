import path from "path";
import { librarySearchEnv, WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS } from "../src/LibrarySearch";

// Library search settings for a lookup or configure: native searches the prefix first and then the user's
// own PKG_CONFIG_PATH; windows searches only the Windows prefix and the toolchain directories.

describe("librarySearchEnv", () => {
  const prefix = "/home/user/the-seed";
  const nativeDir = path.join(prefix, "x86_64-linux-gnu", "lib", "pkgconfig");
  const windowsDir = path.join(prefix, "x86_64-w64-mingw32", "lib", "pkgconfig");

  it("lists the mingw-w64 toolchain directories", () => {
    expect(WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS).toEqual([
      "/usr/local/x86_64-w64-mingw32/lib/pkgconfig",
      "/usr/x86_64-w64-mingw32/lib/pkgconfig",
    ]);
  });

  it("native puts the prefix first and keeps the user's path", () => {
    const env = librarySearchEnv(prefix, "native", { PKG_CONFIG_PATH: "/opt/a/pkgconfig:/opt/b/pkgconfig" });
    expect(env).toEqual({ PKG_CONFIG_PATH: nativeDir + ":/opt/a/pkgconfig:/opt/b/pkgconfig" });
  });

  it("native without a user path is the prefix alone", () => {
    expect(librarySearchEnv(prefix, "native", {})).toEqual({ PKG_CONFIG_PATH: nativeDir });
  });

  it("native with an empty inherited value is the prefix alone", () => {
    const env = librarySearchEnv(prefix, "native", { PKG_CONFIG_PATH: "" });
    expect(env).toEqual({ PKG_CONFIG_PATH: nativeDir });
    expect(env.PKG_CONFIG_PATH.endsWith(":")).toBe(false);
  });

  it("native does not set PKG_CONFIG_LIBDIR", () => {
    const env = librarySearchEnv(prefix, "native", { PKG_CONFIG_PATH: "/opt/a", PKG_CONFIG_LIBDIR: "/elsewhere" });
    expect(env).not.toHaveProperty("PKG_CONFIG_LIBDIR");
  });

  it("windows sets PKG_CONFIG_LIBDIR to the Windows prefix and toolchain directories and clears PKG_CONFIG_PATH", () => {
    const env = librarySearchEnv(prefix, "windows", { PKG_CONFIG_PATH: "/opt/a/pkgconfig" });
    expect(env).toEqual({
      PKG_CONFIG_PATH: "",
      PKG_CONFIG_LIBDIR: [windowsDir, ...WINDOWS_TOOLCHAIN_PKGCONFIG_DIRS].join(":"),
    });
  });

  it("windows ignores the user's path whatever it holds", () => {
    expect(librarySearchEnv(prefix, "windows", {})).toEqual(
      librarySearchEnv(prefix, "windows", { PKG_CONFIG_PATH: "/opt/a:/opt/b", PKG_CONFIG_LIBDIR: "/x" })
    );
  });

  it("keeps a prefix with spaces and a dollar sign as it is", () => {
    const odd = "/tmp/my prefix/it's $HOME \"x\"";
    const native = librarySearchEnv(odd, "native", { PKG_CONFIG_PATH: "/opt/a" });
    expect(native.PKG_CONFIG_PATH).toBe(path.join(odd, "x86_64-linux-gnu", "lib", "pkgconfig") + ":/opt/a");
    const windows = librarySearchEnv(odd, "windows", {});
    expect(windows.PKG_CONFIG_LIBDIR.split(":")[0]).toBe(path.join(odd, "x86_64-w64-mingw32", "lib", "pkgconfig"));
  });

  it("reads process.env when no inherited environment is given", () => {
    const saved = process.env.PKG_CONFIG_PATH;
    process.env.PKG_CONFIG_PATH = "/opt/from-process";
    try {
      expect(librarySearchEnv(prefix, "native").PKG_CONFIG_PATH).toBe(nativeDir + ":/opt/from-process");
    } finally {
      if (saved === undefined) delete process.env.PKG_CONFIG_PATH;
      else process.env.PKG_CONFIG_PATH = saved;
    }
  });

  it("throws for an unknown target", () => {
    expect(() => librarySearchEnv(prefix, "macos", {})).toThrow("Unknown build target macos");
  });
});
