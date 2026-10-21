import crypto from "crypto";
import fs from "fs";
import path from "path";
import Config from "./Config";
import Scopes from "./Scopes";
import { PackageAuthorType, PackageType } from "./types";
import { ProjectError } from "./ProjectError";
import { toIdentifier, validateProjectName } from "./ProjectName";
import { REQUIRED_VERSIONS } from "./RequiredVersions";
import { renderTemplate, TemplateValues } from "./TemplateEngine";
import { editScopeHint } from "./cli/Hints";

const build_command = "the-seed build native";
const build_win64_command = "the-seed build windows";

type TemplateKind = "component" | "system" | "program";

const kindTitles: Record<TemplateKind, string> = {
  component: "a component for libecs-cpp",
  system: "a system for libecs-cpp",
  program: "a program for The Seed"
};

/** Characters the build configuration (AC_INIT) cannot hold in an email or web address, besides control characters. */
const unusableCharacters = "[]$'\"\\`";

const isControl = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

class Template {
  type: TemplateKind = "component";
  /** Absolute path of the last project created */
  packageDir = "";
  config: Config;
  scopes: Scopes;

  constructor(config: Config) {
    this.config = config;
    this.scopes = new Scopes(config);
  }

  askName = () => {
    return [
      {
        "type": "list",
        "name": "scopeName",
        "message": "Choose scope for " + this.type,
        "choices": this.scopes.getScopes()
      },
      {
        "name": "templateName",
        "message": "Choose name for " + this.type,
        "validate": (name: string): true | string => validateProjectName(name, this.type) ?? true
      }
    ];
  };

  /**
   * Creates the project <parentDir>/<name> from the template of this.type.
   * Before anything is written it checks, in order, the name, the scope, the author's name, the author's email and
   * web address, and the target; the project is rendered into a hidden sibling and renamed into place.
   * @param scope Scope the project belongs to, with its "@"
   * @param name Project name
   * @param parentDir Directory the project is created in (the current directory by default)
   * @param now Date the copyright year is taken from (the current date by default)
   * @returns The absolute path of the new project
   * @throws ProjectError when the project cannot be created
   */
  createPackage = (scope: string, name: string, parentDir: string = process.cwd(), now: Date = new Date()): string => {
    const invalid = validateProjectName(name, this.type);
    if (invalid !== null) {
      throw new ProjectError("invalid-name", invalid);
    }
    const configured = this.config.config.scopes;
    if (!Object.prototype.hasOwnProperty.call(configured, scope)) {
      const names = Object.keys(configured);
      throw new ProjectError("unknown-scope",
        `Scope "${scope}" is not configured. Configured scopes: ${names.length > 0 ? names.join(", ") : "none"}.`);
    }
    const author = configured[scope].author;

    if (!author.name || author.name.trim() === "") {
      throw new ProjectError("author-name-missing", `Required author name is missing for scope '${scope}'.`, editScopeHint(scope));
    }
    this.checkDetail(scope, "email", author.email);
    this.checkDetail(scope, "web address", author.url);

    const parent = path.resolve(parentDir);
    const target = path.join(parent, name);
    if (this.exists(target)) {
      throw new ProjectError("target-exists", `${target} already exists; nothing was created.`);
    }

    const email = author.email ?? "";
    const url = author.url ?? "";
    const values: TemplateValues = {
      name,
      identifier: toIdentifier(name),
      scope,
      package: `${scope}/${name}`,
      kind: this.type,
      kind_title: kindTitles[this.type],
      author_name: author.name,
      author_contact: email !== "" ? `${author.name} <${email}>` : author.name,
      author_email: email,
      author_url: url,
      pc_url_line: url !== "" ? `URL: ${url}` : "",
      readme_url_line: url !== "" ? `Web: ${url}` : "",
      year: String(now.getFullYear()),
      ecs_cpp_version: REQUIRED_VERSIONS["ecs-cpp"],
      the_seed_version: REQUIRED_VERSIONS["the-seed"]
    };

    const templateDir = path.join(__dirname, "..", "templates", this.type);
    const hidden = path.join(parent, `.${name}.creating-${crypto.randomBytes(6).toString("hex")}`);
    try {
      renderTemplate(templateDir, hidden, values);
      fs.writeFileSync(path.join(hidden, "package.json"), JSON.stringify(this.describe(values, author), null, 2) + "\n");
      if (this.exists(target)) {
        throw new ProjectError("target-exists", `${target} already exists; nothing was created.`);
      }
      fs.renameSync(hidden, target);
    } catch (error) {
      fs.rmSync(hidden, { recursive: true, force: true });
      if (error instanceof ProjectError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProjectError("write-failed", `${target} could not be created: ${reason}`);
    }

    this.packageDir = target;
    return target;
  };

  private describe = (values: TemplateValues, author: { name: string; email?: string; url?: string }): PackageType => {
    const packageAuthor: PackageAuthorType = { name: author.name };
    if (values.author_email !== "") packageAuthor.email = values.author_email;
    if (values.author_url !== "") packageAuthor.url = values.author_url;
    return {
      name: values.package,
      version: "0.0.1",
      description: `${values.name}, ${values.kind_title}`,
      author: packageAuthor,
      license: "MIT",
      scripts: {
        "build": build_command,
        "build-win64": build_win64_command
      }
    };
  };

  private checkDetail = (scope: string, detail: string, value: string | undefined): void => {
    const character = Array.from(value ?? "").find((c) => unusableCharacters.includes(c) || isControl(c));
    if (character === undefined) return;
    const shown = isControl(character) ? "a control character" : `"${character}"`;
    throw new ProjectError("author-detail-unusable",
      `The author's ${detail} for scope ${scope} contains ${shown}, which the build configuration cannot hold.`,
      editScopeHint(scope));
  };

  private exists = (file: string): boolean => {
    try {
      fs.lstatSync(file);
      return true;
    } catch {
      return false;
    }
  };
}

export default Template;
