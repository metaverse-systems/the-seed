/**
 * Tests for the project name rules in `src/ProjectName.ts`: which names are accepted for each kind
 * of project, the exact reason given for each refused name, and the identifier derived from a name.
 *
 * Interfaces this file expects: `validateProjectName(name, kind)` returns `null` for a usable name
 * and otherwise the reason as one sentence; `toIdentifier(name)` returns the name with every "-"
 * and "." replaced by "_"; `ProjectKind` is "component" | "system" | "program" | "resource-pak".
 *
 * Choices where the contracts leave a detail open:
 * - The form rule is checked first, so a name that breaks it gets the form sentence whatever else is
 *   wrong with it (`Hello`, `3d-mesh`).
 * - For a code name whose identifier differs from the name (`and-eq`, `a--b`), the reason quotes the
 *   name as given in front of "cannot be used" and the identifier after "its C++ name".
 * - The "used by the generated code" rule is checked on the identifier, so `create-component` is
 *   refused like `create_component`, naming the identifier.
 * - The list of C++20 keywords and alternative tokens is written out in this file, not read from the
 *   source.
 */
import { validateProjectName, toIdentifier, ProjectKind } from "../src/ProjectName";

const codeKinds: ProjectKind[] = ["component", "system", "program"];

const formSentence =
  "A project name must start with a lowercase letter and contain only lowercase letters, digits, " +
  "\".\", \"_\" and \"-\" (such as hello-world).";

const article = (kind: ProjectKind): string => `the name of a ${kind}`;

const reservedReason = (name: string, kind: ProjectKind, identifier: string): string =>
  `"${name}" cannot be used as ${article(kind)}: its C++ name "${identifier}" is a reserved word.`;

const underscoreReason = (name: string, kind: ProjectKind, identifier: string): string =>
  `"${name}" cannot be used as ${article(kind)}: its C++ name "${identifier}" has two underscores in a row.`;

const generatedReason = (name: string, kind: ProjectKind, used: string): string =>
  `"${name}" cannot be used as ${article(kind)}: the generated code already uses the name "${used}".`;

const cppKeywords = [
  "alignas", "alignof", "and", "and_eq", "asm", "auto", "bitand", "bitor", "bool", "break", "case",
  "catch", "char", "char8_t", "char16_t", "char32_t", "class", "compl", "concept", "const",
  "consteval", "constexpr", "constinit", "const_cast", "continue", "co_await", "co_return",
  "co_yield", "decltype", "default", "delete", "do", "double", "dynamic_cast", "else", "enum",
  "explicit", "export", "extern", "false", "float", "for", "friend", "goto", "if", "inline", "int",
  "long", "mutable", "namespace", "new", "noexcept", "not", "not_eq", "nullptr", "operator", "or",
  "or_eq", "private", "protected", "public", "register", "reinterpret_cast", "requires", "return",
  "short", "signed", "sizeof", "static", "static_assert", "static_cast", "struct", "switch",
  "template", "this", "thread_local", "throw", "true", "try", "typedef", "typeid", "typename",
  "union", "unsigned", "using", "virtual", "void", "volatile", "wchar_t", "while", "xor", "xor_eq",
];

describe("accepted names", () => {
  const accepted: Array<[string, string]> = [
    ["hello-world", "hello_world"],
    ["mesh.loader", "mesh_loader"],
    ["a_b", "a_b"],
    ["x1", "x1"],
  ];

  describe.each(accepted)("%s", (name, identifier) => {
    it.each([...codeKinds, "resource-pak" as ProjectKind])("is usable for a %s", (kind) => {
      expect(validateProjectName(name, kind)).toBeNull();
    });

    it(`has the identifier ${identifier}`, () => {
      expect(toIdentifier(name)).toBe(identifier);
    });
  });
});

