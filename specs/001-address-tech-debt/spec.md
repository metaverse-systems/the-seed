# Feature Specification: Address Technical Debt

**Feature Branch**: `001-address-tech-debt`  
**Created**: 2026-02-13  
**Status**: Draft  
**Input**: User description: "Address the technical debt."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Eliminate Unsafe Types (Priority: P1)

A contributor opens the codebase and expects every function parameter, return value, and property to have an explicit, meaningful type so that the compiler catches mistakes at build time rather than at runtime. Today, 8 instances of `any` across 4 source files bypass the compiler's safety checks. After this work, the contributor can rely on the compiler to flag type mismatches, making refactoring and feature development faster and less error-prone.

**Why this priority**: Untyped code is the single largest source of preventable runtime errors. Every other change to the codebase is safer once types are enforced, so this must come first.

**Independent Test**: Can be fully tested by running the TypeScript compiler with `strict` and `noImplicitAny` enabled and confirming zero type errors. Delivers immediate value by enabling the compiler to catch bugs that currently go unnoticed.

**Acceptance Scenarios**:

1. **Given** the codebase contains `any` types in `types.ts`, `Scopes.ts`, `Template.ts`, and `Config.ts`, **When** a contributor compiles the project, **Then** the compiler reports zero `any`-related warnings or errors.
2. **Given** `ConfigType` previously allowed arbitrary keys via an `any` index signature, **When** a contributor attempts to assign a value of the wrong type to a known config key, **Then** the compiler rejects the assignment at build time.
3. **Given** `Scopes.ts` prompt functions now use typed parameter interfaces, **When** a contributor passes an object missing a required field, **Then** the compiler reports the missing property.

---

### User Story 2 - Add Test Coverage for Untested Modules (Priority: P2)

A contributor modifying the `Template`, `Build`, or `Dependencies` modules today has no automated way to verify their changes haven't broken existing behavior. After this work, each of these three modules has a corresponding test suite that validates its core behavior, giving contributors confidence that changes produce correct results.

**Why this priority**: Without tests, changes to scaffolding, building, and dependency management are high-risk. Test coverage is the foundation for safe future development, but depends on having correct types first (User Story 1).

**Independent Test**: Can be fully tested by running the test suite (`npm test`) and confirming that all new tests pass. Each module's tests validate independently — `Template` tests verify scaffolding, `Build` tests verify build pipeline orchestration, and `Dependencies` tests verify library detection and installation logic.

**Acceptance Scenarios**:

1. **Given** there is no `Template.test.ts`, **When** the test suite runs, **Then** a `Template.test.ts` file exists and validates template copying, variable substitution (replacing `SKELETON` placeholders with actual project names), and file renaming for each template type (component, system, program).
2. **Given** there is no `Build.test.ts`, **When** the test suite runs, **Then** a `Build.test.ts` file exists and validates that the build pipeline invokes the correct sequence of shell commands for each build target (native, windows).
3. **Given** there is no `Dependencies.test.ts`, **When** the test suite runs, **Then** a `Dependencies.test.ts` file exists and validates library detection via `pkg-config` and the install-from-source fallback flow.
4. **Given** tests for `Build` and `Dependencies` involve shell command execution, **When** tests run, **Then** shell commands are isolated (mocked or sandboxed) so tests do not require autotools or network access.

---

### User Story 3 - Migrate to ES Module Imports (Priority: P3)

A contributor reading `Template.ts`, `Build.ts`, `Dependencies.ts`, or `ResourcePak.ts` finds a mix of `require()` calls and ES `import` statements, making the code inconsistent and harder to reason about. After this work, all module imports use the same ES `import` syntax, and the codebase follows a single, consistent module loading pattern.

**Why this priority**: Import consistency is a code quality improvement. It makes the codebase easier to read and prepares it for a potential future migration to native ES modules, but it has lower user-facing impact than type safety or test coverage.

**Independent Test**: Can be fully tested by searching the source files for `require()` calls and confirming zero results (excluding `require.main` if a functionally equivalent alternative is used), then running the full test suite and CLI commands to confirm no regressions.

**Acceptance Scenarios**:

1. **Given** `Template.ts` uses `const fs = require("fs-extra")` and `const { execSync } = require("child_process")`, **When** the migration is complete, **Then** these are replaced with ES `import` statements and all existing functionality is preserved.
2. **Given** `Build.ts`, `Dependencies.ts`, and `ResourcePak.ts` each use `require("child_process")`, **When** the migration is complete, **Then** each uses an ES `import` statement instead.
3. **Given** `Template.ts` uses `require.main!.filename` to locate the templates directory, **When** the migration is complete, **Then** an equivalent mechanism is used that does not depend on `require.main`.
4. **Given** the project uses CommonJS module resolution (`"module": "commonjs"` in `tsconfig.json`), **When** all `require()` calls are replaced with `import` statements, **Then** the compiled output continues to work correctly under CommonJS.

---

### Edge Cases

- What happens when a previously-typed-as-`any` property receives `undefined` or `null` — does the new type allow it or require an explicit optional marker?
- How does replacing the `ConfigType` index signature affect existing callers that rely on arbitrary key access?
- What happens when `require.main` is `undefined` (e.g., when the module is loaded programmatically rather than as a CLI entry point)?
- How do `Build` and `Dependencies` tests behave in CI environments where autotools or MinGW cross-compilers are not installed?

## Clarifications

### Session 2026-02-13

