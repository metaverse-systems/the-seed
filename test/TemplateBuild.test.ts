/*
 * End-to-end build of each kind of generated project against the installed libraries.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - The libraries are found with pkg-config, using the search environment of the native helper
 *   (`native/pkg-config.js`: the prefix from the configuration of the running user, read only,
 *   then the caller's PKG_CONFIG_PATH, then the system directories). Only the `ecs-cpp.pc` and
 *   `the-seed.pc` files found that way are copied, into the scratch prefix; nothing else of the
 *   installed prefix is read, and nothing is written to it.
 * - The case is skipped through `optionalExternalCheck`, with the reason, when either library is
 *   missing or older than `REQUIRED_VERSIONS`, or `pkg-config`, `autoreconf`, `make` or `c++` is
 *   missing; the hosted job sets THE_SEED_REQUIRE_TOOLS=1, so there it runs.
 * - The installed component and system descriptions are read with `pkg-config --print-requires`
 *   (one `<name> >= <version>` line per requirement), the `Requires:` line of the installed file,
 *   and `--list-all` for the description, each over the scratch prefix alone.
 * - The project is built in place (`build native --jobs 4` in the project directory), so its
 *   `config.log` is found in the project directory.
 * - The scope `@t` is the one scope of the scratch home's configuration; PKG_CONFIG_PATH,
 *   MAKEFLAGS and MFLAGS are removed from the environment for the build and restored afterwards.
 * - Only the native build is covered; the Windows build uses the same generated files and the
 *   cross-compiled libraries, which are not required here.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { findOnPath } from "../src/ProcessRunner";
import { REQUIRED_VERSIONS } from "../src/RequiredVersions";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { runTheSeed } from "./helpers/RunCli";

const CASE_TIMEOUT = 120000;
const JOBS = "4";
const LIBRARIES = ["ecs-cpp", "the-seed"] as const;
const TRIPLET_PKGCONFIG = path.join("x86_64-linux-gnu", "lib", "pkgconfig");

const AUTHOR = {
  name: "Zoë \"Q\" O'Brien, [Lab] & <Co>",
  email: "zoe+test@example.com",
  url: "https://example.com/a?b=1&c=2#top",
};

interface PrefixResolution {
  prefix: string;
}

interface PkgConfigModule {
  resolvePrefix: (home?: string) => PrefixResolution;
  searchEnv: (prefix: string, inherited?: NodeJS.ProcessEnv) => Record<string, string>;
}

interface Installed {
  /** The reason the libraries cannot be used, or null */
  missing: string | null;
  /** library name -> absolute path of its installed .pc file */
  files: Record<string, string>;
}

/** Looks for the installed libraries without writing anything. */
function findInstalled(): Installed {
  const files: Record<string, string> = {};
  const absent = (tool: string): boolean => findOnPath(tool) === null;
  const tools = ["pkg-config", "autoreconf", "make", "c++"].filter(absent);
  if (tools.length > 0) {
    return { missing: `${tools.join(", ")} not found`, files };
  }
  const helper = jest.requireActual<PkgConfigModule>("../native/pkg-config.js");
  const env = { ...process.env, ...helper.searchEnv(helper.resolvePrefix(os.homedir()).prefix, process.env) };
  const problems: string[] = [];
  for (const library of LIBRARIES) {
    const wanted = REQUIRED_VERSIONS[library];
    const check = spawnSync("pkg-config", [`--atleast-version=${wanted}`, library], { env, encoding: "utf8" });
    if (check.status !== 0) {
      problems.push(`${library} >= ${wanted} not found by pkg-config`);
      continue;
    }
    const dir = spawnSync("pkg-config", ["--variable=pcfiledir", library], { env, encoding: "utf8" });
    const file = path.join(dir.stdout.trim(), `${library}.pc`);
    if (dir.status !== 0 || !fs.existsSync(file)) {
      problems.push(`the description file of ${library} could not be located`);
      continue;
    }
    files[library] = file;
  }
  return { missing: problems.length > 0 ? problems.join("; ") : null, files };
}

const installed = findInstalled();

/** Every file called `name` under dir. */
function findFiles(dir: string, name: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === name) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

