import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { optionalExternalCheck } from "./helpers/ExternalTools";

const packageRoot = path.resolve(__dirname, "..");

const allowedPatterns: RegExp[] = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/.+\.js$/,
  /^dist\/.+\.d\.ts$/,
  /^templates\/.+/,
  /^native\/binding\.gyp$/,
  /^native\/src\/addon\.cpp$/,
  /^native\/build\.js$/,
  /^native\/pkg-config\.js$/,
];

const requiredEntries: string[] = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/scripts/the-seed.js",
  "native/binding.gyp",
  "native/src/addon.cpp",
  "native/build.js",
  "native/pkg-config.js",
];

const requiredTemplates: string[] = ["templates/component", "templates/program", "templates/system"];

const scratchDirs: string[] = [];
const strayFiles: string[] = [];

function scratch(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-contents-" + label + "-"));
  scratchDirs.push(dir);
  return dir;
}

function npmAvailable(): boolean {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function listPackedEntries(): string[] {
  if (!fs.existsSync(path.join(packageRoot, "dist", "index.js"))) {
    throw new Error("dist/ is not built: run `npm run build` in the-seed/ before this test");
  }
  const home = scratch("home");
  const cache = scratch("cache");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    npm_config_cache: cache,
    npm_config_update_notifier: "false",
  };
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--silent"], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("npm pack --dry-run failed: " + (result.error ? result.error.message : result.stderr));
  }
  const parsed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((file) => file.path);
}

/** Every file under dir, as relative paths with "/" separators (dot files included). */
function listTemplateFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return found.sort();
}

function createStray(relative: string): void {
  const full = path.join(packageRoot, relative);
  const created: string[] = [];
  let dir = path.dirname(full);
  while (!fs.existsSync(dir)) {
    created.push(dir);
    dir = path.dirname(dir);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "stray\n");
  strayFiles.push(full);
  strayFiles.push(...created);
}

afterEach(() => {
  // Files first, then the directories created for them (deepest first).
  for (const entry of strayFiles.splice(0)) {
    try {
      const stat = fs.statSync(entry);
      if (stat.isDirectory()) {
        fs.rmdirSync(entry);
      } else {
        fs.unlinkSync(entry);
      }
    } catch {
      // already gone
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("package contents", () => {
  test("every entry of the dry-run pack matches the allowed patterns", () => {
    if (!optionalExternalCheck("npm", npmAvailable(), "npm is not installed")) {
      return;
    }
    const entries = listPackedEntries();
    const unexpected = entries.filter((entry) => !allowedPatterns.some((pattern) => pattern.test(entry)));
    expect(unexpected).toEqual([]);
  });

  test("the required entries are present", () => {
    if (!optionalExternalCheck("npm", npmAvailable(), "npm is not installed")) {
      return;
    }
    const entries = listPackedEntries();
    const missing = requiredEntries.filter((entry) => !entries.includes(entry));
    for (const template of requiredTemplates) {
      if (!entries.some((entry) => entry.startsWith(template + "/"))) {
        missing.push(template);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every file under templates/ is listed by the dry-run pack", () => {
    if (!optionalExternalCheck("npm", npmAvailable(), "npm is not installed")) {
      return;
    }
    const entries = listPackedEntries();
    const onDisk = listTemplateFiles(path.join(packageRoot, "templates"));
    const missing = onDisk.filter((file) => !entries.includes("templates/" + file));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("no generic or empty placeholder file and no dot-named ignore file exists under templates/", () => {
    const unwanted = new Set(["INSTALL", "ChangeLog", "NEWS", "README", ".gitignore"]);
    const found = listTemplateFiles(path.join(packageRoot, "templates")).filter((file) =>
      unwanted.has(path.basename(file)));
    expect(found).toEqual([]);
  });

  test("a stray built native component and a stray test result are not listed", () => {
    if (!optionalExternalCheck("npm", npmAvailable(), "npm is not installed")) {
      return;
    }
    createStray("native/build/Release/x.node");
    createStray("test-results/x");
    const entries = listPackedEntries();
    expect(entries.filter((entry) => entry.startsWith("native/build/"))).toEqual([]);
    expect(entries.filter((entry) => entry.startsWith("test-results/"))).toEqual([]);
  });

  test("the lifecycle scripts are declared and the existing scripts are unchanged", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const scripts = manifest.scripts;
    expect(scripts.install).toBe("node native/build.js --install");
    expect(scripts.prepare).toBe("npm run build");
    expect(scripts["build-addon"]).toBe("node native/build.js");
    expect(scripts.prepack).toMatch(/^node -e /);
    expect(scripts.prepack).toContain("dist");
    expect(scripts.prepack).toContain("rmSync");
    expect(scripts.typecheck).toBe("node scripts/run-checks.js typecheck");
    expect(scripts.lint).toBe("node scripts/run-checks.js lint");
    expect(scripts["lint-fix"]).toBe("node ./node_modules/eslint/bin/eslint.js --ext .ts src test --fix");
    expect(scripts.test).toBe("node scripts/run-checks.js");
    expect(scripts.build).toBe("tsc && node -e \"require('fs').chmodSync('dist/scripts/the-seed.js', 0o755)\"");
  });
});
