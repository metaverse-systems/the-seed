/*
 * Tests that creating a project of each of the four kinds leaves the install prefix and the home
 * directory exactly as they were, and puts the projects in the working directory.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - The snapshot taken here records, for every entry under a directory, its path, kind, mode, size,
 *   modification time and SHA-256 (the directories' modification times included, so an entry added
 *   or removed anywhere shows), through a helper of this file because `snapshotTree` keeps no times.
 * - The home directory holds the configuration directory (`<home>/the-seed`), so the snapshot of
 *   the home also shows that the configuration file is not rewritten.
 * - The prefix is given a library directory and a file before the run, so that it is not empty.
 */
import * as crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { runTheSeed } from "./helpers/RunCli";

interface Entry {
  path: string;
  kind: "directory" | "file" | "link";
  mode: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** Every entry under `dir`, sorted, with what a change to it would alter. */
function snapshot(dir: string): Entry[] {
  const entries: Entry[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode: stat.mode, size: 0, mtimeMs: stat.mtimeMs, sha256: "" });
        walk(full);
      } else {
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
        entries.push({
          path: relative,
          kind: stat.isSymbolicLink() ? "link" : "file",
          mode: stat.mode,
          size: bytes.length,
          mtimeMs: stat.mtimeMs,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk(dir);
  return entries;
}

describe("creating projects", () => {
  let root: string;
  let home: string;
  let prefix: string;
  let work: string;
  let configDir: string;

  const create = (args: string[]) => runTheSeed(args, { home, configDir, cwd: work, interactive: false });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "prefix-untouched-"));
    home = path.join(root, "home");
    prefix = path.join(root, "prefix");
    work = path.join(root, "work");
    configDir = path.join(home, "the-seed");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(prefix, "lib", "libexample.txt"), "installed\n");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        prefix,
        scopes: { "@t": { author: { name: "T Author", email: "t@example.com", url: "https://t.example" } } },
      }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("template component, system, program and resource-pak create leave the prefix and the home unchanged", async () => {
    const prefixBefore = snapshot(prefix);
    const homeBefore = snapshot(home);

    const results = [
      await create(["template", "component", "@t/c"]),
      await create(["template", "system", "@t/s"]),
      await create(["template", "program", "@t/p"]),
      await create(["resource-pak", "create", "@t/r"]),
    ];

    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(["", "", "", ""]);
    expect(snapshot(prefix)).toEqual(prefixBefore);
    expect(snapshot(home)).toEqual(homeBefore);
    expect(fs.existsSync(path.join(prefix, "projects"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".npm"))).toBe(false);
  });

  it("the working directory gains exactly c, s, p and r", async () => {
    for (const args of [
      ["template", "component", "@t/c"],
      ["template", "system", "@t/s"],
      ["template", "program", "@t/p"],
      ["resource-pak", "create", "@t/r"],
    ]) {
      expect((await create(args)).status).toBe(0);
    }

    expect(fs.readdirSync(work).sort()).toEqual(["c", "p", "r", "s"]);
    for (const name of ["c", "p", "r", "s"]) {
      expect(JSON.parse(fs.readFileSync(path.join(work, name, "package.json"), "utf-8")).name).toBe(`@t/${name}`);
    }
  });

  it("a pre-existing <prefix>/projects holding a file is left byte-identical", async () => {
    const projects = path.join(prefix, "projects", "@t", "old");
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, "keep.txt"), "kept\n");
    const prefixBefore = snapshot(prefix);

    for (const args of [
      ["template", "component", "@t/c"],
      ["template", "system", "@t/s"],
      ["template", "program", "@t/p"],
      ["resource-pak", "create", "@t/r"],
    ]) {
      expect((await create(args)).status).toBe(0);
    }

    expect(snapshot(prefix)).toEqual(prefixBefore);
    expect(fs.readFileSync(path.join(projects, "keep.txt"), "utf-8")).toBe("kept\n");
  });

  it("a project with the name of one under <prefix>/projects does not touch it", async () => {
    const old = path.join(prefix, "projects", "@t", "r");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "package.json"), "{\"name\":\"@t/r\"}\n");
    const before = snapshot(prefix);

    const result = await create(["resource-pak", "create", "@t/r"]);

    expect(result.status).toBe(0);
    expect(snapshot(prefix)).toEqual(before);
    expect(fs.existsSync(path.join(work, "r", "package.json"))).toBe(true);
  });
});
