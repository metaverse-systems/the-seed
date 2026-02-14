# Implementation Plan: Address Technical Debt

**Branch**: `001-address-tech-debt` | **Date**: 2026-02-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-address-tech-debt/spec.md`

## Summary

Resolve all technical debt identified in the project constitution: replace 8 explicit `any` type annotations across 4 source files with proper interfaces, add Jest test coverage for the 3 untested modules (`Template`, `Build`, `Dependencies`), and migrate 6 `require()` calls across 4 files to ES `import` syntax. Enable `noImplicitAny` enforcement (already active via `strict: true`) and add ESLint `no-explicit-any` rule to prevent regressions.

## Technical Context

**Language/Version**: TypeScript 4.6.x, ES6 target, CommonJS module output  
**Primary Dependencies**: fs-extra ^10.0.1, inquirer ^8.2.2, child_process (Node built-in)  
**Storage**: N/A (filesystem-based config.json)  
**Testing**: Jest 27.x with ts-jest 27.x  
**Target Platform**: Linux (Node.js CLI); Windows via MinGW cross-compilation only  
**Project Type**: Single project (library + CLI)  
**Performance Goals**: N/A (CLI tool, no latency/throughput requirements)  
**Constraints**: Autotools/pkg-config required on host for runtime CLI usage (not for tests)  
**Scale/Scope**: ~8 source files, ~600 LOC; 3 existing test files, 3 new test files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Rule | Status | Notes |
|------|--------|-------|
| **Strict TypeScript**: Eliminate `any` types | ✅ ALIGNED | Core objective of this feature |
| **Class-based design**: Continue using classes | ✅ ALIGNED | No new classes; existing classes unchanged structurally |
| **ES module interop**: CommonJS with `esModuleInterop: true` | ✅ ALIGNED | Migrating `require()` to `import` at source level; compiled output remains CommonJS |
| **Library vs CLI separation**: `src/*.ts` = library, `src/scripts/*.ts` = CLI | ✅ ALIGNED | No changes to separation boundary |
| **Testing - Framework**: Jest with ts-jest | ✅ ALIGNED | New tests use same framework |
| **Testing - Coverage required**: All new modules must include tests | ✅ ALIGNED | Adding tests for 3 uncovered modules |
| **Testing - Isolation**: Temp dirs, clean up | ✅ ALIGNED | New tests follow existing pattern |
| **Testing - Naming**: `<ModuleName>.test.ts` in `test/` | ✅ ALIGNED | `Template.test.ts`, `Build.test.ts`, `Dependencies.test.ts` |
| **C++ templates**: Autotools with `SKELETON` substitution | ✅ NOT AFFECTED | Template files not modified |
| **No browser runtime**: Review `"dom"` in tsconfig lib | ⚠️ OUT OF SCOPE | Noted but not addressed in this feature |

**Gate result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-address-tech-debt/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (TypeScript interface definitions)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── types.ts          # MODIFIED: Replace 3 `any` types with concrete types
├── Config.ts         # MODIFIED: Replace `any` in parseAnswers, remove dynamic key access
├── Scopes.ts         # MODIFIED: Replace 3 `any` params with new typed interfaces
├── Template.ts       # MODIFIED: Replace `any` property, migrate 2 require() + require.main
├── Build.ts          # MODIFIED: Migrate 1 require() to import
├── Dependencies.ts   # MODIFIED: Migrate 1 require() to import
├── ResourcePak.ts    # MODIFIED: Migrate 2 require() to import
└── index.ts          # MODIFIED: Export new types (ScopeAnswersType, ScopeDefaultsType)

test/
├── Config.test.ts       # EXISTING: May need minor update for ConfigType change
├── Scopes.test.ts       # EXISTING: May need type updates for ScopeAnswersType
├── ResourcePak.test.ts  # EXISTING: PRE-EXISTING BUG — calls non-existent API methods
├── Template.test.ts     # NEW: Template scaffolding tests
├── Build.test.ts        # NEW: Build pipeline tests (mocked execSync)
└── Dependencies.test.ts # NEW: Dependency detection tests (mocked execSync)

tsconfig.json            # VERIFIED: strict:true already includes noImplicitAny
```

**Structure Decision**: Existing single-project layout is maintained. No new directories needed — changes are modifications to existing files and addition of 3 test files.

## Complexity Tracking

> No constitution violations. No complexity justifications needed.
