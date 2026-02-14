# Feature Specification: Package Command

**Feature Branch**: `002-package-command`  
**Created**: 2025-02-13  
**Status**: Draft  
**Input**: User description: "Add a package command. The first argument should be a directory name, the rest will be files to include. Use the DependencyLister class from libthe-seed with the listed files to find all dependencies. Then create the directory with the specified name and copy the files to it."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Package Binaries with Shared Library Dependencies (Priority: P1)

A developer has built executables and/or shared libraries for their project and wants to bundle them into a self-contained directory along with all required shared library dependencies. They run `the-seed package my-release myapp.exe libgame.so` and the tool uses the `DependencyLister` class from `libthe-seed` to discover all shared libraries those binaries depend on, then creates the `my-release` directory containing the specified binaries plus all resolved shared library dependencies.

**Why this priority**: This is the core value of the feature — resolving runtime dependencies and collecting binaries into a distributable directory.

**Independent Test**: Can be fully tested by running the package command with a built executable, then verifying the output directory contains the binary and all shared libraries it links against.

**Acceptance Scenarios**:

1. **Given** a built executable that links against shared libraries, **When** the user runs `the-seed package my-release myapp`, **Then** a directory named `my-release` is created containing `myapp` and all shared libraries identified as dependencies by the `DependencyLister` class.
2. **Given** the specified binaries have no shared library dependencies beyond system-provided ones, **When** the user runs the package command, **Then** only the explicitly listed files appear in the output directory.
3. **Given** a binary depends on library A, which in turn depends on library B, **When** the user runs the package command, **Then** the output directory contains the binary, library A, and library B (transitive dependencies are resolved).

---

### User Story 2 - Help and Usage Information (Priority: P2)

A developer unfamiliar with the package command runs `the-seed package help` or `the-seed package` without arguments to learn how to use it. They see clear usage instructions describing the expected arguments and behavior.

**Why this priority**: Discoverability and usability are important for adoption, but the command must work before help text matters.

**Independent Test**: Can be tested by running the help subcommand and verifying the output contains usage syntax, argument descriptions, and at least one example.

**Acceptance Scenarios**:

1. **Given** the user has the tool installed, **When** they run `the-seed package help`, **Then** they see usage information including the expected argument format (directory name followed by binary file list).
2. **Given** the user runs `the-seed package` with no arguments, **When** the command executes, **Then** a helpful usage message is displayed rather than a cryptic error.

---

### User Story 3 - Error Handling for Invalid Inputs (Priority: P3)

A developer provides invalid arguments — such as a file that does not exist, or an output directory that already exists — and receives clear, actionable error messages rather than silent failures or stack traces.

**Why this priority**: Robust error handling improves trust and usability but is lower priority than core functionality.

**Independent Test**: Can be tested by providing non-existent file paths and pre-existing directory names, then verifying appropriate error messages are displayed.

**Acceptance Scenarios**:

1. **Given** the user specifies a binary file that does not exist, **When** the package command runs, **Then** a clear error message identifies which file was not found, and no partial output directory is created.
2. **Given** the output directory already exists, **When** the user runs the package command, **Then** the user is informed that the directory already exists and the command does not overwrite it.
3. **Given** the user provides only a directory name with no files, **When** the command runs, **Then** a usage error is shown indicating that at least one file must be specified.

---

### Edge Cases

