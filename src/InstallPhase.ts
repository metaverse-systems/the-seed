import fs from "fs";
import path from "path";
import { extractScope, getStripTool, targets } from "./Build";
import Signing from "./Signing";
import { commandFailedMessage, findOnPath, formatCommand, runCommand } from "./ProcessRunner";
import { runStep, stepText } from "./StepRunner";
import {
  InstallPhaseOptions,
  InstallPhaseResult,
  InstallReport,
  OutputGroup,
  OutputKind,
  SigningOutcome,
  StagedEntry,
  StagedTree,
} from "./types";

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

/**
 * The build-tree copies of the staged outputs, the files the packaging
 * command reads: for every name among the staged groups, `src/.libs/<name>`
 * if it exists, else `src/<name>`. They are grouped like staged outputs and
 * kept when they are programs or libraries for the target, so a libtool
 * wrapper script is never taken. Nothing outside `src/` and `src/.libs/` is
 * looked at. A group's display is the path relative to the project.
 */
export function buildTreeCopies(projectDir: string, stagedGroups: OutputGroup[], target: TargetName): OutputGroup[] {
  const names = new Set<string>();
  for (const group of stagedGroups) {
    for (const name of group.names) {
      names.add(path.basename(name));
    }
  }

  const srcDir = path.join(projectDir, "src");
  const entries: StagedEntry[] = [];
  for (const name of [...names].sort()) {
    for (const relPath of [".libs/" + name, name]) {
      const full = path.join(srcDir, relPath);
      const st = lstatOrNull(full);
      if (st === null || st.isDirectory()) {
        continue;
      }
      const entry: StagedEntry = {
        relPath,
        type: st.isSymbolicLink() ? "symlink" : "file",
        mode: st.mode,
        dev: st.dev,
        ino: st.ino,
      };
      if (entry.type === "symlink") {
        entry.linkTarget = fs.readlinkSync(full);
      }
      entries.push(entry);
      break;
    }
  }

  // Absolute link targets under the project resolve to themselves
  const tree: StagedTree = { stageDir: "", target, prefix: projectDir, root: srcDir, entries };
  return groupOutputs(tree).map((group) => ({
    ...group,
    display: path.relative(projectDir, group.file).split(path.sep).join("/"),
  }));
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
  const stagedPaths = new Set(tree.entries.map((entry) => entry.relPath));
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
      if (stagedPaths.has(path.relative(tree.root, sigSource))) {
        // The install step staged this signature itself and the entry loop placed it
        continue;
      }
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

// ── Stripping ───────────────────────────────────────────────

/** Runs `action` with owner write on `file`, and puts the mode back in every outcome. */
async function withOwnerWrite<T>(file: string, action: () => Promise<T>): Promise<T> {
  const mode = fs.statSync(file).mode & 0o7777;
  const changed = (mode & 0o200) === 0;
  if (changed) {
    fs.chmodSync(file, mode | 0o200);
  }
  try {
    return await action();
  } finally {
    if (changed) {
      try {
        fs.chmodSync(file, mode);
      } catch {
        // The file is gone; there is no mode to restore
      }
    }
  }
}

/** Makes every other name of the group a hard link to the file again, when a tool replaced the file. */
function restoreHardLinks(group: OutputGroup): void {
  if (group.hardLinks.length === 0) {
    return;
  }
  const ino = fs.statSync(group.file).ino;
  for (const name of group.hardLinks) {
    const st = lstatOrNull(name);
    if (st === null || st.ino !== ino) {
      linkEntry(group.file, name);
    }
  }
}

function stripToolMissing(tool: string, target: TargetName): Error {
  const hint =
    target === "windows"
      ? "\nInstall the MinGW binutils package (e.g., binutils-mingw-w64-x86-64) and try again."
      : "\nInstall binutils (for example the binutils package) and try again.";
  return new Error("Strip tool '" + tool + "' not found on this system." + hint);
}

/**
 * Strips each output group's real file with `strip --strip-unneeded`. A PE
 * loses its embedded signature first, since the tool would leave a damaged
 * file behind. Hard-link names are made links again when the tool replaced
 * the file. Returns at once with no groups, so a project that installs only
 * headers and data needs no strip tool. Throws on the first failure; aborting
 * `signal` throws `Strip cancelled`.
 */
export async function stripOutputs(
  groups: OutputGroup[],
  target: TargetName,
  signal: AbortSignal | undefined,
  log: (line: string) => void
): Promise<void> {
  if (groups.length === 0) {
    return;
  }
  const tool = getStripTool(target);
  const toolPath = findOnPath(tool);
  if (toolPath === null) {
    throw stripToolMissing(tool, target);
  }
  log("Using strip tool: " + tool);

  const signing = new Signing();
  for (const group of groups) {
    if (signal?.aborted) {
      throw new Error("Strip cancelled");
    }
    const args = ["--strip-unneeded", group.file];
    await withOwnerWrite(group.file, async () => {
      if (target === "windows") {
        signing.removeEmbeddedSignature(group.file);
      }
      const result = await runCommand(toolPath, args, { signal });
      if (result.killed) {
        log("Stripping " + group.display + "... cancelled");
        throw new Error("Strip cancelled");
      }
      if (result.exitCode !== 0) {
        log("Stripping " + group.display + "... FAILED");
        throw new Error("strip failed on " + group.display + ": " + commandFailedMessage(formatCommand(toolPath, args), result.stderr));
      }
      if (target === "windows" && signing.detectBinaryFormat(group.file).format !== "pe") {
        log("Stripping " + group.display + "... FAILED");
        throw new Error("strip failed on " + group.display + ": the result is not a valid PE file");
      }
    });
    restoreHardLinks(group);
    log("Stripping " + group.display + "... done");
  }
  log("Stripped " + groups.length + " file(s)");
}

// ── Signing ─────────────────────────────────────────────────

/** Replaces `dest` with a symbolic link holding `text`. */
function replaceWithSymlink(text: string, dest: string): void {
  const temporary = temporaryName(dest);
  try {
    fs.symlinkSync(text, temporary);
    fs.renameSync(temporary, dest);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

/**
 * Signs each output group's real file: an embedded signature for a Windows
 * output, a detached `.sig` for a native one. Every other name of the group
 * gets its own signature: a link to the signature of the name it points at,
 * or a hard link to the signature file. Returns the form each file got.
 * Every signer error becomes `signing failed on <display>: <message>`.
 */
export async function signOutputs(
  groups: OutputGroup[],
  scope: string,
  configDir: string,
  target: TargetName,
  signal: AbortSignal | undefined,
  log: (line: string) => void
): Promise<{ display: string; form: "embedded" | "detached" }[]> {
  const signing = new Signing(configDir);
  const expected = target === "windows" ? "embedded" : "detached";
  const signed: { display: string; form: "embedded" | "detached" }[] = [];

  for (const group of groups) {
    if (signal?.aborted) {
      throw new Error("Sign cancelled");
    }
    const failure = (message: string) => new Error("signing failed on " + group.display + ": " + message);
    const result = await withOwnerWrite(group.file, async () => {
      try {
        return await signing.signFile(group.file, { scope });
      } catch (err) {
        throw failure(reasonOf(err));
      }
    });

    if (result.signatureType !== expected) {
      const unrecognised =
        target === "windows" && signing.detectBinaryFormat(group.file).format !== "pe"
          ? " (the file is not recognised as a valid PE file, for example one left damaged by an earlier version that stripped a signed file; a full build rebuilds it)"
          : "";
      throw failure("expected an " + expected + " signature, got " + result.signatureType + unrecognised);
    }

    try {
      if (result.signatureType === "embedded") {
        restoreHardLinks(group);
        log("Signed (embedded): " + group.display);
      } else {
        const signature = group.file + ".sig";
        for (const link of group.links) {
          replaceWithSymlink(link.target + ".sig", link.path + ".sig");
        }
        for (const name of group.hardLinks) {
          linkEntry(signature, name + ".sig");
        }
        log("Signed (detached): " + group.display + " → " + path.basename(signature));
      }
    } catch (err) {
      throw failure(reasonOf(err));
    }
    signed.push({ display: group.display, form: result.signatureType });
  }

  if (signed.length > 0) {
    log("Auto-signed " + signed.length + " file(s) using scope '" + scope + "'");
  }
  return signed;
}

/**
 * Whether the project is signed: its package name has a scope whose
 * certificate exists and has not expired. Otherwise the reason it is not.
 */
export function signingOutcome(projectDir: string, configDir: string): SigningOutcome {
  const packageJson = path.join(projectDir, "package.json");
  if (!fs.existsSync(packageJson)) {
    return { kind: "unsigned", reason: "noPackageJson" };
  }
  let name: unknown;
  try {
    name = (JSON.parse(fs.readFileSync(packageJson, "utf-8")) as { name?: unknown }).name;
  } catch (err) {
    return { kind: "unsigned", reason: "unreadablePackageJson", detail: reasonOf(err) };
  }
  const scope = typeof name === "string" ? extractScope(name) : undefined;
  if (scope === undefined) {
    return { kind: "unsigned", reason: "noScope", name: typeof name === "string" ? name : undefined };
  }
  const signing = new Signing(configDir);
  if (!signing.hasCert(scope)) {
    return { kind: "unsigned", reason: "noCertificate", scope, name: name as string };
  }
  const info = signing.getCertInfo(scope);
  if (info === null) {
    return { kind: "unsigned", reason: "noCertificate", scope, name: name as string };
  }
  if (info.isExpired) {
    return { kind: "unsigned", reason: "expired", scope, name: name as string, expiredOn: info.notAfter };
  }
  return { kind: "signed", scope };
}

// ── The phase ───────────────────────────────────────────────

/** Removes a directory tree, making directories writable first when a mode stops the removal. */
function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // Fall through to the writable retry
  }
  const makeWritable = (current: string): void => {
    const st = lstatOrNull(current);
    if (st === null || !st.isDirectory()) {
      return;
    }
    fs.chmodSync(current, (st.mode & 0o7777) | 0o700);
    for (const name of fs.readdirSync(current)) {
      makeWritable(path.join(current, name));
    }
  };
  try {
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A stage that cannot be removed is left behind; the build outcome stands
  }
}

/**
 * The install step of a build: runs it into a staging directory under the
 * configured prefix, identifies the programs and libraries it staged, strips
 * them (a release build with a target), signs them (a scope with a valid
 * certificate) and only then places everything in the prefix. Libtool
 * relinks installed files while installing, so the files that were staged,
 * not the ones in the build tree, are the ones processed. Never throws for
 * build outcomes.
 */
export async function runInstallPhase(options: InstallPhaseOptions): Promise<InstallPhaseResult> {
  if (options.signal?.aborted) {
    return { status: "interrupted" };
  }

  const stagingRoot = path.join(options.configPrefix, ".the-seed-staging");
  let stageDir: string;
  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    stageDir = fs.mkdtempSync(path.join(stagingRoot, "stage-"));
    fs.chmodSync(stageDir, 0o700);
  } catch (err) {
    return { status: "failed", step: "install", message: "cannot create the staging directory in " + stagingRoot + ": " + reasonOf(err) };
  }

  try {
    const staged = { ...options.installStep, args: [...options.installStep.args, "DESTDIR=" + stageDir] };
    const text = stepText(options.installStep);
    const outcome = await runStep(staged, {
      baseDir: options.projectDir,
      baseEnv: options.env,
      signal: options.signal,
      output: options.output,
    });
    switch (outcome.status) {
      case "interrupted":
        return { status: "interrupted" };
      case "notFound":
        return { status: "failed", step: "install", message: outcome.message };
      case "failed":
        return {
          status: "failed",
          step: "install",
          message: outcome.exitCode === null ? text + " was ended by " + outcome.signal : text + " exited with status " + outcome.exitCode,
          output: outcome.output === "" ? undefined : outcome.output,
        };
      default:
        break;
    }
    options.onInstalled?.();

    let tree: StagedTree;
    try {
      tree = readStage(stageDir, options.configPrefix, options.target);
    } catch (err) {
      return { status: "failed", step: "install", message: reasonOf(err) };
    }
    const target = tree.target;

    let groups: OutputGroup[];
    try {
      groups = groupOutputs(tree);
    } catch (err) {
      return { status: "failed", step: "install", message: reasonOf(err) };
    }
    let buildTree: OutputGroup[];
    try {
      buildTree = buildTreeCopies(options.projectDir, groups, target);
    } catch (err) {
      return { status: "failed", step: "install", message: reasonOf(err) };
    }
    const processed = [...groups, ...buildTree];
    let signingResult: SigningOutcome;
    try {
      signingResult = signingOutcome(options.projectDir, options.configDir);
    } catch (err) {
      return { status: "failed", step: "sign", message: reasonOf(err) };
    }

    const stripped: string[] = [];
    if (options.release && options.target !== undefined) {
      try {
        await stripOutputs(processed, target, options.signal, options.log);
        stripped.push(...processed.map((group) => group.display));
      } catch (err) {
        if (options.signal?.aborted) {
          return { status: "interrupted" };
        }
        return { status: "failed", step: "strip", message: reasonOf(err) };
      }
    }

    let signed: InstallReport["signed"] = [];
    if (signingResult.kind === "signed" && processed.length > 0) {
      try {
        signed = await signOutputs(processed, signingResult.scope, options.configDir, target, options.signal, options.log);
      } catch (err) {
        if (options.signal?.aborted) {
          return { status: "interrupted" };
        }
        return { status: "failed", step: "sign", message: reasonOf(err) };
      }
    }

    let installed: number;
    try {
      installed = placeStaged(tree, groups, signingResult);
    } catch (err) {
      return { status: "failed", step: "place", message: reasonOf(err) };
    }
    options.log("Installed " + installed + " file(s) into " + tree.prefix);
    return {
      status: "completed",
      report: { prefix: tree.prefix, installed, stripped, signed, outcome: signingResult },
    };
  } finally {
    removeTree(stageDir);
    try {
      fs.rmdirSync(stagingRoot);
    } catch {
      // Not empty (another build is staging) or already gone
    }
  }
}
