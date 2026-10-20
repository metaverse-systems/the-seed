import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** One file of a snapshotted tree. */
export interface TreeEntry {
  /** Path relative to the snapshotted directory, with `/` separators. */
  path: string;
  /** `directory` or `file`. */
  kind: "directory" | "file";
  /** Size in bytes (0 for a directory). */
  size: number;
  /** SHA-256 of the contents as hex (empty for a directory). */
  sha256: string;
}

/**
 * Lists every file and directory under `dir` in sorted order with its size and SHA-256, so a test
 * can show that a command created, changed or deleted nothing by comparing two snapshots.
 */
export function snapshotTree(dir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory", size: 0, sha256: "" });
        walk(full);
      } else {
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
        entries.push({
          path: relative,
          kind: "file",
          size: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk(dir);
  return entries;
}
