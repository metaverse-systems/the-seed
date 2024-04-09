import Config from "./Config";
declare class Scopes {
    config: Config;
    constructor(config: Config);
    askWhichScope: () => {
        type: string;
        name: string;
        message: string;
        choices: string[];
    }[];
    askNewScope: () => ({
        name: string;
        message: string;
        default: any;
    } | {
        name: string;
        message: string;
    })[];
    askEditScope: (defaults?: any) => {
        name: string;
        message: string;
        default: any;
    }[];
    createOrEditScope: (answers: any) => void;
    deleteScope: (scope: string) => void;
    getScopes: () => string[];
    getScope: (scope: string) => import("./types").ScopeType;
    getQuestions: (defaults: any) => {
        name: string;
        message: string;
        default: any;
    }[];
}
export default Scopes;
