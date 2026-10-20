import fs from "fs-extra";
import { NativeComponentMissingError, loadNativeComponent, preloadNativeComponent, requireNativeComponent } from "./NativeComponent";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import Config from "./Config";
import { readElfNames } from "./ElfNames";
import { targets } from "./Build";
import {
  ConflictingProjectError,
  DependencyDiscoveryError,
  isBuildable,
  walkDependencies,
} from "./DependencyWalker";
import {
  DependencyResultType,
  PackagePlan,
  PackageResult,
  PlannedFile,
  UnpackagedLibrary,
} from "./types";

preloadNativeComponent();

/**
 * Packages project binaries with the shared libraries they need into one directory.
 *
 * Dependency projects are found by the rule the recursive build uses: for each entry in a project's
 * package.json `dependencies`, a `file:` path is taken relative to the declaring project and any
 * other dependency (for example one installed from npm) is looked up in that project's own
 * node_modules, each project once by real location.
 * A Linux library is written under the name programs load it by (its soname), as a regular file,
 * with its signature under the same name; programs and Windows files keep their names. Two
 * different files for one name are refused and nothing is written. Libraries needed but left to
 * the target system are reported.
 */
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
   * A native library is returned as the real file the development link {name}.so leads to.
   */
  resolveBinaryPaths = (projectDir: string): string[] => {
    const parsed = this.parseMakefileAm(projectDir);
    if (!parsed) return [];

    const binaryPaths: string[] = [];
    const libsDir = path.join(projectDir, "src", ".libs");
    const srcDir = path.join(projectDir, "src");

    if (parsed.type === "program") {
      // Check .libs/ first (libtool-wrapped programs), then src/ (non-libtool programs)
      const candidates = [
        path.join(libsDir, parsed.name),
        path.join(srcDir, parsed.name),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          binaryPaths.push(candidate);
          break;
        }
      }
      // Cross-compiled Windows binary (.exe)
      const windowsCandidates = [
        path.join(libsDir, parsed.name + ".exe"),
        path.join(srcDir, parsed.name + ".exe"),
      ];
      for (const candidate of windowsCandidates) {
        if (fs.existsSync(candidate)) {
          binaryPaths.push(candidate);
          break;
        }
      }
    } else {
      // library — only .libs/ is relevant for libtool libraries
      if (!fs.existsSync(libsDir)) {
        return binaryPaths;
      }
      const files = fs.readdirSync(libsDir);
      for (const file of files) {
        // Native shared library (.so)
        if (file === parsed.name + ".so") {
          try {
            binaryPaths.push(fs.realpathSync(path.join(libsDir, file)));
          } catch {
            // a dangling link leads to no file
          }
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
   * Invoke the native addon's listDependencies() to call DependencyLister::ListDependencies() directly.
   * Returns the result as a plain JS object.
   * @throws NativeComponentMissingError when the native component is not built
   */
  resolveDependencies = (binaryPaths: string[], searchPaths: string[]): DependencyResultType => {
    const addon = loadNativeComponent<{ listDependencies(binaryPaths: string[], searchPaths: string[]): DependencyResultType }>();
    return addon.listDependencies(binaryPaths, searchPaths);
  };

  /**
   * Decide what packaging the given project directories would write, without writing anything.
   * Dependency projects are found with the walker the recursive build uses; a directory that is
   * not a project contributes itself alone. Resolves a refusal (not a rejection) for a dependency
   * cycle, two different directories with one package name, an unreadable package.json, a malformed
   * ELF file, or two different files that would be written under one name. It also resolves a refusal, naming the
   * step that builds it, when the native component is not built.
   */
  plan = async (projectDirs: string[]): Promise<PackagePlan> => {
    const refuse = (message: string): PackagePlan => ({ ok: false, message });

    // Packaging needs the native component: refuse before discovery or any output
    try {
      requireNativeComponent();
    } catch (error) {
      if (error instanceof NativeComponentMissingError) {
        return refuse(error.message);
      }
      throw error;
    }

    // Discovery: merge the projects of every given directory by real location
    const projectNames = new Map<string, string>();
    const nameLocations = new Map<string, string>();
    const given = new Set<string>();
    try {
      for (const projectDir of projectDirs) {
        const resolved = path.resolve(projectDir);
        const location = fs.realpathSync(resolved);
        given.add(location);
        const found: { name: string; location: string }[] = [];
        if (await isBuildable(location)) {
          const graph = await walkDependencies(location);
          for (const [projectPath, project] of graph.projects) {
            found.push({ name: project.name, location: projectPath });
          }
        } else {
          found.push({ name: path.basename(location), location });
        }
        for (const { name, location: projectPath } of found) {
          if (projectNames.has(projectPath)) {
            continue;
          }
          const known = nameLocations.get(name);
          if (known !== undefined && known !== projectPath) {
            return refuse(new ConflictingProjectError(name, known, projectPath).message);
          }
          nameLocations.set(name, projectPath);
          projectNames.set(projectPath, name);
        }
      }
    } catch (error) {
      if (error instanceof DependencyDiscoveryError) {
        return refuse(error.message);
      }
      throw error;
    }

    // Build-tree outputs: the given directories must have some, dependency projects may
    const files: PlannedFile[] = [];
    const planned = new Map<string, PlannedFile>();
    // Registers a file under its packaged name: the same content twice is kept once (the first
    // entry and its signature stay), different content under one name is a refusal.
    const register = (file: PlannedFile): string | null => {
      const first = planned.get(file.name);
      if (first === undefined) {
        planned.set(file.name, file);
        files.push(file);
        return null;
      }
      if (first.sha256 === file.sha256) {
        return null;
      }
      return this.collisionMessage(first, file);
    };
    const givenByLocation = new Map<string, string>();
    for (const projectDir of projectDirs) {
      givenByLocation.set(fs.realpathSync(path.resolve(projectDir)), projectDir);
    }
    const outputsByLocation = new Map<string, string[]>();
    for (const location of projectNames.keys()) {
      const outputs = this.resolveBinaryPaths(location);
      if (outputs.length === 0 && given.has(location)) {
        return refuse("No installed binaries found for " + (givenByLocation.get(location) ?? location));
      }
      outputsByLocation.set(location, outputs);
    }
    const binaryPaths: string[] = [];
    for (const [location, name] of projectNames) {
      const outputs = outputsByLocation.get(location) ?? [];
      if (outputs.length === 0) {
        continue;
      }
      const isLibrary = this.parseMakefileAm(location)?.type === "library";
      const libsDir = path.join(location, "src", ".libs");
      for (const output of outputs) {
        let source = fs.realpathSync(output);
        let packagedName = path.basename(output);
        let signatureDir = path.dirname(output);
        if (isLibrary && !output.endsWith(".dll")) {
          // A native library goes out under the name programs load it by, with the content that name leads to
          const base = this.parseMakefileAm(location)?.name ?? packagedName;
          let soname: string | null;
          try {
            soname = readElfNames(source)?.soname ?? null;
          } catch (error) {
            return refuse(error instanceof Error ? error.message : String(error));
          }
          packagedName = base + ".so";
          if (soname !== null) {
            packagedName = soname;
            const named = path.join(libsDir, soname);
            if (fs.existsSync(named)) {
              source = fs.realpathSync(named);
            }
          }
          signatureDir = libsDir;
        }
        const before = files.length;
        const collision = register(this.plannedFile(packagedName, source, { kind: "project", project: name, location }, signatureDir));
        if (collision !== null) {
          return refuse(collision);
        }
        if (files.length > before) {
          binaryPaths.push(source);
        }
      }
    }

    // Libraries: analyse in rounds until no new dependency is found
    const searchPaths = this.getSearchPaths();
    const analyzed = new Set<string>();
    const warnedLibraries = new Set<string>();
    const askedNames = new Map<string, string>();
    const planSources = new Set<string>(files.map((file) => file.source));
    const missing = new Map<string, string>();
    let toAnalyze = binaryPaths;

    while (toAnalyze.length > 0) {
      const result = this.resolveDependencies(toAnalyze, searchPaths);

      const errorKeys = Object.keys(result.errors);
      if (errorKeys.length > 0) {
        const lines: string[] = [];
        for (const binaryPath of errorKeys) {
          lines.push("Failed to analyze binary: " + binaryPath);
          lines.push("  " + result.errors[binaryPath]);
        }
        return refuse(lines.join("\n"));
      }

      // Libraries that were found but could not be read: warn, keep packaging them
      const libraryErrors = result.libraryErrors ?? {};
      for (const libPath of Object.keys(libraryErrors)) {
        if (warnedLibraries.has(libPath)) {
          continue;
        }
        warnedLibraries.add(libPath);
        console.warn("Warning: Library could not be read: " + libPath);
        console.warn("  " + libraryErrors[libPath].reason);
        console.warn("  Needed by: " + libraryErrors[libPath].inputs.join(", "));
      }

      for (const p of toAnalyze) {
        analyzed.add(p);
        // The names the analysed files ask for, and the files they lead to
        let names: { needed: string[] } | null = null;
        try {
          names = readElfNames(p);
        } catch {
          // the dependency lister has already judged this file
        }
        for (const asked of names?.needed ?? []) {
          for (const searchPath of searchPaths) {
            const candidate = path.join(searchPath, asked);
            if (fs.existsSync(candidate)) {
              const real = fs.realpathSync(candidate);
              if (!askedNames.has(real)) {
                askedNames.set(real, asked);
              }
              break;
            }
          }
        }
      }

      // Names the search paths did not lead to: remember the first input, by packaged name, that needs each
      const packagedNameOf = (input: string): string => {
        const known = files.find((file) => file.source === input);
        if (known !== undefined) {
          return known.name;
        }
        try {
          const real = fs.realpathSync(input);
          return files.find((file) => file.source === real)?.name ?? path.basename(input);
        } catch {
          return path.basename(input);
        }
      };
      for (const key of Object.keys(result.dependencies)) {
        if (path.isAbsolute(key)) {
          continue;
        }
        for (const input of result.dependencies[key]) {
          const neededBy = packagedNameOf(input);
          const first = missing.get(key);
          if (first === undefined || neededBy < first) {
            missing.set(key, neededBy);
          }
        }
      }

      const nextBatch: string[] = [];
      for (const depPath of Object.keys(result.dependencies).sort()) {
        if (!path.isAbsolute(depPath) || !fs.existsSync(depPath)) {
          continue;
        }
        const source = fs.realpathSync(depPath);
        if (planSources.has(source)) {
          continue;
        }
        planSources.add(source);
        const directory = searchPaths.find((searchPath) => path.dirname(source) === searchPath) ?? path.dirname(source);
        let packagedName = path.basename(depPath);
        if (!(depPath in libraryErrors)) {
          try {
            const soname = readElfNames(source)?.soname ?? null;
            packagedName = soname ?? askedNames.get(source) ?? packagedName;
          } catch (error) {
            return refuse(error instanceof Error ? error.message : String(error));
          }
        }
        const collision = register(this.plannedFile(packagedName, source, { kind: "search-path", directory }, directory));
        if (collision !== null) {
          return refuse(collision);
        }
        if (!analyzed.has(source) && !(depPath in libraryErrors)) {
          nextBatch.push(source);
        }
      }

      toAnalyze = nextBatch;
    }

    const notPackaged: UnpackagedLibrary[] = [...missing.keys()]
      .filter((name) => !planned.has(name))
      .sort()
      .map((name) => ({ name, neededBy: missing.get(name) as string }));

    return { ok: true, projects: [...projectNames.keys()], files, notPackaged };
  };

  /**
   * The refusal text for two different files that would be written under one name.
   */
  private collisionMessage = (first: PlannedFile, second: PlannedFile): string => {
    const describe = (file: PlannedFile): string =>
      file.source + " (" + (file.origin.kind === "project"
        ? "build of " + file.origin.project
        : "installed in " + file.origin.directory) + ")";
    const lines = [
      "Two different files would be packaged as " + first.name + ":",
      "  " + describe(first),
      "  " + describe(second),
    ];
    const build = [first, second].find((file) => file.origin.kind === "project");
    const installed = [first, second].find((file) => file.origin.kind === "search-path");
    if (build !== undefined && installed !== undefined && build.origin.kind === "project" && installed.origin.kind === "search-path") {
      const directory = installed.origin.directory;
      const target = Object.keys(targets).find((key) => directory.startsWith(this.config.config.prefix + "/" + targets[key] + "/")) ?? "native";
      lines.push(
        "The installed copy differs from the build of " + build.origin.project + "; install it again with \"the-seed build " +
          target + "\" in " + build.origin.location + ", or remove the stale copy."
      );
    }
    lines.push("Nothing was written.");
    return lines.join("\n");
  };

  /**
   * A file to be written under a name, with its content hash and its signature: the one named for
   * the packaged name in the directory the name was resolved in, else the one beside the real file.
   */
  private plannedFile = (name: string, source: string, origin: PlannedFile["origin"], directory: string): PlannedFile => {
    const candidates = [path.join(directory, name + ".sig"), source + ".sig"];
    return {
      name,
      source,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
      signature: candidates.find((candidate) => fs.existsSync(candidate)) ?? null,
      origin,
    };
  };

  /**
   * Main entry point: validate inputs, decide what to package, create the directory, copy files.
   * Resolves a PackageResult (it no longer returns a boolean); a refusal or failure is printed once
   * as "Error: <message>", `success` is false and nothing is left written. Without the native component the
   * refusal names the step that builds it, and nothing is read or written.
   */
  run = async (outputDir: string, projectDirs: string[]): Promise<PackageResult> => {
    const failed = (message: string): PackageResult => {
      console.error("Error: " + message);
      return {
        success: false,
        message,
        outputDir,
        projects: [],
        files: [],
        signatures: 0,
        fileCount: 0,
        notPackaged: [],
      };
    };

    // Validate output directory doesn't already exist
    if (fs.existsSync(outputDir)) {
      return failed("Output directory already exists: " + outputDir);
    }

    // Validate all project directories exist and are directories
    for (const projectDir of projectDirs) {
      if (!fs.existsSync(projectDir)) {
        return failed("Directory not found: " + projectDir);
      }
      if (!fs.statSync(projectDir).isDirectory()) {
        return failed("Not a directory: " + projectDir);
      }
    }

    const plan = await this.plan(projectDirs);
    if (!plan.ok) {
      return failed(plan.message);
    }

    // Create output directory and copy files (and their .sig signature files)
    fs.mkdirSync(outputDir, { recursive: true });
    let signatures = 0;
    for (const file of plan.files) {
      try {
        const from = file.name === path.basename(file.source) ? "" : " (from " + file.source + ")";
        console.log("Copying " + file.name + from + "...");
        fs.copyFileSync(file.source, path.join(outputDir, file.name));
        if (file.signature !== null) {
          console.log("Copying " + file.name + ".sig...");
          fs.copyFileSync(file.signature, path.join(outputDir, file.name + ".sig"));
          signatures++;
        }
      } catch (error) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        return failed("Copying " + file.name + " failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }

    // Report summary
    const fileCount = plan.files.length + signatures;
    let summary = "Packaged " + fileCount + " files into " + outputDir + "/";
    if (signatures > 0) {
      summary += " (" + signatures + " signature" + (signatures > 1 ? "s" : "") + " included)";
    }
    console.log(summary);
    if (plan.notPackaged.length > 0) {
      console.log("Not packaged (expected on the target system):");
      for (const library of plan.notPackaged) {
        console.log("  " + library.name + " (needed by " + library.neededBy + ")");
      }
    }

    return {
      success: true,
      message: null,
      outputDir,
      projects: plan.projects,
      files: plan.files.map((file) => file.name),
      signatures,
      fileCount,
      notPackaged: plan.notPackaged,
    };
  };
}

export default Package;
