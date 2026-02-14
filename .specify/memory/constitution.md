# The Seed — Project Constitution

## Identity

- **Name:** `@metaverse-systems/the-seed`
- **Purpose:** A TypeScript CLI toolkit for scaffolding, building, and managing C++ ECS-based game engine projects using autotools, built on top of `libecs-cpp` and `libthe-seed`.
- **Author:** Tim Schwartz <tim@metaverse.systems>
- **License:** MIT
- **Repository:** https://github.com/metaverse-systems/the-seed

## Architecture

### Ecosystem

`the-seed` is part of a three-library ecosystem:

| Library | Role |
|---|---|
| `libecs-cpp` | Implements the Entity-Component-System pattern in C++ |
| `libthe-seed` | Dynamic component/system loading and unloading, resource management; depends on `libecs-cpp` |
| `the-seed` (this project) | TypeScript CLI that scaffolds C++ projects, manages builds, resolves dependencies, and packages resource paks using the above libraries |

### Project Structure

```
src/              # Library modules (importable via @metaverse-systems/the-seed)
  Config.ts       # Configuration persistence (~/<prefix>/config.json)
  Scopes.ts       # Organizational namespaces with author metadata
  Template.ts     # C++ autotools project scaffolding (component, system, program)
  Build.ts        # Autotools build pipeline (autogen → configure → make → install)
  Dependencies.ts # C++ dependency resolution via pkg-config, auto-install from GitHub
  ResourcePak.ts  # Resource file bundling into .pak archives with JSON headers
  types.ts        # Shared TypeScript interfaces
  index.ts        # Public API exports

src/scripts/      # CLI entry points (not part of the library API)
  the-seed.ts     # Main CLI router
  *CLI.ts         # Per-command CLI handlers

templates/        # C++ autotools project templates
  component/      # Shared library template (produces .so/.dll + .pc)
  system/         # System library template (produces .so/.dll + .pc)
  program/        # Executable template (no .pc file)

test/             # Jest test suites
```

### CLI Commands

```
the-seed config [list|edit]
the-seed scopes [list|add|edit|delete]
the-seed template [component|system|program]
the-seed build [native|windows]
the-seed dependencies [check|install]
the-seed resource-pak [create|add|build]
```

### Build Targets

| Target | Toolchain | Host Triple |
|---|---|---|
| `native` | GCC/autotools | `x86_64-linux-gnu` |
| `windows` | MinGW cross-compiler | `x86_64-w64-mingw32` |

### Key Patterns

- **Config** is the root object; most modules accept a `Config` instance in their constructor.
- **Scopes** act like npm scopes — organizational namespaces prefixed with `@` that carry author metadata.
- **Templates** copy a skeleton autotools project, perform variable substitution (`SKELETON` → project name), and initialize a `package.json`.
- **ResourcePak** bundles named files into a single `.pak` file with a JSON header describing contents.

## Coding Conventions

### TypeScript

- **Strict TypeScript:** Eliminate `any` types. All new code must use explicit types. Existing `any` usage should be replaced incrementally.
- **Class-based design:** Continue using classes for modules (Config, Scopes, Template, Build, ResourcePak). New domain modules should follow the same pattern.
- **ES module interop:** The project uses CommonJS (`"module": "commonjs"`) with `esModuleInterop: true`. Maintain this configuration.
- **Library vs CLI separation:** `src/*.ts` files are importable library code. `src/scripts/*.ts` files are CLI-only entry points. Shell execution (`execSync`, `child_process`) is acceptable in both, but prefer encapsulating it within library classes.

### Testing

- **Framework:** Jest with `ts-jest`.
- **Test coverage required:** All new modules and significant changes must include corresponding tests in `test/`.
- **Isolation:** Tests must use temporary directories (via `fs.mkdtempSync`) and clean up after themselves (`fs.rmSync` in `afterAll`/`afterEach`). Never depend on the user's home directory or real config.
- **Naming:** Test files follow `<ModuleName>.test.ts` in the `test/` directory.

### C++ Templates

- Templates use autotools (autoconf/automake) with `autogen.sh` → `configure.ac` → `Makefile.am`.
- Template variable substitution uses `SKELETON` (project name) and `SKELETON_` (underscored variant).
- Components and systems produce pkg-config `.pc` files; programs do not.

## Roadmap

### Planned Features

- **Code signing:** Add support for signing built artifacts.
- **Dependency documentation:** Integrate `DependencyLister` from `libthe-seed` to enumerate required shared libraries for built projects.
- **Distribution packaging:** Package applications with their dependencies for distribution.

### Technical Debt

- Replace `any` types throughout the codebase with proper interfaces.
- Add test coverage for `Template`, `Build`, and `Dependencies` modules.
- Migrate from `require()` to ES `import` in files that still use CommonJS `require` (`fs-extra`, `child_process` in Template.ts, ResourcePak.ts).

## Constraints

- **Node.js runtime:** The CLI runs on Node.js. The project targets ES6.
- **Linux-primary:** Native builds assume a Linux environment. Windows support is cross-compilation only (MinGW).
- **Autotools dependency:** Generated C++ projects require autoconf, automake, libtool, and pkg-config on the host system.
- **No browser runtime:** Despite `"dom"` in `tsconfig.json` lib, this is a CLI-only tool. The `"dom"` lib entry should be reviewed for removal.
