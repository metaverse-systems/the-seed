/*
 * The autogen, configure, compile and install steps, as the project build and the library install
 * produce them, and the single function that is to produce both.
 *
 * - `step lists`: the complete step lists of `Build.getSteps` and of `getInstallSteps`, written out
 *   as literal expectations from the code as it stands. They pin today's lists and must hold
 *   unchanged after the steps come from one function. Steps are compared with `toEqual`, so a key
 *   that is absent and a key that is undefined are the same thing.
 * - `autotoolsSteps`: unit cases for `autotoolsSteps(options)` in `src/AutotoolsSteps.ts`. The
 *   module is loaded lazily and typed here by a local interface, so this file compiles before the
 *   module exists.
 *
 * Choices where the contracts leave a detail open:
 * - The library lists run with `pkg-config` answering "not found" (the one `spawnSync` of
 *   `child_process` is replaced), so both libraries are missing whatever is installed on the
 *   machine.
 * - The clone directories are relative names, so the cases that need an existing one run inside a
 *   scratch working directory and restore the previous one afterwards.
 * - In the unit cases the label of a step with a prefix is `<prefix> <label>`, including the
 *   `distclean` step; the environment goes on the configure step only.
 */
import fs from "fs";
import os from "os";
import path from "path";

jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  spawnSync: jest.fn(() => ({ status: 1, error: undefined, stdout: "", stderr: "" })),
}));

import Config from "../src/Config";
import Build from "../src/Build";
import { getInstallSteps } from "../src/Dependencies";
import type { BuildStep } from "../src/types";

describe("step lists (guard)", () => {
  let scratch: string;
  let prefix: string;
  let config: Config;
  let originalCwd: string;
  let originalHome: string | undefined;

  const user = "/opt/user/lib/pkgconfig";
  const inherited = { PKG_CONFIG_PATH: user };
  const nativeDir = () => path.join(prefix, "x86_64-linux-gnu");
  const windowsDir = () => path.join(prefix, "x86_64-w64-mingw32");
  const windowsLibdir = () => [
    path.join(windowsDir(), "lib", "pkgconfig"),
    "/usr/local/x86_64-w64-mingw32/lib/pkgconfig",
    "/usr/x86_64-w64-mingw32/lib/pkgconfig",
  ].join(":");
  const nativeEnv = () => ({ PKG_CONFIG_PATH: path.join(nativeDir(), "lib", "pkgconfig") + ":" + user });
  const windowsEnv = () => ({ PKG_CONFIG_PATH: "", PKG_CONFIG_LIBDIR: windowsLibdir() });

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autotools-steps-test-")));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(scratch, "home");
    prefix = path.join(scratch, "prefix");
    const configDir = path.join(scratch, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix, scopes: {} }));
    config = new Config(configDir);
    originalCwd = process.cwd();
    const work = path.join(scratch, "work");
    fs.mkdirSync(work);
    process.chdir(work);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe("Build.getSteps", () => {
    it("native, full reconfigure, with 3 jobs and an inherited PKG_CONFIG_PATH", () => {
      expect(new Build(config).getSteps("native", true, 3, inherited)).toEqual([
        { label: "autogen", program: "./autogen.sh", args: [] },
        { label: "distclean", program: "make", args: ["distclean"], ignoreExitCode: true },
        { label: "configure", program: "./configure", args: ["--prefix=" + nativeDir()], env: nativeEnv() },
        { label: "compile", program: "make", args: ["-j3"] },
        { label: "install", program: "make", args: ["install"] },
      ]);
    });

    it("windows, full reconfigure, with 3 jobs", () => {
      expect(new Build(config).getSteps("windows", true, 3, inherited)).toEqual([
        { label: "autogen", program: "./autogen.sh", args: [] },
        { label: "distclean", program: "make", args: ["distclean"], ignoreExitCode: true },
        {
          label: "configure",
          program: "./configure",
          args: ["--prefix=" + windowsDir(), "--host=x86_64-w64-mingw32"],
          env: windowsEnv(),
        },
        { label: "compile", program: "make", args: ["-j3"] },
        { label: "install", program: "make", args: ["install"] },
      ]);
    });

    it.each(["native", "windows"])("%s, incremental, is compile and install only", (target) => {
      expect(new Build(config).getSteps(target, false, 3, inherited)).toEqual([
        { label: "compile", program: "make", args: ["-j3"] },
        { label: "install", program: "make", args: ["install"] },
      ]);
    });
  });

  describe("getInstallSteps", () => {
    const libraries = [
      { name: "libecs-cpp", repo: "https://github.com/metaverse-systems/libecs-cpp.git" },
      { name: "libthe-seed", repo: "https://github.com/metaverse-systems/libthe-seed.git" },
    ];

    /** The five steps of one library, as the install lists them. */
    function library(name: string, repo: string, target: "native" | "windows", existing: boolean): BuildStep[] {
      const dir = name;
      const targetDir = target === "native" ? nativeDir() : windowsDir();
      return [
        existing
          ? { label: `update ${name}`, program: "git", args: ["-C", dir, "pull", "--ff-only"] }
          : { label: `clone ${name}`, program: "git", args: ["clone", repo, dir] },
        { label: `${name} autogen`, program: "./autogen.sh", args: [], cwd: dir },
        {
          label: `${name} configure`,
          program: "./configure",
          args: ["--prefix=" + targetDir, ...(target === "windows" ? ["--host=x86_64-w64-mingw32"] : [])],
          cwd: dir,
          env: target === "native" ? nativeEnv() : windowsEnv(),
        },
        { label: `${name} compile`, program: "make", args: ["-j3"], cwd: dir },
        { label: `${name} install`, program: "make", args: ["install"], cwd: dir },
      ];
    }

    it.each(["native", "windows"] as const)("%s, with neither clone directory present", (target) => {
      const expected = libraries.flatMap((lib) => library(lib.name, lib.repo, target, false));
      expect(getInstallSteps(config, target, 3, inherited)).toEqual(expected);
    });

    it.each(["native", "windows"] as const)("%s, with both clone directories present", (target) => {
      for (const lib of libraries) {
        fs.mkdirSync(path.join(process.cwd(), lib.name));
      }
      const expected = libraries.flatMap((lib) => library(lib.name, lib.repo, target, true));
      expect(getInstallSteps(config, target, 3, inherited)).toEqual(expected);
    });

    it.each(["native", "windows"] as const)("%s, with only the first clone directory present", (target) => {
      fs.mkdirSync(path.join(process.cwd(), libraries[0].name));
      const expected = [
        ...library(libraries[0].name, libraries[0].repo, target, true),
        ...library(libraries[1].name, libraries[1].repo, target, false),
      ];
      expect(getInstallSteps(config, target, 3, inherited)).toEqual(expected);
    });
  });
});

