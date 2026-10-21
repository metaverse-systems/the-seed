import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import Config from "./Config";
import Scopes from "./Scopes";
import { PackageAuthorType, PackageType } from "./types";
import { ProjectError } from "./ProjectError";
import { validateProjectName } from "./ProjectName";
import { editScopeHint } from "./cli/Hints";

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

  build = (packageDir?: string) => {
    this.packageDir = packageDir ?? process.cwd();
    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json").toString());
    if (!this.package) {
      return;
    }
    
    // make a copy of this.package.resources that doesn't include the filename
    // property
    const resources = (this.package.resources ?? []).map((r) => {
      return {
        name: r.name,
        size: r.size,
        attributes: r.attributes
      };
    });
    
    const header = {
      name: this.package.name,
      headerSize: JSON.stringify(resources)
        .length.toString()
        .padStart(10, "0"),
      resources: resources,
    };
    header.headerSize = (JSON.stringify(header).length + 1).toString().padStart(10, "0");

    const [, name] = this.package.name.split("/");
    fs.writeFileSync(this.packageDir + "/" + name + ".pak", JSON.stringify(header) + "\n");
    (this.package.resources ?? []).forEach((r) => {
      fs.appendFileSync(this.packageDir + "/" + name + ".pak", fs.readFileSync(this.packageDir + "/" + r.filename));
    });
  };
}

export default ResourcePak;
