import fs from "fs";
import { ConfigType } from "./types";
import Config from "./Config";

class Scopes {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  askWhichScope = () => {
    return [
      {
        "type": "list",
        "name": "scopeName",
        "message": "Which scope?",
        "choices": this.getScopes()
      }
    ];
  };

  askNewScope = () => {
    return [
      {
        "name": "scopeName",
        "message": "Name for scope?",
      },
      ...this.askEditScope()
    ];
  };

  askEditScope = (defaults?: any) => {
    return [
      {
        "name": "authorName",
        "message": "Your name?",
        "default": defaults?.name ? defaults.name : ""
      },
      {
        "name": "authorEmail",
        "message": "Your email?",
        "default": defaults?.email ? defaults.email : ""
      },
      {
        "name": "authorURL",
        "message": "Your URL?",
        "default": defaults?.url ? defaults.url : ""
      }
    ];
  };

  createOrEditScope = (answers: any) => {
    let name = "";
    if(answers.scopeName[0] != "@") name = "@";
    name += answers.scopeName;

    this.config.config.scopes[name] = {
      author: {
        name: answers.authorName,
        email: answers.authorEmail,
        url: answers.authorURL
      }
    };
  };

  deleteScope = (scope: string) => {
    let name = "";
    if(scope[0] != "@") name = "@";
    name += scope;

    console.log("Deleting scope " + name);
    if(!Object.keys(this.config.config.scopes).includes(name)) {
      console.error("Scope does not exist.");
      return;
    }

    delete this.config.config.scopes[name];
  };

  getScopes = () => {
    const scopes: string[] = Object.keys(this.config.config.scopes);

    return scopes;
  };

  getScope = (scope: string) => {
    return this.config.config.scopes[scope];
  }

  getQuestions = (defaults: any) => {
    return [
      {
        name: "scopeName",
        message: "Scope name?",
        default: defaults.scopeName || null
      }
    ];
  };
}

export default Scopes;
