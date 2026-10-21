/*
 * Keeps README.md in agreement with the tool: the help screens, the commands and options, the
 * exit-status table, the generated type declarations, the class tables, the import example, the
 * shell examples and the repository paths it names.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - A marker is an HTML comment on a line of its own: `<!-- help -->` (the top-level help),
 *   `<!-- help: <command> -->`, `<!-- exit-statuses -->`, `<!-- api-types -->` and
 *   `<!-- api-example -->`. The block belonging to a marker starts at the next non-blank line.
 *   For `help`, `api-types` and `api-example` it is a fenced code block (a line starting with
 *   three backticks to the next such line); for `exit-statuses` it is a Markdown table.
 * - A help block holds the rendered help text exactly (compared after removing trailing blanks).
 * - The exit-status table has a header row and a separator row, then one row per entry of
 *   `EXIT_STATUSES`: `| <status> | <meaning> |` (backticks around a cell are ignored).
 * - The `api-types` block holds the declarations of the interfaces, type aliases and enums that
 *   `src/index.ts` exports from `src/types.ts`, `src/Installer.ts`, `src/ElfNames.ts`,
 *   `src/CmsBuilder.ts` and `src/Signing.ts`, in the order of `index.ts`'s export list, separated
 *   by one blank line, with `export` and `declare` removed (declarations are emitted with
 *   comments removed, in memory).
 * - "Command reference" and "API reference" are `##` headings of the README (case ignored). In the
 *   command reference every `###` heading starts with the name of a registry command (backticks
 *   ignored); `####` headings belong to the `###` above them. The options written in the text of
 *   a command's subsection (outside marked blocks) must be options of that command, or `--help`;
 *   text before the first `###` may use any option of the registry. Every option and every
 *   `<command> <subcommand>` pair of the registry must appear somewhere outside the marked blocks.
 * - A class table is a Markdown table under a `###` or `####` heading of the API reference whose
 *   text (backticks ignored) is the name of an exported class. The first cell of each row is the
 *   member in backticks: `name`, `name(parameters)`, with `static ` in front for a static member
 *   and `constructor(parameters)` for the constructor. A parameter is listed by its name, followed
 *   by `?` when it is optional (a `: type` after the name is allowed and ignored; parameter names
 *   and optionality are compared, not types). A property whose value is a function is listed as
 *   a call. Every exported class that is not an error class needs a table; an error class needs
 *   one only if it has a heading. Private and protected members are not listed. Every other
 *   declared member of the class (not inherited ones) is, except the constructor and members whose
 *   name starts with `_`, which may be left out (but are checked when listed). The header row of
 *   a table (the row before the separator row) is ignored.
 * - The `api-example` block is compiled as a TypeScript module with strict settings in which
 *   `@metaverse-systems/the-seed` resolves to `src/index.ts` and each public subpath named by the
 *   `exports` map of package.json (`./Config`, ...) resolves to its source module (`dist/X.js`
 *   becomes `src/X.ts`); it must produce no diagnostics.
 * - The `public-modules` marker is followed by a Markdown table of the public modules: a header row,
 *   a separator row, then one row per key of `exports` except `./package.json`, in the order of
 *   `exports`: `| <specifier> | <what it holds> |`, where the specifier is the package name followed
 *   by the subpath without its `./` (backticks around a cell are ignored) and the second cell is the
 *   text of `PUBLIC_MODULE_CONTENTS` in this file. The sentence "Nothing else in the package is
 *   public; other paths cannot be imported." has to appear in the README outside fenced blocks.
 * - Backticked repository paths are inline code spans (outside fenced blocks) that start with
 *   `src/`, `test/`, `native/`, `scripts/`, `templates/` or `.github/` and contain no space,
 *   `*`, `<`, `{` or `...`. Relative Markdown links in the README also have to exist, and the
 *   README must link `structure.md` and `LICENSE`.
 * - Shell blocks are all fenced blocks that carry no marker. Within them, a line (or a part
 *   after `&&`, `;` or `|`) that starts with `the-seed ` or `$ the-seed ` is checked with
 *   `checkCommandLine`; trailing `# comments`, redirections and `\` line continuations are
 *   ignored, and arguments must not contain quoted spaces.
 * - On a failure the file `test-results/README.expected.md` is written: the README with the
 *   content of every generated block replaced (hand-written text kept), and the blocks whose
 *   marker is missing appended at the end.
 * - The negative self-test works on a README assembled in memory from the generated blocks (so it
 *   does not depend on the state of the real README) and requires each damaged copy to be
 *   reported by the check that is meant to find the damage.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { COMMANDS } from "../src/cli/Commands";
import { renderTopLevelHelp, renderCommandHelp } from "../src/cli/Help";
import { EXIT_STATUSES } from "../src/cli/ExitStatus";
import type { CommandSpec, SubcommandSpec } from "../src/cli/CommandSpec";
import { checkCommandLine } from "./helpers/HintScan";

jest.setTimeout(180000);

const packageRoot = path.resolve(__dirname, "..");
const readmePath = path.join(packageRoot, "README.md");
const structurePath = path.join(packageRoot, "structure.md");
const expectedPath = path.join(packageRoot, "test-results", "README.expected.md");
const EXPECTED_NAME = "test-results/README.expected.md";

// ---------------------------------------------------------------------------------------------
// Reading the Markdown
// ---------------------------------------------------------------------------------------------

interface Fence {
  /** index of the opening line */
  open: number;
  /** index of the closing line (the last line when the block is not closed) */
  close: number;
  info: string;
}

