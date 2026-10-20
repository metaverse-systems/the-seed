import { MAX_VALIDITY_DAYS } from "../Signing";
import { listScopesHint } from "./Hints";
import {
  CommandSpec,
  OptionSpec,
  PositionalSpec,
  SubcommandSpec,
  ValueParser,
  nonEmpty,
  scopeName,
  wholeNumber,
} from "./CommandSpec";
import { validateScopeName } from "../Scopes";

const TARGETS = ["native", "windows"];

/** `<scope>/<name>` as typed for a new package: the scope with its "@" and the name. */
const packageName: ValueParser = (raw, label) => {
  const fail = {
    ok: false as const,
    message: `Invalid value "${raw}" for ${label}; expected a scope and a name such as @my-scope/hello.`,
  };
  const parts = raw.split("/");
  if (parts.length !== 2 || parts[1] === "" || /\s/.test(parts[1])) return fail;
  const scope = parts[0].startsWith("@") ? parts[0] : `@${parts[0]}`;
  if (validateScopeName(scope) !== null) return fail;
  return { ok: true, value: { scope, name: parts[1] } };
};

const scopeOption = (help: string): OptionSpec => ({
  name: "--scope",
  value: { placeholder: "scope", parse: scopeName },
  help,
});

const forceOption = (help: string): OptionSpec => ({ name: "--force", help });

const pathArgument = (name: string, help: string, required = true): PositionalSpec => ({
  name,
  help,
  required,
  isPath: true,
  parse: nonEmpty,
});

const targetArgument = (noun: string, help: string): PositionalSpec => ({
  name: "target",
  help,
  required: false,
  values: TARGETS,
  valueNoun: noun,
});

const sub = (spec: Partial<SubcommandSpec> & Pick<SubcommandSpec, "name" | "summary" | "handler">): SubcommandSpec => ({
  positionals: [],
  options: [],
  interactive: false,
  notes: [],
  ...spec,
});

const BUILD_ROOT: SubcommandSpec = sub({
  name: "build",
  summary: "Build the project for Linux or Windows, or rebuild the current project",
  handler: "build",
  usageTail: "[native|windows] [--recursive] [--parallel <n>] [--jobs <n>] [--release]",
  positionals: [targetArgument("build target", "native builds for this Linux system, windows cross-compiles with MinGW")],
  options: [
    { name: "--recursive", help: "Build every buildable dependency first, then this project" },
    {
      name: "--parallel",
      value: {
        placeholder: "n",
        parse: wholeNumber(1),
        missing: "--parallel requires a positive whole number.",
      },
      help: "With --recursive, build up to <n> independent projects at once (default 1)",
    },
    {
      name: "--jobs",
      value: {
        placeholder: "n",
        parse: wholeNumber(1),
        missing: "--jobs requires a positive whole number.",
      },
      help: "Run at most <n> compile jobs at once (default: the processor count); with --parallel, the projects building at once share <n>",
    },
    {
      name: "--release",
      help: "Strip the installed programs and libraries (and the build-tree copies \"the-seed package\" reads) before they are signed",
    },
  ],
  leadingOptionForm: {
    options: ["--jobs"],
    message: "A build target is required: native or windows.",
  },
  deprecatedWords: [
    {
      word: "recursive",
      option: "--recursive",
      warning: "\"recursive\" is deprecated; use \"--recursive\" instead.",
    },
  ],
  notes: [
    "With no target, \"the-seed build [--jobs <n>]\" rebuilds the current project (make, install, sign). " +
      "--parallel=<n> and --jobs=<n> are the same as --parallel <n> and --jobs <n>. --parallel above the " +
      "processor count, or above --jobs, is reduced to it.",
    "Examples:\n" +
      "  \"the-seed build native\"                         Build for Linux\n" +
      "  \"the-seed build native --jobs 4\"                Build for Linux with at most 4 compile jobs\n" +
      "  \"the-seed build native --release\"               Build for Linux (stripped)\n" +
      "  \"the-seed build native --recursive\"             Build all dependencies and the project for Linux\n" +
      "  \"the-seed build native --recursive --parallel 4 --release\"\n" +
      "                                                Same, up to 4 projects at once (stripped)\n" +
      "  \"the-seed build windows\"                        Build for Windows (MinGW)\n" +
      "  \"the-seed build windows --recursive --release\"  Build all dependencies and the project for Windows",
    "Installing: \"make install\" runs into a staging directory; the programs and shared libraries it " +
      "installed, and their copies in src/ and src/.libs/ that \"the-seed package\" reads, are stripped (with " +
      "--release) and signed with the project's scope certificate, and only then is everything moved into the " +
      "prefix. Archives, import libraries, wrappers and other files are not stripped or signed. A failure " +
      "leaves the prefix as it was. Without a certificate the build says so in one line and installs unsigned " +
      "files.",
    "With --recursive, dependencies always finish installing before anything that needs them starts, and all " +
      "components finish before systems, and systems before programs. Install phases never overlap. With " +
      "--recursive and --parallel above 1, the compile jobs of the projects building at once never add up to " +
      "more than --jobs, or the processor count when --jobs is not given.",
    "Press Ctrl+C once to stop the running builds; an install in progress finishes first. Press it again to " +
      "stop at once; an install that has not reached the prefix is discarded.",
    "The bare word \"recursive\" after the target is deprecated; it still works for now but prints a warning. " +
      "Use --recursive instead.",
  ],
});

