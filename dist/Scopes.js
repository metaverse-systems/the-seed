"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Scopes {
    constructor(config) {
        this.askWhichScope = () => {
            return [
                {
                    "type": "list",
                    "name": "scopeName",
                    "message": "Which scope?",
                    "choices": this.getScopes()
                }
            ];
        };
        this.askNewScope = () => {
            return [
                {
                    "name": "scopeName",
                    "message": "Name for scope?",
                },
                ...this.askEditScope()
            ];
        };
        this.askEditScope = (defaults) => {
            return [
                {
                    "name": "authorName",
                    "message": "Your name?",
                    "default": (defaults === null || defaults === void 0 ? void 0 : defaults.name) ? defaults.name : ""
                },
                {
                    "name": "authorEmail",
                    "message": "Your email?",
                    "default": (defaults === null || defaults === void 0 ? void 0 : defaults.email) ? defaults.email : ""
                },
                {
                    "name": "authorURL",
                    "message": "Your URL?",
                    "default": (defaults === null || defaults === void 0 ? void 0 : defaults.url) ? defaults.url : ""
                }
            ];
        };
        this.createOrEditScope = (answers) => {
            let name = "";
            if (answers.scopeName[0] != "@")
                name = "@";
            name += answers.scopeName;
            this.config.config.scopes[name] = {
                author: {
                    name: answers.authorName,
                    email: answers.authorEmail,
                    url: answers.authorURL
                }
            };
        };
        this.deleteScope = (scope) => {
            let name = "";
            if (scope[0] != "@")
                name = "@";
            name += scope;
            console.log("Deleting scope " + name);
            if (!Object.keys(this.config.config.scopes).includes(name)) {
                console.error("Scope does not exist.");
                return;
            }
            delete this.config.config.scopes[name];
        };
        this.getScopes = () => {
            const scopes = Object.keys(this.config.config.scopes);
            return scopes;
        };
        this.getScope = (scope) => {
            return this.config.config.scopes[scope];
        };
        this.getQuestions = (defaults) => {
            return [
                {
                    name: "scopeName",
                    message: "Scope name?",
                    default: defaults.scopeName || null
                }
            ];
        };
        this.config = config;
    }
}
exports.default = Scopes;
//# sourceMappingURL=Scopes.js.map