interface Marker {
  /** "help", "help: build", "exit-statuses", "api-types", "api-example" or "public-modules" */
  key: string;
  line: number;
  /** For a fenced block: the fence. For a table: open is the first row and close the last. */
  block: Fence | null;
}

interface Heading {
  line: number;
  level: number;
  title: string;
}

interface Parsed {
  lines: string[];
  fences: Fence[];
  markers: Marker[];
  headings: Heading[];
  /** lines inside a marked block, markers included */
  marked: Set<number>;
  /** lines inside any fenced block, fences included */
  fenced: Set<number>;
}

const MARKER = /^<!--\s*(help|help:\s*[a-z][a-z-]*|exit-statuses|api-types|api-example|public-modules)\s*-->\s*$/;

function parseMarkdown(text: string): Parsed {
  const lines = text.split("\n");
  const fences: Fence[] = [];
  const fenced = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^```(.*)$/.exec(lines[i]);
    if (m === null) continue;
    let close = i + 1;
    while (close < lines.length && !/^```\s*$/.test(lines[close])) close++;
    if (close >= lines.length) close = lines.length - 1;
    fences.push({ open: i, close, info: m[1].trim() });
    for (let k = i; k <= close; k++) fenced.add(k);
    i = close;
  }

  const markers: Marker[] = [];
  const marked = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const m = MARKER.exec(lines[i].trim());
    if (m === null) continue;
    const key = m[1].replace(/\s+/g, " ").replace(/^help: ?/, "help: ");
    marked.add(i);
    let next = i + 1;
    while (next < lines.length && lines[next].trim() === "") next++;
    let block: Fence | null = null;
    if (key === "exit-statuses" || key === "public-modules") {
      if (next < lines.length && lines[next].trim().startsWith("|")) {
        let last = next;
        while (last + 1 < lines.length && lines[last + 1].trim().startsWith("|")) last++;
        block = { open: next, close: last, info: "table" };
      }
    } else {
      block = fences.find((fence) => fence.open === next) ?? null;
    }
    if (block !== null) {
      for (let k = block.open; k <= block.close; k++) marked.add(k);
    }
    markers.push({ key, line: i, block });
  }

  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (m !== null) headings.push({ line: i, level: m[1].length, title: m[2] });
  }
  return { lines, fences, markers, headings, marked, fenced };
}

/** The first and last+1 line of the section under the first heading of this level whose title matches. */
function sectionRange(parsed: Parsed, level: number, title: RegExp): { start: number; end: number } | null {
  const index = parsed.headings.findIndex((heading) => heading.level === level && title.test(heading.title));
  if (index === -1) return null;
  let end = parsed.lines.length;
  for (let k = index + 1; k < parsed.headings.length; k++) {
    if (parsed.headings[k].level <= level) {
      end = parsed.headings[k].line;
      break;
    }
  }
  return { start: parsed.headings[index].line, end };
}

function blockText(parsed: Parsed, marker: Marker): string {
  if (marker.block === null) return "";
  const { open, close, info } = marker.block;
  const body = info === "table" ? parsed.lines.slice(open, close + 1) : parsed.lines.slice(open + 1, close);
  return body.join("\n");
}

