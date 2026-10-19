import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const COMPILE_TIMEOUT_MS = 30000;

function have(program: string): boolean {
  const result = spawnSync(program, ["--version"], { env: toolEnv(), timeout: COMPILE_TIMEOUT_MS, stdio: "ignore" });
  return result.status === 0;
}

export function haveCc(): boolean {
  return have("cc");
}

export function haveMingw(): boolean {
  return have("x86_64-w64-mingw32-gcc");
}

/** The only environment a compiler child process gets. */
export function toolEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
}

function compile(compiler: string, args: string[]): void {
  const result = spawnSync(compiler, args, { env: toolEnv(), timeout: COMPILE_TIMEOUT_MS, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${compiler} ${args.join(" ")} failed (status ${result.status}): ${result.error?.message ?? ""}\n${result.stdout}${result.stderr}`
    );
  }
}

function replaceLink(target: string, link: string): void {
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
}

export interface BuildLibraryOptions {
  libName: string;
  soname?: string;
  version: string;
  text: string;
}

/**
 * Compiles src/.libs/lib<libName>.so.<version> from a one-function C file (<libName>_text
 * returns `text`) and makes the links libtool makes: lib<libName>.so.<major>, only when a
 * soname is given, and lib<libName>.so. Returns the path of the real file.
 */
export function buildLibrary(projectDir: string, options: BuildLibraryOptions): string {
  const libs = path.join(projectDir, "src", ".libs");
  fs.mkdirSync(libs, { recursive: true });
  const source = path.join(projectDir, "src", `lib${options.libName}-${options.version}.c`);
  fs.writeFileSync(
    source,
    `const char *${options.libName}_text(void) { return ${JSON.stringify(options.text)}; }\n`
  );
  const file = path.join(libs, `lib${options.libName}.so.${options.version}`);
  const args = ["-shared", "-fPIC"];
  if (options.soname !== undefined) {
    args.push(`-Wl,-soname,${options.soname}`);
  }
  args.push("-o", file, source);
  compile("cc", args);
  if (options.soname !== undefined) {
    const major = options.version.split(".")[0];
    replaceLink(path.basename(file), path.join(libs, `lib${options.libName}.so.${major}`));
  }
  replaceLink(path.basename(file), path.join(libs, `lib${options.libName}.so`));
  return file;
}

export interface BuildProgramOptions {
  program: string;
  libDirs: string[];
  libs: string[];
}

/**
 * Compiles src/.libs/<program>, which prints the result of <lib>_text() for each library
 * on its own line, linked against lib<lib>.so found in libDirs. Returns the program's path.
 */
export function buildProgram(projectDir: string, options: BuildProgramOptions): string {
  const libs = path.join(projectDir, "src", ".libs");
  fs.mkdirSync(libs, { recursive: true });
  const source = path.join(projectDir, "src", `${options.program}.c`);
  const declarations = options.libs.map((lib) => `const char *${lib}_text(void);`).join("\n");
  const calls = options.libs.map((lib) => `  puts(${lib}_text());`).join("\n");
  fs.writeFileSync(source, `#include <stdio.h>\n${declarations}\nint main(void) {\n${calls}\n  return 0;\n}\n`);
  const file = path.join(libs, options.program);
  const args = ["-o", file, source];
  for (const dir of options.libDirs) {
    args.push(`-L${dir}`);
  }
  for (const lib of options.libs) {
    args.push(`-l${lib}`);
  }
  compile("cc", args);
  return file;
}

/** Copies `file` into a scratch prefix library directory and makes each name in `links` a link to it. */
export function installLibrary(prefixLibDir: string, file: string, links: string[]): string {
  fs.mkdirSync(prefixLibDir, { recursive: true });
  const installed = path.join(prefixLibDir, path.basename(file));
  fs.copyFileSync(file, installed);
  for (const link of links) {
    replaceLink(path.basename(file), path.join(prefixLibDir, link));
  }
  return installed;
}

export interface BuildWindowsOptions {
  libName: string;
  text: string;
  program?: string;
}

/**
 * Cross-compiles src/.libs/lib<libName>-0.dll and, when `program` is given,
 * src/.libs/<program>.exe that prints the library's text. Returns the paths built.
 */
export function buildWindows(projectDir: string, options: BuildWindowsOptions): { dll: string; exe?: string } {
  const compiler = "x86_64-w64-mingw32-gcc";
  const libs = path.join(projectDir, "src", ".libs");
  fs.mkdirSync(libs, { recursive: true });
  const librarySource = path.join(projectDir, "src", `lib${options.libName}-win.c`);
  fs.writeFileSync(
    librarySource,
    `__declspec(dllexport) const char *${options.libName}_text(void) { return ${JSON.stringify(options.text)}; }\n`
  );
  const dll = path.join(libs, `lib${options.libName}-0.dll`);
  compile(compiler, ["-shared", "-o", dll, librarySource]);
  if (options.program === undefined) {
    return { dll };
  }
  const programSource = path.join(projectDir, "src", `${options.program}-win.c`);
  fs.writeFileSync(
    programSource,
    `#include <stdio.h>\nconst char *${options.libName}_text(void);\nint main(void) {\n  puts(${options.libName}_text());\n  return 0;\n}\n`
  );
  const exe = path.join(libs, `${options.program}.exe`);
  compile(compiler, ["-o", exe, programSource, dll]);
  return { dll, exe };
}

/** Runs dir/<program> with exactly PATH, LD_LIBRARY_PATH=dir and LC_ALL=C. */
export function runFrom(dir: string, program: string): { status: number | null; output: string } {
  const result = spawnSync(path.join(dir, program), [], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", LD_LIBRARY_PATH: dir, LC_ALL: "C" },
    encoding: "utf8",
    timeout: COMPILE_TIMEOUT_MS,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