- Q: What strategy should replace `ConfigType`'s `[index: string]: any` index signature? → A: Remove the index signature entirely; declare only `prefix` and `scopes` as explicit properties.
- Q: What is the shape of `ResourceType.attributes`? → A: A flat string-to-string map (`{ [key: string]: string }`).
- Q: Should `noImplicitAny` be enabled in `tsconfig.json` to prevent reintroduction of `any` types? → A: Yes, enable `noImplicitAny` (and optionally `strict`) in `tsconfig.json` as part of this feature.
- Q: How should the templates directory be located after removing `require.main!.filename`? → A: Use `__dirname` with path resolution; trust the package layout (no runtime existence check).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `any` types in `src/types.ts` MUST be replaced with specific, descriptive types: `ResourceType.attributes` MUST become `{ [key: string]: string }`, and `PackageType.main` MUST become `string`.
- **FR-002**: All `any` types in `src/Scopes.ts` function parameters MUST be replaced with typed interfaces that describe the expected shape (field names and types) of prompt answers and defaults.
- **FR-003**: The `package: any` property in `src/Template.ts` MUST be replaced with the existing `PackageType` interface (or a refined version of it).
- **FR-004**: The `parseAnswers` parameter type in `src/Config.ts` MUST use `string` values (or an appropriate union) instead of `any` values.
- **FR-005**: A test file `test/Template.test.ts` MUST exist and cover template copying, placeholder substitution, and file renaming for all three template types (component, system, program).
- **FR-006**: A test file `test/Build.test.ts` MUST exist and cover the build pipeline command sequence for both native and windows targets, with shell execution isolated from the real system.
- **FR-007**: A test file `test/Dependencies.test.ts` MUST exist and cover library detection (found/not-found scenarios) and the install-from-source flow, with shell execution isolated from the real system.
- **FR-008**: All tests MUST use temporary directories and clean up after themselves, following the project's existing test isolation pattern.
- **FR-009**: All `require()` calls in `src/Template.ts`, `src/Build.ts`, `src/Dependencies.ts`, and `src/ResourcePak.ts` MUST be replaced with ES `import` statements.
- **FR-010**: The `require.main!.filename` usage in `src/Template.ts` MUST be replaced with `__dirname`-based path resolution (e.g., `path.resolve(__dirname, '..', 'templates')`) that relies on the compiled package layout.
- **FR-011**: No behavioral regressions MUST occur — all existing tests and CLI commands MUST continue to pass after changes.
- **FR-012**: The `ConfigType` index signature MUST be removed entirely. `ConfigType` MUST declare only its known properties (`prefix: string` and `scopes: ScopesType`) with no index signature.
- **FR-013**: Since `strict: true` (which includes `noImplicitAny`) is already enabled in `tsconfig.json`, the ESLint rule `@typescript-eslint/no-explicit-any` MUST be enabled at `"error"` level to prevent reintroduction of explicit `any` type annotations.

### Key Entities

- **ConfigType**: The root configuration object. The `any` index signature will be removed; only `prefix: string` and `scopes: ScopesType` will remain as declared properties.
- **ScopeAnswersType** (new): Represents the shape of user prompt answers when creating or editing scopes — includes `scopeName`, `authorName`, `authorEmail`, `authorURL`.
- **ScopeDefaultsType** (new): Represents the optional defaults passed to the scope editing prompt — structurally equivalent to `Partial<AuthorType>` (fields: `name?`, `email?`, `url?`). Note: `scopeName` is passed separately to `getQuestions` via an inline type, not as part of `ScopeDefaultsType`.
- **PackageType**: Already defined; represents `package.json` content. The `main` field needs a specific type (likely `string`). The `attributes` field on `ResourceType` needs a concrete type.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero instances of the `any` type remain in source files under `src/`.
- **SC-002**: `strict: true` (already enabled) and the ESLint rule `@typescript-eslint/no-explicit-any` at `"error"` level are both active, and the project compiles and lints with zero errors.
- **SC-003**: Test coverage exists for all six library modules (`Config`, `Scopes`, `Template`, `Build`, `Dependencies`, `ResourcePak`) — up from the current three.
- **SC-004**: All new tests pass in an environment without autotools or cross-compilers installed, confirming proper test isolation.
- **SC-005**: Zero `require()` calls remain in source files under `src/` (with the exception of any runtime-necessary `require` that has no ES import equivalent, which must be documented).
- **SC-006**: All existing tests that currently pass continue to pass after changes. Modifications to existing tests are limited to type-safety adjustments required by interface changes (e.g., bracket notation → dot notation) — no behavioral changes. Note: `test/ResourcePak.test.ts` has pre-existing failures (calls non-existent API methods) documented in research.md R-005; this is out of scope.
- **SC-007**: A contributor can successfully run `the-seed template component`, `the-seed build native`, and `the-seed dependencies check` after all changes with identical behavior to before.

## Assumptions

- The project will remain on CommonJS module resolution (`"module": "commonjs"` in `tsconfig.json`). ES `import` statements compile to `require()` calls in the output; the migration is a source-level consistency improvement, not a runtime module system change.
- `ResourceType.attributes` is a flat key-value object (`{ [key: string]: string }`). This has been confirmed and is not an assumption.
- `PackageType.main` is a `string` representing the npm `main` entry point field.
- `Build` and `Dependencies` tests will mock `child_process.execSync` rather than running real autotools commands, to keep tests fast and environment-independent.
- The `require.main!.filename` replacement will use `__dirname` with `path.resolve` to locate the templates directory relative to the compiled output. No runtime existence check is needed; the package layout is trusted.
