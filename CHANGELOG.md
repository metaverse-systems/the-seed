# Changes

Versions before 2.0.0 have no release notes.

## 2.1.0 — 2026-10-24

This release adds to the library interface and fixes the dependency install; the command line is otherwise unchanged. It requires libecs-cpp 2.1.0 and libthe-seed 0.8.0 or later, as 2.0.0 did.

### Actions required

None.

### Command-line changes

Every command prints the same text to the same streams, with the same exit status, as in 2.0.0, except for this fix:

- Fix: `dependencies install` cleans a library's existing clone with `make distclean` (exit status ignored, printed as `==> <library> distclean: make distclean`) before configuring it, so installing one target after the other no longer reuses the first target's objects.

### Library and extension interface changes

- `Package.run(outputDir, projectDirs, options?)` and `Installer.run(projectDir, options?)` take an optional `PackageRunOptions` (`InstallerRunOptions` for the installer, the same shape). Its `log` (a `ToolLog`, called with each line and its `ToolLogLevel`: `"info"`, `"warn"` or `"error"`) receives every line they print, at the level of the console method they would use, and its `onCopy` receives a `PackageCopyEvent` (`name`, `source`, `index`, `total`) after each file and each signature is written. The installer passes the same options to the packaging it runs when `dist/` is missing. Without options both print to the console as before.
- `Package.plan(projectDirs, options?)`, `Package.parseMakefileAm(projectDir, log?)` and `Package.resolveBinaryPaths(projectDir, log?)` send their warning and error lines to the given log.
- `@metaverse-systems/the-seed/Dependencies` exports `runInstallSteps`. Called as `runInstallSteps(steps, options)`, it runs install steps in order from `options.baseDir`, passes their output to `options.output` as it arrives, sends progress lines to `options.log`, stops the running step and its process group when `options.signal` is aborted, and calls `options.onStepStart` before each step. Its options are `InstallStepsOptions`, and it resolves an `InstallStepsResult`: `completed`, `failed` with the step and message, or `cancelled`. `the-seed dependencies install` uses it, with unchanged output.
- Fix: `getInstallSteps(config, target)` decides whether a library's clone exists in the configured prefix, where its steps run, instead of in the caller's working directory, so a caller running elsewhere (the editor extension) gets `git pull` for an existing clone instead of a `git clone` that fails. An existing clone gets a `<library> distclean` step (exit status ignored) before its configure step.
- `Signing.formatSubject(subject)` is public: `formatSubject` gives the subject text the command line prints. `_formatSubject` is deprecated and returns the same text.
- The prompt methods (`Config.getQuestions`, `Scopes.askWhichScope`, `askNewScope`, `askEditScope`, `getQuestions`, `ResourcePak.askName`, `Template.askName`) return `PromptQuestion[]`; `PromptQuestion` is a type exported from the entry point and `@metaverse-systems/the-seed/types`. Their prompts are unchanged.
- `@metaverse-systems/the-seed/Config` (and the entry point) exports `configFilePath`: `configFilePath(configDir?)` returns the configuration file's location, without reading or creating it. `Config.configPath` has the same value.
- The new types are exported from the entry point and from `@metaverse-systems/the-seed/types` (`InstallStepsOptions` and `InstallStepsResult` from the entry point and `@metaverse-systems/the-seed/Dependencies`).

## 2.0.0 — 2026-10-21

This release changes exit statuses, removes a command and removes or reshapes library interfaces, so its major version changes. It requires libecs-cpp 2.1.0 and libthe-seed 0.8.0 or later, as 1.12.0 did.

### Actions required

