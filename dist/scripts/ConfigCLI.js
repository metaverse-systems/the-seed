"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const fs_1 = tslib_1.__importDefault(require("fs"));
const inquirer_1 = tslib_1.__importDefault(require("inquirer"));
const Config_1 = tslib_1.__importDefault(require("../Config"));
const ConfigCLI = (scriptConfig) => {
    const config = new Config_1.default(scriptConfig.configDir);
    const updateConfig = () => {
        inquirer_1.default.prompt(config.getQuestions())
            .then((answers) => config.parseAnswers(answers))
            .then(() => config.saveConfig());
    };
    const command = scriptConfig.args[3] || "list";
    switch (command) {
        case "list":
            if (!fs_1.default.existsSync(scriptConfig.configDir + config.configFile)) {
                console.log(scriptConfig.configDir + config.configFile + " not found. Run '" + scriptConfig.binName + " config edit' to create it.");
                break;
            }
            console.log(scriptConfig.configDir + config.configFile);
            console.log(config.config);
            break;
        case "edit":
            updateConfig();
            break;
        case "scopes":
            const subcommand = scriptConfig.args[4] || "help";
            console.log(scriptConfig.binName + " " + command + " " + subcommand);
            switch (subcommand) {
                case "help":
                    console.log("Scopes commands:");
                    console.log("  " + scriptConfig.binName + " " + command + " list");
                    break;
                case "list":
                    console.log(Object.keys(config.config.scopes));
                    break;
            }
            break;
    }
};
exports.default = ConfigCLI;
//# sourceMappingURL=ConfigCLI.js.map