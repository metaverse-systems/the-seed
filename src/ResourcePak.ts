import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import Config from "./Config";
import Scopes from "./Scopes";
import { PackageAuthorType, PackageType, PakProjectType } from "./types";
import { ProjectError } from "./ProjectError";
import { validateProjectName } from "./ProjectName";
import { createPakHint, editScopeHint } from "./cli/Hints";

class ResourcePak {
  packageDir = "";
  config: Config;
  scopes: Scopes;
  package?: PackageType;
  
  constructor(config: Config) {
    this.config = config;
    this.scopes = new Scopes(config);
  }

  askName = () => {
    return [
      {
        "type": "list",
        "name": "scopeName",
        "message": "Choose scope for resource pak",
        "choices": this.scopes.getScopes()
      },
      {
        "name": "pakName",
        "message": "Choose name for resource pak",
        "validate": (name: string): true | string => validateProjectName(name, "resource-pak") ?? true
      }
    ];
  };

  /**
   * Creates the resource pak project <parentDir>/<name>.
   * Before anything is written it checks the name, the scope, the author's name and the target; the project is
   * written into a hidden sibling and renamed into place.
   * @param scope Scope the project belongs to, with its "@"
   * @param name Project name
   * @param parentDir Directory the project is created in (the current directory by default)
   * @returns The absolute path of the new project
   * @throws ProjectError when the project cannot be created
   */
  createPackage = (scope: string, name: string, parentDir: string = process.cwd()): string => {
    const invalid = validateProjectName(name, "resource-pak");
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

    const parent = path.resolve(parentDir);
    const target = path.join(parent, name);
    if (this.exists(target)) {
      throw new ProjectError("target-exists", `${target} already exists; nothing was created.`);
    }

    const packageAuthor: PackageAuthorType = { name: author.name };
    if (author.email) packageAuthor.email = author.email;
    if (author.url) packageAuthor.url = author.url;
    const description: PackageType = {
      name: `${scope}/${name}`,
      version: "0.0.1",
      author: packageAuthor,
      license: "UNLICENSED",
      scripts: {
        "build": "the-seed resource-pak build"
      },
      resources: []
    };

    const hidden = path.join(parent, `.${name}.creating-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.mkdirSync(hidden);
      fs.writeFileSync(path.join(hidden, "package.json"), JSON.stringify(description, null, 2) + "\n");
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
    return target;
  };

  private exists = (file: string): boolean => {
    try {
      fs.lstatSync(file);
      return true;
    } catch {
      return false;
    }
  };

  save = () => {
    fs.writeFileSync(
      this.packageDir + "/package.json",
      JSON.stringify(this.package, null, 2)
    );
  };

  addResource = (name: string, filename: string, packageDir?: string) => {
    this.packageDir = packageDir ?? process.cwd();
    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json").toString());
    if (!this.package) {
      return;
    }
    
    if (this.package.resources) {
      if(this.package.resources.find((r) => r.name === name)) {
        return;
      }
    } else {
      this.package.resources = [];
    }

    const fullPath = this.packageDir + "/" + filename;
    const stats = fs.statSync(fullPath);
    this.package.resources.push({
      name: name,
      filename: filename,
      size: stats.size,
    });
    this.save();
  };

  /**
   * Reads and checks the description of the resource pak project in a directory.
   * @param packageDir The project directory
   * @returns The parsed description
   * @throws ProjectError ("not-pak-project") naming the rule that failed
   */
  readProject = (packageDir: string): PakProjectType => {
    const dir = path.resolve(packageDir);
    const refuse = (rule: string): never => {
      throw new ProjectError("not-pak-project", `${dir} is not a resource pak project: ${rule}.`, createPakHint());
    };

    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return refuse("no package.json");
      }
      return refuse(`package.json cannot be read (${(error as Error).message.split("\n")[0]})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return refuse(`package.json is not valid JSON (${(error as Error).message.split("\n")[0]})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return refuse("package.json is not a JSON object");
    }

    const description = parsed as Record<string, unknown>;
    const name = description.name;
    if (typeof name !== "string" || !/^@[^/]+\/[^/]+$/.test(name)) {
      return refuse("\"name\" is not of the form @scope/name");
    }
    if (description.resources === undefined) {
      return refuse("package.json has no \"resources\" list");
    }
    if (!Array.isArray(description.resources)) {
      return refuse("\"resources\" is not a list");
    }
    description.resources.forEach((entry: unknown, index: number) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return refuse(`entry ${index} of "resources" is not an object`);
      }
      const resource = entry as Record<string, unknown>;
      if (typeof resource.name !== "string") {
        return refuse(`entry ${index} of "resources" has no "name" text`);
      }
      if (typeof resource.filename !== "string") {
        return refuse(`entry ${index} of "resources" has no "filename" text`);
      }
      const attributes = resource.attributes;
      if (attributes !== undefined) {
        const valid = typeof attributes === "object" && attributes !== null && !Array.isArray(attributes)
          && Object.values(attributes).every((value) => typeof value === "string");
        if (!valid) {
          return refuse(`"attributes" of entry ${index} of "resources" is not an object of text values`);
        }
      }
    });
    return description as unknown as PakProjectType;
  };

  /**
   * Builds the pak of the resource pak project in a directory. Sizes and bytes come from the files at build time.
   * The pak is written to a hidden temporary file and renamed over `<name>.pak`, so a failure leaves any
   * existing pak as it was.
   * @param packageDir The project directory
   * @returns The path of the pak
   * @throws ProjectError when the project or a resource is unusable or the pak cannot be written
   */
  build = (packageDir: string): string => {
    const dir = path.resolve(packageDir);
    const project = this.readProject(dir);

    // Names: well-formed text, each once
    const seen = new Set<string>();
    project.resources.forEach((resource, index) => {
      if (!ResourcePak.wellFormed(resource.name)) {
        throw new ProjectError("not-pak-project", `Resource ${index} has a name that is not valid Unicode text.`);
      }
      if (seen.has(resource.name)) {
        throw new ProjectError("not-pak-project", `Resource "${resource.name}" appears more than once in package.json.`);
      }
      seen.add(resource.name);
    });

    // Files: present, regular and inside the project; their sizes now are the sizes stated
    const root = fs.realpathSync(dir);
    const files = project.resources.map((resource) => {
      const refers = (state: string): ProjectError =>
        new ProjectError("resource-file-missing", `Resource "${resource.name}" refers to ${resource.filename}, which ${state}.`);
      const file = path.resolve(dir, resource.filename);
      if (!ResourcePak.inside(dir, file)) throw refers("is outside the project");
      let stats: fs.Stats;
      let real: string;
      try {
        stats = fs.statSync(file);
        real = fs.realpathSync(file);
      } catch {
        throw refers("is missing");
      }
      if (!ResourcePak.inside(root, real)) throw refers("is outside the project");
      if (!stats.isFile()) throw refers("is not a file");
      return { file, size: stats.size, filename: resource.filename };
    });

    const entries = project.resources.map((resource, index) => ({
      name: resource.name,
      size: files[index].size,
      attributes: resource.attributes
    }));
    const header = {
      name: project.name,
      headerSize: "0000000000",
      resources: entries,
    };
    const size = Buffer.byteLength(JSON.stringify(header), "utf8") + 1;
    if (size > 9999999999) {
      throw new ProjectError("write-failed", "The pak's description is too large to state its size in ten digits.");
    }
    header.headerSize = size.toString().padStart(10, "0");
    const line = Buffer.from(JSON.stringify(header) + "\n", "utf8");
    if (line.length !== size) {
      throw new ProjectError("write-failed", "The pak's description changed length while its size was stated.");
    }

    const pak = path.join(dir, project.name.split("/")[1] + ".pak");
    const temporary = path.join(dir, `.${project.name.split("/")[1]}.pak.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    let descriptor = -1;
    try {
      descriptor = fs.openSync(temporary, "wx");
      fs.writeSync(descriptor, line);
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      for (const entry of files) {
        let copied = 0;
        const source = fs.openSync(entry.file, "r");
        try {
          for (;;) {
            const count = fs.readSync(source, chunk, 0, chunk.length, null);
            if (count === 0) break;
            copied += count;
            if (copied > entry.size) break;
            ResourcePak.writeAll(descriptor, chunk, count);
          }
        } finally {
          fs.closeSync(source);
        }
        if (copied !== entry.size) {
          throw new ProjectError("resource-changed", `${entry.filename} changed while the pak was written; build again.`);
        }
      }
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = -1;
      fs.renameSync(temporary, pak);
    } catch (error) {
      if (descriptor >= 0) {
        try { fs.closeSync(descriptor); } catch { /* the failure being reported is the first one */ }
      }
      fs.rmSync(temporary, { force: true });
      if (error instanceof ProjectError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProjectError("write-failed", `Cannot write ${pak}: ${reason}`);
    }
    return pak;
  };

  /** True when the text has no unpaired surrogate, so that UTF-8 can carry it. */
  private static wellFormed = (text: string): boolean =>
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

  /** True when the path is the directory or lies below it (lexically). */
  private static inside = (directory: string, file: string): boolean => {
    const relative = path.relative(directory, file);
    return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  private static writeAll = (descriptor: number, buffer: Buffer, length: number): void => {
    let written = 0;
    while (written < length) {
      written += fs.writeSync(descriptor, buffer, written, length - written);
    }
  };
}

export default ResourcePak;
