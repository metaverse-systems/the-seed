# Quickstart: Address Technical Debt

**Date**: 2026-02-13  
**Feature**: 001-address-tech-debt  
**Branch**: `001-address-tech-debt`

## Prerequisites

- Node.js with npm
- Git (branch `001-address-tech-debt` checked out)
- No autotools or cross-compilers needed (tests are mocked)

## Implementation Order

Work must proceed in this order due to dependencies:

### Step 1: Migrate `require()` to `import` (P3 — done first because it's lowest risk and unblocks clean diffs for later steps)

1. In `src/Template.ts`: Replace lines 1–2 `require()` with `import` statements
2. In `src/Template.ts` line 39: Replace `require.main!.filename` with `__dirname`-based path
3. In `src/Build.ts` line 2: Replace `require()` with `import`
4. In `src/Dependencies.ts` line 2: Replace `require()` with `import`
5. In `src/ResourcePak.ts` lines 1–2: Replace `require()` with `import`
6. Verify: `npm run build` compiles successfully

### Step 2: Replace `any` types (P1)

1. Update `src/types.ts`:
   - Remove `[index: string]: any` from `ConfigType`
   - Change `attributes?: any` → `attributes?: { [key: string]: string }` in `ResourceType`
   - Change `main?: any` → `main?: string` in `PackageType`
   - Add `ScopeAnswersType` and `ScopeDefaultsType` interfaces
2. Update `src/Config.ts`:
   - Change `parseAnswers` parameter from `{ [index:string]: any }` to `{ prefix: string }`
   - Replace dynamic key iteration with `this.config.prefix = answers.prefix`
   - Change `this.config["prefix"]` to `this.config.prefix` in `getQuestions`
3. Update `src/Scopes.ts`:
   - Change `askEditScope(defaults?: any)` to `askEditScope(defaults?: ScopeDefaultsType)`
   - Change `createOrEditScope(answers: any)` to `createOrEditScope(answers: ScopeAnswersType)`
   - Change `getQuestions(defaults: any)` to `getQuestions(defaults: { scopeName?: string })`
4. Update `src/Template.ts`:
   - Change `package: any` to `package?: PackageType`
   - Add null checks where `this.package` is accessed (e.g., in `save()`)
5. Update `src/index.ts`: Export new types
6. Update `test/Config.test.ts`: Change bracket notation to dot notation
7. Add ESLint rule `@typescript-eslint/no-explicit-any: "error"`
8. Verify: `npm run build` and `npm run lint` pass with zero errors

### Step 3: Add test coverage (P2)

1. Create `test/Template.test.ts` per test coverage contract
2. Create `test/Build.test.ts` per test coverage contract
3. Create `test/Dependencies.test.ts` per test coverage contract
4. Verify: `npm test` passes all tests (new and existing)

## Verification Checklist

```bash
# Full build
npm run build

# Lint (after adding no-explicit-any rule)
npm run lint

# All tests pass
npm test

# No any types remain
grep -rn ': any' src/ --include='*.ts'
# Expected: zero results

# No require() calls remain
grep -rn 'require(' src/ --include='*.ts'
# Expected: zero results

# Compile succeeds (strict mode already enabled)
npx tsc --noEmit
```

## Key References

- [Types contract](contracts/types-contract.md) — exact interface definitions
- [Import migration contract](contracts/import-migration-contract.md) — line-by-line replacement table
- [Test coverage contract](contracts/test-coverage-contract.md) — test cases and mocking strategy
- [Research](research.md) — rationale for each decision
