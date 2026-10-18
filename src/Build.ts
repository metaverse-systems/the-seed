import fs from "fs";
import path from "path";
import Config from "./Config";
import { BuildStep, ProjectBuildOptions, ProjectBuildResult, StripResult } from "./types";
import Signing from "./Signing";
import { processorCount } from "./BuildScheduler";
import { librarySearchEnv } from "./LibrarySearch";
import { runStep, stepText } from "./StepRunner";
import { runCommand, commandFailedMessage, findOnPath, formatCommand } from "./ProcessRunner";

export const targets: {
  [key: string]: string;
} = {
  native: "x86_64-linux-gnu",
  windows: "x86_64-w64-mingw32",
};

/** The tool's own output streams, used when a build is given no sink. */
const ownOutput = {
  stdout: (chunk: Buffer) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk: Buffer) => {
    process.stderr.write(chunk);
  },
};

class Build {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Builds the project in `options.projectDir`: a full build (autogen,
   * distclean, configure, compile, install) when a target is given, otherwise
   * an incremental one (compile and install). A release build then strips the
   * installed binaries, and the built binaries are signed when a certificate
   * exists.
   *
   * Each step's output is passed on as it arrives, never kept, so a build can
   * write any amount. The first cancellation stops the running step and
   * starts no other; install, strip and sign run under the force signal so a
   * single Ctrl+C lets an install in progress finish.
   */
  buildProject = async (options: ProjectBuildOptions): Promise<ProjectBuildResult> => {
    const log = options.log ?? ((line: string) => console.log(line));
    const output = options.output ?? ownOutput;
    const fullReconfigure = options.target !== undefined;
    const target = options.target ?? "native";

    for (const step of this.getSteps(target, fullReconfigure, options.jobs, options.env)) {
      const isInstall = step.label === "install";
      if (isInstall && (options.signal?.aborted || options.forceSignal?.aborted)) {
        return { status: "cancelled" };
      }

      const text = stepText(step);
      log(`==> ${step.label}: ${text}`);

      const outcome = await runStep(step, {
        baseDir: options.projectDir,
        baseEnv: options.env,
        signal: isInstall ? options.forceSignal : options.signal,
        output: { mode: "stream", output },
      });

      switch (outcome.status) {
        case "interrupted":
          return { status: "cancelled" };
        case "notFound":
          return { status: "failed", step: step.label, message: outcome.message };
        case "failed":
          return {
            status: "failed",
            step: step.label,
            message: outcome.exitCode === null ? `${text} was ended by ${outcome.signal}` : `${text} exited with status ${outcome.exitCode}`,
          };
        case "ignored":
          log(`${step.label} exited with status ${outcome.exitCode}; ignored.`);
          break;
        case "completed":
          break;
      }
    }

    if (options.release && options.target !== undefined) {
      try {
        await stripBinaries(options.projectDir, options.target, options.forceSignal, options.log);
      } catch (e: unknown) {
        if (options.forceSignal?.aborted) return { status: "cancelled" };
        return { status: "failed", step: "strip", message: (e as Error).message ?? String(e) };
      }
    }

    try {
      await autoSignIfCertExists(options.configDir, options.projectDir, options.log);
    } catch (e: unknown) {
      return { status: "failed", step: "sign", message: (e as Error).message ?? String(e) };
    }

    return { status: "completed" };
  };

