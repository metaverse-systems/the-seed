import fs from "fs";

class Scopes {
  configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  createScope = (scope: string) => {
    let name = "";
    if(scope[0] != "@") name = "@";
    name += scope;

    const dir = this.configDir + name;

    console.log("Creating scope '" + name + "' in '" + this.configDir + "'.");

    if(fs.existsSync(dir)) {
      console.error(dir + " already exists.");
      return;
    }

    fs.mkdirSync(dir);
  }

  deleteScope = (scope: string) => {
    let name = "";
    if(scope[0] != "@") name = "@";
    name += scope;

    const dir = this.configDir + name;

    console.log("Deleting scope '" + name + "' in '" + this.configDir + "'.");
    if(!fs.existsSync(dir)) {
      console.error(dir + " does not exist.");
      return;
    }

    fs.rmSync(dir, { recursive: true });
  }

  getScopes = () => {
    const scopes: string[] = [];
    const dirs = fs.readdirSync(this.configDir);
    dirs.forEach((entry: string) => {
      const stats = fs.statSync(this.configDir + entry);
      if(!stats.isDirectory()) return;

      scopes.push(entry);
    });

    return scopes;
  }
}

export default Scopes;
