/*
 * Finds the command lines the tool prints (`the-seed <command> ...`) in source text and checks that
 * each one is written inside double quotes and is accepted by the command-line parser.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - Comments are blanked out (line numbers are kept) before the search, because they are never
 *   printed. String, template and regular-expression literals are recognised so that `//` inside
 *   a string does not start a comment.
 * - A match is `the-seed ` followed by a lowercase letter that is not preceded by a letter, digit,
 *   `-`, `_`, `.`, `/` or `@` (so `libthe-seed`, `/the-seed/`, `~/the-seed` and
 *   `@metaverse-systems/the-seed` are not command lines).
 * - A match directly after `Usage: ` is a usage synopsis (grammar notation such as
 *   `[<command> [<subcommand>]]`), not a line to type, and is not checked.
 * - A literal that consists of one command line and nothing else (`"the-seed build native"`, as
 *   used for a command a template or a package description runs) needs no inner quotes: the whole
 *   literal is the command line.
 * - A quoted span is `\"...\"` inside a double-quoted literal and `"..."` inside a single-quoted or
 *   template literal. The span ends at the next quote mark; a literal that ends before one (for
 *   example a string continued by concatenation) is reported as not quoted.
 * - Inside the span, optional parts in square brackets (nested ones included) are dropped, as are
 *   `...` markers, before the words are given to the parser.
 * - In a template literal, `${expression}` is replaced by the sample for the expression's last
 *   identifier, except that `command.name` counts as `command` (the name of a command is a
 *   command, not a project name).
 * - The outcome of `parseCommandLine` must be `help` or `run`.
 */
import * as fs from "fs";
import * as path from "path";
import { parseCommandLine } from "../../src/cli/ParseArgs";

/** One command line that is not quoted or that the parser does not accept. */
export interface HintFinding {
  file: string;
  /** 1-based line of the command line */
  line: number;
  reason: string;
}

/** What a scan found. */
export interface HintScanResult {
  findings: HintFinding[];
  /** The number of command lines that were quoted and given to the parser */
  checked: number;
}

/** The sample a placeholder name stands for, or null when the name is not known. */
export function placeholderSample(name: string, afterCommand: boolean): string | null {
  switch (name) {
    case "scope":
      return "@sample";
    case "path":
    case "file":
    case "filename":
    case "output-directory":
    case "project-dir":
    case "dir":
      return "./sample";
    case "n":
    case "days":
    case "jobs":
      return "1";
    case "target":
      return "native";
    case "command":
      return "signing";
    case "subcommand":
      return afterCommand ? "sign" : null;
    case "resource-name":
    case "name":
      return "sample";
    default:
      return null;
  }
}

interface Literal {
  /** index of the first character after the opening delimiter */
  start: number;
  /** index of the closing delimiter */
  end: number;
  delimiter: string;
}

const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";

/** Blanks comments and lists the string and template literals of a source text. */
function tokenize(text: string): { code: string; literals: Literal[] } {
  const chars = text.split("");
  const literals: Literal[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (chars[k] !== "\n") chars[k] = " ";
    }
  };

  // Reads code from `i` until the end of the text, or, when `nested`, until the `}` that closes a template expression.
  const scanCode = (from: number, nested: boolean): number => {
    let i = from;
    let depth = 0;
    let lastSignificant = "";
    while (i < text.length) {
      const c = text[i];
      const next = text[i + 1];
      if (c === "/" && next === "/") {
        let j = i;
        while (j < text.length && text[j] !== "\n") j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === "/" && next === "*") {
        let j = text.indexOf("*/", i + 2);
        j = j === -1 ? text.length : j + 2;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === "'" || c === "\"") {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== "\n") {
          j += text[j] === "\\" ? 2 : 1;
        }
        literals.push({ start: i + 1, end: j, delimiter: c });
        i = j + 1;
        lastSignificant = c;
        continue;
      }
      if (c === "`") {
        const start = i + 1;
        let j = start;
        while (j < text.length && text[j] !== "`") {
          if (text[j] === "\\") {
            j += 2;
          } else if (text[j] === "$" && text[j + 1] === "{") {
            j = scanCode(j + 2, true);
          } else {
            j++;
          }
        }
        literals.push({ start, end: j, delimiter: "`" });
        i = j + 1;
        lastSignificant = "`";
        continue;
      }
      if (c === "/" && (lastSignificant === "" || REGEX_PRECEDERS.includes(lastSignificant))) {
        let j = i + 1;
        let inClass = false;
        while (j < text.length && text[j] !== "\n" && (inClass || text[j] !== "/")) {
          if (text[j] === "\\") j++;
          else if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          j++;
        }
        i = j + 1;
        lastSignificant = "/";
        continue;
      }
      if (nested) {
        if (c === "{") depth++;
        if (c === "}") {
          if (depth === 0) return i + 1;
          depth--;
        }
      }
      if (!/\s/.test(c)) lastSignificant = c;
      i++;
    }
    return i;
  };

  scanCode(0, false);
  return { code: chars.join(""), literals };
}