const PACKAGE_ROOT: SubcommandSpec = sub({
  name: "package",
  summary: "Package binaries with their shared library dependencies into a directory",
  handler: "package",
  positionals: [
    // Optional only so that `the-seed package` alone prints the help; a project directory is required.
    pathArgument("output-directory", "Name of the output directory to create", false),
    {
      ...pathArgument("project-dir", "Project directories containing src/Makefile.am"),
      variadic: true,
    },
  ],
  notes: [
    "The command reads src/Makefile.am to determine the binary type and name, resolves installed binaries for " +
      "all build targets, finds the shared library dependencies of each, and copies everything into the output " +
      "directory.",
    "Dependency projects are found the way \"the-seed build native --recursive\" finds them, from the " +
      "\"dependencies\" of each project's package.json: a \"file:\" path is taken relative to the declaring " +
      "project, and any other dependency (for example one installed from npm) is looked up in that project's " +
      "node_modules. Linux libraries are written under the name programs load them by (for example " +
      "libgreet.so.0), each with its .sig when signed. Two different files with the same name are refused; " +
      "nothing is written.",
  ],
});

const templateSub = (kind: string, summary: string): SubcommandSpec =>
  sub({
    name: kind,
    summary,
    handler: `template.${kind}`,
    interactive: true,
    positionals: [
      {
        name: "name",
        help: "The package, such as @my-scope/hello; asked for when not given",
        required: false,
        parse: packageName,
        usage: "<scope>/<name>",
      },
    ],
  });

const signingScope = "The scope whose certificate is used (asked for when several are configured)";