interface AutotoolsStepOptions {
  prefix: string;
  host: string | null;
  jobs: number;
  env: Record<string, string>;
  reconfigure: boolean;
  distclean: boolean;
  cwd?: string;
  labelPrefix?: string;
}

type AutotoolsStepsFunction = (options: AutotoolsStepOptions) => BuildStep[];

describe("autotoolsSteps", () => {
  const env = { PKG_CONFIG_PATH: "/some/pkgconfig" };

  function autotoolsSteps(options: AutotoolsStepOptions): BuildStep[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- the module is loaded when a case runs so this file compiles without it
    const loaded = require("../src/AutotoolsSteps") as { autotoolsSteps: AutotoolsStepsFunction };
    return loaded.autotoolsSteps(options);
  }

  const base: AutotoolsStepOptions = { prefix: "/p/x", host: null, jobs: 6, env, reconfigure: true, distclean: true };

  it("gives autogen, distclean, configure, compile and install in order", () => {
    expect(autotoolsSteps(base)).toEqual([
      { label: "autogen", program: "./autogen.sh", args: [] },
      { label: "distclean", program: "make", args: ["distclean"], ignoreExitCode: true },
      { label: "configure", program: "./configure", args: ["--prefix=/p/x"], env },
      { label: "compile", program: "make", args: ["-j6"] },
      { label: "install", program: "make", args: ["install"] },
    ]);
  });

  it("gives compile and install only when reconfigure is false", () => {
    expect(autotoolsSteps({ ...base, reconfigure: false })).toEqual([
      { label: "compile", program: "make", args: ["-j6"] },
      { label: "install", program: "make", args: ["install"] },
    ]);
  });

  it("leaves out make distclean when distclean is false", () => {
    const labels = autotoolsSteps({ ...base, distclean: false }).map((step) => step.label);
    expect(labels).toEqual(["autogen", "configure", "compile", "install"]);
  });

  it("puts make distclean, which ignores its exit status, between autogen and configure", () => {
    const steps = autotoolsSteps(base);
    expect(steps.map((step) => step.label)).toEqual(["autogen", "distclean", "configure", "compile", "install"]);
    expect(steps[1]).toEqual({ label: "distclean", program: "make", args: ["distclean"], ignoreExitCode: true });
  });

  it("adds no --host option when host is null", () => {
    const configure = autotoolsSteps(base).find((step) => step.label === "configure");
    expect(configure?.args).toEqual(["--prefix=/p/x"]);
  });

  it("adds --host after --prefix when host is given", () => {
    const configure = autotoolsSteps({ ...base, host: "x86_64-w64-mingw32" }).find((step) => step.label === "configure");
    expect(configure?.args).toEqual(["--prefix=/p/x", "--host=x86_64-w64-mingw32"]);
  });

  it("applies cwd to every step, including make distclean", () => {
    const steps = autotoolsSteps({ ...base, cwd: "/work/lib" });
    expect(steps).toHaveLength(5);
    for (const step of steps) {
      expect(step.cwd).toBe("/work/lib");
    }
  });

  it("sets no cwd when none is given", () => {
    for (const step of autotoolsSteps(base)) {
      expect(step.cwd).toBeUndefined();
    }
  });

  it("starts every label with the label prefix and a space", () => {
    const labels = autotoolsSteps({ ...base, labelPrefix: "libx" }).map((step) => step.label);
    expect(labels).toEqual(["libx autogen", "libx distclean", "libx configure", "libx compile", "libx install"]);
  });

  it("keeps the labels plain when no label prefix is given", () => {
    const labels = autotoolsSteps(base).map((step) => step.label);
    expect(labels).toEqual(["autogen", "distclean", "configure", "compile", "install"]);
  });

  it("gives the environment to the configure step only", () => {
    const steps = autotoolsSteps(base);
    for (const step of steps) {
      if (step.label === "configure") {
        expect(step.env).toEqual(env);
      } else {
        expect(step.env).toBeUndefined();
      }
    }
  });
});
