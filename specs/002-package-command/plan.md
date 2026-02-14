# Implementation Plan: Package Command

**Branch**: `002-package-command` | **Date**: 2026-02-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-package-command/spec.md`

## Summary

Add a `the-seed package <dir> <file1> [file2] ...` CLI command that collects binary files and their shared library dependencies into a single output directory. The command calls the `DependencyLister` C++ class from `libthe-seed` directly via a native Node.js addon (built with `node-addon-api` / N-API and `node-gyp`). The addon exposes a synchronous `listDependencies()` function that TypeScript calls to resolve runtime shared library dependencies, then creates the directory and copies all files into it.

## Technical Context

**Language/Version**: TypeScript 4.6 (CommonJS, `esModuleInterop: true`), compiled with `tsc`  
**Primary Dependencies**: `fs-extra` (file operations), `node-addon-api` + `node-gyp` (native addon to call `libthe-seed` C++ directly), existing `Config` class (prefix path resolution)  
**Storage**: Filesystem only — reads binaries, writes to output directory  
**Testing**: Jest with `ts-jest`, `child_process` mocked via `jest.mock`, temp directories via `fs.mkdtempSync`  
**Target Platform**: Linux primary (native `x86_64-linux-gnu`); Windows via MinGW cross-compilation (`x86_64-w64-mingw32`)  
**Project Type**: Single project — extends existing CLI with new command module  
**Performance Goals**: N/A — batch CLI operation, performance bounded by file I/O  
**Constraints**: Must call `DependencyLister` from `libthe-seed` C++ library directly via a native Node.js addon (N-API). `DependencyLister` requires `search_paths` (no platform defaults); Config prefix provides these. Requires `libthe-seed` headers and shared library installed (via `the-seed dependencies install`) for the addon to compile.  
**Scale/Scope**: Single new module (`Package.ts`), single new CLI handler (`PackageCLI.ts`), single new test file (`Package.test.ts`), native addon (`native/` directory with `binding.gyp` + `addon.cpp`), wiring into existing `the-seed.ts` router.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | Notes |
|---|---|---|
| Strict TypeScript: no `any` types | PASS | New code will use explicit types throughout |
| Class-based design for domain modules | PASS | New `Package` class follows Config/Build/ResourcePak pattern |
| Library vs CLI separation | PASS | `Package.ts` in `src/`, `PackageCLI.ts` in `src/scripts/` |
| Tests required for new modules | PASS | `Package.test.ts` planned with mocked native addon |
| Tests use temp directories, clean up | PASS | Will use `fs.mkdtempSync` + `fs.rmSync` pattern from existing tests |
| Test naming: `<Module>.test.ts` in `test/` | PASS | `test/Package.test.ts` |
| Native C++ integration via N-API addon | PASS | `node-addon-api` is the standard stable approach; project already requires C++ toolchains |
| ES module interop: CommonJS with `esModuleInterop` | PASS | No changes to module system |

No gate violations. No entries needed in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-package-command/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── package-command-contract.md
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
native/
├── binding.gyp          # NEW — node-gyp build config; links against libthe-seed via pkg-config
└── src/
    └── addon.cpp        # NEW — N-API wrapper: calls DependencyLister::ListDependencies(), returns JS object

src/
├── Package.ts           # NEW — Package class: loads native addon, dependency resolution + directory creation + file copying
├── Config.ts            # EXISTING — provides prefix path for library search paths
├── Build.ts             # EXISTING — provides targets map (reused for search path construction)
├── types.ts             # MODIFIED — add DependencyResultType interface
└── index.ts             # MODIFIED — export Package class

src/scripts/
├── the-seed.ts          # MODIFIED — add "package" case to CLI router switch
└── PackageCLI.ts        # NEW — CLI handler for package command

test/
└── Package.test.ts      # NEW — Jest tests with mocked native addon and temp directories
```

**Structure Decision**: Single project extension. New `native/` directory for the N-API addon. TypeScript files follow the existing 1:1 pattern of library module + CLI handler + test file.
