import fs from "fs";
import { ConfigType } from "./types";

class Scopes {
  config: ConfigType;

  constructor(config: ConfigType) {
    this.config = config;
  }

  createScope = (scope: string) => {
    let name = "";
    if(scope[0] != "@") name = "@";
    name += scope;

    console.log("Creating scope '" + name);
    if(Object.keys(this.config.scopes).includes(name)) {
      console.error("Scope already exists");
      return;
    }

    this.config.scopes[name] = {
      author: {
        name: "",
        email: "",
        url: ""
      }
    };
  };

  deleteScope = (scope: string) => {
    let name = "";
    if(scope[0] != "@") name = "@";
    name += scope;

    console.log("Deleting scope '" + name);
    if(!Object.keys(this.config.scopes).includes(name)) {
      console.error("Scope does not exist.");
      return;
    }

    delete this.config.scopes[name];
  };

  getScopes = () => {
    const scopes: string[] = Object.keys(this.config.scopes);

    return scopes;
  };
}

export default Scopes;
