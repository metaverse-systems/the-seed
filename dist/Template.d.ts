import Config from "./Config";
import Scopes from "./Scopes";
declare class Template {
    type: string;
    packageDir: string;
    config: Config;
    scopes: Scopes;
    package: any;
    constructor(config: Config);
    askName: () => ({
        type: string;
        name: string;
        message: string;
        choices: string[];
    } | {
        name: string;
        message: string;
        type?: undefined;
        choices?: undefined;
    })[];
    copyTemplate: (scope: string, name: string) => void;
    createPackage: (scope: string, name: string) => void;
    save: () => void;
}
export default Template;
