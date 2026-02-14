# Data Model: Package Command

**Feature**: 002-package-command  
**Date**: 2026-02-13

## Entities

### DependencyResultType

Represents the output of `DependencyLister::ListDependencies()`, returned by the native addon as a plain JavaScript object.

| Field | Type | Description |
|---|---|---|
| `dependencies` | `Record<string, string[]>` | Reverse dependency map. Key: resolved absolute path of a shared library (or bare name if unresolvable). Value: list of input binary paths that depend on it. |
| `errors` | `Record<string, string>` | Error map. Key: input binary path that failed analysis. Value: human-readable error description. |

**Validation Rules**:
- An empty `dependencies` map is valid (binaries with no shared library dependencies).
- A non-empty `errors` map triggers a fatal abort in the package command.
- Only entries in `dependencies` where the key is an existing absolute file path represent copyable shared libraries; bare-name entries represent system libraries and are skipped.

### PackageOptionsType

Configuration for a single package operation, constructed from CLI arguments and Config.

| Field | Type | Description |
|---|---|---|
| `outputDir` | `string` | Path to the output directory to create (first CLI argument). |
| `binaryPaths` | `string[]` | List of binary file paths to include (remaining CLI arguments). |
| `searchPaths` | `string[]` | Ordered list of directories for DependencyLister to search when resolving library names. Constructed from Config prefix + all target lib dirs. |

**Validation Rules**:
- `outputDir` must not already exist on the filesystem.
- `binaryPaths` must contain at least one entry.
- Every path in `binaryPaths` must point to an existing file (not a directory).
- `searchPaths` is derived from Config and the `targets` map; not user-provided.

## Relationships

```
PackageOptionsType --[uses]--> Config (prefix path)
PackageOptionsType --[uses]--> targets map from Build.ts (target directory names)
Package.run(options) --[calls]--> native addon listDependencies() --[returns]--> DependencyResultType
Package.run(options) --[reads]--> binaryPaths (validates existence)
Package.run(options) --[creates]--> outputDir
Package.run(options) --[copies]--> binary files + resolved dependency files into outputDir
```

## State Transitions

The package operation is a single-pass batch process with no persistent state. The logical flow:

```
VALIDATE_INPUTS → RESOLVE_DEPENDENCIES → CREATE_DIRECTORY → COPY_FILES → REPORT_SUMMARY
      │                    │                                       │
      ▼                    ▼                                       ▼
  ERROR_EXIT          ERROR_EXIT                              ERROR_EXIT
  (bad args)        (analysis failed                       (copy failed)
                   or unresolvable dep)
```

1. **VALIDATE_INPUTS**: Check `outputDir` doesn't exist, all `binaryPaths` exist and are files.
2. **RESOLVE_DEPENDENCIES**: Call native addon `listDependencies()`, receive JS object result.
3. **CHECK_ERRORS**: If `errors` map is non-empty, abort with error messages.
4. **BUILD_FILE_LIST**: Collect explicit binary paths + resolved dependency paths (only absolute paths that exist on disk), deduplicate.
5. **CREATE_DIRECTORY**: Create `outputDir`.
6. **COPY_FILES**: Copy each file into `outputDir`, printing each filename.
7. **REPORT_SUMMARY**: Print total count and directory name.
