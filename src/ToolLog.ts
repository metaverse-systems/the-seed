import { ToolLog } from "./types";

/** The default log: each level goes to its console method. */
export const consoleLog: ToolLog = (line, level) => {
  switch (level) {
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
};
