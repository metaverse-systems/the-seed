import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";
import Config from "./Config";
import { targets } from "./Build";
import { DependencyResultType } from "./types";

class Package {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Build the list of search paths from Config prefix and all known build targets.
   * Includes both lib/ and bin/ directories since Windows DLLs are installed to bin/.
   * Also includes the MinGW cross-compiler runtime directory for Windows targets.
   */
  getSearchPaths = (): string[] => {
    const searchPaths: string[] = [];
    for (const target of Object.keys(targets)) {
      const targetDir = targets[target];
      const prefix = this.config.config.prefix + "/" + targetDir;
      searchPaths.push(prefix + "/lib");
      searchPaths.push(prefix + "/bin");
    }

    // Detect MinGW cross-compiler runtime directory for Windows DLLs
    // (libstdc++-6.dll, libgcc_s_seh-1.dll, libwinpthread-1.dll)
    try {
      const mingwGccPath = execSync(
        "x86_64-w64-mingw32-gcc -print-file-name=libstdc++-6.dll",
        { stdio: "pipe" }
      ).toString().trim();
      if (mingwGccPath && mingwGccPath !== "libstdc++-6.dll") {
        searchPaths.push(path.dirname(mingwGccPath));
      }
    } catch {
      // MinGW cross-compiler not installed — skip
    }

    // Also detect MinGW sysroot lib for libwinpthread-1.dll
    try {
      const mingwWinpthreadPath = execSync(
        "x86_64-w64-mingw32-gcc -print-file-name=libwinpthread-1.dll",
        { stdio: "pipe" }
      ).toString().trim();
      if (mingwWinpthreadPath && mingwWinpthreadPath !== "libwinpthread-1.dll") {
        const dir = path.dirname(mingwWinpthreadPath);
        if (!searchPaths.includes(dir)) {
          searchPaths.push(dir);
        }
      }
    } catch {
      // MinGW cross-compiler not installed — skip
    }

    return searchPaths;
  };

  /**
   * Invoke the native addon's listDependencies() to call DependencyLister::ListDependencies() directly.
   * Returns the result as a plain JS object.
   */
  resolveDependencies = (binaryPaths: string[], searchPaths: string[]): DependencyResultType => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const addon = require("../native/build/Release/dependency_lister.node");
    return addon.listDependencies(binaryPaths, searchPaths);
  };

  /**
   * Main entry point: validate inputs, resolve dependencies, create directory, copy files.
   * Returns true on success, false on validation/resolution errors (after printing messages).
   */
  run = (outputDir: string, binaryPaths: string[]): boolean => {
    // Validate output directory doesn't already exist
    if (fs.existsSync(outputDir)) {
      console.error("Error: Output directory already exists: " + outputDir);
      return false;
    }

    // Validate all input files exist and are files (not directories)
    for (const filePath of binaryPaths) {
      if (!fs.existsSync(filePath)) {
        console.error("Error: File not found: " + filePath);
        return false;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        console.error("Error: Not a file: " + filePath);
        return false;
      }
    }

    // Resolve dependencies recursively — resolved libraries may have their own dependencies
    const searchPaths = this.getSearchPaths();
    const filesToCopy = new Set<string>();

    // Add explicit binary paths
    for (const filePath of binaryPaths) {
      filesToCopy.add(path.resolve(filePath));
    }

    // Iteratively resolve until no new dependencies are found
    let toAnalyze = [...binaryPaths];
    const analyzed = new Set<string>();

    while (toAnalyze.length > 0) {
      const result = this.resolveDependencies(toAnalyze, searchPaths);

      // Check for errors from DependencyLister
      const errorKeys = Object.keys(result.errors);
      if (errorKeys.length > 0) {
        for (const binaryPath of errorKeys) {
          console.error("Error: Failed to analyze binary: " + binaryPath);
          console.error("  " + result.errors[binaryPath]);
        }
        return false;
      }

      // Mark current batch as analyzed
      for (const p of toAnalyze) {
        analyzed.add(path.resolve(p));
      }

      // Collect newly discovered resolved dependencies
      const nextBatch: string[] = [];
      for (const depPath of Object.keys(result.dependencies)) {
        if (path.isAbsolute(depPath) && fs.existsSync(depPath)) {
          if (!filesToCopy.has(depPath)) {
            filesToCopy.add(depPath);
            // If not yet analyzed, queue for transitive resolution
            if (!analyzed.has(depPath)) {
              nextBatch.push(depPath);
            }
          }
        }
      }

      toAnalyze = nextBatch;
    }

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Copy files
    for (const filePath of filesToCopy) {
      const destPath = path.join(outputDir, path.basename(filePath));
      console.log("Copying " + path.basename(filePath) + "...");
      fs.copyFileSync(filePath, destPath);
    }

    // Report summary
    console.log("Packaged " + filesToCopy.size + " files into " + outputDir + "/");
    return true;
  };
}

export default Package;
