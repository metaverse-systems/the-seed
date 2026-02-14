# Tasks: Package Command

**Input**: Design documents from `/specs/002-package-command/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/package-command-contract.md, quickstart.md

**Tests**: Not explicitly requested in the feature specification. Test tasks are included because the plan.md and contract specify `test/Package.test.ts` with required test cases and mocking strategy.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `test/` at repository root
- **Native addon**: `native/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization — new dependencies, native addon build configuration, and shared type definitions

- [ ] T001 Add `node-addon-api` and `node-gyp` dependencies to package.json
- [ ] T002 Create native addon build configuration in native/binding.gyp
- [ ] T003 Add `DependencyResultType` interface to src/types.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Native addon and Package class skeleton that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Implement N-API addon wrapper calling DependencyLister::ListDependencies() in native/src/addon.cpp
- [ ] T005 Create Package class with constructor, `getSearchPaths()`, and `resolveDependencies()` methods in src/Package.ts
- [ ] T006 Export Package class and DependencyResultType from src/index.ts

**Checkpoint**: Foundation ready — native addon compiles, Package class can resolve dependencies. User story implementation can now begin.

---

## Phase 3: User Story 1 — Package Binaries with Shared Library Dependencies (Priority: P1) 🎯 MVP

**Goal**: User runs `the-seed package my-release myapp libgame.so` and gets an output directory containing the specified binaries plus all resolved shared library dependencies discovered by DependencyLister.

**Independent Test**: Run the package command with a built executable, verify the output directory contains the binary and all shared libraries it links against. Also verify deduplication when two binaries share a dependency.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T007 [P] [US1] Create test file with mocked native addon and temp directory setup in test/Package.test.ts
- [ ] T008 [P] [US1] Add test: package binary with dependencies creates dir and copies all files in test/Package.test.ts
- [ ] T009 [P] [US1] Add test: package binary with no non-system dependencies copies only explicit files in test/Package.test.ts
- [ ] T010 [P] [US1] Add test: two binaries sharing a dependency copies shared library only once in test/Package.test.ts
- [ ] T011 [P] [US1] Add test: each file printed during copy and summary count displayed in test/Package.test.ts
- [ ] T012 [P] [US1] Add test: search paths constructed from Config prefix and all targets in test/Package.test.ts

### Implementation for User Story 1

- [ ] T013 [US1] Implement `Package.run()` method — validate inputs, resolve dependencies, build deduplicated file list, create directory, copy files, print verbose output in src/Package.ts
- [ ] T014 [US1] Create PackageCLI handler that parses args and delegates to Package.run() in src/scripts/PackageCLI.ts
- [ ] T015 [US1] Wire package command into CLI router switch and help output in src/scripts/the-seed.ts

**Checkpoint**: `the-seed package <dir> <file1> [file2] ...` works end-to-end. Binaries and their resolved dependencies are copied to the output directory with verbose output. All US1 tests pass.

---

## Phase 4: User Story 2 — Help and Usage Information (Priority: P2)

**Goal**: User runs `the-seed package help` or `the-seed package` with no arguments and sees clear usage instructions describing the expected arguments and behavior.

**Independent Test**: Run `the-seed package help` and verify output contains usage syntax, argument descriptions, and at least one example. Run `the-seed package` with no arguments and verify a usage message is displayed.

### Tests for User Story 2

- [ ] T016 [P] [US2] Add test: `help` subcommand prints usage information in test/Package.test.ts
- [ ] T017 [P] [US2] Add test: no arguments prints usage message in test/Package.test.ts

### Implementation for User Story 2

- [ ] T018 [US2] Implement help text output and no-arguments usage message in src/scripts/PackageCLI.ts

**Checkpoint**: `the-seed package help` and `the-seed package` (no args) display correct usage information. All US2 tests pass.

---

## Phase 5: User Story 3 — Error Handling for Invalid Inputs (Priority: P3)

