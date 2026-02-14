import fs from "fs-extra";
import path from "path";
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
   */
  getSearchPaths = (): string[] => {
    const searchPaths: string[] = [];
    for (const target of Object.keys(targets)) {
      const targetDir = targets[target];
      const prefix = this.config.config.prefix + "/" + targetDir;
      searchPaths.push(prefix + "/lib");
      searchPaths.push(prefix + "/bin");
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

    // Resolve dependencies
    const searchPaths = this.getSearchPaths();
    const result = this.resolveDependencies(binaryPaths, searchPaths);

    // Check for errors from DependencyLister
    const errorKeys = Object.keys(result.errors);
    if (errorKeys.length > 0) {
      for (const binaryPath of errorKeys) {
        console.error("Error: Failed to analyze binary: " + binaryPath);
        console.error("  " + result.errors[binaryPath]);
      }
      return false;
    }

    // Build deduplicated file list: explicit binaries + resolved dependencies
    const filesToCopy = new Set<string>();

    // Add explicit binary paths
    for (const filePath of binaryPaths) {
      filesToCopy.add(path.resolve(filePath));
    }

    // Add resolved dependencies (only absolute paths that exist on disk)
    for (const depPath of Object.keys(result.dependencies)) {
      if (path.isAbsolute(depPath) && fs.existsSync(depPath)) {
        filesToCopy.add(depPath);
      }
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
