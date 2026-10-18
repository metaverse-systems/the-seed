import fs from "fs";
import path from "path";

/**
 * Picks a package that pkg-config describes only in one of its own built-in search directories: its name
 * is not present in any of the given directories, and a lookup with no extra search settings succeeds.
 * Returns null when there is no such package on this machine.
 */
export function findSystemOnlyPackage(excludedDirs: string[]): string | null {
  // The real child_process: some test files replace the module with a mock.
  const { spawnSync } = jest.requireActual<typeof import("child_process")>("child_process");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PKG_CONFIG_PATH;
  delete env.PKG_CONFIG_LIBDIR;

  const pcPath = spawnSync("pkg-config", ["--variable", "pc_path", "pkg-config"], { env, encoding: "utf8" });
  if (pcPath.error || pcPath.status !== 0) {
    return null;
  }
  const excluded = new Set<string>();
  for (const dir of excludedDirs) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        excluded.add(entry);
      }
    }
  }
  for (const dir of pcPath.stdout.trim().split(":").filter((entry) => entry !== "")) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith(".pc") || excluded.has(entry)) continue;
      const name = path.basename(entry, ".pc");
      const lookup = spawnSync("pkg-config", ["--cflags", "--libs", name], { env, encoding: "utf8" });
      if (!lookup.error && lookup.status === 0 && lookup.stdout.includes(name)) {
        return name;
      }
    }
  }
  return null;
}

/** Writes a minimal package description named `name` into `dir` (created when missing). */
export function writePackageDescription(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name + ".pc"),
    ["Name: " + name, "Description: test package", "Version: 1.0.0", "Libs: -l" + name, "Cflags:", ""].join("\n")
  );
}