- **Rebuild resource paks whose names are not plain ASCII.** Paks built by earlier versions whose pak name, any resource name, or any attribute key or value contains a non-ASCII character state a header size that is too small (one byte short for each extra UTF-8 byte). libthe-seed 0.8.0 refuses them as damaged and older readers read every resource from the wrong offset. Run `the-seed resource-pak build` in the project again. ASCII-only paks are byte-identical to before and need nothing.
- **Re-sign files signed by earlier versions.** Signatures are now standard CMS/Authenticode containers that osslsigncode and openssl accept. Files signed by earlier versions still verify, with a notice asking to re-sign them.
- **Rebuild or reinstall the native component.** It is now built as `native/build/Release/the_seed_native.node`; a copy built by an earlier version under the old name is not loaded and the tool reports the native component as missing. Reinstall the package, or run `npm run build-addon` in the package directory.
- **Reinstall if the native component was not built.** Installing the package now compiles the tool (when installed from git or a checkout) and builds the native component when a C++ compiler, `make`, `python3`, `pkg-config` and libthe-seed 0.8.0 or later are present. libthe-seed is found through the configured prefix, without `PKG_CONFIG_PATH`. A failed native build no longer fails the installation; build the component later with `npm run build-addon` in the package directory.
- **Signing keys must be ECDSA P-256** matching the scope's certificate; other keys are refused before any file changes.
- **Scripts that check exit statuses**: see the table under "Command-line changes".
- **Code that imports modules by path** (`@metaverse-systems/the-seed/dist/...`): use the public modules listed under "Library and extension interface changes"; other paths can no longer be imported.

### Command-line changes

**Exit statuses.** Every command now uses one scheme: 0 success; 1 the command ran and the outcome is a failure; 2 something it needs is missing or unusable; 3 usage error or input it cannot interpret; 4 (verification only) intact but not trusted; 128+N a build stopped by signal N. Changed:

| Condition | Was | Now |
|---|---|---|
| no scopes configured (`create-cert`, `import-cert`, `sign`, `export-cert`) | 3 | 2 |
| no scopes configured (`cert-info`) | 1 | 2 |
| no certificate (`sign`, `cert-info`, `export-cert`) | 1 | 2 |
| `import-cert` key mismatch or unsupported key | 3 | 2 |
| `export-cert` without `--output` | 2 | 3 |
| `sign` of a directory with no binary files | 4 | 1 |
| `build` usage errors | 1 | 3 |
| native component missing | 1 | 2 |
| configuration error | 1 | 2 |
| `installer windows` unknown `--scope`; `wixl` missing | 1 | 2 |
| `installer windows` with no or an unreadable `package.json`, or a package version or product name it refuses | 1 | 2 |
| `signing sign` of a path that does not exist | 3 | 2 |
| `signing sign` of a file that is not binary or is read-only, or another signing failure | 3 | 1 |
| `package` without a project directory; `dependencies check` or `install` with an unknown target | 1 | 3 |
| `resource-pak add` or `build` outside a pak project (no readable `package.json`) | uncaught stack trace | 2 |
| `package` with a project directory that does not exist | 1 | 2 |
| unknown command or subcommand; `dependencies` with an unknown subcommand | 0 | 3 |
| `dependencies install` failure | 0 | 1 |
| `signing verify` of a file that is intact but signed by an untrusted signer | 0 | 4 |
| a configuration file that cannot be read | stack trace | 2 |

**Commands and options.**

