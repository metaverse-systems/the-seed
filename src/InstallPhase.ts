import fs from "fs";
import path from "path";
import { targets } from "./Build";
import { OutputGroup, OutputKind, SigningOutcome, StagedEntry, StagedTree } from "./types";

type TargetName = "native" | "windows";

const ELF_MAGIC = Buffer.from("\x7fELF", "latin1");
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_DLL = 0x2000;
const HEADER_BYTES = 4096;
const MAX_LINK_HOPS = 40;
const MAX_OUTSIDE_PATHS = 10;

/** The install step wrote files outside the configured prefix. */
export class OutsidePrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutsidePrefix";
  }
}

/** The install step wrote no file or link under the prefix. */
export class NothingStagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingStaged";
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Identification ──────────────────────────────────────────

/**
 * What a file is for the build target, from its first bytes: a program or a
 * shared library for that target, or null for anything else (objects,
 * archives, scripts, text, files of the other target, truncated headers).
 * A file that cannot be opened is an error naming it.
 */
export function outputKind(file: string, target: TargetName): OutputKind | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    throw new Error("cannot read " + file + ": " + reasonOf(err));
  }
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const count = fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    if (target === "native") {
      return elfKind(head.subarray(0, count));
    }
    return peKind(fd, head.subarray(0, count));
  } catch (err) {
    throw new Error("cannot read " + file + ": " + reasonOf(err));
  } finally {
    fs.closeSync(fd);
  }
}

function elfKind(head: Buffer): OutputKind | null {
  if (head.length < 18 || !head.subarray(0, 4).equals(ELF_MAGIC)) {
    return null;
  }
  const bigEndian = head[5] === 2;
  const type = bigEndian ? head.readUInt16BE(16) : head.readUInt16LE(16);
  if (type === 2) {
    return "elfExecutable";
  }
  if (type === 3) {
    return "elfShared";
  }
  return null;
}

function peKind(fd: number, head: Buffer): OutputKind | null {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) {
    return null;
  }
  const headerOffset = head.readUInt32LE(0x3c);
  const header = Buffer.alloc(24);
  const count = fs.readSync(fd, header, 0, header.length, headerOffset);
  if (count < header.length || !header.subarray(0, 4).equals(Buffer.from("PE\0\0", "latin1"))) {
    return null;
  }
  const characteristics = header.readUInt16LE(22);
  if ((characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) === 0) {
    return null;
  }
  return (characteristics & IMAGE_FILE_DLL) !== 0 ? "peLibrary" : "peProgram";
}

// ── Reading the stage ───────────────────────────────────────

