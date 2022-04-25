const fs = require("fs-extra");
const { execSync } = require('child_process');
import path from "path";
import os from "os";
import Config from "./Config";
import Scopes from "./Scopes";
import { ConfigType } from "./types";

const build_command = "build_command src/Template.ts";
const build_win64_command = "";

class Template {
  type: string = "";
  packageDir: string = "";
  config: Config;
  scopes: Scopes;
  package: any;

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
  }

  copyTemplate = (scope: string, name: string) => {
    const templateDir = path.join(path.dirname(require.main!.filename), "../../templates/" +  this.type);
    const scopeDir = this.config.config.prefix + "/projects/" + scope;

    const underscoreRegex = new RegExp("-", "g");
    const underscoreName = name.replace(underscoreRegex, "_");
    
    if(!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir);
    }

    // Create package from template
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
      'AUTHORS',
      'configure.ac',
      'SKELETON.pc.in',
      'Makefile.am',
      'src/Makefile.am',
      'src/SKELETON.hpp',
      'src/SKELETON.cpp'
    ];

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
    fs.renameSync(this.packageDir + "/SKELETON.pc.in", this.packageDir + "/" + name + ".pc.in");
  }

  createPackage = (scope: string, name: string) => {
    const scopeDir = this.config.config.prefix + "/projects/" + scope;
    this.packageDir = scopeDir + "/" + name;
    this.copyTemplate(scope, name);

    // Create default package.json
    execSync('npm init --yes', { cwd: this.packageDir });

    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
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
  }

  save = () => {
    fs.writeFileSync(this.packageDir + "/package.json", JSON.stringify(this.package, null, 2));
  }
}

export default Template;
