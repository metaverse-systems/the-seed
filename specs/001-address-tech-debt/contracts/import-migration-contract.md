# Import Migration Contract

**Date**: 2026-02-13  
**Feature**: 001-address-tech-debt

This contract defines exactly which `require()` calls must be replaced and their ES `import` equivalents.

## Migration Table

| File | Line | Before | After |
|------|------|--------|-------|
| `src/Template.ts` | 1 | `const fs = require("fs-extra");` | `import fs from "fs-extra";` |
| `src/Template.ts` | 2 | `const { execSync } = require("child_process");` | `import { execSync } from "child_process";` |
| `src/Build.ts` | 2 | `const { execSync } = require('child_process');` | `import { execSync } from "child_process";` |
| `src/Dependencies.ts` | 2 | `const { execSync } = require("child_process");` | `import { execSync } from "child_process";` |
| `src/ResourcePak.ts` | 1 | `const fs = require("fs-extra");` | `import fs from "fs-extra";` |
| `src/ResourcePak.ts` | 2 | `const { execSync } = require("child_process");` | `import { execSync } from "child_process";` |

## Special Case: require.main

| File | Line | Before | After |
|------|------|--------|-------|
| `src/Template.ts` | 39 | `path.join(path.dirname(require.main!.filename), "../../templates/" + this.type)` | `path.join(__dirname, '..', 'templates', this.type)` |

## Compilation Behavior

With `tsconfig.json` settings `"module": "commonjs"` and `"esModuleInterop": true`:

- `import fs from "fs-extra"` compiles to `const fs = __importDefault(require("fs-extra"))` — functionally equivalent
- `import { execSync } from "child_process"` compiles to destructured access on `require("child_process")` — functionally equivalent
- `__dirname` is natively available in CommonJS modules — no polyfill needed

## ESLint Configuration Addition

Add to ESLint config to prevent `any` type regressions:

```json
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error"
  }
}
```

This rule is available in the already-installed `@typescript-eslint/eslint-plugin` ^5.15.0.