- `the-seed config scopes` is removed; use `the-seed scopes list`, which prints one name per line. `the-seed scopes delete` with no scopes says "There are no scopes to delete."
- Help is available for every command and subcommand and printed with status 0; unknown commands and subcommands are usage errors. Errors and hints go to standard error; an unexpected error prints one line (`THE_SEED_DEBUG=1` for details).
- The signing commands accept `--scope`; `--validity-days` is checked (1 to 3650); scope names are checked when a scope is added.
- `build --jobs N` limits compile jobs for plain, incremental and recursive builds; every build now runs `make -j<processor count>` by default instead of an unlimited `make -j`.
- Plain and incremental builds stream their output as it arrives and no longer fail when a step prints more than 1 MiB; no shell is used to run any step, so paths with spaces and quotes work.
- Windows builds look for libraries only in the Windows prefix and the cross-compiler's directories; the user's `PKG_CONFIG_PATH` is kept, after the prefix, for native builds.
- First use: the configuration directory is created when missing; a malformed `config.json` is reported in one line instead of a stack trace; writes are atomic and keep unknown entries.
- Installed copies are now the ones stripped (`--release`) and signed: builds install into a private staging directory, strip and sign there, and only then place the files in the prefix; a failure leaves the prefix untouched. Only real programs and libraries are stripped and signed (not archives, objects, `.la` files or wrappers); a signing failure fails the build naming the file; projects that cannot be signed print one notice.
- `signing verify` checks Mac programs page by page, reads standard signature containers, and checks trust: a file signed by a certificate other than the configured scopes' (or those given with `--cert`, repeatable) is reported intact but not trusted (status 4). Reports state integrity, trust, form, signer and what was not checked; directory verification checks the manifest's certificate, each file's signer, paths that leave the directory and files the manifest does not list; directory signing records skipped files.
- Without the native component, signing a Windows program, Mac program or installer, packaging, the installer command and Windows builds stop with one message naming the step that builds it, instead of writing a detached signature or failing with a raw error; verification's "not checked" reason names the same step.
- Packaging and recursive builds: a dependency cycle (including a project that declares itself) is reported at once, naming the projects in the cycle, instead of building forever; two different directories providing one package name and an unreadable `package.json` are reported; `package` finds dependency projects as `build --recursive` does, so dependencies declared with `file:` are packaged; Linux libraries are packaged under the name programs load them by (`libgreet.so.0`, was `libgreet.so` or `libgreet.so.0.0.0`), so a packaged program runs from its directory; existing packages gain those files and lose the development and fully versioned names; two different files with one name are refused instead of overwriting each other; libraries left to the target system are listed.
- `installer windows`: installer file names carry the package version (`hello-1.0.0.msi`, was `hello-1.0.0.0.msi`), the installer version has three numbers, and prerelease and build suffixes are dropped with a message.
- Projects (`template`, `resource-pak create`): created in the current directory (`./<name>`); the tool no longer creates, reads, moves or deletes `<prefix>/projects` (creating a code project no longer creates `<prefix>/projects/<scope>/`), and projects created earlier under `<prefix>/projects/<scope>/<name>` still work from that directory; `resource-pak create` accepts `<scope>/<name>`; an existing `<name>` is refused (status 1) instead of files in it being overwritten; names must start with a lowercase letter and use only lowercase letters, digits, `.`, `_` and `-` (`-` and `.` become `_` in C++ and Automake names; names whose C++ form is reserved are refused), so names accepted before (upper case, a leading digit, non-ASCII) are refused now; the scope author's name is required (status 2 with a hint when missing) and an email or web address containing `[ ] $ ' " \` or a backquote is refused (status 2).
- Generated projects: the licence's copyright line names the scope author with the year; `AUTHORS` lists name and email; the pkg-config description describes the library and the web address is in `URL:`; the system's pkg-config file requires libthe-seed as well as libecs-cpp; libecs-cpp 2.1.0 (was 2.0.0) and, where linked, libthe-seed 0.8.0 are required; a code project's `package.json` declares `MIT` (was `UNLICENSED`; a resource pak project stays `UNLICENSED`) and neither kind has a failing `test` script; one `README.md` replaces the empty `README`, `ChangeLog`, `NEWS` and the generic `INSTALL`; Automake runs in `foreign` mode; `.gitignore` is present in projects created by an installed copy.
- Resource paks: `add` under an existing name fails (status 1, was: did nothing) with a hint naming `--force`, which replaces the entry; `--attribute key=value` (repeatable) records attributes; a file outside the project is refused (status 2); a directory that is not a resource pak project is refused (status 2) instead of being given a `resources` list; `build` takes sizes from the files at build time, replaces the pak only when complete, and reports a missing resource file or a description that is not a pak project (status 2) instead of an unexpected error.
- The published package contains only the compiled tool, its type declarations, templates, native sources and build helpers, README, licence and these notes; installing it from the registry no longer installs the TypeScript compiler. It no longer contains tests, sources or development configuration.

### Library and extension interface changes