const trimBlock = (text: string): string => text.split("\n").map((line) => line.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");

function stripBackticks(text: string): string {
  return text.replace(/`/g, "").trim();
}

// ---------------------------------------------------------------------------------------------
// What the tool generates
// ---------------------------------------------------------------------------------------------

function subcommandSpecs(command: CommandSpec): SubcommandSpec[] {
  return [...(command.root ? [command.root] : []), ...command.subcommands];
}

const PACKAGE_NAME = "@metaverse-systems/the-seed";
const PUBLIC_SENTENCE = "Nothing else in the package is public; other paths cannot be imported.";

/** What each public module holds, as the Public modules table words it. */
const PUBLIC_MODULE_CONTENTS: Record<string, string> = {
  ".": "The entry point: the classes, error types and type declarations listed in this reference",
  "./Build": "`Build`, the build target table and the strip-tool helpers",
  "./Config": "`Config` and `ConfigError`",
  "./Dependencies": "The dependency checks and installers for libecs-cpp and libthe-seed",
  "./DependencyWalker": "`walkDependencies` and the dependency discovery errors",
  "./Hints": "The hint texts that follow command-line messages",
  "./Installer": "`Installer` and its configuration and result types",
  "./NativeComponent": "The native component loader functions and `NativeComponentMissingError`",
  "./Package": "`Package`",
  "./ProjectError": "`ProjectError` and its error codes",
  "./RecursiveBuild": "`buildRecursive` and `getRecursiveBuildSteps`",
  "./ResourcePak": "`ResourcePak`",
  "./Scopes": "`Scopes`, `ScopeNameError` and `validateScopeName`",
  "./Signing": "`Signing`, `SigningError` and the signing constants",
  "./Template": "`Template`",
  "./types": "The shared type declarations",
};

/** The keys of package.json's exports map, in order, without the manifest itself. */
function publicSubpaths(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as { exports?: Record<string, unknown> };
  return Object.keys(manifest.exports ?? {}).filter((subpath) => subpath !== "./package.json");
}

function publicSpecifier(subpath: string): string {
  return subpath === "." ? PACKAGE_NAME : `${PACKAGE_NAME}/${subpath.slice(2)}`;
}

/** The source module a public subpath is compiled from (`dist/X.js` becomes `src/X.ts`). */
function publicSources(): Record<string, string[]> {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
    exports?: Record<string, { default?: string } | string>;
  };
  const paths: Record<string, string[]> = {};
  for (const subpath of publicSubpaths()) {
    const entry = (manifest.exports ?? {})[subpath];
    const target = typeof entry === "string" ? entry : entry?.default;
    if (target === undefined) continue;
    paths[publicSpecifier(subpath)] = [target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")];
  }
  return paths;
}

function publicModulesTable(): string[] {
  return [
    "| Module | Holds |",
    "|---|---|",
    ...publicSubpaths().map((subpath) => `| \`${publicSpecifier(subpath)}\` | ${PUBLIC_MODULE_CONTENTS[subpath] ?? ""} |`),
  ];
}

function exitStatusTable(): string[] {
  return ["| Status | Meaning |", "|---|---|", ...EXIT_STATUSES.map((row) => `| ${row.status} | ${row.meaning} |`)];
}

interface Declared {
  /** the generated declarations, as the api-types block holds them */
  types: string;
  classes: Map<string, DeclaredClass>;
}

interface DeclaredClass {
  isError: boolean;
  /** key (`name` or `static name`) to the parameter lists the member can be called with; null for a value */
  members: Map<string, Array<string[] | null>>;
}

const TYPE_FILES = ["types", "Installer", "ElfNames", "CmsBuilder", "Signing"];

function compilerOptions(): ts.CompilerOptions {
  const read = ts.readConfigFile(path.join(packageRoot, "tsconfig.json"), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, packageRoot).options;
}

function parameterNames(parameters: ts.NodeArray<ts.ParameterDeclaration>): string[] {
  return parameters.map(
    (parameter) =>
      (parameter.dotDotDotToken ? "..." : "") + parameter.name.getText() + (parameter.questionToken || parameter.initializer ? "?" : ""),
  );
}

function isErrorClass(checker: ts.TypeChecker, declaration: ts.ClassDeclaration): boolean {
  const seen = new Set<ts.Type>();
  const walk = (type: ts.Type): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.symbol && type.symbol.name === "Error") return true;
    if (!type.isClassOrInterface()) return false;
    return checker.getBaseTypes(type).some(walk);
  };
  return walk(checker.getTypeAtLocation(declaration));
}

function declaredMembers(declaration: ts.ClassDeclaration): Map<string, Array<string[] | null>> {
  const members = new Map<string, Array<string[] | null>>();
  const add = (key: string, value: string[] | null): void => {
    members.set(key, [...(members.get(key) ?? []), value]);
  };
  for (const member of declaration.members) {
    const flags = ts.getCombinedModifierFlags(member);
    if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    const prefix = flags & ts.ModifierFlags.Static ? "static " : "";
    if (ts.isConstructorDeclaration(member)) {
      add("constructor", parameterNames(member.parameters));
    } else if (ts.isMethodDeclaration(member) && !ts.isPrivateIdentifier(member.name)) {
      add(prefix + member.name.getText(), parameterNames(member.parameters));
    } else if (ts.isPropertyDeclaration(member) && !ts.isPrivateIdentifier(member.name)) {
      const init = member.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        add(prefix + member.name.getText(), parameterNames(init.parameters));
      } else if (member.type && ts.isFunctionTypeNode(member.type)) {
        add(prefix + member.name.getText(), parameterNames(member.type.parameters));
      } else {
        add(prefix + member.name.getText(), null);
      }
    } else if (ts.isGetAccessor(member) && !ts.isPrivateIdentifier(member.name)) {
      add(prefix + member.name.getText(), null);
    }
  }
  return members;
}

let declaredCache: Declared | null = null;

