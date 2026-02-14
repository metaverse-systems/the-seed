# Test Coverage Contract

**Date**: 2026-02-13  
**Feature**: 001-address-tech-debt

This contract defines the required test suites, their test cases, and the isolation strategy.

## New Test Files

### test/Template.test.ts

**Module under test**: `src/Template.ts`  
**Isolation strategy**: Temporary directories via `fs.mkdtempSync`; no shell commands (Template.copyTemplate uses `fs-extra` for file operations, but `createPackage` calls `execSync("npm init")` which should be mocked).

| Test Case | Description | Key Assertions |
|-----------|-------------|----------------|
| `askName returns questions` | Verify question array shape | Returns 2 questions; first is list type with scope choices; second asks for template name |
| `copyTemplate - component` | Copy component template, substitute variables | Template files exist in target dir; `SKELETON` replaced with project name; `.hpp`/`.cpp` files renamed; `.pc.in` file renamed |
| `copyTemplate - system` | Copy system template | Same as component (system also produces `.pc.in`) |
| `copyTemplate - program` | Copy program template | Same but no `.pc.in` file exists |
| `variable substitution` | Verify SKELETON_ (underscore) and SKELETON replacements | Files contain project name; files contain underscore variant; no `SKELETON` literals remain |

**Mocking requirements**:
- `fs-extra` operations run against real temp directories (no mock needed)
- `execSync` (used in `createPackage` for `npm init`) must be mocked
- `require.main` (or `__dirname` after migration) — templates directory must be accessible from test runner

### test/Build.test.ts

**Module under test**: `src/Build.ts`  
**Isolation strategy**: Mock `child_process.execSync` entirely — no real shell commands.

| Test Case | Description | Key Assertions |
|-----------|-------------|----------------|
| `autogen runs autogen.sh` | Verify autogen command | `execSync` called with `./autogen.sh` |
| `configure - native target` | Verify configure command for native | Command includes `--prefix=<prefix>/x86_64-linux-gnu`; no `--host` flag |
| `configure - windows target` | Verify configure command for windows | Command includes `--host=x86_64-w64-mingw32` |
| `configure runs distclean first` | Verify distclean before configure | `execSync` called with `make distclean` before configure |
| `reconfigure chains autogen + configure` | Verify reconfigure flow | `autogen()` then `configure()` both called |
| `compile runs make -j` | Verify compile command | `execSync` called with `make -j` |
| `install runs make install` | Verify install command | `execSync` called with `make install` |
| `autogen error propagates` | Verify error handling | Exception thrown when `execSync` throws |
| `targets map is correct` | Verify exported targets | `native` → `x86_64-linux-gnu`, `windows` → `x86_64-w64-mingw32` |

**Mocking requirements**:
- `child_process.execSync` — fully mocked via `jest.mock('child_process')`
- `Config` — construct with temp directory

### test/Dependencies.test.ts

**Module under test**: `src/Dependencies.ts`  
**Isolation strategy**: Mock `child_process.execSync` entirely — no real shell commands, no network.

| Test Case | Description | Key Assertions |
|-----------|-------------|----------------|
| `checkLib - library found` | pkg-config succeeds and output includes library name | Returns `true` |
| `checkLib - library not found (exception)` | pkg-config throws | Returns `false` |
| `checkLib - output doesn't include library name` | pkg-config succeeds but output wrong | Returns `false` |
| `checkLibEcs delegates to checkLib` | Wrapper passes correct library name | Calls `checkLib` with `"ecs-cpp"` |
| `checkLibTheSeed delegates to checkLib` | Wrapper passes correct library name | Calls `checkLib` with `"the-seed"` |
| `installLib - success` | Clone + build succeeds | Returns `true` |
| `installLib - build failure` | Build command throws | Returns `false` |
| `installLib - native vs cross target` | Verify configure flags differ | Native: no `--host`; Windows: `--host=x86_64-w64-mingw32` |
| `installLibEcs delegates to installLib` | Wrapper passes correct repo URL | Calls `installLib` with libecs-cpp repo |
| `installLibTheSeed delegates to installLib` | Wrapper passes correct repo URL | Calls `installLib` with libthe-seed repo |

**Mocking requirements**:
- `child_process.execSync` — fully mocked
- `Config` — construct with temp directory

## Existing Test Adjustments

### test/Config.test.ts

- Line 27: Change `config.config["prefix"] = prefix` → `config.config.prefix = prefix` (bracket to dot notation, for type safety after removing index signature)

### test/Scopes.test.ts

- No changes required — `createOrEditScope` calls already pass objects matching `ScopeAnswersType` shape

### test/ResourcePak.test.ts

- **Pre-existing bug**: Test calls non-existent API methods. Out of scope for this feature — document only.
