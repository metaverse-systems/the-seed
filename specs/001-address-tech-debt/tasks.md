# Tasks: Address Technical Debt

**Input**: Design documents from `/specs/001-address-tech-debt/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: Test tasks are included — User Story 2 is specifically about adding test coverage for the 3 untested modules.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `test/` at repository root

---

## Phase 1: Setup

**Purpose**: Establish baseline and verify current project state

- [X] T001 Verify baseline by running `npm run build` and `npm test`; document pre-existing ResourcePak.test.ts failures per research.md R-005

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: No new foundational infrastructure is needed — the project already exists with all tooling configured

**⚠️ NOTE**: `strict: true` and `esModuleInterop: true` are already enabled in tsconfig.json. `@typescript-eslint/eslint-plugin` ^5.15.0 is already installed. No blocking setup is required beyond the Phase 1 baseline verification.

**Checkpoint**: Baseline verified — user story implementation can now begin

---

## Phase 3: User Story 1 — Eliminate Unsafe Types (Priority: P1) 🎯 MVP

**Goal**: Replace all 8 explicit `any` type annotations across 4 source files with proper interfaces so the TypeScript compiler catches type mismatches at build time.

**Independent Test**: Run `npx tsc --noEmit` and confirm zero type errors. Run `grep -rn ': any' src/ --include='*.ts'` and confirm zero results. Run `npm run lint` and confirm zero `any`-related errors.

### Implementation for User Story 1

- [X] T002 [US1] Update type interfaces in src/types.ts per types-contract.md: remove `[index: string]: any` from ConfigType, change `attributes?: any` to `attributes?: { [key: string]: string }` in ResourceType, change `main?: any` to `main?: string` in PackageType, add ScopeAnswersType and ScopeDefaultsType interfaces
- [X] T003 [P] [US1] Refactor parseAnswers in src/Config.ts: change parameter type from `{ [index:string]: any }` to `{ prefix: string }`, replace dynamic key iteration with `this.config.prefix = answers.prefix`, change `this.config["prefix"]` to `this.config.prefix` in getQuestions
- [X] T004 [P] [US1] Update parameter types in src/Scopes.ts: change `askEditScope(defaults?: any)` to `askEditScope(defaults?: ScopeDefaultsType)`, change `createOrEditScope(answers: any)` to `createOrEditScope(answers: ScopeAnswersType)`, change `getQuestions(defaults: any)` to `getQuestions(defaults: { scopeName?: string })`; add import for ScopeAnswersType and ScopeDefaultsType from ./types
- [X] T005 [P] [US1] Replace `package: any` property with `package?: PackageType` in src/Template.ts; add import for PackageType from ./types; add null checks where this.package is accessed if needed
- [X] T006 [P] [US1] Export new types (ScopeAnswersType, ScopeDefaultsType, ResourceType, PackageType, ScriptArgsType) from src/index.ts per types-contract.md
- [X] T007 [P] [US1] Update test/Config.test.ts: change `config.config["prefix"]` bracket notation to `config.config.prefix` dot notation
- [X] T008 [US1] Add ESLint rule `@typescript-eslint/no-explicit-any` at `"error"` level in the ESLint configuration file to prevent any-type regressions
- [X] T009 [US1] Verify US1 completion: run `npm run build`, `npm run lint`, `npx tsc --noEmit`, and `grep -rn ': any' src/ --include='*.ts'` confirming zero errors and zero any types

**Checkpoint**: All explicit `any` types eliminated. Compiler and linter enforce type safety. US1 is independently verifiable.

---

## Phase 4: User Story 2 — Add Test Coverage for Untested Modules (Priority: P2)

**Goal**: Create test suites for Template, Build, and Dependencies modules so contributors can verify changes to these modules haven't broken existing behavior.

**Independent Test**: Run `npm test` and confirm all new tests pass. Each module's tests validate independently — Template tests verify scaffolding, Build tests verify build pipeline orchestration, Dependencies tests verify library detection.

### Implementation for User Story 2

- [X] T010 [P] [US2] Create test/Template.test.ts per test-coverage-contract.md: test askName question shape, copyTemplate for component/system/program types, SKELETON variable substitution and file renaming; mock execSync for npm init; use fs.mkdtempSync for temp directories with cleanup
- [X] T011 [P] [US2] Create test/Build.test.ts per test-coverage-contract.md: test autogen, configure (native/windows targets), reconfigure chain, compile, install commands, error propagation, and targets map; fully mock child_process.execSync; construct Config with temp directory
- [X] T012 [P] [US2] Create test/Dependencies.test.ts per test-coverage-contract.md: test checkLib found/not-found/wrong-output, checkLibEcs/checkLibTheSeed delegation, installLib success/failure/target-flags, installLibEcs/installLibTheSeed delegation; fully mock child_process.execSync; construct Config with temp directory
- [X] T013 [US2] Verify US2 completion: run `npm test` confirming all 6 test suites (3 existing + 3 new) pass

**Checkpoint**: All six library modules have test coverage. Tests pass without autotools or cross-compilers installed (shell commands are mocked). US2 is independently verifiable.

---

## Phase 5: User Story 3 — Migrate to ES Module Imports (Priority: P3)

**Goal**: Replace all `require()` calls with ES `import` statements so the codebase follows a single, consistent module loading pattern.

**Independent Test**: Run `grep -rn 'require(' src/ --include='*.ts'` and confirm zero results. Run `npm run build` and `npm test` to confirm no regressions.

### Implementation for User Story 3

- [X] T014 [P] [US3] Migrate src/Template.ts per import-migration-contract.md: replace `const fs = require("fs-extra")` with `import fs from "fs-extra"`, replace `const { execSync } = require("child_process")` with `import { execSync } from "child_process"`, replace `require.main!.filename` path resolution with `path.join(__dirname, '..', 'templates', this.type)`
- [X] T015 [P] [US3] Migrate src/Build.ts per import-migration-contract.md: replace `const { execSync } = require('child_process')` with `import { execSync } from "child_process"`
- [X] T016 [P] [US3] Migrate src/Dependencies.ts per import-migration-contract.md: replace `const { execSync } = require("child_process")` with `import { execSync } from "child_process"`
- [X] T017 [P] [US3] Migrate src/ResourcePak.ts per import-migration-contract.md: replace `const fs = require("fs-extra")` with `import fs from "fs-extra"`, replace `const { execSync } = require("child_process")` with `import { execSync } from "child_process"`
- [X] T018 [US3] Verify US3 completion: run `npm run build`, `npm test`, and `grep -rn 'require(' src/ --include='*.ts'` confirming zero require() calls and no regressions

**Checkpoint**: All source files use consistent ES import syntax. Compiled CommonJS output is functionally unchanged. US3 is independently verifiable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all user stories

- [X] T019 Run full verification checklist from quickstart.md: `npm run build`, `npm run lint`, `npm test`, `npx tsc --noEmit`, grep for `: any` and `require(` in src/
- [X] T020 [P] Validate CLI commands still work: verify `the-seed template component`, `the-seed build native`, and `the-seed dependencies check` produce identical behavior to pre-change baseline per SC-007

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: No action needed — project already configured
- **US1 (Phase 3)**: Depends on Phase 1. Within phase: T002 (types.ts) must complete first, then T003–T007 run in parallel, then T008, then T009
- **US2 (Phase 4)**: Depends on US1 (Phase 3) — tests need correct types to compile. T010–T012 run in parallel, then T013
- **US3 (Phase 5)**: Depends on Phase 1 only — **independent of US1 and US2**. T014–T017 run in parallel, then T018
- **Polish (Phase 6)**: Depends on all phases being complete

### User Story Dependencies

- **US1 (P1)**: No dependencies on other stories. **Blocks US2.**
- **US2 (P2)**: Depends on US1 (correct types required for test compilation)
- **US3 (P3)**: Independent — can run in parallel with US1 and US2

> **Practical note** (from quickstart.md): The recommended implementation order is US3 → US1 → US2 because import migration is lowest-risk and produces cleaner diffs for subsequent type changes. However, US1 delivers the highest value (MVP), so prioritize accordingly.

### Parallel Opportunities

**Within US1 (Phase 3):**
```
T002 (types.ts) ──→ T003 (Config.ts)      ─┐
                    T004 (Scopes.ts)       ─┤
                    T005 (Template.ts)     ─┤──→ T008 (ESLint rule) ──→ T009 (verify)
                    T006 (index.ts)        ─┤
                    T007 (Config.test.ts)  ─┘
```

**Within US2 (Phase 4):**
```
T010 (Template.test.ts)     ─┐
T011 (Build.test.ts)        ─┤──→ T013 (verify)
T012 (Dependencies.test.ts) ─┘
```

**Within US3 (Phase 5):**
```
T014 (Template.ts)    ─┐
T015 (Build.ts)       ─┤──→ T018 (verify)
T016 (Dependencies.ts)─┤
T017 (ResourcePak.ts) ─┘
```

**Across stories** (if parallelizing):
```
Phase 1 ──→ US3 (Phase 5) ─────────────────────→ Phase 6
         ──→ US1 (Phase 3) ──→ US2 (Phase 4) ──→ Phase 6
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup — verify baseline
2. Complete Phase 3: User Story 1 — eliminate all `any` types
3. **STOP and VALIDATE**: Compiler catches type mismatches; linter prevents `any` regressions
4. Immediate value: safer refactoring and feature development

### Incremental Delivery

1. Setup → Baseline verified
2. US1 (types) → Type-safe codebase (MVP!)
3. US2 (tests) → Full test coverage for all modules
4. US3 (imports) → Consistent import style
5. Polish → Final validation across all stories

### Optimal Parallel Strategy

1. Complete Setup
2. Start US3 (imports) and US1 (types) simultaneously
3. After US1 completes, start US2 (tests)
4. After all complete, run Polish phase

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- ResourcePak.test.ts has a pre-existing bug (calls non-existent API methods) — documented in research.md R-005, out of scope for this feature
- All contracts in `specs/001-address-tech-debt/contracts/` contain exact before/after code for each change
- Commit after each task or logical group