/** The raw text of a literal with each `${expression}` replaced by a marker holding its last identifier. */
function literalBody(code: string, literal: Literal): string {
  const raw = code.slice(literal.start, literal.end);
  if (literal.delimiter !== "`") return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\\") {
      out += raw.slice(i, i + 2);
      i += 2;
    } else if (raw[i] === "$" && raw[i + 1] === "{") {
      let depth = 0;
      let j = i + 2;
      while (j < raw.length && !(raw[j] === "}" && depth === 0)) {
        if (raw[j] === "{") depth++;
        if (raw[j] === "}") depth--;
        j++;
      }
      const identifiers = raw.slice(i + 2, j).match(/[A-Za-z_$][\w$]*/g) ?? [];
      let last = identifiers.length > 0 ? identifiers[identifiers.length - 1] : "";
      if (last === "name" && identifiers.length > 1 && identifiers[identifiers.length - 2] === "command") last = "command";
      out += "\uE000" + last + "\uE001";
      i = j + 1;
    } else {
      out += raw[i];
      i++;
    }
  }
  return out;
}

/** Removes optional parts in square brackets (nested ones included) and `...` markers. */
function dropOptionals(span: string): string {
  let out = "";
  let depth = 0;
  for (const c of span) {
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out.replace(/\.\.\./g, "");
}

/**
 * Splits a quoted command line (the text after `the-seed `) into the words the parser is given,
 * replacing placeholders by samples. Returns an error text instead when a placeholder is unknown.
 */
export function wordsOfCommandLine(span: string): { words: string[] } | { error: string } {
  const words: string[] = [];
  let afterCommand = false;
  for (const raw of dropOptionals(span).split(/\s+/).filter((word) => word !== "")) {
    let unknown: string | null = null;
    const word = raw.replace(/<([^<>]*)>|\uE000([^\uE001]*)\uE001/g, (_match, angle: string | undefined, expression: string | undefined) => {
      const name = angle ?? expression ?? "";
      const sample = placeholderSample(name, afterCommand);
      if (sample === null) {
        unknown = name;
        return name;
      }
      return sample;
    });
    if (unknown !== null) {
      return { error: `unknown placeholder "${unknown}"` };
    }
    afterCommand = /<command>|\uE000command\uE001/.test(raw);
    words.push(word);
  }
  return { words };
}

/**
 * Checks one command line (the words after `the-seed `): the placeholders are replaced and the
 * words given to `parseCommandLine`. Returns the reason it is not acceptable, or null.
 */
export function checkCommandLine(span: string): string | null {
  const split = wordsOfCommandLine(span);
  if ("error" in split) return split.error;
  const outcome = parseCommandLine(split.words);
  if (outcome.kind === "usage") {
    return `the parser rejects "the-seed ${split.words.join(" ")}": ${outcome.error.message}`;
  }
  return null;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Scans a source text (TypeScript or JavaScript) for printed command lines. */
export function scanHintText(text: string, file: string): HintScanResult {
  const { code, literals } = tokenize(text);
  const findings: HintFinding[] = [];
  let checked = 0;

  for (const literal of literals) {
    const body = literalBody(code, literal);
    const quote = literal.delimiter === "\"" ? /\\"/g : /\\"|"/g;
    const quotes: number[] = [];
    for (let m = quote.exec(body); m !== null; m = quote.exec(body)) {
      quotes.push(m.index);
      quote.lastIndex = m.index + m[0].length;
    }

    const pattern = /the-seed (?=[a-z])/g;
    for (let m = pattern.exec(body); m !== null; m = pattern.exec(body)) {
      const found = m.index;
      const before = body[found - 1] ?? "";
      if (/[A-Za-z0-9_./@-]/.test(before)) continue;
      if (body.slice(Math.max(0, found - 7), found) === "Usage: ") continue;
      const line = lineOf(text, literal.start) + body.slice(0, found).split("\n").length - 1;
      if (found === 0 && !body.includes("\n") && quotes.length === 0) {
        checked++;
        const problem = checkCommandLine(body.slice("the-seed ".length));
        if (problem !== null) findings.push({ file, line, reason: problem });
        continue;
      }
      const opening = quotes.filter((at) => at < found).length;
      const closing = quotes.find((at) => at > found);
      if (opening % 2 === 0 || closing === undefined) {
        findings.push({ file, line, reason: "command line not quoted" });
        continue;
      }
      const span = body.slice(found + "the-seed ".length, closing);
      checked++;
      const problem = checkCommandLine(span);
      if (problem !== null) {
        findings.push({ file, line, reason: problem });
      }
    }
  }
  return { findings, checked };
}

/** Lists the `.ts` files under `dir`, in order. */
function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** The files the tool prints from: every `.ts` file under `src` and every `.js` file directly in `native`, under the package root. */
export function hintSourceFiles(packageRoot: string): string[] {
  const native = path.join(packageRoot, "native");
  const scripts = fs.existsSync(native)
    ? fs.readdirSync(native).filter((name) => name.endsWith(".js")).sort().map((name) => path.join(native, name))
    : [];
  return [...typescriptFiles(path.join(packageRoot, "src")), ...scripts];
}

/** Scans the files and gathers the findings, with files named relative to the package root. */
export function scanHintFiles(packageRoot: string, files: string[]): HintScanResult {
  const all: HintScanResult = { findings: [], checked: 0 };
  for (const file of files) {
    const result = scanHintText(fs.readFileSync(file, "utf-8"), path.relative(packageRoot, file).split(path.sep).join("/"));
    all.findings.push(...result.findings);
    all.checked += result.checked;
  }
  return all;
}