function declared(): Declared {
  if (declaredCache !== null) return declaredCache;
  const options: ts.CompilerOptions = {
    ...compilerOptions(),
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
    noEmit: false,
    sourceMap: false,
    outDir: "/virtual-declarations",
    rootDir: path.join(packageRoot, "src"),
  };
  const emitted = new Map<string, string>();
  const host = ts.createCompilerHost(options);
  host.writeFile = (fileName, content) => {
    emitted.set(fileName, content);
  };
  const entry = path.join(packageRoot, "src", "index.ts");
  const program = ts.createProgram([entry], options, host);
  program.emit();
  const checker = program.getTypeChecker();
  const indexFile = program.getSourceFile(entry);
  if (indexFile === undefined) throw new Error("src/index.ts could not be read");

  const blocks: string[] = [];
  const seen = new Set<string>();
  const classes = new Map<string, DeclaredClass>();

  const resolve = (symbol: ts.Symbol): ts.Symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

  for (const statement of indexFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      const name = specifier.name.text;
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (symbol === undefined) continue;
      const target = resolve(symbol);
      const declarations = target.declarations ?? [];
      for (const declaration of declarations) {
        if (ts.isClassDeclaration(declaration) && !classes.has(name)) {
          classes.set(name, { isError: isErrorClass(checker, declaration), members: declaredMembers(declaration) });
        }
      }
      const typeDeclarations = declarations.filter(
        (declaration) => ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isEnumDeclaration(declaration),
      );
      if (typeDeclarations.length === 0 || seen.has(name)) continue;
      const sourceName = path.basename(typeDeclarations[0].getSourceFile().fileName, ".ts");
      if (!TYPE_FILES.includes(sourceName)) continue;
      const emittedText = emitted.get(path.join("/virtual-declarations", sourceName + ".d.ts"));
      if (emittedText === undefined) throw new Error(`No declaration was emitted for src/${sourceName}.ts`);
      const emittedFile = ts.createSourceFile(sourceName + ".d.ts", emittedText, ts.ScriptTarget.Latest, true);
      const texts: string[] = [];
      for (const emittedStatement of emittedFile.statements) {
        if (
          (ts.isInterfaceDeclaration(emittedStatement) || ts.isTypeAliasDeclaration(emittedStatement) || ts.isEnumDeclaration(emittedStatement)) &&
          emittedStatement.name.text === name
        ) {
          texts.push(emittedStatement.getText(emittedFile).replace(/^(export\s+)?(declare\s+)?/, ""));
        }
      }
      if (texts.length === 0) continue;
      seen.add(name);
      blocks.push(texts.join("\n"));
    }
  }
  declaredCache = { types: blocks.join("\n\n"), classes };
  return declaredCache;
}

// ---------------------------------------------------------------------------------------------
// The checks; each returns the problems it found
// ---------------------------------------------------------------------------------------------

function knownCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Check 1: every help block equals the rendered help. */
function checkHelpBlocks(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const problems: string[] = [];
  for (const marker of parsed.markers.filter((candidate) => candidate.key.startsWith("help"))) {
    const command = marker.key === "help" ? null : knownCommand(marker.key.slice("help: ".length));
    if (marker.key !== "help" && command === undefined) continue; // reported by check 2
    if (marker.block === null) {
      problems.push(`line ${marker.line + 1}: <!-- ${marker.key} --> is not followed by a fenced block`);
      continue;
    }
    const expected = marker.key === "help" ? renderTopLevelHelp() : renderCommandHelp(command as CommandSpec);
    if (trimBlock(blockText(parsed, marker)) !== trimBlock(expected)) {
      problems.push(`line ${marker.line + 1}: the block after <!-- ${marker.key} --> differs from the help the tool prints`);
    }
  }
  return problems;
}

/** Check 2: every command has a block; every marker names a command. */
function checkHelpMarkers(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const problems: string[] = [];
  const keys = parsed.markers.map((marker) => marker.key);
  if (!keys.includes("help")) problems.push("no <!-- help --> block for the top-level help");
  for (const command of COMMANDS) {
    const count = keys.filter((key) => key === `help: ${command.name}`).length;
    if (count === 0) problems.push(`no <!-- help: ${command.name} --> block for the command "${command.name}"`);
    if (count > 1) problems.push(`<!-- help: ${command.name} --> appears ${count} times`);
  }
  for (const marker of parsed.markers) {
    if (marker.key.startsWith("help: ") && knownCommand(marker.key.slice("help: ".length)) === undefined) {
      problems.push(`line ${marker.line + 1}: <!-- ${marker.key} --> names a command that does not exist`);
    }
  }
  return problems;
}

const OPTION = /(^|[^\w-])(--[a-z][a-z0-9-]*)/g;

function optionsIn(line: string): string[] {
  const found: string[] = [];
  OPTION.lastIndex = 0;
  for (let m = OPTION.exec(line); m !== null; m = OPTION.exec(line)) found.push(m[2]);
  return found;
}

