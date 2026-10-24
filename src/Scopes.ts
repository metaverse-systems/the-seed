import { PromptQuestion, ScopeAnswersType, ScopeDefaultsType } from "./types";
import Config from "./Config";

/**
 * Checks a scope name as typed, with or without its leading "@".
 * @returns null when the name is usable, otherwise the reason it is not
 */
export function validateScopeName(name: string): string | null {
  const bare = name.startsWith("@") ? name.slice(1) : name;
  if (bare === "") {
    return "A scope name cannot be empty.";
  }
  if (bare.includes("/")) {
    return "A scope name cannot contain \"/\".";
  }
  if (/\s/.test(bare)) {
    return "A scope name cannot contain spaces or other whitespace.";
  }
  return null;
}

/** Thrown when a new scope is given a name that is not usable; the message is the reason. */
export class ScopeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeNameError";
  }
}

class Scopes {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  askWhichScope(): PromptQuestion[] {
    return [
      {
        "type": "list",
        "name": "scopeName",
        "message": "Which scope?",
        "choices": this.getScopes()
      }
    ];
  }

  askNewScope(): PromptQuestion[] {
    return [
      {
        "name": "scopeName",
        "message": "Name for scope?",
        "validate": (input: string): true | string => validateScopeName(input) ?? true,
      },
      ...this.askEditScope()
    ];
  }

  askEditScope(defaults?: ScopeDefaultsType): PromptQuestion[] {
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
  }

  createOrEditScope(answers: ScopeAnswersType) {
    let name = "";
    if(answers.scopeName[0] != "@") name = "@";
    name += answers.scopeName;

    if (!Object.prototype.hasOwnProperty.call(this.config.config.scopes, name)) {
      const reason = validateScopeName(answers.scopeName);
      if (reason !== null) {
        throw new ScopeNameError(reason);
      }
    }

    this.config.config.scopes[name] = {
      author: {
        name: answers.authorName,
        email: answers.authorEmail,
        url: answers.authorURL
      }
    };
  }

  deleteScope(scope: string) {
    let name = "";
    if(scope[0] != "@") name = "@";
    name += scope;

    console.log("Deleting scope " + name);
    if(!Object.keys(this.config.config.scopes).includes(name)) {
      console.error("Scope does not exist.");
      return;
    }

    delete this.config.config.scopes[name];
  }

  getScopes() {
    const scopes: string[] = Object.keys(this.config.config.scopes);

    return scopes;
  }

  getScope(scope: string) {
    return this.config.config.scopes[scope];
  }

  getQuestions(defaults: { scopeName?: string }): PromptQuestion[] {
    return [
      {
        name: "scopeName",
        message: "Scope name?",
        default: defaults.scopeName || null
      }
    ];
  }
}

export default Scopes;