- **Public modules.** The package declares its public modules: `@metaverse-systems/the-seed` and `/Build`, `/Config`, `/Dependencies`, `/DependencyWalker`, `/Hints`, `/Installer`, `/NativeComponent`, `/Package`, `/ProjectError`, `/RecursiveBuild`, `/ResourcePak`, `/Scopes`, `/Signing`, `/Template`, `/types`. Imports of any other path, including every `dist/...` path, are refused (`ERR_PACKAGE_PATH_NOT_EXPORTED`, or `TS2307` from TypeScript under `node16`, `nodenext` or `bundler` resolution). There are no aliases for the old paths; `dist/cli/Hints` is now `/Hints`.
- **Methods.** The methods of `Build`, `Config`, `Scopes`, `Package`, `Template`, `ResourcePak` and `Installer` are ordinary methods on the prototype (they were per-instance function properties): they can be overridden and spied on through the prototype; a method taken off its object and called alone no longer has its `this`.
- `RecursiveBuildOptions` has a required `config: Config`; `getRecursiveBuildSteps(config, projectDir, target, fullReconfigure, jobs?)` takes it first. A recursive build uses the configuration it is given (the command passes the one for its configuration directory); it no longer loads the default configuration itself.
- `signFileAuthenticode`, `signFileMachO` and `signFileMsi` called directly for a scope without a certificate throw `SigningError` with the code `certificate-missing`, as `signFile` does, before touching the file (was `UnsupportedSigningKey` when no key was passed, otherwise an error reading the certificate file or a `TypeError`).
- Native component: renamed `the_seed_native`; `machoComputeCodeDirectory`, `machoEmbedSignature` (which only threw), `machoBuildSuperBlob` and `msiIsMsi` removed; `machoListSlices`, `peStripSignature` and `readResourcePak` added; `detectBinaryFormat` reads only the headers it needs.
- Builds: `BuildStep` is structured (`program`, `args`, `cwd`, `env`, `label`), replacing the shell `command`; `Build.autogen`, `configure`, `reconfigure`, `compile` and the shell-string `runCommand` are removed; `Build.buildProject` runs a plain or incremental build (with `onStepStart`, and `cancelled.installed` in its result); `stripBinaries`, `autoSignIfCertExists`, `findBuiltOutputs`, `isBinaryByMagic` and `StripResult` are removed; `Signing.removeEmbeddedSignature` is added.
- `ConfigError` is thrown for an unusable configuration.
- Verification: `VerifyStatus` gains `UNTRUSTED`, `NOT_FULLY_SIGNED` and `NOT_CHECKED`; `VerifyResult` carries integrity, trust, form, per-slice results, both signatures when present, warnings and what was not checked; `DirectoryVerifyResult` is reshaped (`passed`, `failed`, `notFound` and `overallPass` removed); `VerifyOptions` takes trusted certificates; `Signing.loadTrust` is added; `_parseCmsSignedData` is removed; the directory manifest gains an optional `skipped` list.
- Signing: `UnsupportedSigningKey` and `Signing.loadSigningKey` are added; the three form-specific signing methods take an optional key; the hand-written container builders and DER helpers are removed; the package now depends directly on `@peculiar/asn1-cms`, `@peculiar/asn1-schema`, `@peculiar/asn1-x509` and `asn1js` (versions it already installed through `@peculiar/x509`).
- Packaging: `Package.run` and `Installer.run` are asynchronous; `Package.run` resolves a result object; `Package.getPackageDeps` is removed.
- `NativeComponentMissingError` and `nativeComponentMessage` are exported.
- Command line: `runCli` is the single place that prints an error and sets the exit status, and its `binName` parameter is removed (help always says `the-seed`); `ScriptArgsType` and the exports of the old build-argument module are removed; these command-line modules are internal and, with the public modules above, can no longer be imported, so run the `the-seed` command instead. `Signing` throws `SigningError` with a `code` (`SigningErrorCode`) and a separate `hint`, so failures can be told apart without reading messages; `SignatureType`, `BinaryFormat`, `FormatDetectionResult` and `SignOptions` are exported from the entry point.
- `Template`: `createPackage(scope, name, parentDir?, now?)` returns the project path; `copyTemplate`, `save` and `package` are removed. `ResourcePak`: `createPackage(scope, name, parentDir?)` returns the project path; `readProject(dir)` is added; `addResource(name, filename, packageDir, { attributes, force })` returns the entry; `build(packageDir)` returns the pak path; `packageDir` is required; the `packageDir` and `package` fields and `save` are removed. New exports `ProjectError`, `ProjectErrorCode`, `PakProjectType` and `PackageAuthorType`; `PackageType.author` is `PackageAuthorType` (email and web address optional), `PackageType.resources` is optional, and `PackageType.main` is removed.
- Dependencies: `typescript` is no longer a runtime dependency (it is a development dependency, `^5.9.3`); `@types/node` is `^22.20.5`; the compiled declarations no longer reference the browser library. `node-addon-api` stays a runtime dependency. The test framework moves to `jest` `^30.5.2`, `ts-jest` `^29.4.15` and `@types/jest` `^30.0.0` (development only; no other runtime dependency changes).
- Editor extension (the-seed-vscode): creates projects in the open folder or one the user chooses, never under the prefix; shows verification outcomes separately (untrusted as a warning); uses `buildProject` for plain builds; imports only the public modules.
