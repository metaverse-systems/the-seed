import fs from "fs";
import path from "path";
import { ProjectError } from "./ProjectError";

/** The format a file's values are escaped for, chosen by file name. */
export type TemplateFileFormat = "autoconf" | "pkg-config" | "cpp" | "text";

/** The values a template can use; each is available as `{{key}}`. */
export interface TemplateValues {
  name: string;
  identifier: string;
  scope: string;
  package: string;
  kind: string;
  kind_title: string;
  author_name: string;
  author_contact: string;
  author_email: string;
  author_url: string;
  pc_url_line: string;
  readme_url_line: string;
  year: string;
  ecs_cpp_version: string;
  the_seed_version: string;
}

interface RenderedFile {
  relative: string;
  content: string;
  mode: number;
}

const variablePattern = /\{\{([a-z0-9_]+)\}\}/g;

function formatOf(fileName: string): TemplateFileFormat {
  if (fileName === "configure.ac") return "autoconf";
  if (fileName.endsWith(".pc.in")) return "pkg-config";
  if (fileName.endsWith(".cpp") || fileName.endsWith(".hpp")) return "cpp";
  return "text";
}

function escapeFor(format: TemplateFileFormat, value: string): string {
  switch (format) {
    case "pkg-config":
      return value.replace(/#/g, "\\#");
    case "cpp":
      return value.replace(/[\\"]/g, "\\$&");
    default:
      return value;
  }
}

function lookup(values: TemplateValues, variable: string, where: string): string {
  if (!Object.prototype.hasOwnProperty.call(values, variable)) {
    throw new Error(`Unknown variable "${variable}" in ${where}`);
  }
  return values[variable as keyof TemplateValues];
}

/** One pass over the text: each variable is replaced once, and a replacement is never scanned again. */
function substitute(text: string, values: TemplateValues, where: string, format: TemplateFileFormat): string {
  return text.replace(variablePattern, (_match, variable: string) => escapeFor(format, lookup(values, variable, where)));
}

/** Substitutes a template's contents, dropping each line whose whole content is a variable with an empty value. */
function substituteContent(text: string, values: TemplateValues, where: string, format: TemplateFileFormat): string {
  const kept: string[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.endsWith("\n") ? line.slice(0, -1) : line;
    const whole = /^\{\{([a-z0-9_]+)\}\}$/.exec(body);
    if (whole && lookup(values, whole[1], where) === "") {
      continue;
    }
    kept.push(substitute(line, values, where, format));
  }
  return kept.join("");
}

function collect(templateDir: string, relativeDir: string, values: TemplateValues, files: RenderedFile[], directories: string[]): void {
  const directory = path.join(templateDir, relativeDir);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const templateRelative = path.join(relativeDir, entry.name);
    const renderedName = substitute(entry.name, values, templateRelative, "text");
    const renderedRelative = path.join(relativeDir === "" ? "" : renderedDirectory(relativeDir, values), renderedName);
    const source = path.join(templateDir, templateRelative);
    if (fs.statSync(source).isDirectory()) {
      directories.push(renderedRelative);
      collect(templateDir, templateRelative, values, files, directories);
      continue;
    }
    const outputName = renderedName === "gitignore" ? ".gitignore" : renderedName;
    const outputRelative = path.join(path.dirname(renderedRelative), outputName);
    const format = formatOf(outputName);
    const content = substituteContent(fs.readFileSync(source, "utf8"), values, templateRelative, format);
    const mode = outputName === "autogen.sh" ? 0o755 : fs.statSync(source).mode & 0o777;
    files.push({ relative: outputRelative, content, mode });
  }
}

/** The rendered form of a template-relative directory path. */
function renderedDirectory(relativeDir: string, values: TemplateValues): string {
  return relativeDir
    .split(path.sep)
    .map((part) => substitute(part, values, relativeDir, "text"))
    .join(path.sep);
}

function failure(error: unknown, targetDir: string): ProjectError {
  const reason = error instanceof Error ? error.message : String(error);
  return new ProjectError("write-failed", `${targetDir} could not be written: ${reason}`);
}

/**
 * Renders every file under templateDir into targetDir (which must not exist): file names and contents,
 * one pass per file, values escaped for the file's format; a line holding only an empty variable is dropped;
 * "gitignore" becomes ".gitignore"; "autogen.sh" gets mode 0755.
 * Throws ProjectError("write-failed") on I/O failure and Error on an unknown variable (a template defect).
 * Nothing is left in the target's place after a failure.
 */
export function renderTemplate(templateDir: string, targetDir: string, values: TemplateValues): void {
  if (fs.existsSync(targetDir) || isLink(targetDir)) {
    throw new ProjectError("write-failed", `${targetDir} already exists; nothing was written.`);
  }

  const files: RenderedFile[] = [];
  const directories: string[] = [];
  try {
    collect(templateDir, "", values, files, directories);
  } catch (error) {
    if (error instanceof Error && !isSystemError(error)) {
      throw error;
    }
    throw failure(error, targetDir);
  }

  try {
    fs.mkdirSync(targetDir);
  } catch (error) {
    throw failure(error, targetDir);
  }
  try {
    for (const directory of directories) {
      fs.mkdirSync(path.join(targetDir, directory), { recursive: true });
    }
    for (const file of files) {
      const destination = path.join(targetDir, file.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content);
      fs.chmodSync(destination, file.mode);
    }
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw failure(error, targetDir);
  }
}

function isLink(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isSystemError(error: Error): boolean {
  return typeof (error as NodeJS.ErrnoException).code === "string";
}
