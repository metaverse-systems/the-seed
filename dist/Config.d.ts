import { ConfigType } from "./types";
declare class Config {
    configDir: string;
    configFile: string;
    config: ConfigType;
    constructor(configDir: string);
    loadConfig: () => void;
    saveConfig: () => void;
    getQuestions: () => {
        name: string;
        message: string;
        default: string;
    }[];
    parseAnswers: (answers: {
        [index: string]: any;
    }) => void;
}
export default Config;
