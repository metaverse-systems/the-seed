"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const inquirer_1 = tslib_1.__importDefault(require("inquirer"));
const Config_1 = tslib_1.__importDefault(require("../Config"));
const Scopes_1 = tslib_1.__importDefault(require("../Scopes"));
const ScopesCLI = (scriptConfig) => {
    const config = new Config_1.default(scriptConfig.configDir);
    const scopes = new Scopes_1.default(config);
    const command = scriptConfig.args[3] || "help";
    switch (command) {
        case "help":
            console.log("Scopes commands:");
            console.log("  " + scriptConfig.binName + " scopes help");
            console.log("     -- This screen");
            console.log("  " + scriptConfig.binName + " scopes list");
            console.log("     -- List existing scopes");
            console.log("  " + scriptConfig.binName + " scopes edit");
            console.log("     -- Edit an existing scope");
            console.log("  " + scriptConfig.binName + " scopes add");
            console.log("     -- Create a new scope");
            console.log("  " + scriptConfig.binName + " scopes delete");
            console.log("     -- Delete a scope");
            break;
        case "list":
            console.log(Object.keys(config.config.scopes));
            break;
        case "edit":
            if (Object.keys(config.config.scopes).length === 0) {
                console.log("There are no scopes to edit.");
                break;
            }
            inquirer_1.default.prompt(scopes.askWhichScope())
                .then((answers) => {
                const { scopeName } = answers;
                inquirer_1.default.prompt(scopes.askEditScope(config.config.scopes[scopeName].author))
                    .then((editAnswers) => {
                    editAnswers.scopeName = scopeName;
                    scopes.createOrEditScope(editAnswers);
                })
                    .then(() => config.saveConfig());
            });
            break;
        case "add":
            inquirer_1.default.prompt(scopes.askNewScope())
                .then((answers) => scopes.createOrEditScope(answers))
                .then(() => config.saveConfig());
            break;
        case "delete":
            if (Object.keys(config.config.scopes).length === 0) {
                console.log("There are no scopes to edit.");
                break;
            }
            inquirer_1.default.prompt(scopes.askWhichScope())
                .then((answers) => {
                const { scopeName } = answers;
                scopes.deleteScope(scopeName);
            })
                .then(() => config.saveConfig());
            break;
    }
};
exports.default = ScopesCLI;
//# sourceMappingURL=ScopesCLI.js.map