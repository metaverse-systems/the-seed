import fs from "fs-extra";
import { execSync } from "child_process";
import path from "path";
import Config from "./Config";
import Scopes from "./Scopes";
import { PackageType } from "./types";

const build_command = "the-seed build native";
const build_win64_command = "the-seed build windows";

class Template {
  type = "";
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
        "message": "Choose scope for " + this.type,
        "choices": this.scopes.getScopes()
      },
      {
        "name": "templateName",
        "message": "Choose name for " + this.type
      }
    ];
  };

  copyTemplate = (scope: string, name: string) => {
    const templateDir = path.join(__dirname, "..", "templates", this.type);
    const scopeDir = this.config.config.prefix + "/projects/" + scope;

    const underscoreRegex = new RegExp("-", "g");
    const underscoreName = name.replace(underscoreRegex, "_");
    
    if(!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }

    // Create package from template
    console.log("Copying template from " + templateDir + " to " + this.packageDir);
    fs.copySync(templateDir, this.packageDir);

    // Replace template variables with real values
    const author = this.scopes.getScope(scope).author;

    const variables: {
      [index: string]: string;
    } = {
      "AUTHOR_EMAIL": author.email,
      "AUTHOR_URL": author.url,
      "SKELETON_": underscoreName,
      "SKELETON": name
    };

    const files = [
      "AUTHORS",
      "COPYING",
      "configure.ac",
      "Makefile.am",
      "src/Makefile.am",
      "src/SKELETON.hpp",
      "src/SKELETON.cpp"
    ];

    if(this.type != "program") {
      files.push("SKELETON.pc.in");
    }

    files.forEach((file) => {
      let temp = fs.readFileSync(this.packageDir + "/" + file).toString();
      Object.keys(variables).forEach((variable) => {
        const regex = new RegExp(variable, "g");
        temp = temp.replace(regex, variables[variable]);
      });
      fs.writeFileSync(this.packageDir + "/" + file, temp);
    });

    fs.renameSync(this.packageDir + "/src/SKELETON.hpp", this.packageDir + "/src/" + name + ".hpp");
    fs.renameSync(this.packageDir + "/src/SKELETON.cpp", this.packageDir + "/src/" + name + ".cpp");
    if(this.type != "program") fs.renameSync(this.packageDir + "/SKELETON.pc.in", this.packageDir + "/" + name + ".pc.in");
  };

  createPackage = (scope: string, name: string) => {
    this.packageDir = name;
    this.copyTemplate(scope, name);

    // Create default package.json
    execSync("npm init --yes", { cwd: this.packageDir });

    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json").toString()) as PackageType;
    this.package.author = this.scopes.getScope(scope).author;
    this.package.license = "UNLICENSED";
    this.package.name = scope + "/" + name;
    this.package.version = "0.0.1";
    this.package.scripts = {
      "test": "echo \"Error: no test specified\" && exit 1",
      "build": build_command,
      "build-win64": build_win64_command
    };
    delete this.package.main;
    this.save();
  };

  save = () => {
    if (!this.package) return;
    fs.writeFileSync(this.packageDir + "/package.json", JSON.stringify(this.package, null, 2));
  };
}

export default Template;