/** Check 3: every subcommand and option appears; every option in a command's section belongs to it. */
function checkCommandsAndOptions(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const problems: string[] = [];
  const outside = parsed.lines.map((line, index) => (parsed.marked.has(index) ? "" : line));
  const text = outside.join("\n");

  for (const command of COMMANDS) {
    for (const sub of command.subcommands) {
      const pair = new RegExp(`(^|[^\\w-])${command.name}\\s+${sub.name}([^\\w-]|$)`);
      if (!pair.test(text)) problems.push(`"${command.name} ${sub.name}" is not mentioned outside the help blocks`);
    }
    for (const spec of subcommandSpecs(command)) {
      for (const option of spec.options) {
        const found = optionsIn(text);
        if (!found.includes(option.name)) {
          problems.push(`${option.name} (${command.name}${spec.name === command.name ? "" : " " + spec.name}) is not mentioned outside the help blocks`);
        }
      }
    }
  }

  const range = sectionRange(parsed, 2, /^command reference$/i);
  if (range === null) return [...problems, "the README has no \"Command reference\" section"];
  const all = new Set<string>(["--help"]);
  for (const command of COMMANDS) for (const spec of subcommandSpecs(command)) for (const option of spec.options) all.add(option.name);

  let current: CommandSpec | null = null;
  let currentTitle = "";
  for (let i = range.start + 1; i < range.end; i++) {
    const heading = parsed.headings.find((candidate) => candidate.line === i);
    if (heading && heading.level === 3) {
      const first = stripBackticks(heading.title).split(/\s+/)[0];
      current = knownCommand(first) ?? null;
      currentTitle = heading.title;
      if (current === null) problems.push(`line ${i + 1}: the heading "${heading.title}" in the command reference does not start with a command name`);
    }
    if (parsed.marked.has(i)) continue;
    const allowed = new Set<string>(["--help"]);
    if (current !== null) {
      for (const spec of subcommandSpecs(current)) for (const option of spec.options) allowed.add(option.name);
    }
    const sectionOptions = currentTitle === "" ? all : allowed;
    for (const option of optionsIn(parsed.lines[i])) {
      if (!sectionOptions.has(option)) {
        problems.push(
          `line ${i + 1}: ${option} is not an option of ${currentTitle === "" ? "any command" : `the command "${current === null ? currentTitle : current.name}"`}`,
        );
      }
    }
  }
  return problems;
}

/** Check 4: the examples in shell blocks parse. */
function checkShellBlocks(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const problems: string[] = [];
  for (const fence of parsed.fences) {
    if (parsed.marked.has(fence.open)) continue;
    const logical: Array<{ line: number; text: string }> = [];
    let pending: { line: number; text: string } | null = null;
    for (let i = fence.open + 1; i < fence.close; i++) {
      const raw = parsed.lines[i];
      const joined: { line: number; text: string } = pending ?? { line: i, text: "" };
      joined.text += (joined.text === "" ? "" : " ") + raw.replace(/\\\s*$/, "").trim();
      if (/\\\s*$/.test(raw)) {
        pending = joined;
      } else {
        logical.push(joined);
        pending = null;
      }
    }
    if (pending !== null) logical.push(pending);
    for (const entry of logical) {
      const withoutComment = entry.text.replace(/(^|\s)#.*$/, "");
      for (const part of withoutComment.split(/&&|;|\|\|?/)) {
        const m = /^(?:\$\s+)?the-seed\s+(\S.*)$/.exec(part.trim());
        if (m === null) continue;
        const command = m[1].replace(/\s+\d?>.*$/, "");
        const problem = checkCommandLine(command);
        if (problem !== null) problems.push(`line ${entry.line + 1}: "the-seed ${command}": ${problem}`);
      }
    }
  }
  return problems;
}

/** Check 5: the exit-status table. */
function checkExitStatuses(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const marker = parsed.markers.find((candidate) => candidate.key === "exit-statuses");
  if (marker === undefined) return ["no <!-- exit-statuses --> table"];
  if (marker.block === null) return ["<!-- exit-statuses --> is not followed by a table"];
  const rows = blockText(parsed, marker)
    .split("\n")
    .slice(2)
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(stripBackticks));
  const problems: string[] = [];
  if (rows.length !== EXIT_STATUSES.length) {
    problems.push(`the table has ${rows.length} rows; the tool has ${EXIT_STATUSES.length} exit statuses`);
  }
  EXIT_STATUSES.forEach((expected, index) => {
    const row = rows[index];
    if (row === undefined) return;
    if (row.length !== 2 || row[0] !== expected.status || row[1] !== expected.meaning) {
      problems.push(`row ${index + 1} differs from the exit status "${expected.status}"`);
    }
  });
  return problems;
}

