"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const fs_1 = tslib_1.__importDefault(require("fs"));
const os_1 = tslib_1.__importDefault(require("os"));
class Config {
    constructor(configDir) {
        this.config = {
            prefix: os_1.default.homedir() + "/the-seed",
            scopes: {}
        };
        this.loadConfig = () => {
            this.config = JSON.parse(fs_1.default.readFileSync(this.configDir + this.configFile).toString());
        };
        this.saveConfig = () => {
            fs_1.default.writeFileSync(this.configDir + this.configFile, JSON.stringify(this.config, null, 2));
        };
        this.getQuestions = () => {
            return [
                {
                    name: "prefix",
                    message: "Installation prefix?",
                    default: this.config["prefix"]
                }
            ];
        };
        this.parseAnswers = (answers) => {
            Object.keys(answers).forEach((k) => {
                this.config[k] = answers[k];
            });
        };
        this.configDir = configDir || os_1.default.homedir() + "/the-seed";
        this.configFile = "/config.json";
        this.loadConfig();
    }
}
exports.default = Config;
//# sourceMappingURL=Config.js.map