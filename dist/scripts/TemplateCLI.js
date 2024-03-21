"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const inquirer_1 = tslib_1.__importDefault(require("inquirer"));
const Config_1 = tslib_1.__importDefault(require("../Config"));
const Template_1 = tslib_1.__importDefault(require("../Template"));
const TemplateCLI = (scriptConfig) => {
    const config = new Config_1.default(scriptConfig.configDir);
    const command = scriptConfig.args[3] || "help";
    const template = new Template_1.default(config);
    switch (command) {
        case "help":
            console.log("Available template(s):");
            console.log("  component");
            console.log("  system");
            console.log("  program");
            break;
        case "component":
        case "system":
        case "program":
            template.type = command;
            inquirer_1.default.prompt(template.askName())
                .then((answers) => {
                template.createPackage(answers.scopeName, answers.templateName);
            });
            break;
    }
};
exports.default = TemplateCLI;
//# sourceMappingURL=TemplateCLI.js.map