import fs from "fs";
import path from "path";
import Config from "./Config";
import { execSync } from "child_process";
import { BuildStep, StripResult } from "./types";
import Signing from "./Signing";

export const targets: {
  [key: string]: string;
} = {
  native: "x86_64-linux-gnu",
  windows: "x86_64-w64-mingw32",
};

const execOptions = { stdio: "pipe" as const };

class Build {
  config: Config;
  target = "linux";

  constructor(config: Config) {
    this.config = config;
  }

  autogen = () => {
    const autogen_command = "./autogen.sh";
    try {
      const result = execSync(autogen_command, execOptions).toString();
    } catch (e) {
      console.error(e);
      throw e;
    }

    console.log("Completed " + autogen_command);
  };

  configure = () => {
    const newTarget = targets[this.target];
    const distclean_command = "make distclean";
    try {
      const result = execSync(distclean_command, execOptions).toString();
    } catch (e) {}

    const prefix = this.config.config.prefix + "/" + newTarget;

    const configure_command =
      "PKG_CONFIG_PATH=" +
      prefix +
      "/lib/pkgconfig/ " +
      "./configure --prefix=" +
      prefix +
      (this.target === "windows" ? " --host=" + targets["windows"] : "");

    try {
      const result = execSync(configure_command, execOptions).toString();
    } catch (e) {
      console.error(e);
      throw e;
    }

    console.log("Configure complete");
  };

  reconfigure = (target: string) => {
    this.target = target;
    this.autogen();
    this.configure();
  };