describe("TemplateBuild", () => {
  let root: string;
  let home: string;
  let prefix: string;
  let work: string;
  let savedEnv: Record<string, string | undefined>;
  const ENV_KEYS = ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "MAKEFLAGS", "MFLAGS"];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "template-build-"));
    home = path.join(root, "home");
    prefix = path.join(root, "prefix");
    work = path.join(root, "work");
    fs.mkdirSync(path.join(home, "the-seed"), { recursive: true });
    fs.mkdirSync(work);
    fs.writeFileSync(
      path.join(home, "the-seed", "config.json"),
      JSON.stringify({ prefix, scopes: { "@t": { author: AUTHOR } } })
    );
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    if (installed.missing === null) {
      const pcDir = path.join(prefix, TRIPLET_PKGCONFIG);
      fs.mkdirSync(pcDir, { recursive: true });
      for (const library of LIBRARIES) {
        fs.copyFileSync(installed.files[library], path.join(pcDir, `${library}.pc`));
      }
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const available = (): boolean =>
    optionalExternalCheck("libecs-cpp and libthe-seed at the required versions", installed.missing === null,
      installed.missing ?? "");

  /** Runs one command and fails with the end of its output when the status is not 0. */
  async function succeed(args: string[], cwd: string): Promise<void> {
    const result = await runTheSeed(args, { home, cwd, interactive: false });
    if (result.status !== 0) {
      throw new Error(`the-seed ${args.join(" ")} ended with status ${result.status}\n` +
        `${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`);
    }
  }

  /** pkg-config over the scratch prefix alone. */
  function pkgConfig(args: string[]): string {
    const dir = path.join(prefix, TRIPLET_PKGCONFIG);
    const env = { ...process.env, PKG_CONFIG_PATH: dir, PKG_CONFIG_LIBDIR: dir };
    const run = spawnSync("pkg-config", args, { env, encoding: "utf8" });
    if (run.status !== 0) {
      throw new Error(`pkg-config ${args.join(" ")} failed: ${run.stderr}`);
    }
    return run.stdout;
  }

  /** Creates the project, builds it and returns its directory. */
  async function createAndBuild(kind: string, name: string): Promise<string> {
    await succeed(["template", kind, `@t/${name}`], work);
    const project = path.join(work, name);
    await succeed(["build", "native", "--jobs", JOBS], project);
    return project;
  }

  function expectAuthorInConfigureLog(project: string): void {
    const logs = findFiles(project, "config.log");
    expect(logs.length).toBeGreaterThan(0);
    const text = fs.readFileSync(logs[0], "utf8");
    expect(text).toContain(`PACKAGE_BUGREPORT='${AUTHOR.email}'`);
    expect(text).toContain(`PACKAGE_URL='${AUTHOR.url}'`);
  }

  function installedDescription(name: string): string {
    return fs.readFileSync(path.join(prefix, TRIPLET_PKGCONFIG, `${name}.pc`), "utf8");
  }

  it("builds a component named hello-world and installs a description that asks for libecs-cpp", async () => {
    if (!available()) return;

    const project = await createAndBuild("component", "hello-world");

    expect(installedDescription("hello-world")).toContain(`Requires: ecs-cpp >= ${REQUIRED_VERSIONS["ecs-cpp"]}\n`);
    expect(pkgConfig(["--print-requires", "hello-world"]).trim().split("\n")).toEqual([`ecs-cpp >= ${REQUIRED_VERSIONS["ecs-cpp"]}`]);
    expect(pkgConfig(["--list-all"])).toContain("hello-world, a component for libecs-cpp");
    expectAuthorInConfigureLog(project);
  }, CASE_TIMEOUT);

  it("builds a system named mesh.loader and installs a description that asks for both libraries", async () => {
    if (!available()) return;

    const project = await createAndBuild("system", "mesh.loader");

    expect(installedDescription("mesh.loader")).toContain(
      `Requires: ecs-cpp >= ${REQUIRED_VERSIONS["ecs-cpp"]}, the-seed >= ${REQUIRED_VERSIONS["the-seed"]}\n`);
    expect(pkgConfig(["--print-requires", "mesh.loader"]).trim().split("\n")).toEqual([
      `ecs-cpp >= ${REQUIRED_VERSIONS["ecs-cpp"]}`, `the-seed >= ${REQUIRED_VERSIONS["the-seed"]}`]);
    expect(pkgConfig(["--list-all"])).toContain("mesh.loader, a system for libecs-cpp");
    expectAuthorInConfigureLog(project);
  }, CASE_TIMEOUT);

  it("builds a program named game", async () => {
    if (!available()) return;

    const project = await createAndBuild("program", "game");

    expect(fs.existsSync(path.join(prefix, "x86_64-linux-gnu", "bin", "game"))).toBe(true);
    expectAuthorInConfigureLog(project);
  }, CASE_TIMEOUT);
});
