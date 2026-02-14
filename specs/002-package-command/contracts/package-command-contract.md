# API Contract: Package Command

**Feature**: 002-package-command  
**Date**: 2026-02-13

## CLI Interface

### Command Syntax

```
the-seed package <output-dir> <file1> [file2] ...
the-seed package help
```

### Arguments

| Position | Name | Required | Description |
|---|---|---|---|
| 1 | `command` | Yes | Must be `package` (or `help` for usage) |
| 2 | `output-dir` | Yes | Name/path of the directory to create |
| 3+ | `files` | Yes (min 1) | Paths to binary files to include in the package |

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success — all files packaged |
| 1 | Error — invalid arguments, missing files, existing directory, dependency resolution failure |

### Output Format

**Success (stdout)**:
```
Copying myapp...
Copying libfoo.so...
Copying libbar.so...
Packaged 3 files into my-release/
```

**Error — missing input file (stderr)**:
```
Error: File not found: path/to/missing-binary
```

**Error — directory already exists (stderr)**:
```
Error: Output directory already exists: my-release
```

**Error — no files specified (stderr)**:
```
Usage: the-seed package <directory> <file1> [file2] ...
```

**Error — dependency resolution failure (stderr)**:
```
Error: Failed to analyze binary: path/to/binary
  <error description from DependencyLister>
```

**Help output (stdout)**:
```
Usage: the-seed package <directory> <file1> [file2] ...

Package binary files with their shared library dependencies into a directory.

Arguments:
  directory    Name of the output directory to create
  file1...     Binary files (executables or libraries) to include

The command uses DependencyLister from libthe-seed to resolve all shared
library dependencies and copies them into the output directory.
```

---

## TypeScript Module API

### Package Class

**File**: `src/Package.ts`

```typescript
import Config from "./Config";

class Package {
  config: Config;

  constructor(config: Config);

  /**
   * Build the list of search paths from Config prefix and all known build targets.
   * Returns paths like: ["~/the-seed/x86_64-linux-gnu/lib", "~/the-seed/x86_64-w64-mingw32/lib"]
   */
  getSearchPaths(): string[];

  /**
   * Invoke the native addon's listDependencies() to call DependencyLister::ListDependencies() directly.
   * Returns the result as a plain JS object.
   */
  resolveDependencies(binaryPaths: string[], searchPaths: string[]): DependencyResultType;

  /**
   * Main entry point: validate inputs, resolve dependencies, create directory, copy files.
   * Returns true on success, false on validation/resolution errors (after printing messages).
   */
  run(outputDir: string, binaryPaths: string[]): boolean;
}
```

### New Types (in `types.ts`)

```typescript
export interface DependencyResultType {
  dependencies: Record<string, string[]>;
  errors: Record<string, string>;
}
```

### PackageCLI Handler

**File**: `src/scripts/PackageCLI.ts`

```typescript
import { ScriptArgsType } from "../types";

/**
 * CLI handler for the package command.
 * Parses args[3] as command/output-dir, args[4+] as binary file paths.
 * Delegates to Package class for all logic.
 */
const PackageCLI: (scriptConfig: ScriptArgsType) => void;
```

### CLI Router Addition

**File**: `src/scripts/the-seed.ts`

```typescript
// Add to switch(section):
case "package":
  PackageCLI(scriptConfig);
  break;

// Add to help output:
console.log(scriptConfig.binName + " package");
```

### Public API Export

**File**: `src/index.ts`

```typescript
// Add:
import Package from "./Package";
export { Package };
// Add DependencyResultType to the type exports
```

---

## Native Addon Contract

**Source**: `native/src/addon.cpp`  
**Build**: `native/binding.gyp` (compiled with `node-gyp`, links against `libthe-seed` via `pkg-config`)  
**Loaded by**: `Package.ts` via `require('../native/build/Release/dependency_lister.node')` or bindings loader

### Exported Function

```typescript
/**
 * Synchronous call to DependencyLister::ListDependencies().
 * @param binaryPaths - Array of file paths to compiled binaries (ELF or PE).
 * @param searchPaths - Ordered array of directories to search when resolving library names.
 * @returns Plain JS object with dependencies and errors maps.
 * @throws Error if the native call itself fails (e.g., invalid arguments).
 */
function listDependencies(binaryPaths: string[], searchPaths: string[]): {
  dependencies: Record<string, string[]>;
  errors: Record<string, string>;
};
```

### Return Value Semantics

```typescript
{
  dependencies: {
    "/absolute/path/to/libfoo.so": ["./binary1", "./binary2"],  // resolved → copy this
    "/absolute/path/to/libbar.so": ["./binary1"],                // resolved → copy this
    "libsystem.so.6": ["./binary1"]                              // unresolved → skip (system lib)
  },
  errors: {}  // empty = all binaries analyzed successfully
}
```

**Key semantics in `dependencies`**:
- Absolute path → resolved library file, should be copied to package directory
- Bare name (no `/` prefix) → unresolvable/system library, should be skipped

---

## Test Contract

**File**: `test/Package.test.ts`

### Mocking Strategy

Mock the native addon module (same pattern as mocking `child_process` but for the addon's `listDependencies` function). Use `jest.mock()` to replace the addon import with a mock that returns controlled `DependencyResultType` objects. Use temp directories for file system operations.

### Required Test Cases

| Category | Test | Validates |
|---|---|---|
| Happy path | Package binary with dependencies → creates dir, copies all files | FR-004, FR-005, FR-006, FR-007 |
| Happy path | Package binary with no non-system dependencies → only explicit files copied | FR-006 |
| Happy path | Two binaries sharing a dependency → dependency copied once | FR-008 |
| Verbose output | Each file printed during copy, summary at end | FR-013 |
| Error | Input file doesn't exist → error message, no directory created | FR-009 |
| Error | Output directory already exists → error message | FR-010 |
| Error | No files specified → usage error | FR-012 |
| Error | DependencyLister returns errors → fatal abort | FR-004, FR-009 |
| Help | `help` subcommand → prints usage | FR-011 |
| Help | No arguments → prints usage | FR-012 |
| Integration | Search paths constructed from Config prefix + all targets | FR-004 |
