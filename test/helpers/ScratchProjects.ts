import fs from "fs";
import path from "path";

export interface ScratchProjectOptions {
  name: string;
  makefileAm: string;
  dependencies?: Record<string, string>;
  configureAc?: string;
}

/**
 * Writes a minimal buildable project: package.json (name and dependencies verbatim),
 * src/Makefile.am, and configure.ac when given. Missing parent directories are created.
 */
export function writeProject(dir: string, options: ScratchProjectOptions): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest: Record<string, unknown> = { name: options.name };
  if (options.dependencies !== undefined) {
    manifest.dependencies = options.dependencies;
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "src", "Makefile.am"), options.makefileAm);
  if (options.configureAc !== undefined) {
    fs.writeFileSync(path.join(dir, "configure.ac"), options.configureAc);
  }
}

/**
 * Makes node_modules/<name> in projectDir a symbolic link to target. A relative target is
 * stored as given, so it is relative to the link's own directory.
 */
export function linkModule(projectDir: string, name: string, target: string): void {
  const link = path.join(projectDir, "node_modules", name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
}

export interface Hook {
  restore(): void;
}

export interface ReadBound extends Hook {
  count(): number;
}

type ReadFile = typeof fs.promises.readFile;

/**
 * Replaces fs.promises.readFile with a wrapper that calls the current implementation and
 * returns an object that puts the previous one back. Wrappers stack, so hooks installed in
 * one case compose when they are restored in the reverse order.
 */
function wrapReadFile(make: (previous: ReadFile) => (...args: Parameters<ReadFile>) => ReturnType<ReadFile>): Hook {
  const previous = fs.promises.readFile;
  fs.promises.readFile = make(previous) as ReadFile;
  const installed = fs.promises.readFile;
  return {
    restore(): void {
      if (fs.promises.readFile === installed) {
        fs.promises.readFile = previous;
      }
    },
  };
}

/**
 * Lets `limit` reads through, then rejects every further read with
 * "walk did not finish: more than <limit> file reads". count() is the number of calls so far.
 */
export function readBound(limit: number): ReadBound {
  let calls = 0;
  const hook = wrapReadFile((previous) => (...args) => {
    calls++;
    if (calls > limit) {
      return Promise.reject(new Error(`walk did not finish: more than ${limit} file reads`));
    }
    return previous(...args);
  });
  return {
    count: () => calls,
    restore: () => hook.restore(),
  };
}

/**
 * Runs `action` once, on the first read of a path that ends with `match`, before the read
 * itself is carried out.
 */
export function onRead(match: string, action: () => void): Hook {
  let done = false;
  return wrapReadFile((previous) => (...args) => {
    if (!done && String(args[0]).endsWith(match)) {
      done = true;
      action();
    }
    return previous(...args);
  });
}
