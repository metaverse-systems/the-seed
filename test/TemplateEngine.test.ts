/**
 * Tests for `renderTemplate` in `src/TemplateEngine.ts`, on small template trees written into
 * scratch directories (never the real `templates/`).
 *
 * Interfaces and choices where the contracts leave a detail open:
 * - `renderTemplate(templateDir, targetDir, values)` is synchronous. It creates `targetDir`
 *   itself, so `targetDir` must not exist beforehand; its parent must.
 * - A target that already exists (a directory or a file) is refused with a `ProjectError` whose
 *   code is "write-failed" or "target-exists"; whatever was in the target is left as it was.
 * - An unknown variable throws a plain `Error` (not a `ProjectError`) whose message contains the
 *   path of the template file, relative to the template directory, and the variable name. Nothing
 *   is left in the target's parent afterwards.
 * - An I/O failure while rendering (a template file that cannot be read) throws
 *   `ProjectError("write-failed")` whose message contains the system's reason, and leaves nothing in
 *   the target's parent: no target, no hidden directory. The case is skipped for a user who can read
 *   any file (root), since the failure cannot be made that way.
 * - The values are a complete `TemplateValues` object; the cases change only the fields they name.
 * - Escaping is checked on whole values containing each special character: `#` in "*.pc.in",
 *   `\` and `"` in "*.cpp" and "*.hpp", none in "configure.ac" and in other files.
 * - A line is dropped only when its whole content is one variable whose value is empty; the line's
 *   newline goes with it.
 * - Other files keep the mode of the template file, except `autogen.sh`, which is written 0755.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { renderTemplate, TemplateValues } from "../src/TemplateEngine";
import { ProjectError } from "../src/ProjectError";

const baseValues: TemplateValues = {
  name: "hello",
  identifier: "hello",
  scope: "@acme",
  package: "@acme/hello",
  kind: "component",
  kind_title: "a component for libecs-cpp",
  author_name: "Ada Lovelace",
  author_contact: "Ada Lovelace <ada@example.com>",
  author_email: "ada@example.com",
  author_url: "https://acme.example",
  pc_url_line: "URL: https://acme.example",
  readme_url_line: "Web: https://acme.example",
  year: "2026",
  ecs_cpp_version: "2.1.0",
  the_seed_version: "0.8.0",
};

function values(changes: Partial<TemplateValues> = {}): TemplateValues {
  return { ...baseValues, ...changes };
}

let scratch = "";
let templateDir = "";
let parentDir = "";
let targetDir = "";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "template-engine-"));
  templateDir = path.join(scratch, "template");
  parentDir = path.join(scratch, "parent");
  targetDir = path.join(parentDir, "hello");
  fs.mkdirSync(templateDir);
  fs.mkdirSync(parentDir);
});

afterEach(() => {
  fs.chmodSync(scratch, 0o755);
  for (const dir of [templateDir, parentDir]) {
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try {
        const entry = path.join(dir, file);
        if (fs.lstatSync(entry).isFile()) fs.chmodSync(entry, 0o644);
      } catch {
        // already removed
      }
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

function writeTemplate(relative: string, content: string, mode?: number): void {
  const file = path.join(templateDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function rendered(relative: string): string {
  return fs.readFileSync(path.join(targetDir, relative), "utf8");
}

function caught(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function listing(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        found.push(relative + "/");
        walk(path.join(current, entry.name), relative + "/");
      } else {
        found.push(relative);
      }
    }
  };
  walk(dir, "");
  return found.sort();
}

describe("substitution", () => {
  it("replaces variables in contents", () => {
    writeTemplate("README.md", "# {{name}}\n\nBy {{author_name}}, {{year}}.\n");
    renderTemplate(templateDir, targetDir, values());
    expect(rendered("README.md")).toBe("# hello\n\nBy Ada Lovelace, 2026.\n");
  });

  it("replaces variables in file names, including in subdirectories", () => {
    writeTemplate("{{name}}.pc.in", "Name: {{name}}\n");
    writeTemplate("src/{{name}}.cpp", "// {{identifier}}\n");
    writeTemplate("src/{{name}}.hpp", "// {{identifier}}\n");
    renderTemplate(templateDir, targetDir, values({ name: "mesh.loader", identifier: "mesh_loader" }));
    expect(listing(targetDir)).toEqual(["mesh.loader.pc.in", "src/", "src/mesh.loader.cpp", "src/mesh.loader.hpp"]);
    expect(rendered("mesh.loader.pc.in")).toBe("Name: mesh.loader\n");
    expect(rendered("src/mesh.loader.cpp")).toBe("// mesh_loader\n");
  });

  it("replaces every occurrence on a line", () => {
    writeTemplate("a.txt", "{{name}} {{name}} {{scope}}\n");
    renderTemplate(templateDir, targetDir, values());
    expect(rendered("a.txt")).toBe("hello hello @acme\n");
  });

  it("writes a value that contains a variable as given, not substituted again", () => {
    writeTemplate("COPYING", "Copyright (c) {{year}} {{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "{{name}}" }));
    expect(rendered("COPYING")).toBe("Copyright (c) 2026 {{name}}\n");
  });

  it("writes a value that contains SKELETON as given", () => {
    writeTemplate("README.md", "{{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "SKELETON" }));
    expect(rendered("README.md")).toBe("SKELETON\n");
  });

  it("does not substitute in a file name from a value of an earlier substitution", () => {
    writeTemplate("{{name}}.txt", "x\n");
    renderTemplate(templateDir, targetDir, values({ name: "{{year}}" }));
    expect(listing(targetDir)).toEqual(["{{year}}.txt"]);
  });

  it("copies dot files and nested directories", () => {
    writeTemplate(".hidden", "{{name}}\n");
    writeTemplate("a/b/c.txt", "deep {{name}}\n");
    renderTemplate(templateDir, targetDir, values());
    expect(listing(targetDir)).toEqual([".hidden", "a/", "a/b/", "a/b/c.txt"]);
    expect(rendered(".hidden")).toBe("hello\n");
    expect(rendered("a/b/c.txt")).toBe("deep hello\n");
  });

  it("leaves text without variables, including single braces, untouched", () => {
    const text = "int main() { return {1}; }\n{ {not a variable} }\n{{ spaced }}\n";
    writeTemplate("notes.txt", text);
    renderTemplate(templateDir, targetDir, values());
    expect(rendered("notes.txt")).toBe(text);
  });
});

describe("unknown variables", () => {
  it("throws an Error naming the file and the variable", () => {
    writeTemplate("src/{{name}}.cpp", "// {{no_such_value}}\n");
    const error = caught(() => renderTemplate(templateDir, targetDir, values()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProjectError);
    const message = (error as Error).message;
    expect(message).toContain("no_such_value");
    expect(message).toContain(".cpp");
  });

  it("throws for an unknown variable in a file name", () => {
    writeTemplate("{{nothing}}.txt", "x\n");
    const error = caught(() => renderTemplate(templateDir, targetDir, values()));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("nothing");
  });

  it("leaves nothing in the target's parent, even after other files were rendered", () => {
    writeTemplate("a.txt", "{{name}}\n");
    writeTemplate("b.txt", "{{name}}\n");
    writeTemplate("z/c.txt", "{{missing}}\n");
    expect(caught(() => renderTemplate(templateDir, targetDir, values()))).toBeInstanceOf(Error);
    expect(fs.readdirSync(parentDir)).toEqual([]);
  });
});

describe("empty variables", () => {
  it("removes a line whose whole content is an empty variable, with its newline", () => {
    writeTemplate("p.pc.in", "Name: {{name}}\n{{pc_url_line}}\nVersion: 0.0.1\n");
    renderTemplate(templateDir, targetDir, values({ pc_url_line: "" }));
    expect(rendered("p.pc.in")).toBe("Name: hello\nVersion: 0.0.1\n");
  });

  it("keeps the line when the variable is not empty", () => {
    writeTemplate("p.pc.in", "Name: {{name}}\n{{pc_url_line}}\nVersion: 0.0.1\n");
    renderTemplate(templateDir, targetDir, values());
    expect(rendered("p.pc.in")).toBe("Name: hello\nURL: https://acme.example\nVersion: 0.0.1\n");
  });

  it("keeps a line where the empty variable is among other text", () => {
    writeTemplate("README.md", "Contact: {{author_email}}\n{{author_email}} is empty\n [{{author_url}}]\n");
    renderTemplate(templateDir, targetDir, values({ author_email: "", author_url: "" }));
    expect(rendered("README.md")).toBe("Contact: \n is empty\n []\n");
  });

  it("removes each such line", () => {
    writeTemplate("README.md", "a\n{{readme_url_line}}\nb\n{{pc_url_line}}\nc\n");
    renderTemplate(templateDir, targetDir, values({ readme_url_line: "", pc_url_line: "" }));
    expect(rendered("README.md")).toBe("a\nb\nc\n");
  });
});

describe("escaping by file", () => {
  it("escapes # in a pkg-config file", () => {
    writeTemplate("{{name}}.pc.in", "Description: {{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "C# fan #1" }));
    expect(rendered("hello.pc.in")).toBe("Description: C\\# fan \\#1\n");
  });

  it("leaves \\ and \" alone in a pkg-config file", () => {
    writeTemplate("x.pc.in", "Description: {{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "a\\b\"c" }));
    expect(rendered("x.pc.in")).toBe("Description: a\\b\"c\n");
  });

  it.each(["x.cpp", "x.hpp"])("escapes \\ and \" in %s", (file) => {
    writeTemplate(file, "const char *by = \"{{author_name}}\";\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "a\\b\"c" }));
    expect(rendered(file)).toBe("const char *by = \"a\\\\b\\\"c\";\n");
  });

  it("does not escape # in a C++ file", () => {
    writeTemplate("x.cpp", "// {{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "C# fan" }));
    expect(rendered("x.cpp")).toBe("// C# fan\n");
  });

  it("does not escape in configure.ac", () => {
    writeTemplate("configure.ac", "AC_INIT([{{name}}], [0.0.1], [{{author_email}}])\n# {{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "a\\b\"c #", author_email: "a#b@example.com" }));
    expect(rendered("configure.ac")).toBe("AC_INIT([hello], [0.0.1], [a#b@example.com])\n# a\\b\"c #\n");
  });

  it.each(["README.md", "AUTHORS", "COPYING", "Makefile.am", "notes.txt"])("does not escape in %s", (file) => {
    writeTemplate(file, "{{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "a\\b\"c #" }));
    expect(rendered(file)).toBe("a\\b\"c #\n");
  });

  it("escapes by the rendered file's own name, not by a directory it is in", () => {
    writeTemplate("src/{{name}}.cpp", "\"{{author_name}}\"\n");
    writeTemplate("src/Makefile.am", "{{author_name}}\n");
    renderTemplate(templateDir, targetDir, values({ author_name: "\"q\"" }));
    expect(rendered("src/hello.cpp")).toBe("\"\\\"q\\\"\"\n");
    expect(rendered("src/Makefile.am")).toBe("\"q\"\n");
  });
});

describe("special files", () => {
  it("writes gitignore as .gitignore", () => {
    writeTemplate("gitignore", "*.o\n.libs/\n");
    renderTemplate(templateDir, targetDir, values());
    expect(listing(targetDir)).toEqual([".gitignore"]);
    expect(rendered(".gitignore")).toBe("*.o\n.libs/\n");
  });

  it("writes autogen.sh with mode 0755 when the template file is 0644", () => {
    writeTemplate("autogen.sh", "#!/bin/sh\nautoreconf -i\n", 0o644);
    renderTemplate(templateDir, targetDir, values());
    expect(fs.statSync(path.join(targetDir, "autogen.sh")).mode & 0o777).toBe(0o755);
    expect(rendered("autogen.sh")).toBe("#!/bin/sh\nautoreconf -i\n");
  });

  it("keeps the mode of other files", () => {
    writeTemplate("plain.txt", "x\n", 0o644);
    writeTemplate("tool.sh", "#!/bin/sh\n", 0o755);
    renderTemplate(templateDir, targetDir, values());
    expect(fs.statSync(path.join(targetDir, "plain.txt")).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(targetDir, "tool.sh")).mode & 0o777).toBe(0o755);
  });
});

describe("failures", () => {
  it("refuses a target directory that exists and writes nothing into it", () => {
    writeTemplate("a.txt", "{{name}}\n");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "mine.txt"), "keep\n");
    const error = caught(() => renderTemplate(templateDir, targetDir, values()));
    expect(error).toBeInstanceOf(ProjectError);
    expect(["write-failed", "target-exists"]).toContain((error as ProjectError).code);
    expect(listing(targetDir)).toEqual(["mine.txt"]);
    expect(rendered("mine.txt")).toBe("keep\n");
    expect(fs.readdirSync(parentDir)).toEqual(["hello"]);
  });

  it("refuses a target that is a file", () => {
    writeTemplate("a.txt", "x\n");
    fs.writeFileSync(targetDir, "keep\n");
    const error = caught(() => renderTemplate(templateDir, targetDir, values()));
    expect(error).toBeInstanceOf(ProjectError);
    expect(["write-failed", "target-exists"]).toContain((error as ProjectError).code);
    expect(fs.readFileSync(targetDir, "utf8")).toBe("keep\n");
    expect(fs.readdirSync(parentDir)).toEqual(["hello"]);
  });

  const unprivileged = typeof process.getuid === "function" && process.getuid() !== 0;
  (unprivileged ? it : it.skip)(
    "reports write-failed with the system's reason when a template file cannot be read, and leaves nothing behind",
    () => {
      writeTemplate("a.txt", "{{name}}\n");
      writeTemplate("sub/b.txt", "{{name}}\n");
      writeTemplate("z.txt", "{{name}}\n", 0o000);
      const error = caught(() => renderTemplate(templateDir, targetDir, values()));
      expect(error).toBeInstanceOf(ProjectError);
      expect((error as ProjectError).code).toBe("write-failed");
      expect((error as ProjectError).message).toMatch(/EACCES|permission denied/i);
      expect(fs.readdirSync(parentDir)).toEqual([]);
    }
  );

  it("reports write-failed when the target's parent does not exist, and creates nothing", () => {
    writeTemplate("a.txt", "x\n");
    const missing = path.join(scratch, "no-such-parent", "hello");
    const error = caught(() => renderTemplate(templateDir, missing, values()));
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe("write-failed");
    expect(fs.existsSync(path.join(scratch, "no-such-parent"))).toBe(false);
  });
});