  compile = () => {
    const make_command = "make -j";

    try {
      const result = execSync(make_command).toString();
      console.log(result);
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  install = () => {
    const install_command = "make install";

    try {
      const result = execSync(install_command).toString();
      console.log(result);
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  /**
   * Returns an ordered array of BuildStep objects for the given target and mode.
   * @param target - 'native' or 'windows'
   * @param fullReconfigure - if true, includes autogen/distclean/configure steps; if false, only compile+install
   */
  getSteps = (target: string, fullReconfigure: boolean): BuildStep[] => {
    const newTarget = targets[target];
    const prefix = this.config.config.prefix + "/" + newTarget;

    const steps: BuildStep[] = [];

    if (fullReconfigure) {
      steps.push({
        label: "autogen",
        command: "./autogen.sh",
      });

      steps.push({
        label: "distclean",
        command: "make distclean",
        ignoreExitCode: true,
      });

      const configureCommand =
        "PKG_CONFIG_PATH=" +
        prefix +
        "/lib/pkgconfig/ " +
        "./configure --prefix=" +
        prefix +
        (target === "windows" ? " --host=" + targets["windows"] : "");

      steps.push({
        label: "configure",
        command: configureCommand,
      });
    }

    steps.push({
      label: "compile",
      command: "make -j",
    });

    steps.push({
      label: "install",
      command: "make install",
    });

    return steps;
  };

  /**
   * Get the install prefix directory for the current or specified target.
   */
  getInstallPrefix = (target?: string): string => {
    const t = target || this.target;
    const newTarget = targets[t];
    return this.config.config.prefix + "/" + newTarget;
  };
}

/**
 * Extract the scope (org) from a scoped package name.
 * e.g., "@metaverse-systems/libecs-cpp" → "@metaverse-systems"
 * Returns undefined if the name is not scoped.
 */
export function extractScope(packageName: string): string | undefined {
  if (packageName.startsWith("@")) {
    const slashIndex = packageName.indexOf("/");
    if (slashIndex > 0) {
      return packageName.substring(0, slashIndex);
    }
  }
  return undefined;
}

/**
 * Find built binary outputs in a project's src/ directory.
 * Scans src/ (non-recursively) and src/.libs/ for binary build outputs,
 * skipping intermediate artifacts like .o, .lo, .la files.
 */
export function findBuiltOutputs(projectDir: string): string[] {
  const srcDir = path.join(projectDir, "src");
  if (!fs.existsSync(srcDir)) return [];

  const skipExtensions = new Set([".o", ".lo", ".la", ".lai"]);
  const results: string[] = [];

  const scanDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (skipExtensions.has(ext)) continue;
      results.push(path.join(dir, entry.name));
    }
  };

  scanDir(srcDir);
  scanDir(path.join(srcDir, ".libs"));

  return results;
}

/**
 * After a successful build+install, check if the project's package.json has a scoped name.
 * If a signing certificate exists for that scope, auto-sign the built binaries in src/.
 *
 * @param configDir - Path to the-seed config directory
 * @param projectDir - Path to the project directory (defaults to process.cwd())
 */
export async function autoSignIfCertExists(configDir: string, projectDir?: string): Promise<void> {
  const dir = projectDir || process.cwd();
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let pkg: { name?: string };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return;
  }

  if (!pkg.name) return;

  const scope = extractScope(pkg.name);
  if (!scope) return;

  const signing = new Signing(configDir);
  if (!signing.hasCert(scope)) return;

  const certInfo = signing.getCertInfo(scope);
  if (!certInfo || certInfo.isExpired) return;

  const candidates = findBuiltOutputs(dir);
  let signedCount = 0;

  for (const filePath of candidates) {
    try {
      if (await signing.isBinaryFile(filePath)) {
        const result = await signing.signFile(filePath, { scope });
        const rel = path.relative(dir, filePath);
        if (result.signatureType === "embedded") {
          console.log(`  Signed (embedded): ${rel}`);
        } else {
          console.log(`  Signed (detached): ${rel} → ${path.basename(result.signaturePath!)}`);
        }
        signedCount++;
      }
    } catch {
      // Skip files that can't be signed
    }
  }

  if (signedCount > 0) {
    console.log(`\nAuto-signed ${signedCount} file(s) using scope '${scope}'`);
  }
}

/**
 * Returns the appropriate strip tool name for the given build target.
 * @internal Exported for unit testing
 */
export function getStripTool(target: string): string {
  if (target === "native") {
    return "strip";
  }
  return targets[target] + "-strip";
}

/**
 * Checks if a file is an ELF or PE binary by reading the first 4 bytes.
 * Returns true if the file starts with ELF magic (\x7fELF) or PE magic (MZ).
 * @internal Exported for unit testing
 */
export function isBinaryByMagic(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;

    // ELF magic: 0x7f 'E' 'L' 'F'
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return true;
    }
    // PE magic: 'M' 'Z'
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      return true;
    }

    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Strips debug symbols from all binary outputs in a project.
 * Verifies the strip tool exists, finds binary outputs, filters by magic bytes,
 * and runs `strip --strip-unneeded` on each binary.
 */
export async function stripBinaries(projectDir: string, target: string): Promise<StripResult> {
  const stripTool = getStripTool(target);

  // Verify strip tool exists
  try {
    execSync(`command -v ${stripTool}`, { stdio: "pipe" });
  } catch {
    const hint = target === "windows"
      ? `\nInstall the MinGW binutils package (e.g., binutils-mingw-w64-x86-64) and try again.`
      : "";
    throw new Error(`Strip tool '${stripTool}' not found on this system.${hint}`);
  }

  console.log(`[strip] Using strip tool: ${stripTool}`);

  const candidates = findBuiltOutputs(projectDir);
  const strippedFiles: string[] = [];

  for (const filePath of candidates) {
    if (!isBinaryByMagic(filePath)) continue;

    const rel = path.relative(projectDir, filePath);
    process.stdout.write(`[strip] Stripping ${rel}... `);

    try {
      execSync(`${stripTool} --strip-unneeded ${filePath}`, { stdio: "pipe" });
      console.log("done");
      strippedFiles.push(filePath);
    } catch (e: unknown) {
      console.log("FAILED");
      const err = e as { message?: string };
      throw new Error(`strip failed on ${rel}: ${err.message ?? "Unknown error"}`);
    }
  }

  console.log(`[strip] Stripped ${strippedFiles.length} file(s)`);

  return { strippedFiles, stripTool };
}

export default Build;
