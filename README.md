# @metaverse-systems/the-seed

A command-line tool and TypeScript library for scaffolding, building, packaging, signing and cross-compiling C++ ECS projects built on the libecs-cpp framework. It provides project templates, dependency management, native and Windows builds, code signing and verification, Windows installers, resource paks, and a programmatic API for custom tooling.

The command reference below quotes the tool's own help screens, and the test suite fails when this README and the tool disagree (see [Running the checks](#running-the-checks)).

## Architecture

The project consists of four repositories with a linear dependency chain:

```text
libecs-cpp --> libthe-seed --> the-seed --> the-seed-vscode
```

**libecs-cpp** -- A C++20 Entity Component System framework providing Manager, Container, Entity, Component, System, Timing, and Uuid classes. Built with GNU Autotools and distributed via pkg-config as `ecs-cpp`.
GitHub: https://github.com/metaverse-systems/libecs-cpp

**libthe-seed** -- A C++20 engine runtime that depends on libecs-cpp. Provides LibraryLoader, ComponentLoader, SystemLoader, JSONLoader, ResourcePak, NameParser, and DependencyLister. Built with GNU Autotools and distributed via pkg-config as `the-seed`.
GitHub: https://github.com/metaverse-systems/libthe-seed

**the-seed** -- A TypeScript CLI tool and npm package (`@metaverse-systems/the-seed`) with a C++ N-API native addon (node-gyp). Wraps DependencyLister for shared library dependency analysis. Provides the commands described in the [Command reference](#command-reference).
GitHub: https://github.com/metaverse-systems/the-seed

**the-seed-vscode** -- A TypeScript VS Code extension that depends on `@metaverse-systems/the-seed`. Provides commands for scopes, templates, builds, packaging, installers, signing and resource paks from within the editor.
GitHub: https://github.com/metaverse-systems/the-seed-vscode

The source and test layout is described in [structure.md](structure.md). The package is released under the [MIT license](LICENSE).

## Prerequisites

### Required

- Node.js v16+ and npm

```bash
sudo apt install build-essential libtool pkg-config autoconf automake curl git
```

### The native component

Signing and verifying Windows programs, Mac programs and installers, packaging, the installer command and Windows builds use a native component (a C++ N-API addon) that is compiled on your machine when the package is installed. Building it needs:

- a C++ compiler and `make` (`build-essential`),
- `python3` (used by node-gyp),
- `pkg-config`, and
- libthe-seed 0.8.0 or later with libecs-cpp, which `the-seed dependencies install` builds into the prefix.

Everything else in the tool works without it.

### Optional: Windows Cross-Compilation

These packages are only needed if you intend to cross-compile projects for Windows:

```bash
sudo apt install mingw-w64-x86-64-dev g++-mingw-w64-x86-64 binutils-mingw-w64-x86-64 wine wine64
```

### Optional: Windows MSI Installer Generation

To generate `.msi` installer packages from cross-compiled Windows binaries:

```bash
sudo apt install wixl
```

## Installation

Install in this order:

1. Install the system packages listed under Prerequisites.
2. Install the tool. Add `--foreground-scripts` to see the native component's build report; npm hides it otherwise.

   ```bash
   npm install -g --foreground-scripts @metaverse-systems/the-seed
   ```

   On a fresh machine the report says the native component was not built because libthe-seed is missing. The installation still succeeds and every other command works.
3. Optionally set the prefix (`the-seed config edit`), then install the libraries into it:

   ```bash
   the-seed dependencies install
   ```

4. Build the native component:

   ```bash
   cd "$(npm root -g)/@metaverse-systems/the-seed" && npm run build-addon
   ```

5. Verify the installation:

   ```bash
   the-seed help
   ```

   It prints the list of commands (see [Command reference](#command-reference)).

### Commands that need the native component

Without the native component these stop with one message that names the step above, and change nothing:

- `signing sign` of a Windows program, Mac program or installer, or of a directory holding one (`--detached` and files of other kinds do not need it);
- `package` and `installer`;
- `build windows`, plain or release, checked before any step; an incremental build (`build` with no target) of a tree that produces Windows programs is stopped before installing them.

`signing verify` does not fail: it reports an embedded signature as not checked and gives the same message as the reason.

The message is also the error `NativeComponentMissingError` carries (see the API reference).

### How the library is found

The native component's build looks for libthe-seed in this order:

1. the configured prefix (`<prefix>/x86_64-linux-gnu/lib/pkgconfig`), read from `~/the-seed/config.json` when the build runs (the default prefix when there is none);
2. your own `PKG_CONFIG_PATH`;
3. pkg-config's default directories.

No `PKG_CONFIG_PATH` is needed when the libraries are in the configured prefix. If you change the prefix later, repeat step 4 so the component is built against the new one.

### Other ways to install

- From git, as a dependency of a project or from a remote (`npm install git+https://github.com/metaverse-systems/the-seed.git`): npm compiles the tool and builds the native component as it does for a registry install.
- With `--ignore-scripts`, npm skips both the compile (for a git install, which has no compiled files) and the native component's build; run `npm run build` and `npm run build-addon` in the package directory afterwards.
- With `npm link` or `npm install -g .` from a checkout, the checkout's own component is used; build it there with `npm run build-addon`.

## Quick Start

The commands below were run in a scratch home directory; the output is what the tool prints. Paths on your machine differ (`/home/you` stands for your home directory).

### Step 1: Configure the installation prefix (optional)

```bash
the-seed config edit
```

```text
? Installation prefix? ~/the-seed
```

This creates `~/the-seed/config.json` with your chosen prefix. The first command that needs the configuration creates it with the defaults (the prefix `~/the-seed` and no scopes), so this step can be skipped.

### Step 2: Add a scope

```bash
the-seed scopes add
```

```text
? Name for scope? my-project
? Your name? Jane Developer
? Your email? jane@example.com
? Your URL? https://example.com
```

The scope `@my-project` is saved to your configuration. `the-seed scopes list` prints it:

```text
@my-project
```

### Step 3: Create a component in the current directory

Code projects are created in the directory you are in, never under the prefix:

```bash
mkdir -p ~/work && cd ~/work
the-seed template component @my-project/hello-world
```

```text
Copying template from /usr/lib/node_modules/@metaverse-systems/the-seed/templates/component to hello-world
```

This creates `./hello-world` with autotools build files and a package.json whose name is `@my-project/hello-world` and whose author is the scope's author. Without the argument the command asks for the scope and the name:

```text
? Choose scope for component: @my-project
? Choose name for component: hello-world
```

### Step 4: Install dependencies

```bash
cd hello-world
the-seed dependencies install
```

```text
Installing libecs-cpp...
==> clone libecs-cpp: git clone https://github.com/metaverse-systems/libecs-cpp.git libecs-cpp
Cloning into 'libecs-cpp'...
==> libecs-cpp autogen: ./autogen.sh
...
==> libecs-cpp configure: ./configure --prefix=/home/you/the-seed/x86_64-linux-gnu
...
==> libecs-cpp compile: make -j8
...
==> libecs-cpp install: make install
...
libecs-cpp installed successfully.
Installing libthe-seed...
==> clone libthe-seed: git clone https://github.com/metaverse-systems/libthe-seed.git libthe-seed
...
libthe-seed installed successfully.
```

This clones and builds the required C++ libraries into your prefix. Each step is printed as `==> <label>: <command>`, followed by the program's own output as it happens. The compile step uses the processor count as its job limit (`8` above).

### Step 5: Build the project

```bash
the-seed build native
```

```text
==> autogen: ./autogen.sh
...
==> distclean: make distclean
...
==> configure: ./configure --prefix=/home/you/the-seed/x86_64-linux-gnu
...
==> compile: make -j8
...
==> install: make install
...
```

Each block is a step's label and command, followed by the program's output as it happens; `...` stands for that output. The compiled binary or library is installed to `~/the-seed/x86_64-linux-gnu/`. Without a signing certificate the build says so in one line and installs the files unsigned; the next step creates one.

### Step 6: Create a signing certificate

```bash
the-seed signing create-cert --scope @my-project
```

```text
Certificate created successfully.
  Subject:     CN=Jane Developer, EMAIL=jane@example.com, O=@my-project
  Fingerprint: SHA256:e879e44ae80e59ef86c8cc2d62724e6fb7e2f2bd7549c4cdf2bcc73efb2fd10e
  Valid:        2026-10-20 to 2027-10-20
  Stored:       /home/you/the-seed/signing/@my-project/cert.pem
```

With only one scope configured `--scope` can be left out. The certificate is valid for 365 days unless `--validity-days` says otherwise.

### Step 7: Sign and verify a file

```bash
cp /bin/true hello-tool
the-seed signing sign hello-tool
the-seed signing verify hello-tool
```

```text
Signed: /home/you/work/hello-world/hello-tool
  Signature:   /home/you/work/hello-world/hello-tool.sig
  Type:        detached
  Fingerprint: SHA256:e879e44ae80e59ef86c8cc2d62724e6fb7e2f2bd7549c4cdf2bcc73efb2fd10e
Verification: VALID ✓
  File:        /home/you/work/hello-world/hello-tool
  Form:        detached (hello-tool.sig)
  Integrity:   intact (signature over the whole file)
  Trust:       trusted: certificate of scope @my-project
  Signer:      CN=Jane Developer, EMAIL=jane@example.com, O=@my-project
  Issuer:      self-signed
  Fingerprint: SHA256:e879e44ae80e59ef86c8cc2d62724e6fb7e2f2bd7549c4cdf2bcc73efb2fd10e
  Valid:       2026-10-20 to 2027-10-20
  Not checked: certificate chains, revocation, signing time, acceptance by the platform's own verifier
```

`sign` and `verify` print their results and exit with the statuses described under [Exit statuses](#exit-statuses).

## Configuration and directories

The configuration is `~/the-seed/config.json`, holding the installation prefix and the scopes with their authors. `the-seed config list` prints its location and contents.

The installation prefix (default `~/the-seed`) has this layout:

```text
~/the-seed/
+-- config.json                    # Configuration file (prefix, scopes)
+-- include/                       # Shared headers
+-- projects/                      # Resource paks, by scope and name
+-- signing/                       # Certificates and keys, one directory per scope
|   +-- @scope-name/
+-- x86_64-linux-gnu/              # Native Linux target
|   +-- bin/                       # Installed programs
|   +-- lib/
|       +-- pkgconfig/             # pkg-config files
+-- x86_64-w64-mingw32/            # Windows cross-compilation target
    +-- bin/                       # Cross-compiled programs
    +-- lib/
        +-- pkgconfig/             # pkg-config files
```

Code projects (components, systems and programs from `template`) are created in the current directory. Resource paks are created under `<prefix>/projects/<scope>/<name>` as they behave now.

## Exit statuses

Every command ends with one of these statuses:

<!-- exit-statuses -->

| Status | Meaning |
|---|---|
| 0 | The command did what was asked, including printing help that was asked for and a verification that is valid |
| 1 | The command ran and the outcome is a failure: a build, packaging, installer, dependency installation or signing operation failed; verification found the file invalid, not fully signed, not checked or unsigned; the user declined to overwrite; an unexpected internal error |
| 2 | Something the command needs is missing or unusable: a file or directory, a project description, scopes, the named scope, a certificate (or it has expired or cannot be read), a valid configuration file, the native component, a required program such as wixl |
| 3 | Usage error, or input the command cannot interpret (for verification: a malformed manifest, or a signature file given in place of a signed file) |
| 4 | Verification only: intact but not trusted |
| 128+N | A build stopped by signal N (130 after Ctrl+C) |

Results go to standard output. Errors, hints and notes go to standard error: a failure prints one `Error: <message>` line, followed by the hint that names the command to run next, if there is one. A usage error also prints the usage line and a pointer to the help. An unexpected internal error prints one line naming the command; set `THE_SEED_DEBUG=1` to have the stack follow on standard error. Requested help (`the-seed help`, `the-seed <command> --help`) is printed on standard output with status 0.

```text
$ the-seed signing sign app.exe --scope @a
Error: No signing certificate found for scope '@a'.
Create one with "the-seed signing create-cert --scope @a".
```

That example ends with status 2.

## Command reference

The tool is one program with commands and subcommands. Every command and subcommand accepts `--help` (or `-h`) and prints its help with status 0; `the-seed help <command> [<subcommand>]` prints the same. An unknown command, subcommand or option, a missing argument or an invalid value is a usage error (status 3) that names the problem and the usage line, before anything is read, prompted for or changed. The screens below are the tool's own help; the text after each describes what help does not carry.

<!-- help -->

```text
Usage: the-seed <command> [<subcommand>] [arguments] [options]

Commands:
  config        Show or edit the tool's configuration
  scopes        List, add, edit and delete scopes
  template      Create a component, system or program from a template
  build         Build the project for Linux or Windows
  dependencies  Check or install libecs-cpp and libthe-seed
  package       Package binaries with their shared library dependencies
  resource-pak  Create a resource pak project, add resources to it and build it
  signing       Create, import, use and inspect code-signing certificates
  installer     Build a Windows installer for the project
  help          Show help for the tool, a command or a subcommand

Exit statuses:
  0      The command did what was asked, including printing help that was asked for and a
         verification that is valid
  1      The command ran and the outcome is a failure: a build, packaging, installer, dependency
         installation or signing operation failed; verification found the file invalid, not fully
         signed, not checked or unsigned; the user declined to overwrite; an unexpected internal
         error
  2      Something the command needs is missing or unusable: a file or directory, a project
         description, scopes, the named scope, a certificate (or it has expired or cannot be read),
         a valid configuration file, the native component, a required program such as wixl
  3      Usage error, or input the command cannot interpret (for verification: a malformed manifest,
         or a signature file given in place of a signed file)
  4      Verification only: intact but not trusted
  128+N  A build stopped by signal N (130 after Ctrl+C)

Run "the-seed help <command>" for a command's subcommands and options.
Set THE_SEED_DEBUG=1 to print the full details of an unexpected error.
```

### config

<!-- help: config -->

```text
Usage: the-seed config [list|edit]

Show or edit the tool's configuration.

Subcommands:
  list
      Show the configuration file's location and its contents
  edit
      Change the configuration by answering questions

Run "the-seed help config <subcommand>" for one subcommand's details.
```

`config list` (the default) prints the path of `config.json` and its contents. `config edit` asks for the installation prefix:

```text
? Installation prefix? ~/the-seed
```

The first command that needs configuration creates `~/the-seed/config.json` with the defaults (the prefix `~/the-seed` and no scopes), so there is no setup step before `config list`, `scopes add` or `build`; help does not create it. Entries missing from the file are filled in with their defaults. An entry of the wrong kind (for example a `prefix` that is not text), a file that is not valid JSON, or a directory that cannot be written stops the command with one line naming the file and the entry (status 2); the file is never rewritten to repair it. `config edit` and the other commands that save the configuration write it atomically. To list the scopes use `the-seed scopes list`.

### scopes

<!-- help: scopes -->

```text
Usage: the-seed scopes <list|add|edit|delete>

List, add, edit and delete scopes.

Subcommands:
  list
      List the configured scopes, one per line
  add
      Add a scope by answering questions
  edit
      Edit a scope's author by answering questions
  delete
      Delete a scope

Run "the-seed help scopes <subcommand>" for one subcommand's details.
```

Scopes group projects under a namespace (for example `@my-org`) and name the author recorded in the projects and certificates of the scope. `scopes list` prints one scope name per line and nothing else on standard output; with no scopes it prints nothing there, and `No scopes are configured. Add one with "the-seed scopes add".` on standard error, with status 0.

`scopes add` prompts:

```text
? Name for scope? my-project
? Your name? Jane Developer
? Your email? jane@example.com
? Your URL? https://example.com
```

Names are prefixed with `@` when written without it. A name cannot be empty, contain `/` or contain whitespace; the prompt asks again. `scopes edit` and `scopes delete` prompt you to select from the existing scopes (the author's name, email and URL can be changed in `scopes edit`, which does not check the scope name again); with no scopes they say so, print the hint to run `scopes add` and exit with status 0.

### template

<!-- help: template -->

```text
Usage: the-seed template <component|system|program>

Create a component, system or program from a template.

Subcommands:
  component [<scope>/<name>]
      Create a component
  system [<scope>/<name>]
      Create a system
  program [<scope>/<name>]
      Create a program

The project is created in the current directory.

Run "the-seed help template <subcommand>" for one subcommand's details.
```

The project is created in the current directory, in a directory named after the project. `template component @my-project/hello-world` takes the scope and the name together; given alone, `template component` asks for them (`template system` and `template program` work the same way):

```text
? Choose scope for component: @my-project
? Choose name for component: hello-world
```

A value that is not of the form `<scope>/<name>` is a usage error (status 3) that shows an example. Template variable substitutions applied during scaffolding:

| Variable | Replaced With |
|----------|---------------|
| `SKELETON` | Project name |
| `SKELETON_` | Project name with `-` replaced by `_` |
| `AUTHOR_EMAIL` | Scope author email |
| `AUTHOR_URL` | Scope author URL |

The generated `package.json` includes build scripts:

```json
{
  "scripts": {
    "build": "the-seed build native",
    "build-win64": "the-seed build windows"
  }
}
```

The `component` and `system` templates include a `.pc.in` file for pkg-config. The `program` template does not.

### build

<!-- help: build -->

```text
Usage: the-seed build [native|windows] [--recursive] [--parallel <n>] [--jobs <n>] [--release]

Build the project for Linux or Windows, or rebuild the current project.

Arguments:
  [<target>]  native builds for this Linux system, windows cross-compiles with MinGW

Options:
  --recursive     Build every buildable dependency first, then this project
  --parallel <n>  With --recursive, build up to <n> independent projects at once (default 1)
  --jobs <n>      Run at most <n> compile jobs at once (default: the processor count); with
                  --parallel, the projects building at once share <n>
  --release       Strip the installed programs and libraries (and the build-tree copies "the-seed
                  package" reads) before they are signed
  -h, --help      Show this help

With no target, "the-seed build [--jobs <n>]" rebuilds the current project (make, install, sign).
--parallel=<n> and --jobs=<n> are the same as --parallel <n> and --jobs <n>. --parallel above the
processor count, or above --jobs, is reduced to it.

Examples:
  "the-seed build native"                         Build for Linux
  "the-seed build native --jobs 4"                Build for Linux with at most 4 compile jobs
  "the-seed build native --release"               Build for Linux (stripped)
  "the-seed build native --recursive"             Build all dependencies and the project for Linux
  "the-seed build native --recursive --parallel 4 --release"
                                                Same, up to 4 projects at once (stripped)
  "the-seed build windows"                        Build for Windows (MinGW)
  "the-seed build windows --recursive --release"  Build all dependencies and the project for Windows

Installing: "make install" runs into a staging directory; the programs and shared libraries it
installed, and their copies in src/ and src/.libs/ that "the-seed package" reads, are stripped (with
--release) and signed with the project's scope certificate, and only then is everything moved into
the prefix. Archives, import libraries, wrappers and other files are not stripped or signed. A
failure leaves the prefix as it was. Without a certificate the build says so in one line and
installs unsigned files.

With --recursive, dependencies always finish installing before anything that needs them starts, and
all components finish before systems, and systems before programs. Install phases never overlap.
With --recursive and --parallel above 1, the compile jobs of the projects building at once never add
up to more than --jobs, or the processor count when --jobs is not given.

Press Ctrl+C once to stop the running builds; an install in progress finishes first. Press it again
to stop at once; an install that has not reached the prefix is discarded.

The bare word "recursive" after the target is deprecated; it still works for now but prints a
warning. Use --recursive instead.
```

Building needs a target (`native` or `windows`), except that `the-seed build` alone, optionally with `--jobs`, rebuilds the current project: `make` and the install phase, without reconfiguring. A misspelled option, `--parallel` without `--recursive`, an invalid or repeated `--parallel` or `--jobs` value, an option given without a target (`the-seed build --release`) and an unknown target are usage errors (status 3) reported before anything is built. A build step that fails, or a recursive build whose projects cannot be ordered or read, ends with status 1 (see [Exit statuses](#exit-statuses)). The options may come before the target.

| Option | Description |
|--------|-------------|
| `--recursive` | Build every buildable dependency first, then the current project (see [Recursive Builds](#recursive-builds)) |
| `--parallel N` | With `--recursive`, build up to `N` independent projects at once. Default 1. `N` must be a positive whole number; values above the processor count are reduced to it |
| `--jobs N` | Run at most `N` compile jobs at once (`make -j<N>`). Default: the processor count. With `--parallel`, it is the budget the projects building at once share |
| `--release` | Strip the installed programs and shared libraries, and the build-tree copies that `package` reads, before they are signed |

Target directory mapping:

| Target | Configured for | Install Prefix |
|--------|----------------|----------------|
| `native` | this machine | `<prefix>/x86_64-linux-gnu` |
| `windows` | the host `x86_64-w64-mingw32` | `<prefix>/x86_64-w64-mingw32` |

During `configure`, and when `dependencies check` and `dependencies install` look for a library, pkg-config searches these places:

| Target | Searched |
|--------|----------|
| `native` | `<prefix>/x86_64-linux-gnu/lib/pkgconfig` first, then your own `PKG_CONFIG_PATH`, then pkg-config's default directories |
| `windows` | Only `<prefix>/x86_64-w64-mingw32/lib/pkgconfig`, `/usr/local/x86_64-w64-mingw32/lib/pkgconfig` and `/usr/x86_64-w64-mingw32/lib/pkgconfig` (`PKG_CONFIG_LIBDIR`). Your `PKG_CONFIG_PATH` and the system directories are not used, so a library built only for Linux can never satisfy a Windows build |

A library description that does not depend on the architecture, such as `nlohmann_json.pc`, is installed once in a system directory and so is not found for a Windows build; install it into the Windows prefix (`<prefix>/x86_64-w64-mingw32/lib/pkgconfig`) to make it visible.

The output of a plain or incremental build is shown as it happens, one `==> <label>: <command>` line per step. Paths are passed to every program exactly as they are, so a prefix or project directory may contain spaces, quotes or `$`. When a step fails, the build stops with a message naming the step and how it ended, and exits with status 1.

Build steps for `native` and `windows`:

1. `./autogen.sh`
2. `make distclean` (errors ignored)
3. `./configure` with the prefix `<prefix>/<target>` (and, for `windows`, the host `x86_64-w64-mingw32`)
4. `make -j<jobs>` (the processor count unless `--jobs` is given)
5. `make install DESTDIR=<prefix>/.the-seed-staging/<random>`

Then the install phase:

1. Identify the programs and shared libraries the install step wrote: ELF executables and shared objects for `native`, PE programs and DLLs for `windows`. Archives, import libraries, `.la` files, wrappers, scripts, headers, `.pc` files and data are not processed.
2. Find the matching copies in src/.libs/ (else src/), which `package` reads.
3. Strip both (with `--release`).
4. Sign both when the scope has a valid certificate.
5. Place the staged files into `<prefix>/<target>`.
6. Remove the staging directory.

Every build has a job limit; the tool never runs an unbounded `make -j`.

Running `the-seed build` without a subcommand performs only step 4 and the install phase (step 5 and what follows it).

The files in the prefix are stripped and signed, not only the build-tree copies; static archives and the Windows libtool wrapper are not signed, and a signing error fails the build.

#### What is installed, stripped and signed

- Detached signatures for Linux outputs are written beside the installed file and beside each of its link names (`libx.so.sig` is a link to `libx.so.0.0.0.sig`); signatures for Windows outputs are embedded in the file.
- Signing happens on every kind of build. Stripping needs `--release` and a target (an incremental build with no target does not strip).
- When the project has programs or libraries to sign but cannot sign them (no `package.json`, no scope in the package name, no certificate for the scope, or an expired one), the build prints one line saying why (for example `Not signed: no signing certificate for scope '@t'. Create one with "the-seed signing create-cert".`), installs the files unsigned and removes any signature left beside them by an earlier build. An unreadable certificate or a file that cannot be stripped or signed fails the build.
- All or nothing: the prefix is changed only after every file has been stripped and signed. A failure at `install`, `strip`, `sign` or `place` leaves the prefix as it was.
- Cancelling: the first Ctrl+C lets the install phase finish and place its files (`Build cancelled after installing.`); a second Ctrl+C, `SIGTERM` or `SIGHUP` discards an install phase that has not reached placement (`Build cancelled.`). Placement, once started, completes.
- `<prefix>/.the-seed-staging` holds the staging directories while a build runs. It may be deleted when no build is running.
- A build refuses to install (failing at `install`) when `make install` writes outside the prefix, writes nothing under `DESTDIR` (the message names the project), or the project was configured for another prefix; run a full build (`the-seed build native` or `the-seed build windows`) in that case. A project whose install rules ignore `DESTDIR` has already written into the prefix by then; the build reports the failure but cannot undo that.
- Files that an install rule deletes (for example retired headers) are not removed from the prefix, because the install writes into a staging directory.
- Outputs installed outside src/ and src/.libs/ are processed in the prefix, but their build-tree copies are not.

#### Recursive Builds

The `--recursive` option finds the projects the current project depends on, classifies each by type (component, system, or program), and builds them in topological order so that dependencies are always installed before their dependents.

Dependencies are found by one rule, which `the-seed package` uses too (see [package](#package)): for each entry in a project's `package.json` `dependencies`, a `file:` path is taken relative to the project that declares it, and any other name is looked up in that project's own `node_modules`. Parent directories are never searched. A project is identified by its real location, so a project reached through links, or declared by several projects, is built once.

Before anything runs, the build stops with exit status 1 and a message when the projects cannot be ordered or read:

- A dependency cycle, including a project that declares itself, names the projects in the cycle and where they are, for example:

  ```text
  Dependency cycle: @t/a → @t/b → @t/a
    @t/a  /work/a
    @t/b  /work/b
  Each project above declares the next one in its package.json "dependencies"; remove the declaration that closes the cycle.
  ```

- Two different directories with the same package name are reported with both locations.
- A `package.json` that cannot be read or parsed is reported with its path and the reason.

A stop request (Ctrl+C, `SIGTERM`, `SIGHUP`) while the dependencies are being scanned cancels the build.

```bash
the-seed build native --recursive
the-seed build windows --recursive --release
the-seed build native --recursive --parallel 4 --release
the-seed build native --recursive --jobs 4
```

Projects are classified by inspecting src/Makefile.am:

| Type | Detection | Build Priority |
|------|-----------|----------------|
| Component | `lib_LTLIBRARIES` without `the-seed` in name | 0 (first) |
| System | `lib_LTLIBRARIES` with `the-seed` in name | 1 |
| Program | `bin_PROGRAMS` | 2 (last) |

Within each tier, projects are sorted alphabetically.

By default (`--parallel 1`) projects build one at a time in that order, with the same commands as a plain build, including its job limit. With `--parallel N`, up to `N` projects build at once (never more than the processor count), and the ordering guarantees still hold:

- A project starts only after each of its dependencies has finished installing.
- Every component finishes before any system starts, and every system before any program. A project that depends on a higher tier than its own waits with that tier.
- Among projects that are ready, the one earliest in the build order starts first.
- Install phases never overlap. Each project's install phase (staged `make install`, strip with `--release`, signing, placement) runs as one unit that no other project's install phase can interleave with; a dependent starts only after its dependency's processed files are in the prefix.
- When more than one project builds at once, each tier's projects share the processors as `make -j<jobs>`, so the compile jobs running at once never add up to more than `--jobs`, or the processor count when `--jobs` is not given. `MAKEFLAGS` and `MFLAGS` are removed from the build environment so an inherited `-j` cannot override the share.

Every progress line names its project, for example `[@org/physics-system] compile... done`. Build output is captured, not streamed; when the build ends, a report lists the projects that completed, failed, were interrupted or never started, and each failure's full output appears as one block between `===== <project> failed at <step> =====` and `===== end of <project> output =====`.

The build stops starting new projects at the first failure; projects already building run to the end and are reported. A failed build exits with status 1.

Cancelling:

- The first Ctrl+C stops every running autogen, distclean, configure and compile step, and starts nothing new. An install phase already in progress finishes and places its files, so the prefix is never left half-written.
- A second Ctrl+C also stops an install phase that has not reached placement and discards it; that project is reported as interrupted. Placement, once started, completes.
- `SIGTERM` and `SIGHUP` act like two presses.
- A cancelled build exits with 130 after Ctrl+C, 143 after `SIGTERM` and 129 after `SIGHUP`.

When invoked programmatically, `buildRecursive` accepts an `AbortSignal` (`signal`, the graceful kind) and an optional `forceSignal`; cancelling from the VS Code extension is always the graceful kind.

The bare word `recursive` (without dashes) after the target is deprecated. It still requests a recursive build but prints a warning; use `--recursive` instead.

### dependencies

<!-- help: dependencies -->

```text
Usage: the-seed dependencies <check|install>

Check or install libecs-cpp and libthe-seed.

Subcommands:
  check [<target>]
      Report whether libecs-cpp and libthe-seed are installed
  install [<target>]
      Install the libraries that are missing

Run "the-seed help dependencies <subcommand>" for one subcommand's details.
```

`dependencies check` reports whether libecs-cpp and libthe-seed are installed (a missing library is reported, with status 0). `dependencies install` installs the ones that are missing. The `target` argument is `native` or `windows` and defaults to `native`; anything else is a usage error (status 3). For each missing library, `install` clones the repository from GitHub and builds it with autotools into the target prefix. Each step is printed as `==> <label>: <command>` with the program's output as it happens. The compile step uses the processor count as its job limit; `dependencies install` has no option for the job limit. A step that fails stops that library's install, the failure is reported and the status is 1:

- `ecs-cpp`: Cloned from `https://github.com/metaverse-systems/libecs-cpp.git`
- `the-seed`: Cloned from `https://github.com/metaverse-systems/libthe-seed.git`

Minimum versions are libecs-cpp 2.1.0 and libthe-seed 0.8.0. An installed copy older than its minimum is treated as missing and reinstalled; if the clone directory already exists it is updated first with a fast-forward-only `git pull`, and the install fails naming the directory when that update fails. Projects generated by earlier versions keep their unversioned `the-seed` line in `configure.ac`; new projects ask for `the-seed >= 0.8.0`.

### package

<!-- help: package -->

```text
Usage: the-seed package <output-directory> <project-dir>...

Package binaries with their shared library dependencies into a directory.

Arguments:
  <output-directory>  Name of the output directory to create
  <project-dir>...    Project directories containing src/Makefile.am

Options:
  -h, --help  Show this help

The command reads src/Makefile.am to determine the binary type and name, resolves installed binaries
for all build targets, finds the shared library dependencies of each, and copies everything into the
output directory.

Dependency projects are found the way "the-seed build native --recursive" finds them, from the
"dependencies" of each project's package.json: a "file:" path is taken relative to the declaring
project, and any other dependency (for example one installed from npm) is looked up in that
project's node_modules. Linux libraries are written under the name programs load them by (for
example libgreet.so.0), each with its .sig when signed. Two different files with the same name are
refused; nothing is written.
```

Behavior:

1. Validates that all directories exist (a missing one is status 2)
2. Parses src/Makefile.am for binary type (`bin_PROGRAMS` or `lib_LTLIBRARIES`)
3. Resolves compiled binaries from src/.libs/ (the build strips them with its release option and signs them when the scope has a certificate)
4. Finds dependency projects exactly as a recursive build does: `file:` paths relative to the declaring project, other names in that project's own `node_modules`, parent directories never searched, each project once by real location. A dependency cycle, two different directories with one package name, or an unreadable `package.json` stops packaging with the same message as the build
5. Analyzes shared library dependencies using the native DependencyLister addon
6. Names each Linux library by the name programs load it by (its soname, for example `libgreet.so.0`), copied as a regular file from what that name resolves to; programs and Windows files keep their names
7. Copies each file's `.sig` under the same name, from the same place
8. Copies a file reached twice with the same content once; refuses two different files for one name, naming both, and writes nothing
9. Lists the libraries needed but not packaged

The summary counts every file written, signatures included:

```text
Packaged 5 files into dist/ (2 signatures included)
Not packaged (expected on the target system):
  libc.so.6 (needed by tiny)
```

A refusal prints `Error: <message>` and exits with status 1; the output directory is not created. A collision reads:

```text
Error: Two different files would be packaged as libfoo.so.1:
  <source 1> (build of @t/a)
  <source 2> (build of @t/b)
Nothing was written.
```

Packaged output includes the dependency projects declared in `package.json` (whether `file:` paths or packages installed from npm into `node_modules`) and each Linux library under its loadable name (for example `libgreet.so.0`). It does not include `lib<name>.so` development copies or fully versioned names such as `libgreet.so.0.0.0`.

Search paths for shared library resolution include `<prefix>/<target>/lib`, `<prefix>/<target>/bin`, and MinGW cross-compiler runtime directories.

### resource-pak

<!-- help: resource-pak -->

```text
Usage: the-seed resource-pak <create|add|build>

Create a resource pak project, add resources to it and build it.

Subcommands:
  create [<scope>/<name>]
      Create a resource pak project in the current directory
  add <resource-name> <filename> [--attribute <key>=<value>]... [--force]
      Add a file to the resource pak project
  build
      Build the resource pak

add and build run in a resource pak project's directory.

Run "the-seed help resource-pak <subcommand>" for one subcommand's details.
```

`resource-pak create` prompts:

```text
? Choose scope for resource pak: @my-project
? Choose name for resource pak: my-assets
```

This creates a project directory at `<prefix>/projects/<scope>/<name>/` (not in the current directory) with a `package.json` containing a `resources` array.

`the-seed resource-pak add <resource-name> <filename>` reads `package.json` from the current directory and adds a resource entry with `name`, `filename`, and `size`. If a resource with the same name already exists, it is skipped. Give `--attribute <key>=<value>` once per attribute to record it on the resource, in the order given.

`the-seed resource-pak build` reads `package.json` from the current directory and produces a `.pak` file. The file format consists of a JSON header (containing the name, a zero-padded 10-digit header size, and resource metadata) followed by a newline and the concatenated raw resource bytes. `add` and `build` outside a resource pak project (no readable `package.json`) stop with status 2.

### signing

<!-- help: signing -->

```text
Usage: the-seed signing <create-cert|import-cert|sign|verify|cert-info|export-cert>

Create, import, use and inspect code-signing certificates.

Subcommands:
  create-cert [--scope <scope>] [--validity-days <days>] [--force]
      Generate a self-signed ECDSA P-256 certificate for a scope
  import-cert --cert <file> --key <file> [--scope <scope>] [--force]
      Import an existing PEM certificate and private key
  sign <path> [--scope <scope>] [--force] [--detached]
      Sign a binary file, or every binary file in a directory
  verify [--cert <file>]... <path>
      Check the signature of a file, or of a directory with a signing manifest
  cert-info [--scope <scope>]
      Show the details of a scope's certificate
  export-cert --output <file> [--scope <scope>]
      Write a scope's public certificate to a file

verify checks that a file is unchanged since it was signed and that its signer is one of the
certificates of your configured scopes (or of the files named with --cert). Certificate chains,
revocation, signing time and acceptance by the platform's own verifier are not checked.

sign writes standard signature containers (signed attributes, the signer's certificate). Checked
with independent tools, the signer's certificate given as the trusted root: Windows programs and
installers pass osslsigncode; each slice of a Mac program passes openssl's signed-data check over
its code directory. Not checked with the platforms' own tools (signtool, WinVerifyTrust, the Windows
Installer service, codesign, Gatekeeper), which may still refuse the certificate. Files signed by
earlier versions should be signed again.

Run "the-seed help signing <subcommand>" for one subcommand's details.
```

Signing uses ECDSA P-256 certificates, one per scope (`signing create-cert`, `signing import-cert`, `signing export-cert` and `signing cert-info` manage them), kept under `<prefix>/signing/<scope>/`.

**Choosing the scope.** `create-cert`, `import-cert`, `sign`, `cert-info` and `export-cert` take `--scope <scope>` (with or without the `@`). Without it the only configured scope is used; with several, the command asks which one when it can prompt, and otherwise stops with a usage error (status 3) that names `--scope`. A scope that is not configured, or no scopes at all, is status 2 and the message names `the-seed scopes add`. The scope is chosen before any other work, so nothing is changed when it cannot be chosen.

**Certificates.** `create-cert` generates a self-signed certificate for the scope's author; `--validity-days` is a whole number from 1 to 3650 (365 by default). `import-cert --cert <file> --key <file>` imports an existing PEM certificate and private key. `export-cert --output <file>` writes the scope's public certificate to a file, which others can name with `verify --cert`. When the scope already has a certificate, `create-cert` and `import-cert` ask before replacing it; when they cannot ask, they stop with a usage error naming `--force`. Declining is status 1. `cert-info` shows the certificate: subject, issuer, fingerprint, key type, validity, whether it is active or expired, and where it is stored.

**Embedded signatures** are automatically applied when signing PE (`.exe`, `.dll`) and Mach-O binaries and Windows installers (`.msi`). The signature is stored inside the binary itself — no separate `.sig` file is created. For all other file types, a detached `.sig` file is produced.

Embedded signatures use the standard container form: the signer record carries signed attributes (content type, message digest, and for Windows publisher information), the signature is made over them, and the signer's certificate is included. Only ECDSA P-256 keys are used; `sign` refuses any other scope key, or a key that does not match the certificate, before changing any file.

**Windows programs.** `sign` embeds an Authenticode signature in `.exe` and `.dll` files. What was checked: osslsigncode (2.14 locally; the distribution's version in the hosted check job) verifies programs signed by the-seed, including re-signed ones and certificates with long serial numbers and long names, when the signer's certificate is given as the trusted root (`osslsigncode verify -CAfile <cert.pem> -in <file>`): it finds no decoding error, computes the same fingerprint and accepts the signature. What was not checked: Microsoft's signtool, WinVerifyTrust (Windows' trust check) and running a signed program on Windows. Because the certificate is self-signed, Windows will not trust it unless it is installed as trusted on that machine.

**Mac programs.** `sign` handles 64-bit little-endian arm64 and x86-64 programs, alone or in a universal file (every slice is signed, or none). The page fingerprints are computed over the finished file, so the order is fixed: the library prepares the layout and returns the CodeDirectory of each slice, the-seed signs each one with the scope's key, and the library writes the result in one step. Signing an already signed program replaces its signature in place (the warning "Replaced existing embedded signature" is shown) and the file does not grow. When something cannot be signed the command prints the library's message, exits with status 1 and leaves the file as it was:

* No room for the signature command: `<path>: no room for the code signature command: 16 bytes needed, <n> available ...; relink with extra header space (for example -headerpad 0x20)`.
* Big-endian or 32-bit programs, or a universal file with such a slice: `<path>: <kind> Mac programs are not supported (supported: 64-bit little-endian arm64 and x86-64, alone or in a universal file)`.
* Data after the existing signature: the file is refused.

`verify` recomputes every page fingerprint of every slice and the special slots, checks the signature over the code directory, reports each slice, and reports partly signed or unsupported programs as not valid.

What was checked: page fingerprints in a signature produced by this library match the finished file (an independent checker and values recorded from Python's hashlib); the checker accepts the ad-hoc signature written by ld64.lld, a different producer; the structure of signed files parses with llvm-otool, llvm-objdump and llvm-lipo.

What was checked: each slice's signature container is in the standard form (signed attributes with the content type and the message digest of the code directory, signature over them, signer certificate included) and passes openssl's signed-data check (`openssl cms -verify -binary -content <code directory> -CAfile <cert.pem> -purpose any`); the tests' independent checker recomputes every page fingerprint. What was not checked: codesign, Gatekeeper and running a signed program on a Mac, because no Mac is part of the test setup; Apple's tools may still refuse the program, at least for its certificate. Programs signed by earlier versions of the-seed are malformed after re-signing and may need to be rebuilt from their unsigned originals: rebuild from the unsigned original, then sign again.

The Mac signature container's signature length uses the DER length encoding, so signatures of 128 bytes or more are well formed. The addon's Mac exports are listed in [structure.md](structure.md).

**Windows installers.** `sign` embeds the signature of a `.msi` package into its `\x05DigitalSignature` stream. The package fingerprint is computed by libthe-seed by the rule osslsigncode uses, the signature is written, and the command then reads it back from the finished file: success is reported only when the stored fingerprint equals the package's. A signature whose fingerprint does not belong to the package is refused and the file is left as it was. Signing an already signed installer replaces its signature (the warning "Replaced existing embedded signature" is shown); a stale extended signature stream is dropped. `verify` reports no signature as `NOT_FOUND`, a signature whose fingerprint differs from the package as `INVALID` ("the file was changed after signing: its fingerprint differs from the one in the signature"), a signature that cannot be read as `INVALID` ("signature present but could not be read (<detail>)"), and otherwise checks the signature and compares its signer with your trusted certificates (see Verification). An extended signature stream is "present, not checked".

What is not checked: certificate chains and revocation. Installers signed by the-seed pass osslsigncode's verification when the signer's certificate is given as the trusted root.

What was and was not verified: the fingerprint and the package structure written by libthe-seed were compared with osslsigncode 2.14, with an independent reader written for the tests, and (for stream lookup by name) with Wine 10's structured-storage implementation. The complete signature (fingerprint, signed attributes and signature) was verified with osslsigncode as above. They were not checked with Microsoft's signtool, WinVerifyTrust, the Windows Installer service or Microsoft's own storage code, because no Windows machine is part of the test setup. Installers signed by earlier versions of the-seed may be damaged; re-sign them from the unsigned original when you have it. (Re-signing the signed file in place repairs the signature itself but cannot restore other damage an earlier version may have caused.)

**Files signed by earlier versions.** Earlier versions of the-seed wrote signature containers without signed attributes and, for about half of all certificates, with a signer serial number other tools cannot match. osslsigncode and Windows reject such Windows programs and installers, and Apple's tools are not known to accept such Mac programs. `verify` still checks them and adds the notice "The signature is in the earlier form written by the-seed…". Sign each such file again with `the-seed signing sign <file>`: the old signature is replaced and the result is in the current form. (For installers and Mac programs damaged by older versions, the advice above about starting from the unsigned original still applies.)

Use `--detached` to force detached signatures even for PE and Mach-O files:

```bash
# Embedded (default for PE/Mach-O)
the-seed signing sign myapp.exe

# Detached (forced)
the-seed signing sign --detached myapp.exe

# Detached (default for non-binary files)
the-seed signing sign config.json
```

**Builds sign automatically.** `the-seed build` signs the programs and libraries it installs with the project's scope certificate; see [What is installed, stripped and signed](#what-is-installed-stripped-and-signed). `verify` works on installed files and on any of a library's link names.

**Verification** checks two things about a file: integrity (the file is unchanged since it was signed) and trust (the signer is one of your trusted certificates).

A file signed by a certificate that is not one of your scopes' certificates is reported as intact but not trusted, with exit status 4. Name the signer's exported certificate with `--cert` to trust it.

```bash
the-seed signing verify myapp.exe                       # embedded signature
the-seed signing verify config.json                     # detached .sig file
the-seed signing verify --cert alice.pem myapp.exe      # trust the certificate in alice.pem
```

What is checked, by form:

* **Detached** (`<file>.sig`): the ECDSA signature over the file with the certificate stored in the `.sig` file.
* **Windows program**: the fingerprint in the embedded Authenticode signature against the file, and the signature with the signer's key.
* **Installer** (`.msi`): the fingerprint in the `\x05DigitalSignature` stream against the package, and the signature with the signer's key.
* **Mac program**: every page fingerprint of every slice and the special slots, and the signature over the code directory, with a line for each slice.

When a file has both an embedded and a detached signature, both are checked and the worse result is the headline. A Mac program or installer that is recognised but whose structure cannot be read, for example one cut short inside its signature, is `INVALID` with the reason the native component gives, not `NOT_FOUND`.

**Trusted certificates.** By default the trusted certificates are the certificates of your configured scopes. `--cert <file>` (PEM with one or more certificates, or DER; may be repeated) replaces them with the certificates in the named files. A signer is trusted when its SHA-256 fingerprint equals that of a trusted certificate. Without any trusted certificate nothing is trusted, and the report says to create one with `the-seed signing create-cert` or to name one with `--cert`.

| Status | Meaning | Exit status |
|--------|---------|-------------|
| `VALID` | intact and signed by a trusted certificate | 0 |
| `UNTRUSTED` | intact, but the signer is not trusted (or there is no signer) | 4 |
| `INVALID` | the file or signature does not check out | 1 |
| `NOT_FULLY_SIGNED` | some slices of a Mac program are unsigned | 1 |
| `NOT_CHECKED` | a signature is present but this version cannot check it | 1 |
| `NOT_FOUND` | no signature | 1 |

Exit status 2 means the path, a `--cert` file or the directory's manifest was not found; 3 means a usage error, a malformed manifest, or a `.sig` file or `.signatures.json` given instead of the file or directory.

**Expiry.** A signer certificate that is expired (or not yet valid) produces a warning, not a failure: the signing time is not established because timestamps are not checked.

**Not checked.** Every report ends with `Not checked: certificate chains, revocation, signing time, acceptance by the platform's own verifier`, followed by anything file-specific.

**Signatures made by other tools.** The standard signed-attribute form of a CMS signature is read. A form this version cannot read is reported as `NOT_CHECKED` with the reason, never as valid.

**Directory signing** produces a `.signatures.json` manifest (version 2 format) with one entry per signed binary:

```bash
the-seed signing sign ./dist
the-seed signing verify ./dist
```

Manifest version 2 example:

```json
{
  "version": 2,
  "signedAt": "2026-10-18T12:00:00.000Z",
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "certificateFingerprint": "SHA256:...",
  "files": [
    { "path": "myapp.exe", "signatureFile": null, "algorithm": "SHA256", "signature": "...", "signatureType": "embedded" },
    { "path": "lib/libx.so", "signatureFile": "lib/libx.so.sig", "algorithm": "SHA256", "signature": "...", "signatureType": "detached" }
  ],
  "skipped": ["README.txt"]
}
```

`skipped` lists files that were judged not to be binaries and left unsigned. Directory verification checks that the manifest's certificate is trusted and matches the fingerprint the manifest records, that each file's signer equals it, the recorded fingerprint for embedded entries, that every listed file is present and valid, that files not in the manifest fail (links inside the directory that point to listed files are reported, not failed; skipped files are reported as present but not signed, with contents not checked), and that the result is the worst of these. A listed file whose detached signature file is gone is reported as missing, naming the signature file. The command prints `Result: PASS` (exit status 0), `Result: NOT TRUSTED` (4: nothing failed but the manifest's certificate is not trusted) or `Result: FAIL` (1), with the number of files in each outcome. Manifests written by earlier versions (version 1) still verify and are reported as the earlier format.

A path that does not exist is status 2 for `sign` and `verify`. Signing a file that is not a binary (without a detached signature being possible), a read-only file, or a directory with no binary files is status 1, and an expired certificate stops `sign` with status 2 unless `--force` is given.

### installer

<!-- help: installer -->

```text
Usage: the-seed installer <windows>

Build a Windows installer for the project.

Subcommands:
  windows [--scope <scope>]
      Build a Windows installer (.msi) from the project's build output

The project must have been built with "the-seed build windows" first.

Run "the-seed help installer <subcommand>" for one subcommand's details.
```

**Prerequisites**: `wixl` must be installed (`sudo apt install wixl`).

**Usage**:

```bash
# Cross-compile your project for Windows first
the-seed build windows

# Package binaries into dist/
the-seed package dist .

# Generate the MSI installer
the-seed installer windows
```

**Output files** (in the project directory, named from the package name and version):

- `<name>-<version>.wxs`, the WiX XML source (kept for inspection), for example `hello-1.0.0.wxs`
- `<name>-<version>.msi`, the Windows Installer package, for example `hello-1.0.0.msi`

If `dist/` does not exist, the package step creates it in the project directory before the installer is generated; if packaging refuses (for example a name collision), no installer is built. The installer installs files to `C:\Program Files\<name>\` on Windows and uses a deterministic `UpgradeCode` derived from the project name for seamless major-upgrade behavior.

`installer windows` signs the installer with the scope's certificate, chosen as for `signing` (`--scope`, the only scope, or a prompt). With no scopes, or no certificate for the scope, the installer is still generated unsigned and the command says so, with the command to run. An unknown `--scope` stops before anything is generated (status 2).

**Installer metadata.** The package's `package.json` supplies the product name (the package name), the manufacturer (the author's name) and the version. Before anything is written, the command checks them and stops with status 2 and a message naming the value when:

- the product name contains a character a Windows folder name cannot contain (`<`, `>`, `:`, `"`, `/`, `\\`, `|`, `?`, `*`), ends in a space or a dot, or is a reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension);
- a value holds a character XML cannot carry (a control character other than tab, line feed and carriage return);
- the version is not a valid `MAJOR.MINOR.PATCH`, optionally with `-prerelease` or `+build`, or a number is above the installer limits (major and minor 255, patch 65535).

Names, the manufacturer and file names are escaped, so `Smith & Jones <sales@example.com>` or a file named `ü&'q.txt` is written exactly. Every file and component gets an identifier made from its name and a hash of it, so `a-b.dll` and `a_b.dll` stay separate. The installer version has three numbers; a prerelease or build suffix is dropped with a message (`Installer version 2.1.0 (from 2.1.0-beta.3; installer versions hold three numbers, so the prerelease suffix is dropped).`), and the file names carry the full package version.

Recorded limits: values are written to the description exactly, but how Windows shows characters outside Windows-1252 in the installed program's name depends on `wixl`, which stores those characters as UTF-8 bytes and others as Windows-1252, and is not checked without a Windows host. Two prerelease builds of one release get the same installer version, so installing a newer prerelease over an older one of the same release is not an upgrade; remove the older one first. A missing `wixl` or native component is status 2; a packaging or compilation failure is status 1.

### help

<!-- help: help -->

```text
Usage: the-seed help [<command> [<subcommand>]]

Show help for the tool, a command or a subcommand.
```

`the-seed help` with no argument prints the top-level help shown at the start of this reference.

## API Reference

Everything below is exported from `@metaverse-systems/the-seed`, except `ConfigError`, `walkDependencies` and `NativeComponent`'s loader functions, which are imported from their modules under `dist/`. The tables list every public member of a class with its parameters (`?` marks an optional one); the README check compares them with the source.

### Classes

#### Config

Manages the-seed configuration file.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(configDir?)` | | `configDir` is the directory that holds the file (default `~/the-seed`) |
| `configDir` | `string` | Path to the configuration directory |
| `configFile` | `string` | Configuration filename (`config.json`) |
| `configPath` | `string` | Full path of the configuration file |
| `config` | `ConfigType` | The loaded configuration object |
| `loadConfig()` | `void` | Load configuration from disk. Creates the directory and a default file when missing, fills missing entries in memory, and throws `ConfigError` for a malformed file |
| `saveConfig()` | `void` | Write the configuration to disk atomically (creating the directory if needed); throws `ConfigError` when it cannot |
| `getQuestions()` | `object[]` | Return inquirer prompt questions for configuration |
| `parseAnswers(answers)` | `void` | Apply prompt answers (`{ prefix: string }`) to the configuration |

`ConfigError` is a named export of the `Config` module (`import Config, { ConfigError } from "@metaverse-systems/the-seed/dist/Config"`). It extends `Error`; `path` is the configuration file the problem concerns and `message` is one line naming the file and the entry or cause. The command line reports it with status 2.

#### Scopes

Manages project scopes within the configuration. `validateScopeName(name)` returns the reason a new scope name is refused, or `null`; `createOrEditScope` throws `ScopeNameError` (its message is the reason) for a new scope with a refused name.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(config)` | | `config` is the `Config` to read and write scopes from |
| `config` | `Config` | The Config instance |
| `askWhichScope()` | `object[]` | Return the inquirer prompt to select an existing scope |
| `askNewScope()` | `object[]` | Return the inquirer prompts for creating a new scope; the name prompt validates the name |
| `askEditScope(defaults?)` | `object[]` | Return the inquirer prompts for editing a scope |
| `createOrEditScope(answers)` | `void` | Save a scope from prompt answers (`ScopeAnswersType`) |
| `deleteScope(scope)` | `void` | Remove a scope from the configuration |
| `getScopes()` | `string[]` | Return the scope names |
| `getScope(scope)` | `ScopeType` | Return a scope by name |
| `getQuestions(defaults)` | `object[]` | Return the inquirer prompts with optional defaults |

#### Package

Resolves project binaries and their shared library dependencies for packaging.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(config)` | | `config` supplies the prefix and target paths |
| `config` | `Config` | The Config instance |
| `getSearchPaths()` | `string[]` | Return library search paths for the current target |
| `parseMakefileAm(projectDir)` | `{ type: "program" \| "library"; name: string } \| null` | Parse the project's src/Makefile.am for binary type and name |
| `resolveBinaryPaths(projectDir)` | `string[]` | Resolve compiled binary paths from src/.libs/; a native library is the real file behind `<name>.so`, which packaging writes under its soname |
| `resolveDependencies(binaryPaths, searchPaths)` | `DependencyResultType` | Analyze shared library dependencies using the native component |
| `plan(projectDirs)` | `Promise<PackagePlan>` | Decide what packaging would write, naming each file, its source, its signature and its origin, without writing anything; a refusal is `{ ok: false, message }` |
| `run(outputDir, projectDirs)` | `Promise<PackageResult>` | Execute the full packaging workflow; a refusal or failure is printed, writes nothing and resolves `success: false` |

#### Build

Builds a project with autotools, installs, strips and signs what it installed.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(config)` | | `config` supplies the prefix |
| `config` | `Config` | The Config instance |
| `buildProject(options)` | `Promise<ProjectBuildResult>` | Build the project in `options` (target, release, jobs and the stop signals) and run the install phase; the recursive build is `buildRecursive` in the `RecursiveBuild` module |
| `getSteps(target, fullReconfigure, jobs?, inherited?)` | `BuildStep[]` | The steps a build would run, without running them |
| `getInstallPrefix(target?)` | `string` | The directory a target installs into (`<prefix>/x86_64-linux-gnu` or `<prefix>/x86_64-w64-mingw32`) |

#### Installer

Builds a Windows installer from a project's `dist/` directory.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(config)` | | `config` supplies the prefix |
| `config` | `Config` | The Config instance |
| `checkWixl()` | `boolean` | True when `wixl` is installed |
| `readProjectMetadata(projectDir)` | `ProjectMetadataResult` | Read and check the product name, manufacturer and version; `{ ok: false, message, status: 2 }` when one is refused |
| `ensureDist(projectDir)` | `Promise<boolean>` | Create `dist/` by packaging when it does not exist; false when packaging was refused |
| `generateWxs(projectDir, config, files)` | `string` | The WiX description for the given files, every value escaped |
| `compileMsi(projectDir, wxsPath, outputPath)` | `boolean` | Compile the description with `wixl` |
| `run(projectDir)` | `Promise<InstallerRunResult>` | The whole workflow: `{ ok: true, msiPath }`, or `{ ok: false, status, message }` where `status` is 2 for something missing or unusable and 1 for a packaging or compilation failure; the message has been printed |

`InstallerMetadataError` (thrown by the metadata functions, whose message names the value) extends `Error`.

#### Signing

Sign and verify files using ECDSA P-256 certificates with support for embedded (PE Authenticode, Mach-O code signatures, installer) and detached signatures. Failures are `SigningError`s whose `code` is a `SigningErrorCode`; `DEFAULT_VALIDITY_DAYS` (365) and `MAX_VALIDITY_DAYS` (3650) bound the validity of a new certificate.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(configDir?)` | | `configDir` is the configuration directory (default `~/the-seed`) |
| `configDir` | `string` | The configuration directory |
| `signingDir` | `string` | The directory that holds the certificates, one per scope |
| `scopeCertPath(scope)` | `string` | Path of the scope's certificate |
| `scopeKeyPath(scope)` | `string` | Path of the scope's private key |
| `getScopes()` | `string[]` | The configured scope names |
| `createCert(options?)` | `Promise<CertInfo>` | Create a signing certificate for a scope; an invalid `validityDays` throws `SigningError("invalid-validity")` |
| `importCert(certInputPath, keyInputPath, scope?)` | `Promise<CertInfo>` | Import a PEM certificate and private key |
| `exportCert(outputPath, scope?)` | `Promise<void>` | Write the scope's public certificate to a file |
| `hasCert(scope?)` | `boolean` | Check if a certificate exists |
| `getCertInfo(scope)` | `CertInfo \| null` | Return certificate details |
| `loadSigningKey(scope)` | `crypto.KeyObject` | Load and check the scope's private key (ECDSA P-256 matching the certificate); throws `UnsupportedSigningKey` before any file is changed |
| `isBinaryFile(filePath)` | `Promise<boolean>` | True when the file is a binary the tool signs |
| `detectBinaryFormat(filePath)` | `FormatDetectionResult` | Detect PE, Mach-O, installer or other format via magic bytes |
| `removeEmbeddedSignature(filePath)` | `boolean` | Remove an embedded signature; true when something was removed |
| `getSigningStrategy(filePath, options?)` | `SignatureType` | Return "embedded" or "detached" for a file |
| `signFile(filePath, options?)` | `Promise<SignResult>` | Sign a file (auto-detects format) |
| `signFileAuthenticode(filePath, scope, key?)` | `Promise<SignResult>` | Embed an Authenticode signature in a PE binary; the optional `key` replaces the scope's key |
| `signFileMsi(filePath, scope, key?)` | `Promise<SignResult>` | Embed a signature in a Windows installer; the optional `key` replaces the scope's key |
| `signFileMachO(filePath, scope, key?)` | `Promise<SignResult>` | Embed a code signature in a Mach-O binary (prepare, sign each CodeDirectory, complete); the optional `key` replaces the scope's key |
| `signDirectory(dirPath, options?)` | `Promise<DirectorySignResult>` | Sign all files and produce a version 2 manifest |
| `loadTrust(certificatePaths?)` | `TrustedCertificates` | The certificates signatures are trusted against: the configured scopes' certificates, or those in the given files |
| `verifyFile(filePath, options?)` | `Promise<VerifyResult>` | Verify a file: integrity and trust of the embedded and detached signatures |
| `verifyFileAuthenticode(filePath, options?)` | `Promise<VerifyResult>` | Verify an embedded Authenticode signature |
| `verifyFileMachO(filePath, options?)` | `Promise<VerifyResult>` | Verify an embedded Mach-O code signature |
| `verifyFileMsi(filePath, options?)` | `Promise<VerifyResult>` | Verify an embedded installer signature |
| `verifyDirectory(dirPath, options?)` | `Promise<DirectoryVerifyResult>` | Verify a directory against its signing manifest: integrity, trust and unlisted files |

#### SigningError

| Member | Type | Description |
|--------|------|-------------|
| `code` | `SigningErrorCode` | What went wrong; the command line maps it to an exit status |
| `hint` | `string` | The command to run next, when there is one |

`UnsupportedSigningKey` is a `SigningError` (code `unsupported-key`).

#### ProjectError

Raised when a project or a resource cannot be created or changed.

| Member | Type | Description |
|--------|------|-------------|
| `code` | `ProjectErrorCode` | What went wrong: `invalid-name`, `unknown-scope`, `author-name-missing`, `author-detail-unusable`, `target-exists`, `not-pak-project`, `resource-file-missing`, `duplicate-resource`, `resource-changed` or `write-failed`; the command line maps it to an exit status |
| `hint` | `string` | What to do about it, when there is something to do |

#### NativeComponentMissingError

Thrown when the native component is absent or does not load. Its message names the step that builds it (`cd "<package directory>" && npm run build-addon`) and, when the component exists but cannot be loaded, ends with the first line of the loading error. `nativeComponentMessage(loadError?)` returns the same text.

| Member | Type | Description |
|--------|------|-------------|
| `loadError` | `string \| null` | The first line of the loading error, or `null` |

Where it is thrown:

- `Signing.signFile`, `signFileAuthenticode`, `signFileMsi`, `signFileMachO` and `signDirectory`: the file announces a Windows program, Mac program or installer, and no detached signature is asked for (nothing is written).
- `Signing.detectBinaryFormat`: the first bytes announce one of those forms.
- `Build.buildProject` and `buildRecursive`: the target is `windows`, plain or release, before any step; an incremental build is stopped by the install phase instead.
- `Package.resolveDependencies`: always, without the component; `plan` and `run` refuse with the message instead of throwing.

`Installer.run` prints the message and resolves `{ ok: false, status: 2, message }`. `Signing.verifyFile` does not throw: an embedded signature is reported as not checked, with the message as the reason.

#### Dependency discovery

`walkDependencies(projectDir, options?)` (from `@metaverse-systems/the-seed/dist/DependencyWalker`) resolves the `DependencyGraph` of a project by the rule in [Recursive Builds](#recursive-builds). `options.signal` is an `AbortSignal`; aborting it rejects with `DiscoveryCancelledError`. It rejects with one of these error classes, all exported from the package:

| Class | Raised when |
|-------|-------------|
| `DependencyDiscoveryError` | Base class of the three below |
| `CyclicDependencyError` | Projects depend on each other, or a project on itself (`cycleParticipants`, `chain`, `locations`) |
| `ConflictingProjectError` | Two different directories carry one package name (`packageName`, `locations`) |
| `ProjectManifestError` | A `package.json` cannot be read or parsed (`manifestPath`, `reason`) |
| `DiscoveryCancelledError` | The signal was aborted; not a `DependencyDiscoveryError` |

`readElfNames(filePath)` returns `{ soname, needed }` for an ELF file, `null` for any other file, and throws for a malformed ELF file.

### Types

The declarations of every exported type, as the compiler prints them:

<!-- api-types -->

```text
type SignedContent = {
    kind: "windows-program";
    fingerprint: Buffer;
} | {
    kind: "installer";
    fingerprint: Buffer;
} | {
    kind: "mac-program";
    codeDirectory: Buffer;
};

type SigningErrorCode = "scope-required" | "unknown-scope" | "author-name-missing" | "certificate-missing" | "certificate-expired" | "certificate-unreadable" | "key-mismatch" | "unsupported-key" | "invalid-validity" | "path-not-found" | "not-binary" | "read-only" | "no-binaries" | "manifest-missing" | "manifest-malformed" | "wrong-target" | "signing-failed";

type InstallerRunResult = {
    ok: true;
    msiPath: string;
} | {
    ok: false;
    status: 1 | 2;
    message: string;
};

type ElfNames = {
    soname: string | null;
    needed: string[];
};

interface InstallerConfig {
    productName: string;
    version: string;
    packageVersion: string;
    manufacturer: string;
    upgradeCode: string;
}

interface AuthorType {
    name: string;
    email: string;
    url: string;
}

interface ConfigType {
    prefix: string;
    scopes: ScopesType;
    [key: string]: unknown;
}

interface ScopeType {
    author: AuthorType;
}

interface ScopesType {
    [index: string]: ScopeType;
}

interface ScopeAnswersType {
    scopeName: string;
    authorName: string;
    authorEmail: string;
    authorURL: string;
}

interface ScopeDefaultsType {
    name?: string;
    email?: string;
    url?: string;
}

interface ResourceType {
    name: string;
    filename: string;
    size: number;
    attributes?: {
        [key: string]: string;
    };
}

interface PackageType {
    name: string;
    version: string;
    description?: string;
    author: PackageAuthorType;
    license: string;
    scripts: {
        [index: string]: string;
    };
    resources?: ResourceType[];
}

interface PakProjectType extends PackageType {
    resources: ResourceType[];
}

interface PackageAuthorType {
    name: string;
    email?: string;
    url?: string;
}

interface DependencyResultType {
    dependencies: Record<string, string[]>;
    errors: Record<string, string>;
    libraryErrors?: Record<string, {
        reason: string;
        inputs: string[];
    }>;
}

interface BuildStep {
    label: string;
    program: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    ignoreExitCode?: boolean;
}

interface CertSubject {
    commonName: string;
    email?: string;
    organization?: string;
}

interface CertOptions {
    validityDays?: number;
    scope?: string;
}

interface CertInfo {
    subject: CertSubject;
    issuer: string;
    fingerprint: string;
    keyType: string;
    notBefore: Date;
    notAfter: Date;
    isExpired: boolean;
    isNotYetValid: boolean;
    certPath: string;
}

interface SignResult {
    filePath: string;
    signaturePath: string | null;
    fingerprint: string;
    signatureType: SignatureType;
    warnings: string[];
}

interface DirectorySignResult {
    manifestPath: string;
    signed: SignResult[];
    skipped: string[];
}

type VerifyStatus = "VALID" | "UNTRUSTED" | "INVALID" | "NOT_FULLY_SIGNED" | "NOT_CHECKED" | "NOT_FOUND";

interface VerifyResult {
    filePath: string;
    status: VerifyStatus;
    reason?: string;
    form?: SignatureForm;
    signatureType?: SignatureType;
    integrity: IntegrityResult;
    trust: TrustResult;
    signer?: CertInfo;
    slices?: MachOSliceResult[];
    signatures?: VerifyResult[];
    warnings: string[];
    notChecked: string[];
}

interface DirectoryVerifyResult {
    directory: string;
    manifest: {
        path: string;
        version: 1 | 2;
        earlierFormat: boolean;
        signedAt: string;
        certificate: CertInfo;
        recordedFingerprint: string;
        fingerprintConsistent: boolean;
        trust: TrustResult;
    };
    results: DirectoryFileResult[];
    unlisted: Array<{
        relativePath: string;
        kind: "file" | "link" | "other";
        reason: string;
    }>;
    skipped: Array<{
        relativePath: string;
        present: boolean;
    }>;
    links: Array<{
        relativePath: string;
        target: string;
    }>;
    counts: {
        valid: number;
        untrusted: number;
        invalid: number;
        notFullySigned: number;
        notChecked: number;
        missing: number;
        unlisted: number;
        skipped: number;
    };
    status: VerifyStatus;
    warnings: string[];
    notChecked: string[];
}

interface DirectoryFileResult extends VerifyResult {
    relativePath: string;
    signerMatchesManifest: boolean | null;
    recordedValueMatches: boolean | null;
}

interface SigFileFormat {
    version: 1;
    algorithm: "SHA256";
    curve: "P-256";
    signature: string;
    certificate: string;
}

interface SigningManifestFormat {
    version: 1 | 2;
    signedAt: string;
    certificate: string;
    certificateFingerprint: string;
    files: SigningManifestEntry[];
    skipped?: string[];
}

interface SigningManifestEntry {
    path: string;
    signatureFile: string | null;
    algorithm: "SHA256";
    signature: string;
    signatureType?: SignatureType;
}

type SignatureForm = "detached" | "windows-program" | "installer" | "mac-program";

type IntegrityState = "intact" | "invalid" | "not-checked" | "none";

interface IntegrityResult {
    state: IntegrityState;
    reason?: string;
    checked: string[];
    unsignedOnly?: string[];
}

type TrustAnchor = {
    source: "scope";
    scope: string;
    fingerprint: string;
    certPath: string;
} | {
    source: "supplied";
    path: string;
    fingerprint: string;
};

interface TrustedCertificates {
    source: "scopes" | "supplied";
    anchors: TrustAnchor[];
    warnings: string[];
}

type TrustState = "trusted" | "untrusted" | "not-applicable";

type UntrustedReason = "unknown-signer" | "no-signer" | "no-trusted-certificates";

interface TrustResult {
    state: TrustState;
    anchor?: TrustAnchor;
    reason?: UntrustedReason;
    message?: string;
}

interface MachOSliceResult {
    arch: string;
    cpuType: number;
    offset: number;
    size: number;
    state: "intact" | "invalid" | "unsigned" | "not-checked";
    reason?: string;
    codeDirectories: Array<{
        slot: number;
        hashType: "sha1" | "sha256" | "sha384";
        pages: number;
        pagesMismatched: number;
        codeLimit: number;
    }>;
    adHoc: boolean;
    signerFingerprint?: string;
}

interface VerifyOptions {
    trust?: TrustedCertificates;
}

interface PlannedFile {
    name: string;
    source: string;
    sha256: string;
    signature: string | null;
    origin: {
        kind: "project";
        project: string;
        location: string;
    } | {
        kind: "search-path";
        directory: string;
    };
}

interface UnpackagedLibrary {
    name: string;
    neededBy: string;
}

type PackagePlan = {
    ok: true;
    projects: string[];
    files: PlannedFile[];
    notPackaged: UnpackagedLibrary[];
} | {
    ok: false;
    message: string;
};

interface PackageResult {
    success: boolean;
    message: string | null;
    outputDir: string;
    projects: string[];
    files: string[];
    signatures: number;
    fileCount: number;
    notPackaged: UnpackagedLibrary[];
}

type SignatureType = "embedded" | "detached";

type BinaryFormat = "pe" | "macho" | "msi" | "other";

interface FormatDetectionResult {
    format: BinaryFormat;
    subFormat: "pe32" | "pe32+" | "macho32" | "macho64" | "fat" | null;
}

interface SignOptions {
    force?: boolean;
    scope?: string;
    detached?: boolean;
}
```

### Import Example

<!-- api-example -->

```typescript
import { Config, Scopes, Package, Signing, SigningError, validateScopeName } from "@metaverse-systems/the-seed";
import type { SignResult, VerifyResult } from "@metaverse-systems/the-seed";

async function main(): Promise<void> {
  // Initialize configuration
  const config = new Config();

  // List all scopes and check a name before adding one
  const scopes = new Scopes(config);
  console.log(scopes.getScopes());
  console.log(validateScopeName("my project")); // "A scope name cannot contain spaces or other whitespace."

  // Package a project
  const pkg = new Package(config);
  const packaged = await pkg.run("./output", ["./my-project"]);
  console.log(packaged.success, packaged.fileCount);

  // Sign a binary (embedded for Windows and Mac programs and installers, detached for others)
  const signing = new Signing();
  try {
    const signed: SignResult = await signing.signFile("./dist/myapp.exe", { scope: "@my-project" });
    console.log(signed.signatureType); // "embedded"
  } catch (error) {
    if (error instanceof SigningError) console.log(error.code, error.hint);
    else throw error;
  }

  // Verify a signed file
  const verify: VerifyResult = await signing.verifyFile("./dist/myapp.exe");
  console.log(verify.status, verify.integrity.state, verify.trust.state); // "VALID" "intact" "trusted"
}

main();
```

## Running the checks

### Prerequisites

- libthe-seed (0.8.0 or later) and libecs-cpp (2.1.0 or later), in the configured prefix (what `the-seed dependencies install` makes) or reachable by `pkg-config`. The native component's build finds the prefix by itself, so `PKG_CONFIG_PATH` is not needed for it.

- `openssl` (one signing test generates a certificate with it).
- Optional: `python3`. The independent Mach-O cross-check in `test/Signing.embedded.test.ts` runs `../libthe-seed/tests/fixtures/check_pages.py` when the parent repository is present. Without it the case prints a `SKIPPED CHECK:` line and carries on, unless `THE_SEED_REQUIRE_TOOLS=1` is set, in which case a missing tool fails the case.

### Build and run

```bash
npm ci                  # compiles the tool and builds the native component
npm run build-addon     # optional: the strict gate, which fails when the component cannot be built
npm test                # typecheck, then lint, then unit
```

`npm test` runs three stages in order and ends with a line such as `Summary: typecheck PASS, lint PASS, unit PASS`. It exits non-zero if any stage fails, and a failing stage does not stop the later ones from running. Run one stage, or a subset of the tests:

```bash
npm run typecheck                       # tsc over src/ and test/
npm run lint                            # ESLint over src/ and test/
npm test -- unit                        # Jest only (at most 4 workers)
npm test -- unit -t "verifyFileAuthenticode"
npm test -- unit test/Signing.test.ts
```

Failures are named as `FAILED: <file> › <case>` or `FAILED GROUP: <file>: <message>` (a test file that could not run, or whose hook failed), and the run ends with a `Totals:` line. Skipped cases are reported and counted.

### Install check

```bash
npm test -- install
```

This fourth stage is not part of a plain `npm test`. It packs the package, installs the tarball into a scratch global prefix with a scratch home and checks the result: with libthe-seed in the prefix, signing a Windows program works; with no library, the installation still succeeds, says the native component was not built, and signing a Windows program stops with the one message; and, on a clean working tree, installing from git works. Everything it writes goes to a scratch directory under the system temporary directory, which it removes afterwards, and it reports `REAL HOME CHANGED:` if your `~/the-seed` differs. The first run needs the network (dependencies and the Node headers); later runs use the npm and node-gyp caches. A case it cannot run prints `SKIPPED CHECK:`, which fails the run when `THE_SEED_REQUIRE_TOOLS=1` is set.

`npm pack` (and so the install check) briefly empties `dist/` and compiles it again; run `npm run build` if it is interrupted.

### Known gaps

No entries remain; the list is `[]`. A case that fails today because of a problem recorded in `docs/reviews/the-seed-1.md` is listed in `test/known-gaps.json` and marked in its test file with `itKnownGap`. It is reported as `KNOWN GAP:` and does not fail the run. The task that fixes the problem must remove both the marker and the entry: a marked case that now passes is reported as `STALE KNOWN GAP:` and fails the run, and an entry that is malformed or does not match the review and the roadmap in the parent repository is reported as `MALFORMED KNOWN GAP:` and fails the run.

### Isolation

`npm test` runs Jest with `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `TMPDIR`, `TMP` and `TEMP` pointing into a fresh scratch directory, so the tests never read or write your real `~/the-seed`. It also sets `NODE_DISABLE_COMPILE_CACHE=1` so that Node processes started by tests do not write a module compile cache into the scratch area. The runner prints `LEFTOVER:` for any file a test leaves in the scratch area, removes the area afterwards, and prints `REAL HOME CHANGED:` if your real `~/the-seed` differs after the run. Both fail the run. Run the tests through `npm test`, not by calling `jest` directly, so that this protection applies.

### The README and hint checks

`test/Readme.test.ts` keeps this README in agreement with the tool: the help screens quoted after the `<!-- help -->` markers, the exit-status table, the generated type declarations, the class tables, the import example, the `the-seed` lines in shell blocks, every command and option, and the repository paths named in this file and in structure.md. `test/Hints.test.ts` parses every `the-seed` command line the tool prints in a hint. Both run in the `unit` stage of `npm test`.

The help text lives in `src/cli/Commands.ts`. After changing it (or an exported type or class), the README check fails and writes `test-results/README.expected.md`: the README with every generated block replaced. Compare it with README.md, copy the changed blocks over and update the hand-written text that no longer fits. The unit stage then ends with the line `README out of date: compare README.md with test-results/README.expected.md`. The file is in `test-results/`, which git ignores.

### Hosted check

Every proposal to `main` and every push to `main` runs the `check` job in `.github/workflows/ci.yaml` with read-only repository permissions. It builds the tool and the addon against libecs-cpp and libthe-seed at fixed commits (libecs-cpp `16a272ce17bf03369febf0796444a8df8cd1ffec`, libthe-seed `839bc62d3233e88347059942ce25e84da23b48ee`), then runs the type check, the style check and the tests with `THE_SEED_REQUIRE_TOOLS=1`. The commits are set in the `env` block at the top of the workflow; change them there when the tool needs newer libraries. A manual run (Actions, CI, Run workflow) accepts `repeat` to run the tests several times in a row.

### Notes

- Signature containers are built by `src/CmsBuilder.ts` with `@peculiar/asn1-cms` (the family `@peculiar/x509` already uses) and read by `src/CmsReader.ts` with the same library.
- The style check disables `@typescript-eslint/no-var-requires` on five lines (`src/Package.ts`, `src/Signing.ts`, `test/Package.test.ts`, `test/Signing.embedded.test.ts`, `test/TestInfrastructure.test.ts`), each with a reason: the native addon has no type declarations, or a module must be loaded again after Jest resets its registry. No rule is disabled in the ESLint configuration.
- The build tests (`Build`, `BuildCLI`, `RecursiveBuild`) are mock-based: they check which commands would run. `test/BuildEndToEnd.test.ts` goes further and builds and installs a real autotools project into a temporary prefix, including the native and Windows strip-and-sign cases (the Windows ones need mingw-w64 and report `SKIPPED CHECK:` when it is absent); without autotools, `git`, `file` or the mingw-w64 compiler its cases report `SKIPPED CHECK:` and carry on, unless `THE_SEED_REQUIRE_TOOLS=1` is set.

The source and test layout is described in [structure.md](structure.md).

## License

MIT — see [LICENSE](LICENSE).

## Author

Tim Schwartz <tim@metaverse.systems>