function sortedNames(dir: string): string[] {
  return fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function otherPrefixMessage(configPrefix: string): string {
  return (
    "the install step did not install under " +
    path.join(configPrefix, targets["native"]) +
    " or " +
    path.join(configPrefix, targets["windows"]) +
    "; the project was configured for another prefix. " +
    "Run a full build (the-seed build native or the-seed build windows)."
  );
}

/** Finds every file and link under the stage that is not inside the staged root. */
function findOutside(dir: string, root: string, stageDir: string, found: string[]): void {
  for (const name of sortedNames(dir)) {
    const full = path.join(dir, name);
    if (full === root) {
      continue;
    }
    const st = fs.lstatSync(full);
    if (st.isDirectory()) {
      findOutside(full, root, stageDir, found);
    } else {
      found.push(full.slice(stageDir.length));
    }
  }
}

function walkRoot(root: string, relDir: string, entries: StagedEntry[]): void {
  const dir = relDir === "" ? root : path.join(root, relDir);
  for (const name of sortedNames(dir)) {
    const relPath = relDir === "" ? name : relDir + "/" + name;
    const full = path.join(root, relPath);
    const st = fs.lstatSync(full);
    const entry: StagedEntry = {
      relPath,
      type: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "file",
      mode: st.mode,
      dev: st.dev,
      ino: st.ino,
    };
    if (entry.type === "symlink") {
      entry.linkTarget = fs.readlinkSync(full);
    }
    entries.push(entry);
    if (entry.type === "dir") {
      walkRoot(root, relPath, entries);
    }
  }
}

/**
 * Reads the stage left by the install step. With no target (an incremental
 * build) the target is the one whose staged root exists. Throws
 * OutsidePrefix for files outside the prefix and NothingStaged when no file
 * or link was staged under it.
 */
export function readStage(stageDir: string, configPrefix: string, target?: TargetName): StagedTree {
  const rootOf = (name: TargetName) => stageDir + path.join(configPrefix, targets[name]);
  let found: TargetName;
  if (target !== undefined) {
    if (!isDirectory(rootOf(target))) {
      throw new Error(otherPrefixMessage(configPrefix));
    }
    found = target;
  } else {
    const present = (["native", "windows"] as TargetName[]).filter((name) => isDirectory(rootOf(name)));
    if (present.length === 2) {
      throw new Error(
        "the install step installed under both target prefixes " +
          path.join(configPrefix, targets["native"]) +
          " and " +
          path.join(configPrefix, targets["windows"]) +
          "; one build installs for one target"
      );
    }
    if (present.length === 0) {
      throw new Error(otherPrefixMessage(configPrefix));
    }
    found = present[0];
  }

  const prefix = path.join(configPrefix, targets[found]);
  const root = stageDir + prefix;

  const outside: string[] = [];
  findOutside(stageDir, root, stageDir, outside);
  if (outside.length > 0) {
    const shown = outside.slice(0, MAX_OUTSIDE_PATHS).join(", ");
    const rest = outside.length > MAX_OUTSIDE_PATHS ? " and " + (outside.length - MAX_OUTSIDE_PATHS) + " more" : "";
    throw new OutsidePrefixError("the install step writes outside the prefix " + prefix + ": " + shown + rest);
  }

  const entries: StagedEntry[] = [];
  walkRoot(root, "", entries);
  if (!entries.some((entry) => entry.type !== "dir")) {
    throw new NothingStagedError(
      "the install step wrote nothing under DESTDIR; its install rules do not support a staged install (DESTDIR), " +
        "so it cannot be installed safely"
    );
  }
  return { stageDir, target: found, prefix, root, entries };
}

// ── Grouping ────────────────────────────────────────────────

/**
 * Groups the staged program and library outputs with every name they have:
 * symlinks that resolve to them and hard links.
 */
export function groupOutputs(tree: StagedTree): OutputGroup[] {
  const absolute = (entry: StagedEntry) => path.join(tree.root, entry.relPath);
  const groups = new Map<string, OutputGroup>();
  const groupOfFile = new Map<string, OutputGroup>();

  for (const entry of tree.entries) {
    if (entry.type !== "file") {
      continue;
    }
    const file = absolute(entry);
    const kind = outputKind(file, tree.target);
    if (kind === null) {
      continue;
    }
    const key = entry.dev + ":" + entry.ino;
    const existing = groups.get(key);
    if (existing === undefined) {
      const group: OutputGroup = {
        file,
        kind,
        names: [file],
        links: [],
        hardLinks: [],
        display: path.join(tree.prefix, entry.relPath),
      };
      groups.set(key, group);
      groupOfFile.set(file, group);
    } else {
      existing.names.push(file);
      existing.hardLinks.push(file);
      groupOfFile.set(file, existing);
    }
  }

  const linkEntries = new Map<string, StagedEntry>();
  for (const entry of tree.entries) {
    if (entry.type === "symlink") {
      linkEntries.set(absolute(entry), entry);
    }
  }
  for (const [linkPath, entry] of linkEntries) {
    let current: StagedEntry | undefined = entry;
    let currentPath = linkPath;
    for (let hop = 0; hop < MAX_LINK_HOPS && current !== undefined; hop++) {
      const target: string = current.linkTarget ?? "";
      let resolved: string;
      if (path.isAbsolute(target)) {
        if (target !== tree.prefix && !target.startsWith(tree.prefix + "/")) {
          break;
        }
        resolved = path.join(tree.stageDir, target);
      } else {
        resolved = path.resolve(path.dirname(currentPath), target);
      }
      const group = groupOfFile.get(resolved);
      if (group !== undefined) {
        group.names.push(linkPath);
        group.links.push({ path: linkPath, target: entry.linkTarget ?? "" });
        break;
      }
      current = linkEntries.get(resolved);
      currentPath = resolved;
    }
  }

  return [...groups.values()];
}

// ── Placement ───────────────────────────────────────────────

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function placeError(dest: string, err: unknown): Error {
  return new Error("cannot place " + dest + ": " + reasonOf(err));
}

function temporaryName(dest: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return path.join(path.dirname(dest), "." + path.basename(dest) + ".the-seed-" + random);
}

/** Creates `dest` with exactly `mode` when missing; an existing directory keeps its mode. */
function ensureDirectory(dest: string, mode: number): void {
  const existing = lstatOrNull(dest);
  if (existing !== null) {
    if (existing.isDirectory() || (existing.isSymbolicLink() && isDirectory(dest))) {
      return;
    }
    throw placeError(dest, "it exists and is not a directory");
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.mkdirSync(dest);
    fs.chmodSync(dest, mode & 0o7777);
  } catch (err) {
    throw placeError(dest, err);
  }
}

/** Moves a staged file or link to `dest`, replacing what is there; copies across devices. */
function moveEntry(source: string, dest: string, entry: { type: "file" | "symlink"; mode: number }): void {
  try {
    fs.renameSync(source, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      throw placeError(dest, err);
    }
  }
  const temporary = temporaryName(dest);
  try {
    if (entry.type === "symlink") {
      fs.symlinkSync(fs.readlinkSync(source), temporary);
    } else {
      fs.copyFileSync(source, temporary);
      fs.chmodSync(temporary, entry.mode & 0o7777);
    }
    fs.renameSync(temporary, dest);
    fs.unlinkSync(source);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw placeError(dest, err);
  }
}

/** Makes `dest` a hard link to `existing`, replacing what is there. */
function linkEntry(existing: string, dest: string): void {
  const temporary = temporaryName(dest);
  try {
    fs.linkSync(existing, temporary);
    fs.renameSync(temporary, dest);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw placeError(dest, err);
  }
}

/**
 * Places the staged tree into the prefix: directories are created with their
 * staged mode when missing, files and links are moved over what is there,
 * hard-link groups stay hard links, and the signature files written into the
 * stage after it was read are placed beside the names they belong to. A
 * signature file the stage no longer has for a name is removed from the
 * prefix. Files in the prefix that the stage does not contain are left alone.
 * Returns the number of files and links placed. Errors read
 * `cannot place <path>: <reason>`.
 */
export function placeStaged(tree: StagedTree, groups: OutputGroup[], outcome: SigningOutcome): number {
  void outcome;
  const stagePath = (relPath: string) => path.join(tree.root, relPath);
  const prefixPath = (relPath: string) => path.join(tree.prefix, relPath);

  const groupByName = new Map<string, OutputGroup>();
  for (const group of groups) {
    for (const name of group.hardLinks.concat(group.file)) {
      groupByName.set(name, group);
    }
  }
  const placedHardLink = new Map<OutputGroup, string>();
  let placed = 0;

  const rootStat = fs.lstatSync(tree.root);
  ensureDirectory(tree.prefix, rootStat.mode);

  for (const entry of tree.entries) {
    const source = stagePath(entry.relPath);
    const dest = prefixPath(entry.relPath);
    if (entry.type === "dir") {
      ensureDirectory(dest, entry.mode);
      continue;
    }
    const group = entry.type === "file" ? groupByName.get(source) : undefined;
    const first = group === undefined ? undefined : placedHardLink.get(group);
    if (group !== undefined && first !== undefined) {
      linkEntry(first, dest);
      fs.rmSync(source, { force: true });
    } else {
      moveEntry(source, dest, { type: entry.type, mode: entry.mode });
      if (group !== undefined) {
        placedHardLink.set(group, dest);
      }
    }
    placed++;
  }

  for (const group of groups) {
    for (const name of group.names) {
      const sigSource = name + ".sig";
      const sigDest = path.join(tree.prefix, path.relative(tree.root, sigSource));
      const sigStat = lstatOrNull(sigSource);
      if (sigStat !== null) {
        moveEntry(sigSource, sigDest, { type: sigStat.isSymbolicLink() ? "symlink" : "file", mode: sigStat.mode });
        placed++;
        continue;
      }
      try {
        const stale = lstatOrNull(sigDest);
        if (stale !== null && !stale.isDirectory()) {
          fs.unlinkSync(sigDest);
        }
      } catch (err) {
        throw placeError(sigDest, err);
      }
    }
  }
  return placed;
}