export const COMMANDS: CommandSpec[] = [
  {
    name: "config",
    summary: "Show or edit the tool's configuration",
    whenEmpty: { run: "list" },
    notes: [],
    movedTo: { subcommand: "scopes", sentence: listScopesHint() },
    subcommands: [
      sub({ name: "list", summary: "Show the configuration file's location and its contents", handler: "config.list" }),
      sub({ name: "edit", summary: "Change the configuration by answering questions", handler: "config.edit", interactive: true }),
    ],
  },
  {
    name: "scopes",
    summary: "List, add, edit and delete scopes",
    whenEmpty: "help",
    notes: [],
    subcommands: [
      sub({ name: "list", summary: "List the configured scopes, one per line", handler: "scopes.list" }),
      sub({ name: "add", summary: "Add a scope by answering questions", handler: "scopes.add", interactive: true }),
      sub({ name: "edit", summary: "Edit a scope's author by answering questions", handler: "scopes.edit", interactive: true }),
      sub({ name: "delete", summary: "Delete a scope", handler: "scopes.delete", interactive: true }),
    ],
  },
  {
    name: "template",
    summary: "Create a component, system or program from a template",
    whenEmpty: "help",
    notes: ["The project is created in the current directory."],
    subcommands: [
      templateSub("component", "Create a component"),
      templateSub("system", "Create a system"),
      templateSub("program", "Create a program"),
    ],
  },
  {
    name: "build",
    summary: "Build the project for Linux or Windows",
    whenEmpty: { run: "build" },
    notes: [],
    subcommands: [],
    root: BUILD_ROOT,
    validate: (parsed) => {
      if (parsed.options.parallel !== undefined && parsed.options.recursive !== true) {
        return { argument: "--parallel", message: "--parallel applies only to recursive builds; add --recursive." };
      }
      return null;
    },
  },
  {
    name: "dependencies",
    summary: "Check or install libecs-cpp and libthe-seed",
    whenEmpty: "help",
    notes: [],
    subcommands: [
      sub({
        name: "check",
        summary: "Report whether libecs-cpp and libthe-seed are installed",
        handler: "dependencies.check",
        positionals: [targetArgument("target", "native (the default) or windows")],
      }),
      sub({
        name: "install",
        summary: "Install the libraries that are missing",
        handler: "dependencies.install",
        positionals: [targetArgument("target", "native (the default) or windows")],
      }),
    ],
  },
  {
    name: "package",
    summary: "Package binaries with their shared library dependencies",
    whenEmpty: "help",
    notes: [],
    subcommands: [],
    root: PACKAGE_ROOT,
  },
  {
    name: "resource-pak",
    summary: "Create a resource pak project, add resources to it and build it",
    whenEmpty: "help",
    notes: ["add and build run in a resource pak project's directory."],
    subcommands: [
      sub({
        name: "create",
        summary: "Create a resource pak project in the current directory",
        handler: "resource-pak.create",
        interactive: true,
      }),
      sub({
        name: "add",
        summary: "Add a file to the resource pak project",
        handler: "resource-pak.add",
        positionals: [
          { name: "resource-name", help: "Name the resource is stored under", required: true, parse: nonEmpty },
          pathArgument("filename", "The file to add"),
        ],
      }),
      sub({ name: "build", summary: "Build the resource pak", handler: "resource-pak.build" }),
    ],
  },
  {
    name: "signing",
    summary: "Create, import, use and inspect code-signing certificates",
    whenEmpty: "help",
    notes: [
      "verify checks that a file is unchanged since it was signed and that its signer is one of the " +
        "certificates of your configured scopes (or of the files named with --cert). Certificate chains, " +
        "revocation, signing time and acceptance by the platform's own verifier are not checked.",
      "sign writes standard signature containers (signed attributes, the signer's certificate). Checked with " +
        "independent tools, the signer's certificate given as the trusted root: Windows programs and installers " +
        "pass osslsigncode; each slice of a Mac program passes openssl's signed-data check over its code " +
        "directory. Not checked with the platforms' own tools (signtool, WinVerifyTrust, the Windows Installer " +
        "service, codesign, Gatekeeper), which may still refuse the certificate. Files signed by earlier " +
        "versions should be signed again.",
    ],
    subcommands: [
      sub({
        name: "create-cert",
        summary: "Generate a self-signed ECDSA P-256 certificate for a scope",
        handler: "signing.create-cert",
        interactive: true,
        options: [
          scopeOption(signingScope),
          {
            name: "--validity-days",
            value: {
              placeholder: "days",
              parse: wholeNumber(1, MAX_VALIDITY_DAYS, `a whole number of days from 1 to ${MAX_VALIDITY_DAYS}`),
            },
            help: `Days the certificate is valid, 1 to ${MAX_VALIDITY_DAYS} (default 365)`,
          },
          forceOption("Replace an existing certificate without asking"),
        ],
      }),
      sub({
        name: "import-cert",
        summary: "Import an existing PEM certificate and private key",
        handler: "signing.import-cert",
        interactive: true,
        options: [
          { name: "--cert", required: true, value: { placeholder: "file", parse: nonEmpty }, help: "The PEM certificate" },
          { name: "--key", required: true, value: { placeholder: "file", parse: nonEmpty }, help: "The PEM private key" },
          scopeOption(signingScope),
          forceOption("Replace an existing certificate without asking"),
        ],
      }),
      sub({
        name: "sign",
        summary: "Sign a binary file, or every binary file in a directory",
        handler: "signing.sign",
        interactive: true,
        positionals: [pathArgument("path", "The file or directory to sign")],
        options: [
          scopeOption(signingScope),
          forceOption("Sign even though the certificate has expired"),
          { name: "--detached", help: "Write the signature to a separate .sig file instead of into the file" },
        ],
      }),
      sub({
        name: "verify",
        summary: "Check the signature of a file, or of a directory with a signing manifest",
        handler: "signing.verify",
        usageTail: "[--cert <file>]... <path>",
        positionals: [pathArgument("path", "The file or directory to verify")],
        options: [
          {
            name: "--cert",
            repeatable: true,
            value: { placeholder: "file", parse: nonEmpty },
            help: "Trust this certificate (may be given more than once)",
          },
        ],
      }),
      sub({
        name: "cert-info",
        summary: "Show the details of a scope's certificate",
        handler: "signing.cert-info",
        interactive: true,
        options: [scopeOption(signingScope)],
      }),
      sub({
        name: "export-cert",
        summary: "Write a scope's public certificate to a file",
        handler: "signing.export-cert",
        interactive: true,
        options: [
          { name: "--output", required: true, value: { placeholder: "file", parse: nonEmpty }, help: "The file to write" },
          scopeOption(signingScope),
        ],
      }),
    ],
  },
  {
    name: "installer",
    summary: "Build a Windows installer for the project",
    whenEmpty: "help",
    notes: ["The project must have been built with \"the-seed build windows\" first."],
    subcommands: [
      sub({
        name: "windows",
        summary: "Build a Windows installer (.msi) from the project's build output",
        handler: "installer.windows",
        interactive: true,
        options: [scopeOption("The scope whose certificate signs the installer (asked for when several are configured)")],
      }),
    ],
  },
  {
    name: "help",
    summary: "Show help for the tool, a command or a subcommand",
    whenEmpty: "help",
    notes: [],
    subcommands: [],
  },
];

/** The command with this name. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
