# Data Model: Address Technical Debt

**Date**: 2026-02-13  
**Feature**: 001-address-tech-debt

## Entity Overview

This feature modifies existing type interfaces and introduces two new ones. No database, persistent storage, or state machines are involved — these are compile-time TypeScript interfaces.

## Modified Entities

### ConfigType

The root configuration object persisted to `config.json`.

| Field | Type (before) | Type (after) | Notes |
|-------|--------------|--------------|-------|
| `[index: string]` | `any` | *removed* | Index signature eliminated |
| `prefix` | `string` | `string` | Unchanged |
| `scopes` | `ScopesType` | `ScopesType` | Unchanged |

**Relationships**: Contains `ScopesType` (map of scope names → `ScopeType`).

### ResourceType

Describes a single resource file within a resource pak.

| Field | Type (before) | Type (after) | Notes |
|-------|--------------|--------------|-------|
| `name` | `string` | `string` | Unchanged |
| `filename` | `string` | `string` | Unchanged |
| `size` | `number` | `number` | Unchanged |
| `attributes` | `any` (optional) | `{ [key: string]: string }` (optional) | Flat string-to-string map |

**Relationships**: Contained within `PackageType.resources[]`.

### PackageType

Represents the `package.json` content for scaffolded projects and resource paks.

| Field | Type (before) | Type (after) | Notes |
|-------|--------------|--------------|-------|
| `author` | `AuthorType` | `AuthorType` | Unchanged |
| `name` | `string` | `string` | Unchanged |
| `license` | `string` | `string` | Unchanged |
| `version` | `string` | `string` | Unchanged |
| `scripts` | `{ [index: string]: string }` | `{ [index: string]: string }` | Unchanged |
| `resources` | `ResourceType[]` | `ResourceType[]` | Unchanged |
| `main` | `any` (optional) | `string` (optional) | npm `main` entry point |

**Relationships**: Contains `AuthorType`, contains `ResourceType[]`.

## New Entities

### ScopeAnswersType

Represents the shape of user prompt answers when creating or editing a scope via inquirer.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scopeName` | `string` | Yes | Scope name (with or without `@` prefix) |
| `authorName` | `string` | Yes | Author display name |
| `authorEmail` | `string` | Yes | Author email address |
| `authorURL` | `string` | Yes | Author URL |

**Relationships**: Consumed by `Scopes.createOrEditScope()`. Fields map to `AuthorType` via name transformation (`authorName` → `author.name`, etc.).

### ScopeDefaultsType

Represents the optional defaults pre-filled in the scope editing prompt.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | No | Pre-filled author name |
| `email` | `string` | No | Pre-filled author email |
| `url` | `string` | No | Pre-filled author URL |

**Relationships**: Passed to `Scopes.askEditScope()`. Field names match `AuthorType` (this is `Partial<AuthorType>`).

**Validation note**: `ScopeDefaultsType` is structurally identical to `Partial<AuthorType>`. The named type is introduced for clarity at call sites, but `Partial<AuthorType>` would also be acceptable.

## Unchanged Entities (for reference)

- **AuthorType**: `{ name: string; email: string; url: string }` — no changes
- **ScopeType**: `{ author: AuthorType }` — no changes
- **ScopesType**: `{ [index: string]: ScopeType }` — no changes
- **ScriptArgsType**: `{ binName: string; args: string[]; configDir: string }` — no changes
