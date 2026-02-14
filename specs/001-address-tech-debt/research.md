# Research: Address Technical Debt

**Date**: 2026-02-13  
**Feature**: 001-address-tech-debt

## R-001: TypeScript `strict` Mode and `any` Enforcement

**Decision**: `strict: true` is already enabled in `tsconfig.json` (line 18). This includes `noImplicitAny`. However, `noImplicitAny` only prevents *inferred* `any` — it does **not** prevent explicit `any` type annotations. All 8 `any` instances in the codebase are explicit annotations. To prevent regressions, enable the ESLint rule `@typescript-eslint/no-explicit-any` (already available in `@typescript-eslint/eslint-plugin` ^5.15.0, which is installed).

**Rationale**: Relying solely on `strict: true` would allow developers to add new explicit `any` annotations. The ESLint rule catches these at lint time.

**Alternatives considered**:
- `noImplicitAny` in tsconfig only — rejected because it doesn't catch explicit `any`
- Manual code review only — rejected because it's error-prone

**Impact on spec**: FR-013 ("enable `noImplicitAny`") is already satisfied by existing `strict: true`. Reinterpret FR-013 as: add `@typescript-eslint/no-explicit-any` ESLint rule to enforce no explicit `any` either.

## R-002: Config.parseAnswers Refactoring Strategy

**Decision**: `parseAnswers` is called from exactly one location: `src/scripts/ConfigCLI.ts` line 10. The only question returned by `getQuestions()` has `name: "prefix"`, so the only key ever passed through `parseAnswers` is `"prefix"`. Replace the dynamic key iteration with an explicit typed parameter:

```typescript
parseAnswers = (answers: { prefix: string }) => {
  this.config.prefix = answers.prefix;
};
```

**Rationale**: The dynamic `Object.keys(answers).forEach` + bracket-access pattern exists only because the parameter was typed as `{ [index: string]: any }`. Since there's exactly one config key users can edit (`prefix`), explicit assignment is simpler, type-safe, and eliminates the need for an index signature on `ConfigType`.

**Alternatives considered**:
- `Partial<ConfigType>` parameter — rejected because it would still require an index signature or union type for iteration
- Keep dynamic iteration with `keyof ConfigType` — rejected because it's over-engineered for one property

**Impact on existing code**:
- `test/Config.test.ts` line 27 uses `config.config["prefix"] = prefix` — must change to `config.config.prefix = prefix` (dot notation)
- `src/Config.ts` line 36 uses `this.config["prefix"]` — change to `this.config.prefix`

## R-003: ES Import Migration for fs-extra and child_process

**Decision**: With `esModuleInterop: true` and `module: "commonjs"` (both already configured), the following replacements produce identical runtime behavior:

| Before | After |
|--------|-------|
| `const fs = require("fs-extra")` | `import fs from "fs-extra"` |
| `const { execSync } = require("child_process")` | `import { execSync } from "child_process"` |

TypeScript compiles `import fs from "fs-extra"` to `__importDefault(require("fs-extra"))`, and `import { execSync } from "child_process"` to destructured `require("child_process")`. Both are equivalent.

**Rationale**: Direct drop-in replacement with no behavioral change.

**Alternatives considered**: None needed — this is a straightforward syntax migration.

## R-004: Template Directory Resolution — `require.main` Replacement

**Decision**: Replace `path.join(path.dirname(require.main!.filename), "../../templates/" + this.type)` with `path.join(__dirname, '..', 'templates', this.type)`.

**Rationale**: 
- Current: `require.main!.filename` → `dist/scripts/the-seed.js` → dirname → `dist/scripts/` → `../../templates/<type>` → `<root>/templates/<type>`
- Replacement: `__dirname` in `dist/Template.js` → `dist/` → `../templates/<type>` → `<root>/templates/<type>`
- Both resolve to the same path. Confirmed by checking `tsconfig.json`: no `rootDir` set, `include: ["./src/**/*"]`, effective root is `src/`, so `src/Template.ts` → `dist/Template.js`.

**Alternatives considered**:
- `__filename` with `path.dirname` — equivalent but more verbose
- Config-based templates path — over-engineered for the use case

## R-005: Pre-existing Bug in ResourcePak.test.ts

**Decision**: Document but do not fix in this feature. `test/ResourcePak.test.ts` calls API methods that don't exist on `ResourcePak`:
- Constructor called with 2 args (`config, tempDir`) — actual constructor takes 1 arg (`config`)
- `rp.create(packageName)` — actual method is `createPackage(scope, name)` (2 args)
- `rp.savePackage()` — actual method is `save()`

This test likely fails at compile time. It should be addressed, but fixing the ResourcePak test API is outside the scope of "address technical debt" as defined by the constitution's roadmap (which says: "Add test coverage for `Template`, `Build`, and `Dependencies` modules").

**Rationale**: Scope discipline — fix what's listed, document what's found.

**Impact**: SC-006 ("all existing tests continue to pass") needs to account for the fact that this test may already be failing. Verify before starting implementation.

## R-006: Scopes.ts Type Replacements

**Decision**: Introduce two new interfaces in `src/types.ts`:

```typescript
export interface ScopeAnswersType {
  scopeName: string;
  authorName: string;
  authorEmail: string;
  authorURL: string;
}

export interface ScopeDefaultsType {
  name?: string;
  email?: string;
  url?: string;
}
```

**Rationale**:
- `ScopeAnswersType` matches the exact shape of inquirer answers consumed by `createOrEditScope` (fields: `scopeName`, `authorName`, `authorEmail`, `authorURL`)
- `ScopeDefaultsType` matches the shape of the optional defaults passed to `askEditScope` (fields: `name?`, `email?`, `url?` — matching `AuthorType` field names used in the defaults check)
- The `getQuestions` method takes `{ scopeName?: string }` — can use `Pick<ScopeAnswersType, 'scopeName'>` or inline

**Alternatives considered**:
- `Partial<AuthorType>` for defaults — rejected because `askEditScope` accesses `.name`, `.email`, `.url` directly (matching AuthorType fields), but the answers use `authorName`, `authorEmail`, `authorURL`. Two distinct shapes.
- Single union type — rejected because the two shapes serve different purposes

## R-007: Template.ts `package` Property Type

**Decision**: Replace `package: any` with `package: PackageType | undefined` (or the optional `package?: PackageType`). The `PackageType` interface is already defined in `types.ts` and imported by `ResourcePak.ts`.

**Rationale**: In `createPackage`, the value is assigned from `JSON.parse(fs.readFileSync(...))` which returns `any`, but the subsequent assignments (`this.package.author = ...`, etc.) match `PackageType` exactly. Line 110 does `delete this.package.main` — since `main` is optional (`main?: string` after our fix), this is valid.

**Alternatives considered**: None — `PackageType` already describes the shape perfectly.

## Summary of NEEDS CLARIFICATION Resolutions

All items resolved. No remaining unknowns.

| Item | Resolution |
|------|-----------|
| `noImplicitAny` enforcement | Already active; add ESLint `no-explicit-any` rule |
| `parseAnswers` refactoring | Explicit typed parameter `{ prefix: string }` |
| `require()` → `import` safety | Confirmed equivalent with `esModuleInterop: true` |
| `require.main` → `__dirname` | `path.join(__dirname, '..', 'templates', this.type)` |
| ResourcePak test bug | Document, do not fix (out of scope) |
| Scopes type shapes | Two new interfaces: `ScopeAnswersType`, `ScopeDefaultsType` |
| Template.package type | Use existing `PackageType` |
