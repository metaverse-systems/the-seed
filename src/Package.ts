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
   * Parse src/Makefile.am in a project directory to determine the binary type and name.
   * Returns { type, name } for programs (bin_PROGRAMS) or libraries (lib_LTLIBRARIES), or null on error.
   */
  parseMakefileAm = (projectDir: string): { type: "program" | "library"; name: string } | null => {
    const makefileAmPath = path.join(projectDir, "src", "Makefile.am");
    if (!fs.existsSync(makefileAmPath)) {
      console.error("Error: src/Makefile.am not found in " + projectDir);
      return null;
    }

    const content = fs.readFileSync(makefileAmPath, "utf-8");

    // Check for bin_PROGRAMS = <name>
    const programMatch = content.match(/^bin_PROGRAMS\s*=\s*(\S+)/m);
    if (programMatch) {
      return { type: "program", name: programMatch[1] };
    }

    // Check for lib_LTLIBRARIES = <name>.la
    const libraryMatch = content.match(/^lib_LTLIBRARIES\s*=\s*(\S+)\.la/m);
    if (libraryMatch) {
      return { type: "library", name: libraryMatch[1] };
    }

    console.error("Error: Could not determine binary type from " + makefileAmPath);
    return null;
  };

  /**
   * Resolve actual installed binary paths from a project directory for all build targets.
   * Resolve binary paths from the libtool build output in {projectDir}/src/.libs/.
   * For programs: looks for {name} (native) or {name}.exe (cross-compiled for Windows).
   * For libraries: looks for {name}.so (native) or {name}*.dll (cross-compiled for Windows).
   */
  resolveBinaryPaths = (projectDir: string): string[] => {
    const parsed = this.parseMakefileAm(projectDir);
    if (!parsed) return [];

    const binaryPaths: string[] = [];
    const libsDir = path.join(projectDir, "src", ".libs");

    if (!fs.existsSync(libsDir)) {
      return binaryPaths;
    }

    if (parsed.type === "program") {
      // Native binary (no extension)
      const nativePath = path.join(libsDir, parsed.name);
      if (fs.existsSync(nativePath) && fs.statSync(nativePath).isFile()) {
        binaryPaths.push(nativePath);
      }
      // Cross-compiled Windows binary (.exe)
      const windowsPath = path.join(libsDir, parsed.name + ".exe");
      if (fs.existsSync(windowsPath)) {
        binaryPaths.push(windowsPath);
      }
    } else {
      // library
      const files = fs.readdirSync(libsDir);
      for (const file of files) {
        // Native shared library (.so)
        if (file === parsed.name + ".so") {
          binaryPaths.push(path.join(libsDir, file));
        }
        // Cross-compiled Windows DLL
        if (file.startsWith(parsed.name) && file.endsWith(".dll")) {
          binaryPaths.push(path.join(libsDir, file));
        }
      }
    }

    return binaryPaths;
  };

  /**
   * Recursively read package.json from a project directory and resolve dependency
   * directories via node_modules. Returns an array of absolute paths to all native
   * dependency project directories (those with src/Makefile.am), including transitive deps.
   */
  getPackageDeps = (projectDir: string, visited: Set<string> = new Set()): string[] => {
    const resolved = path.resolve(projectDir);
    if (visited.has(resolved)) return [];
    visited.add(resolved);

    const packageJsonPath = path.join(projectDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return [];
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const deps = packageJson.dependencies || {};
    const depDirs: string[] = [];

    for (const depName of Object.keys(deps)) {
      const depDir = path.join(projectDir, "node_modules", depName);
      if (fs.existsSync(depDir) && fs.existsSync(path.join(depDir, "src", "Makefile.am"))) {
        depDirs.push(depDir);
        // Recurse into the dependency's own package.json
        depDirs.push(...this.getPackageDeps(depDir, visited));
      }
    }

    return depDirs;
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
   * Main entry point: validate inputs, resolve binary paths from project directories,
   * resolve dependencies, create directory, copy files.
   * Returns true on success, false on validation/resolution errors (after printing messages).
   */
  run = (outputDir: string, projectDirs: string[]): boolean => {
    // Validate output directory doesn't already exist
    if (fs.existsSync(outputDir)) {
      console.error("Error: Output directory already exists: " + outputDir);
      return false;
    }

    // Validate all project directories exist and are directories
    for (const projectDir of projectDirs) {
      if (!fs.existsSync(projectDir)) {
        console.error("Error: Directory not found: " + projectDir);
        return false;
      }
      const stat = fs.statSync(projectDir);
      if (!stat.isDirectory()) {
        console.error("Error: Not a directory: " + projectDir);
        return false;
      }
    }

    // Resolve binary paths from project directories and their package.json dependencies
    const binaryPaths: string[] = [];
    for (const projectDir of projectDirs) {
      const paths = this.resolveBinaryPaths(projectDir);
      if (paths.length === 0) {
        console.error("Error: No installed binaries found for " + projectDir);
        return false;
      }
      binaryPaths.push(...paths);

      // Also resolve binaries from package.json dependencies in node_modules
      const depDirs = this.getPackageDeps(projectDir);
      for (const depDir of depDirs) {
        const depPaths = this.resolveBinaryPaths(depDir);
        if (depPaths.length > 0) {
          binaryPaths.push(...depPaths);
        }
      }
    }

    // Resolve dependencies recursively — resolved libraries may have their own dependencies
    const searchPaths = this.getSearchPaths();
    const filesToCopy = new Set<string>();

    // Add resolved binary paths
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