describe("names that break the form", () => {
  const refused = ["", "3d-mesh", "-x", ".x", "_x", "Hello", "a b", "a/b", "päk"];

  describe.each(codeKinds)("for a %s", (kind) => {
    it.each(refused)("refuses %j with the form sentence", (name) => {
      expect(validateProjectName(name, kind)).toBe(formSentence);
    });
  });

  it.each(["3d-mesh", "Hello", "päk", "", "a b"])("refuses %j for a resource-pak with the form sentence", (name) => {
    expect(validateProjectName(name, "resource-pak")).toBe(formSentence);
  });
});

describe("reserved words", () => {
  describe.each(codeKinds)("for a %s", (kind) => {
    it.each(["class", "and", "co_await"])("refuses %s", (name) => {
      expect(validateProjectName(name, kind)).toBe(reservedReason(name, kind, name));
    });

    it("refuses a name whose identifier is a keyword and quotes both", () => {
      expect(validateProjectName("and-eq", kind)).toBe(reservedReason("and-eq", kind, "and_eq"));
    });

    it("refuses every C++20 keyword and alternative token", () => {
      const wrong: string[] = [];
      for (const word of cppKeywords) {
        const reason = validateProjectName(word, kind);
        if (reason !== reservedReason(word, kind, word)) wrong.push(`${word}: ${String(reason)}`);
      }
      expect(wrong).toEqual([]);
    });
  });

  it("accepts words that only contain a keyword", () => {
    for (const kind of codeKinds) {
      expect(validateProjectName("classy", kind)).toBeNull();
      expect(validateProjectName("my-class", kind)).toBeNull();
      expect(validateProjectName("or-else", kind)).toBeNull();
    }
  });

  it("does not apply the keyword rule to a resource-pak", () => {
    for (const word of cppKeywords) {
      expect(validateProjectName(word, "resource-pak")).toBeNull();
    }
  });
});

describe("two underscores in a row", () => {
  describe.each(codeKinds)("for a %s", (kind) => {
    it.each([
      ["a--b", "a__b"],
      ["a.-b", "a__b"],
      ["a__b", "a__b"],
      ["a-_b", "a__b"],
    ])("refuses %s", (name, identifier) => {
      expect(validateProjectName(name, kind)).toBe(underscoreReason(name, kind, identifier));
    });
  });

  it("accepts them for a resource-pak", () => {
    expect(validateProjectName("a--b", "resource-pak")).toBeNull();
    expect(validateProjectName("a.-b", "resource-pak")).toBeNull();
    expect(validateProjectName("a__b", "resource-pak")).toBeNull();
  });
});

describe("names the generated code uses", () => {
  describe.each(codeKinds)("for a %s", (kind) => {
    it.each(["ecs", "std", "main", "nlohmann", "run", "create_component", "create_system"])("refuses %s", (name) => {
      expect(validateProjectName(name, kind)).toBe(generatedReason(name, kind, name));
    });

    it("refuses a name whose identifier is one of them", () => {
      expect(validateProjectName("create-system", kind)).toBe(generatedReason("create-system", kind, "create_system"));
    });

    it("accepts a name that only contains one of them", () => {
      expect(validateProjectName("ecs-extra", kind)).toBeNull();
      expect(validateProjectName("my.main", kind)).toBeNull();
    });
  });

  it("accepts them for a resource-pak", () => {
    for (const name of ["ecs", "std", "main", "nlohmann", "run", "class", "a--b"]) {
      expect(validateProjectName(name, "resource-pak")).toBeNull();
    }
  });
});

describe("toIdentifier", () => {
  it("replaces every - and . and nothing else", () => {
    expect(toIdentifier("a-b.c-d.e")).toBe("a_b_c_d_e");
    expect(toIdentifier("a--b")).toBe("a__b");
    expect(toIdentifier("a_b1")).toBe("a_b1");
    expect(toIdentifier("plain")).toBe("plain");
  });

  it("leaves characters outside the accepted form as they are", () => {
    expect(toIdentifier("A b/ä")).toBe("A b/ä");
  });
});
