const fs = require("fs-extra");
const { execSync } = require("child_process");
import Config from "./Config";
import Scopes from "./Scopes";
import { PackageType } from "./types";

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
        "message": "Choose name for resource pak"
      }
    ];
  };

  createPackage = (scope: string, name: string) => {
    const scopeDir = this.config.config.prefix + "/projects/" + scope;
    if(!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir);
    }

    this.packageDir = scopeDir + "/" + name;
    if(!fs.existsSync(this.packageDir)) {
      fs.mkdirSync(this.packageDir);
    }

    // Create default package.json
    execSync("npm init --yes", { cwd: this.packageDir });

    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
    if(!this.package) {
      return;
    }
    this.package.author = this.scopes.getScope(scope).author;
    this.package.license = "UNLICENSED";
    this.package.name = scope + "/" + name;
    this.package.version = "0.0.1";
    this.package.scripts = {
      "test": "echo \"Error: no test specified\" && exit 1",
      "build": "the-seed resource-pak build"
    };
    this.package.resources = [];
    delete this.package.main;
    this.save();
  };

  save = () => {
    fs.writeFileSync(
      this.packageDir + "/package.json",
      JSON.stringify(this.package, null, 2)
    );
  };

  addResource = (name: string, filename: string) => {
    this.packageDir = process.cwd();
    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
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

    const stats = fs.statSync(filename);
    this.package.resources.push({
      name: name,
      filename: filename,
      size: stats.size,
    });
    this.save();
  };

  build = () => {
    this.packageDir = process.cwd();
    this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
    if (!this.package) {
      return;
    }
    
    // make a copy of this.package.resources that doesn't include the filename
    // property
    const resources = this.package.resources.map((r) => {
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
    header.headerSize = JSON.stringify(header).length.toString().padStart(10, "0");

    const [, name] = this.package.name.split("/");
    fs.writeFileSync(this.packageDir + "/" + name + ".pak", JSON.stringify(header));
    this.package.resources.forEach((r) => {
      fs.appendFileSync(name + ".pak", fs.readFileSync(r.filename));
    });
  };
}

export default ResourcePak;
