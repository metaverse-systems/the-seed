# Types Contract: Updated `src/types.ts`

**Date**: 2026-02-13  
**Feature**: 001-address-tech-debt

This contract defines the target state of all exported TypeScript interfaces after the technical debt cleanup. This is the authoritative reference for implementers.

## Complete Interface Definitions

```typescript
export interface AuthorType {
  name: string;
  email: string;
  url: string;
}

export interface ScopeType {
  author: AuthorType;
}

export interface ScopesType {
  [index: string]: ScopeType;
}

export interface ConfigType {
  prefix: string;
  scopes: ScopesType;
}

export interface ScriptArgsType {
  binName: string;
  args: string[];
  configDir: string;
}

export interface ResourceType {
  name: string;
  filename: string;
  size: number;
  attributes?: { [key: string]: string };
}

export interface PackageType {
  author: AuthorType;
  name: string;
  license: string;
  version: string;
  scripts: {
    [index: string]: string;
  };
  resources: ResourceType[];
  main?: string;
}

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

## Change Summary

| Interface | Change |
|-----------|--------|
| `ConfigType` | Removed `[index: string]: any` index signature |
| `ResourceType` | `attributes?: any` → `attributes?: { [key: string]: string }` |
| `PackageType` | `main?: any` → `main?: string` |
| `ScopeAnswersType` | **New** — inquirer prompt answers shape |
| `ScopeDefaultsType` | **New** — prompt defaults shape (equivalent to `Partial<AuthorType>`) |

## Module Signature Changes

### Config.ts

```typescript
// Before
parseAnswers = (answers: { [index:string]: any }) => { ... }

// After
parseAnswers = (answers: { prefix: string }) => {
  this.config.prefix = answers.prefix;
}
```

### Scopes.ts

```typescript
// Before
askEditScope = (defaults?: any) => { ... }
createOrEditScope = (answers: any) => { ... }
getQuestions = (defaults: any) => { ... }

// After
askEditScope = (defaults?: ScopeDefaultsType) => { ... }
createOrEditScope = (answers: ScopeAnswersType) => { ... }
getQuestions = (defaults: { scopeName?: string }) => { ... }
```

### Template.ts

```typescript
// Before
package: any;

// After
package?: PackageType;
```

## Export Changes (index.ts)

Add to exports:
- `ScopeAnswersType`
- `ScopeDefaultsType`
- `ResourceType`
- `PackageType`
- `ScriptArgsType`