- What happens when two specified binaries share a common shared library dependency? The shared library should appear only once in the output directory (no duplicate copies).
- What happens when the `DependencyLister` resolves a system-level library (e.g., libc, libstdc++)? The `DependencyLister` is responsible for filtering out system-provided libraries; the package command receives only non-system dependencies and copies all of them.
- What happens when a resolved dependency cannot be found on disk (e.g., the library is listed as a dependency but the file is missing)? The command treats this as a fatal error, aborts without creating the output directory, and reports which library is missing.
- What happens when the user lacks write permissions to create the output directory? A clear permissions error is displayed.
- What happens when one of the input files is a directory rather than a file? An error message indicates that only files are accepted as input.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `the-seed` CLI MUST accept a `package` command as a top-level subcommand (e.g., `the-seed package <dir> <file1> [file2] ...`).
- **FR-002**: The first positional argument after `package` MUST be treated as the output directory name.
- **FR-003**: All subsequent positional arguments MUST be treated as paths to binary files (executables or libraries) to include in the package.
- **FR-004**: The system MUST use the `DependencyLister` class from `libthe-seed` to resolve all runtime shared library dependencies of the specified binary files. The `DependencyLister` auto-detects the target platform from the binary file format (e.g., ELF vs PE); no explicit target argument is required. The system MUST pass the project's Config prefix path to `DependencyLister` so it can locate libraries installed by the build system.
- **FR-005**: The system MUST create the output directory if it does not already exist.
- **FR-006**: The system MUST copy all specified binary files into the output directory.
- **FR-007**: The system MUST copy all resolved shared library dependency files into the output directory.
- **FR-008**: The system MUST NOT create duplicate copies of files that appear both in the explicit list and in the resolved dependencies.
- **FR-009**: The system MUST display an error and exit without creating the output directory if any specified file does not exist.
- **FR-010**: The system MUST display an error if the output directory already exists.
- **FR-011**: The system MUST display usage information when `the-seed package help` is run.
- **FR-012**: The system MUST display a usage error when fewer than two arguments are provided after `package` (i.e., no directory name or no files).
- **FR-013**: The system MUST print each file name as it is copied to the output directory and display a summary count upon completion (e.g., "Packaged 7 files into my-release/").

### Key Entities

- **Package Directory**: The output directory created by the command; named by the user as the first argument. Contains all packaged binaries and their dependencies.
- **Binary Files**: The explicitly listed executables or shared libraries the user wants to include in the package.
- **Shared Library Dependencies**: Library files identified by the `DependencyLister` class as being required at runtime by the specified binaries. These are automatically discovered and added.

## Assumptions

- The `DependencyLister` class from `libthe-seed` is already available and provides an interface for resolving runtime shared library dependencies of binary files.
- The package command uses the project's Config prefix (where `the-seed build` installs libraries) as the library search path for `DependencyLister`, consistent with how `build` and `dependencies` commands operate.
- Dependency resolution covers shared libraries (`.so`, `.dll`) as used in the metaverse-systems ecosystem build targets (native Linux and cross-compiled Windows). The `DependencyLister` auto-detects the target platform from the binary file format rather than requiring an explicit target argument.
- The command operates on the current working directory's project context (consistent with other `the-seed` commands like `build` and `resource-pak`).
- System-level libraries (e.g., libc, kernel libraries) that are expected to exist on all target systems are excluded from the package output. This filtering is handled by the `DependencyLister` class; the package command trusts its output and copies all returned dependencies without additional filtering.
- File paths provided by the user are relative to the current working directory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can package a set of binaries with all their runtime dependencies into a single directory in a single command invocation.
- **SC-002**: 100% of shared library files identified as dependencies by `DependencyLister` are present in the output directory after a successful package operation.
- **SC-003**: Users receive clear, actionable error messages for all invalid-input scenarios (missing files, existing directory, insufficient arguments) without encountering unhandled exceptions.
- **SC-004**: The package command follows the same CLI patterns and conventions as existing `the-seed` subcommands (help, argument parsing, error handling style).
- **SC-005**: The output directory contains no duplicate files, even when the same library is a dependency of multiple specified binaries.

## Clarifications

### Session 2026-02-13

- Q: Should the `package` command accept a build target argument (like `native` or `windows`)? → A: No target argument; DependencyLister auto-detects platform from the binary file format (ELF vs PE).
- Q: When a resolved shared library dependency cannot be found on disk, should it be a fatal error or a warning? → A: Fatal error — abort packaging and report the missing library. No partial output directory is created.
- Q: Should the package command use the project's Config prefix to help DependencyLister locate shared libraries? → A: Yes — uses Config prefix for library search paths, consistent with how build and dependencies commands work.
- Q: How should system-level libraries be excluded from the package output? → A: DependencyLister handles the filtering; the package command receives only non-system dependencies.
- Q: What output should the package command produce on a successful run? → A: Verbose by default — print each file as it's copied plus a summary count at the end.
