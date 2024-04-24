"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const fs = require("fs-extra");
const { execSync } = require("child_process");
const path_1 = tslib_1.__importDefault(require("path"));
const Scopes_1 = tslib_1.__importDefault(require("./Scopes"));
const build_command = "build_command src/Template.ts";
const build_win64_command = "";
class Template {
    constructor(config) {
        this.type = "";
        this.packageDir = "";
        this.askName = () => {
            return [
                {
                    "type": "list",
                    "name": "scopeName",
                    "message": "Choose scope for " + this.type,
                    "choices": this.scopes.getScopes()
                },
                {
                    "name": "templateName",
                    "message": "Choose name for " + this.type
                }
            ];
        };
        this.copyTemplate = (scope, name) => {
            const templateDir = path_1.default.join(path_1.default.dirname(require.main.filename), "../../templates/" + this.type);
            const scopeDir = this.config.config.prefix + "/projects/" + scope;
            const underscoreRegex = new RegExp("-", "g");
            const underscoreName = name.replace(underscoreRegex, "_");
            if (!fs.existsSync(scopeDir)) {
                fs.mkdirSync(scopeDir);
            }
            // Create package from template
            fs.copySync(templateDir, this.packageDir);
            // Replace template variables with real values
            const author = this.scopes.getScope(scope).author;
            const variables = {
                "AUTHOR_EMAIL": author.email,
                "AUTHOR_URL": author.url,
                "SKELETON_": underscoreName,
                "SKELETON": name
            };
            const files = [
                "AUTHORS",
                "COPYING",
                "configure.ac",
                "Makefile.am",
                "src/Makefile.am",
                "src/SKELETON.hpp",
                "src/SKELETON.cpp"
            ];
            if (this.type != "program") {
                files.push("SKELETON.pc.in");
            }
            files.forEach((file) => {
                let temp = fs.readFileSync(this.packageDir + "/" + file).toString();
                Object.keys(variables).forEach((variable) => {
                    const regex = new RegExp(variable, "g");
                    temp = temp.replace(regex, variables[variable]);
                });
                fs.writeFileSync(this.packageDir + "/" + file, temp);
            });
            fs.renameSync(this.packageDir + "/src/SKELETON.hpp", this.packageDir + "/src/" + name + ".hpp");
            fs.renameSync(this.packageDir + "/src/SKELETON.cpp", this.packageDir + "/src/" + name + ".cpp");
            if (this.type != "program")
                fs.renameSync(this.packageDir + "/SKELETON.pc.in", this.packageDir + "/" + name + ".pc.in");
        };
        this.createPackage = (scope, name) => {
            const scopeDir = this.config.config.prefix + "/projects/" + scope;
            this.packageDir = scopeDir + "/" + name;
            this.copyTemplate(scope, name);
            // Create default package.json
            execSync("npm init --yes", { cwd: this.packageDir });
            this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
            this.package.author = this.scopes.getScope(scope).author;
            this.package.license = "UNLICENSED";
            this.package.name = scope + "/" + name;
            this.package.version = "0.0.1";
            this.package.scripts = {
                "test": "echo \"Error: no test specified\" && exit 1",
                "build": build_command,
                "build-win64": build_win64_command
            };
            delete this.package.main;
            this.save();
        };
        this.save = () => {
            fs.writeFileSync(this.packageDir + "/package.json", JSON.stringify(this.package, null, 2));
        };
        this.config = config;
        this.scopes = new Scopes_1.default(config);
    }
}
exports.default = Template;
//# sourceMappingURL=Template.js.map