/** Check 6: the generated declarations. */
function checkApiTypes(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const marker = parsed.markers.find((candidate) => candidate.key === "api-types");
  if (marker === undefined) return ["no <!-- api-types --> block"];
  if (marker.block === null) return ["<!-- api-types --> is not followed by a fenced block"];
  const actual = trimBlock(blockText(parsed, marker));
  const expected = trimBlock(declared().types);
  if (actual === expected) return [];
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const at = expectedLines.findIndex((line, index) => line !== actualLines[index]);
  return [`the api-types block differs from the declarations generated from src/index.ts (first difference at line ${at + 1}: expected "${expectedLines[at] ?? ""}")`];
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && !(c === ">" && text[i - 1] === "=")) depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** Check 7: the class tables. */
function checkClassTables(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const problems: string[] = [];
  const range = sectionRange(parsed, 2, /^api reference$/i);
  if (range === null) return ["the README has no \"API reference\" section"];
  const { classes } = declared();

  const tables = new Map<string, Array<{ line: number; cell: string }>>();
  const sectionHeadings = parsed.headings.filter((heading) => heading.line > range.start && heading.line < range.end && (heading.level === 3 || heading.level === 4));
  for (const heading of sectionHeadings) {
    const name = stripBackticks(heading.title);
    if (!classes.has(name)) continue;
    const next = parsed.headings.find((candidate) => candidate.line > heading.line);
    const end = next ? Math.min(next.line, range.end) : range.end;
    const rows: Array<{ line: number; cell: string }> = [];
    for (let i = heading.line + 1; i < end; i++) {
      const line = parsed.lines[i].trim();
      if (!line.startsWith("|") || parsed.fenced.has(i)) continue;
      const cell = line.replace(/^\|/, "").split("|")[0].trim();
      if (/^:?-+:?$/.test(cell) || /^\s*\|?\s*:?-+/.test(parsed.lines[i + 1] ?? "")) continue;
      rows.push({ line: i, cell });
    }
    tables.set(name, rows);
  }

  for (const [name, info] of classes) {
    const rows = tables.get(name);
    if (rows === undefined) {
      if (!info.isError) problems.push(`the API reference has no table for the class ${name}`);
      continue;
    }
    const listed = new Set<string>();
    for (const row of rows) {
      const cell = stripBackticks(row.cell);
      const m = /^(static\s+)?([A-Za-z_$][\w$]*)(?:\((.*)\))?$/.exec(cell);
      if (m === null) {
        problems.push(`${name} table, line ${row.line + 1}: "${cell}" is not a member written as name or name(parameters)`);
        continue;
      }
      const key = (m[1] ? "static " : "") + m[2];
      listed.add(key);
      const candidates = info.members.get(key);
      if (candidates === undefined) {
        problems.push(`${name} table, line ${row.line + 1}: ${name} has no public member "${key}"`);
        continue;
      }
      const listedParameters = m[3] === undefined ? null : splitTopLevel(m[3]).map((part) => part.split(/[:=]/)[0].trim());
      const normalise = (parameters: string[] | null): string => (parameters === null ? "(value)" : `(${parameters.join(", ")})`);
      if (!candidates.some((candidate) => normalise(candidate) === normalise(listedParameters))) {
        problems.push(
          `${name} table, line ${row.line + 1}: "${key}" is listed as ${normalise(listedParameters)} but declared as ${candidates.map(normalise).join(" or ")}`,
        );
      }
    }
    for (const key of info.members.keys()) {
      const optional = key === "constructor" || key.replace(/^static /, "").startsWith("_");
      if (!listed.has(key) && !optional) problems.push(`${name}: the public member "${key}" is not listed in its table`);
    }
  }
  return problems;
}

