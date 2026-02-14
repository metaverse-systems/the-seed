# Research: Package Command

**Feature**: 002-package-command  
**Date**: 2026-02-13

## Research Question 1: How to invoke DependencyLister from TypeScript

### Decision
Create a native Node.js addon using `node-addon-api` (N-API) that links against `libthe-seed` and directly calls `DependencyLister::ListDependencies()`. The addon exposes a single JavaScript function `listDependencies(binaryPaths, searchPaths)` that returns a plain JS object matching the `DependencyResult` structure. The addon is built with `node-gyp` as part of this project.

### Rationale
- Direct C++ integration eliminates the need for a separate CLI wrapper binary, JSON serialization/parsing, and `execSync` overhead.
- `node-addon-api` (N-API) is the standard, stable approach for calling C++ from Node.js — ABI-stable across Node versions.
- The addon links against the installed `libthe-seed` shared library (found via `pkg-config`) so it always uses the same `DependencyLister` implementation.
- `node-gyp` is already standard in the Node.js ecosystem and handles cross-platform compilation. The project already depends on C++ toolchains (autotools, gcc, MinGW) so this adds no new system requirements.

### Alternatives Considered
- **CLI wrapper binary via `execSync`**: Adds a separate binary to build, install, and maintain. Requires JSON serialization in C++ and parsing in TypeScript. Rejected — user prefers direct C++ calls.
- **FFI via `node-ffi-napi`**: Can call C functions but poorly suited for C++ classes with `std::map`/`std::vector` return types. Would require a C wrapper around DependencyLister anyway. Rejected — more complexity than a native addon.
- **Embed dependency logic in TypeScript** (parse ELF/PE from JS): Duplicates C++ implementation. Rejected.

## Research Question 2: Native addon structure and build

### Decision
Add a `native/` directory in the project root containing:
- `binding.gyp` — node-gyp build configuration that links against `libthe-seed` (using `pkg-config` for include/lib paths)
- `src/addon.cpp` — N-API wrapper that instantiates `DependencyLister`, calls `ListDependencies()`, and converts the `DependencyResult` to JS objects
- The compiled `.node` file is loaded by `Package.ts` via `require()` or a bindings loader

### Rationale
- Keeping native code in a dedicated `native/` directory separates it from the TypeScript source.
- `binding.gyp` integrates with `npm install` (via the `install` script) so the addon is compiled when the package is installed.
- Using `pkg-config` to find `libthe-seed` headers and libraries is consistent with how `Dependencies.ts` already uses `pkg-config` for dependency checking.

### Alternatives Considered
- **Inline the `.gyp` at project root**: Works but pollutes root. Rejected for organization.
- **Use `cmake-js` instead of `node-gyp`**: Equally valid but `node-gyp` is more conventional in the npm ecosystem. Rejected for consistency.

## Research Question 3: How to construct search_paths for DependencyLister

### Decision
Pass all configured target lib directories from Config prefix as search paths:
```
${config.prefix}/${targetDir}/lib/
```
For all targets in the `targets` map (e.g., `x86_64-linux-gnu/lib`, `x86_64-w64-mingw32/lib`).

### Rationale
- `DependencyLister` uses **no platform defaults** for search paths — they must be explicitly provided.
- Including all target lib dirs is safe: DependencyLister iterates paths and checks filesystem existence, so Windows lib paths are harmlessly checked when analyzing ELF binaries and vice versa.
- This matches how `Dependencies.ts` and `Build.ts` construct paths using `config.config.prefix + "/" + targetDir`.

### Alternatives Considered
- **Include only the detected target's lib dir**: Would require the package command to know the target, contradicting the "no target argument" clarification. Rejected.
- **Include system paths like `/usr/lib`**: Would cause system libraries to be resolved and copied. Rejected — the filtering mechanism relies on system libraries remaining unresolved (bare names, not absolute paths).
- **Include CWD or build output paths**: Not needed — project libraries are installed to the prefix by `the-seed build`, which is the expected workflow before packaging.

## Research Question 4: System library filtering mechanism

### Decision
System library filtering is implicit via `DependencyLister`'s search path resolution. Libraries not found in provided `search_paths` appear in the result's `dependencies` map with bare names (e.g., `"libc.so.6"`) rather than absolute paths. The package command copies only entries where the key is an existing absolute file path, which automatically excludes system libraries.

### Rationale
- `DependencyLister` documents: key is "resolved absolute filesystem path of a discovered library, **or the recorded name if the library could not be located on the filesystem**."
- By providing only the project's prefix lib directories as search paths (not `/usr/lib`, `/lib`), system libraries won't resolve to absolute paths.
- Checking `fs.existsSync(key)` or checking for an absolute path prefix cleanly separates project dependencies from system ones.

### Alternatives Considered
- **Maintain an explicit exclusion list of system libraries**: Brittle, platform-dependent, and requires maintenance. Rejected.
- **Filter by path prefix (exclude `/usr/lib`, `/lib`)**: Works but couples the package command to Linux filesystem layout. Rejected — the implicit mechanism is cleaner.

## Research Question 5: DependencyResult error handling

### Decision
If `DependencyResult.errors` is non-empty, treat it as a fatal error: print all error messages, do not create the output directory, and exit with a non-zero status.

### Rationale
- The spec states: "The command treats this as a fatal error, aborts without creating the output directory, and reports which library is missing."
- `DependencyResult.errors` keys are input binary paths that failed processing. If we can't analyze a binary's dependencies, the package would be incomplete.
- Errors for individual binaries are already collected without aborting the DependencyLister itself, so all errors can be reported at once.

### Alternatives Considered
- **Warn and continue**: Would produce incomplete packages with missing dependency info. Rejected per spec.

## Research Question 6: N-API addon JavaScript interface

### Decision
The native addon exports a single function:
```typescript
function listDependencies(binaryPaths: string[], searchPaths: string[]): DependencyResultType;
```
It returns a plain JavaScript object:
```typescript
{
  dependencies: Record<string, string[]>,  // library path -> [binary paths]
  errors: Record<string, string>           // binary path -> error message
}
```
The function is synchronous (matching `DependencyLister::ListDependencies` which is a synchronous C++ operation).

### Rationale
- A single synchronous function mirrors the C++ API exactly: one method, takes two `vector<string>`, returns a struct with two maps.
- Returning a plain JS object avoids any N-API handle management on the caller side.
- Synchronous is appropriate because the operation is CPU-bound (parsing binary headers) and the CLI is not concurrent.

### Alternatives Considered
- **Async/Promise-based interface**: Adds complexity (AsyncWorker) with no benefit for a CLI tool. Rejected.
- **Expose the DependencyLister class to JS**: Over-engineering — only one method is needed. Rejected.
