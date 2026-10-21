/** What went wrong when a project or a resource was created or changed. */
export type ProjectErrorCode =
  | "invalid-name"
  | "unknown-scope"
  | "author-name-missing"
  | "author-detail-unusable"
  | "target-exists"
  | "not-pak-project"
  | "resource-file-missing"
  | "duplicate-resource"
  | "resource-changed"
  | "write-failed";

/** A failure while creating or changing a project: `code` names the situation, `hint` (when there is one) says what to do about it. */
export class ProjectError extends Error {
  code: ProjectErrorCode;
  /** What to do about it, printed after the Error: line */
  hint?: string;

  constructor(code: ProjectErrorCode, message: string, hint?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ProjectError";
    this.code = code;
    this.hint = hint;
  }
}