/** Check 8: the example compiles against src/index.ts. */
function checkApiExample(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const marker = parsed.markers.find((candidate) => candidate.key === "api-example");
  if (marker === undefined) return ["no <!-- api-example --> block"];
  if (marker.block === null) return ["<!-- api-example --> is not followed by a fenced block"];
  const code = blockText(parsed, marker);
  const fileName = path.join(packageRoot, "readme-example.ts");
  const options: ts.CompilerOptions = {
    ...compilerOptions(),
    noEmit: true,
    declaration: false,
    sourceMap: false,
    outDir: undefined,
    baseUrl: packageRoot,
    paths: { [PACKAGE_NAME]: ["src/index.ts"], ...publicSources() },
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    path.resolve(name) === fileName ? ts.createSourceFile(name, code, languageVersion, true) : original(name, languageVersion, onError, shouldCreate);
  const originalExists = host.fileExists.bind(host);
  host.fileExists = (name) => path.resolve(name) === fileName || originalExists(name);
  const originalRead = host.readFile.bind(host);
  host.readFile = (name) => (path.resolve(name) === fileName ? code : originalRead(name));
  const program = ts.createProgram([fileName], options, host);
  const source = program.getSourceFile(fileName);
  if (source === undefined) return ["the example could not be read"];
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  return diagnostics.map((diagnostic) => {
    const where = diagnostic.start === undefined ? "" : `line ${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `;
    return `example, ${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
}

/** Check 8b: the Public modules table equals the exports map, and the closing sentence is present. */
function checkPublicModules(readme: string): string[] {
  const parsed = parseMarkdown(readme);
  const problems: string[] = [];
  const marker = parsed.markers.find((candidate) => candidate.key === "public-modules");
  if (marker === undefined) problems.push("no <!-- public-modules --> table");
  else if (marker.block === null) problems.push("<!-- public-modules --> is not followed by a table");
  else {
    const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(stripBackticks);
    const rows = blockText(parsed, marker).split("\n").slice(2).map(cells);
    const expected = publicSubpaths();
    if (rows.length !== expected.length) problems.push(`the table has ${rows.length} rows; exports has ${expected.length} public subpaths`);
    expected.forEach((subpath, index) => {
      const row = rows[index];
      if (row === undefined) return;
      const holds = stripBackticks(PUBLIC_MODULE_CONTENTS[subpath] ?? "");
      if (row.length !== 2 || row[0] !== publicSpecifier(subpath) || row[1] !== holds) {
        problems.push(`row ${index + 1} differs from the public module ${publicSpecifier(subpath)}`);
      }
    });
  }
  const outsideFences = parsed.lines.filter((_, index) => !parsed.fenced.has(index)).join(" ");
  if (!outsideFences.replace(/\s+/g, " ").includes(PUBLIC_SENTENCE)) problems.push(`the sentence "${PUBLIC_SENTENCE}" is missing`);
  return problems;
}

const PATH_PREFIXES = /^(src|test|native|scripts|templates|\.github)\//;

/** Check 9a: backticked repository paths and relative links exist. */
function checkPaths(text: string, file: string): string[] {
  const parsed = parseMarkdown(text);
  const problems: string[] = [];
  parsed.lines.forEach((line, index) => {
    if (parsed.fenced.has(index)) return;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const candidate = m[1];
      if (!PATH_PREFIXES.test(candidate) || /[\s*<{]|\.\.\./.test(candidate)) continue;
      if (!fs.existsSync(path.join(packageRoot, candidate))) problems.push(`${file} line ${index + 1}: the path ${candidate} does not exist`);
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (!fs.existsSync(path.join(packageRoot, target))) problems.push(`${file} line ${index + 1}: the link ${target} does not exist`);
    }
  });
  return problems;
}

/** Check 9b: LICENSE and structure.md exist and the README links them. */
function checkLinkedFiles(readme: string): string[] {
  const problems: string[] = [];
  for (const name of ["LICENSE", "structure.md"]) {
    if (!fs.existsSync(path.join(packageRoot, name))) problems.push(`${name} does not exist`);
    if (!readme.includes(`](${name})`)) problems.push(`README.md does not link ${name}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The expected README
// ---------------------------------------------------------------------------------------------

function generatedBlock(key: string): string[] | null {
  if (key === "help") return renderTopLevelHelp().replace(/\n+$/, "").split("\n");
  if (key.startsWith("help: ")) {
    const command = knownCommand(key.slice("help: ".length));
    return command ? renderCommandHelp(command).replace(/\n+$/, "").split("\n") : null;
  }
  if (key === "exit-statuses") return exitStatusTable();
  if (key === "public-modules") return publicModulesTable();
  if (key === "api-types") return declared().types.split("\n");
  return null;
}

function expectedReadme(readme: string): string {
  const parsed = parseMarkdown(readme);
  const lines = parsed.lines.slice();
  const present = new Set<string>();
  const edits: Array<{ marker: Marker; content: string[] }> = [];
  for (const marker of parsed.markers) {
    const content = generatedBlock(marker.key);
    if (content === null || marker.block === null) continue;
    present.add(marker.key);
    edits.push({ marker, content });
  }
  for (const { marker, content } of edits.sort((a, b) => b.marker.line - a.marker.line)) {
    const block = marker.block as Fence;
    if (block.info === "table") lines.splice(block.open, block.close - block.open + 1, ...content);
    else lines.splice(block.open + 1, block.close - block.open - 1, ...content);
  }
  const missing = ["help", ...COMMANDS.map((command) => `help: ${command.name}`), "exit-statuses", "api-types", "public-modules"].filter((key) => !present.has(key));
  if (missing.length > 0) {
    lines.push("", "<!-- Blocks whose marker the README does not have yet -->");
    for (const key of missing) {
      const content = generatedBlock(key) as string[];
      lines.push("", `<!-- ${key} -->`);
      if (key === "exit-statuses" || key === "public-modules") lines.push("", ...content);
      else lines.push("```text", ...content, "```");
    }
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

let reported = false;

function fail(check: number, name: string, problems: string[]): void {
  if (problems.length === 0) return;
  if (!reported) {
    reported = true;
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, expectedReadme(fs.readFileSync(readmePath, "utf-8")));
  }
  const shown = problems.slice(0, 20).map((problem) => `  - ${problem}`);
  if (problems.length > shown.length) shown.push(`  - ... and ${problems.length - shown.length} more`);
  throw new Error(
    `README check ${check} (${name}) found ${problems.length} problem(s):\n${shown.join("\n")}\n` +
      `The README with the generated blocks replaced is in ${EXPECTED_NAME}.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

describe("README check", () => {
  let readme = "";

  beforeAll(() => {
    fs.rmSync(expectedPath, { force: true });
    readme = fs.readFileSync(readmePath, "utf-8");
  });

  test("1: every help block equals the rendered help", () => {
    fail(1, "help blocks", checkHelpBlocks(readme));
  });

  test("2: every command has a help block and every help marker names a command", () => {
    fail(2, "help markers", checkHelpMarkers(readme));
  });

  test("3: every subcommand and option is documented, and the options in a command's section belong to it", () => {
    fail(3, "commands and options", checkCommandsAndOptions(readme));
  });

  test("4: every the-seed line in a shell block is accepted by the parser", () => {
    fail(4, "shell blocks", checkShellBlocks(readme));
  });

  test("5: the exit-status table equals EXIT_STATUSES", () => {
    fail(5, "exit statuses", checkExitStatuses(readme));
  });

  test("6: the api-types block equals the declarations generated from src/index.ts", () => {
    fail(6, "api types", checkApiTypes(readme));
  });

  test("7: the class tables list every public member with its parameters", () => {
    fail(7, "class tables", checkClassTables(readme));
  });

  test("8: the api-example block type-checks against src/index.ts", () => {
    fail(8, "api example", checkApiExample(readme));
  });

  test("10: the Public modules table equals the exports map of package.json", () => {
    fail(10, "public modules", checkPublicModules(readme));
  });

  test("9: repository paths and links in README.md and structure.md exist, and LICENSE and structure.md are linked", () => {
    const structure = fs.existsSync(structurePath) ? fs.readFileSync(structurePath, "utf-8") : "";
    fail(9, "paths", [...checkPaths(readme, "README.md"), ...checkPaths(structure, "structure.md"), ...checkLinkedFiles(readme)]);
  });
});

describe("README check: negative self-test", () => {
  function sample(): string {
    const lines: string[] = ["# Sample", "", "See [structure](structure.md) and `src/index.ts`.", "", "## Command reference", "", "<!-- help -->", "```text"];
    lines.push(...(generatedBlock("help") as string[]), "```", "");
    for (const command of COMMANDS) {
      lines.push(`### ${command.name}`, "", `<!-- help: ${command.name} -->`, "```text", ...(generatedBlock(`help: ${command.name}`) as string[]), "```", "");
    }
    lines.push("## Exit statuses", "", "<!-- exit-statuses -->", "", ...exitStatusTable(), "");
    lines.push("## API reference", "", "<!-- api-types -->", "```ts", ...(generatedBlock("api-types") as string[]), "```", "");
    lines.push("```bash", "the-seed build native", "the-seed help signing", "```", "");
    return lines.join("\n");
  }

  const checks: Array<{ number: number; run: (text: string) => string[] }> = [
    { number: 1, run: checkHelpBlocks },
    { number: 2, run: checkHelpMarkers },
    { number: 4, run: checkShellBlocks },
    { number: 5, run: checkExitStatuses },
    { number: 6, run: checkApiTypes },
    { number: 9, run: (text) => checkPaths(text, "README.md") },
  ];

  function run(text: string): Map<number, string[]> {
    return new Map(checks.map((check) => [check.number, check.run(text)]));
  }

  test("an undamaged README is accepted by checks 1, 2, 4, 5, 6 and 9", () => {
    const results = run(sample());
    for (const [number, problems] of results) expect({ number, problems }).toEqual({ number, problems: [] });
  });

  test("check 1 reports a changed help line", () => {
    const damaged = sample().replace("Usage: the-seed", "Usage: the-seeds");
    expect(damaged).not.toBe(sample());
    expect(run(damaged).get(1)?.length).toBeGreaterThan(0);
  });

  test("check 4 reports an unknown option in an example", () => {
    const damaged = sample() + "\n```bash\nthe-seed build native --no-such-option\n```\n";
    expect(run(damaged).get(4)?.length).toBeGreaterThan(0);
  });

  test("check 9 reports a missing path", () => {
    const damaged = sample() + "\nThe code is in `src/DoesNotExist.ts`.\n";
    expect(run(damaged).get(9)?.length).toBeGreaterThan(0);
  });

  test("check 6 reports a type member that was removed", () => {
    const text = sample();
    const lines = text.split("\n");
    const start = lines.indexOf("<!-- api-types -->");
    const member = lines.findIndex((line, index) => index > start + 2 && /^ {4}\S/.test(line));
    expect(member).toBeGreaterThan(start);
    lines.splice(member, 1);
    expect(run(lines.join("\n")).get(6)?.length).toBeGreaterThan(0);
  });

  test("check 2 reports a help block for a command that does not exist", () => {
    const damaged = sample() + "\n<!-- help: nothing -->\n```text\nx\n```\n";
    expect(run(damaged).get(2)?.length).toBeGreaterThan(0);
  });

  test("check 10 reports a README without the Public modules table and sentence", () => {
    expect(checkPublicModules(sample()).length).toBeGreaterThan(0);
  });

  test("check 5 reports a changed exit-status row", () => {
    const damaged = sample().replace(/\| 3 \|/, "| 9 |");
    expect(run(damaged).get(5)?.length).toBeGreaterThan(0);
  });
});