  /**
   * Returns an ordered array of BuildStep objects for the given target and mode.
   * @param target - 'native' or 'windows'
   * @param fullReconfigure - if true, includes autogen/distclean/configure steps; if false, only compile+install
   * @param jobs - compile job limit; defaults to the processor count, so the compile step is always "make -j<jobs>"
   * @param inherited - the environment whose PKG_CONFIG_PATH the library search extends; defaults to process.env
   */
  getSteps = (
    target: string,
    fullReconfigure: boolean,
    jobs: number = processorCount(),
    inherited: NodeJS.ProcessEnv = process.env
  ): BuildStep[] => {
    const newTarget = targets[target];
    const prefix = this.config.config.prefix + "/" + newTarget;

    const steps: BuildStep[] = [];

    if (fullReconfigure) {
      steps.push({ label: "autogen", program: "./autogen.sh", args: [] });

      steps.push({ label: "distclean", program: "make", args: ["distclean"], ignoreExitCode: true });

      steps.push({
        label: "configure",
        program: "./configure",
        args: [
          "--prefix=" + prefix,
          ...(target === "windows" ? ["--host=" + targets["windows"]] : []),
        ],
        env: librarySearchEnv(this.config.config.prefix, target, inherited),
      });
    }

    steps.push({ label: "compile", program: "make", args: [`-j${jobs}`] });

    steps.push({ label: "install", program: "make", args: ["install"] });

    return steps;
  };

  /**
   * Get the install prefix directory for the given target (native by default).
   */
  getInstallPrefix = (target = "native"): string => {
    return this.config.config.prefix + "/" + targets[target];
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
 * @param log - Receives each progress line whole, instead of it being printed
 */
export async function autoSignIfCertExists(
  configDir: string,
  projectDir?: string,
  log?: (line: string) => void
): Promise<void> {
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
        const line = result.signatureType === "embedded"
          ? `Signed (embedded): ${rel}`
          : `Signed (detached): ${rel} → ${path.basename(result.signaturePath!)}`;
        if (log) {
          log(line);
        } else {
          console.log(`  ${line}`);
        }
        signedCount++;
      }
    } catch {
      // Skip files that can't be signed
    }
  }

  if (signedCount > 0) {
    const line = `Auto-signed ${signedCount} file(s) using scope '${scope}'`;
    if (log) {
      log(line);
    } else {
      console.log(`\n${line}`);
    }
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
 *
 * Aborting `signal` stops the strip command that is running and strips no
 * further files; the promise then rejects.
 *
 * When `log` is given it receives each progress line whole and nothing is
 * printed, so a caller building several projects at once can attribute the
 * lines without another project's output landing mid-line.
 */
export async function stripBinaries(
  projectDir: string,
  target: string,
  signal?: AbortSignal,
  log?: (line: string) => void
): Promise<StripResult> {
  const stripTool = getStripTool(target);

  const toolPath = findOnPath(stripTool);
  if (toolPath === null) {
    const hint = target === "windows"
      ? "\nInstall the MinGW binutils package (e.g., binutils-mingw-w64-x86-64) and try again."
      : "\nInstall binutils (for example the binutils package) and try again.";
    throw new Error(`Strip tool '${stripTool}' not found on this system.${hint}`);
  }

  const report = (line: string) => (log ? log(line) : console.log(`[strip] ${line}`));

  report(`Using strip tool: ${stripTool}`);

  const candidates = findBuiltOutputs(projectDir);
  const strippedFiles: string[] = [];

  for (const filePath of candidates) {
    if (!isBinaryByMagic(filePath)) continue;

    if (signal?.aborted) {
      throw new Error("Strip cancelled");
    }

    const rel = path.relative(projectDir, filePath);
    if (!log) {
      process.stdout.write(`[strip] Stripping ${rel}... `);
    }
    // Completes the line begun above, or reports it whole to the logger.
    const finishLine = (status: string) => (log ? log(`Stripping ${rel}... ${status}`) : console.log(status));

    const stripArgs = ["--strip-unneeded", filePath];
    const result = await runCommand(toolPath, stripArgs, { signal });
    if (result.killed) {
      finishLine("cancelled");
      throw new Error("Strip cancelled");
    }
    if (result.exitCode !== 0) {
      finishLine("FAILED");
      throw new Error(`strip failed on ${rel}: ${commandFailedMessage(formatCommand(toolPath, stripArgs), result.stderr)}`);
    }
    finishLine("done");
    strippedFiles.push(filePath);
  }

  report(`Stripped ${strippedFiles.length} file(s)`);

  return { strippedFiles, stripTool };
}

export default Build;