**Goal**: User provides invalid arguments (non-existent file, existing output directory, no files specified, directory as input) and receives clear, actionable error messages with no partial output.

**Independent Test**: Provide non-existent file paths, pre-existing directory names, only a directory name with no files, and verify appropriate error messages are displayed with no partial directory created.

### Tests for User Story 3

- [ ] T019 [P] [US3] Add test: input file doesn't exist shows error, no directory created in test/Package.test.ts
- [ ] T020 [P] [US3] Add test: output directory already exists shows error in test/Package.test.ts
- [ ] T021 [P] [US3] Add test: no files specified shows usage error in test/Package.test.ts
- [ ] T022 [P] [US3] Add test: DependencyLister returns errors triggers fatal abort in test/Package.test.ts
- [ ] T022a [P] [US3] Add test: input path is a directory shows error in test/Package.test.ts

### Implementation for User Story 3

- [ ] T023 [US3] Implement input file existence validation with clear error messages in src/Package.ts
- [ ] T024 [US3] Implement output directory existence check with error message in src/Package.ts
- [ ] T025 [US3] Implement argument count validation (no files specified) in src/scripts/PackageCLI.ts
- [ ] T026 [US3] Implement DependencyLister error map handling with fatal abort in src/Package.ts
- [ ] T026a [US3] Implement directory-as-input validation (reject non-file paths) in src/Package.ts

**Checkpoint**: All error scenarios produce clear messages, no partial directories are created, and exit codes are correct. All US3 tests pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T027 [P] Add `install` script to package.json for node-gyp native addon compilation
- [ ] T028 [P] Verify all existing tests still pass after changes to types.ts, index.ts, and the-seed.ts
- [ ] T029 Run quickstart.md validation — test basic packaging, multiple binaries, help, and error scenarios

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–5)**: All depend on Foundational phase completion
  - User stories can proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) — Independent of US1 (help text is self-contained)
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) — Validation logic is in Package.run() and PackageCLI, but testable independently

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Core logic before CLI wiring
- Story complete before moving to next priority

### Parallel Opportunities

- T001, T002, T003 can run in parallel (different files)
- T007–T012 (US1 tests) can all run in parallel (same file but additive test cases)
- T016, T017 (US2 tests) can run in parallel
- T019–T022 (US3 tests) can run in parallel
- Once Foundational phase completes, US1, US2, and US3 can start in parallel
- T027, T028 can run in parallel (different concerns)

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: T007 "Create test file with mocked native addon and temp directory setup in test/Package.test.ts"
Task: T008 "Add test: package binary with dependencies creates dir and copies all files"
Task: T009 "Add test: package binary with no non-system dependencies copies only explicit files"
Task: T010 "Add test: two binaries sharing a dependency copies shared library only once"
Task: T011 "Add test: each file printed during copy and summary count displayed"
Task: T012 "Add test: search paths constructed from Config prefix and all targets"

# Then implement sequentially:
Task: T013 "Implement Package.run() method in src/Package.ts"
Task: T014 "Create PackageCLI handler in src/scripts/PackageCLI.ts"
Task: T015 "Wire package command into CLI router in src/scripts/the-seed.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational (T004–T006)
3. Complete Phase 3: User Story 1 (T007–T015)
4. **STOP and VALIDATE**: Test with a real built binary — verify output directory contains binary and all shared library dependencies
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo (help text works)
4. Add User Story 3 → Test independently → Deploy/Demo (error handling robust)
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (core packaging)
   - Developer B: User Story 2 (help/usage)
   - Developer C: User Story 3 (error handling)
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files or additive to same file, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Native addon (T004) is the most complex task — requires C++ compilation against libthe-seed
- The `targets` map from `src/Build.ts` is reused by `Package.getSearchPaths()` to construct library search paths
- `DependencyResultType` keys that are absolute paths = resolved libraries to copy; bare names = system libraries to skip
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
