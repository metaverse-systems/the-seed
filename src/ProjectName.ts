/** The kinds of project a name is chosen for. */
export type ProjectKind = "component" | "system" | "program" | "resource-pak";

const formReason =
  "A project name must start with a lowercase letter and contain only lowercase letters, digits, " +
  "\".\", \"_\" and \"-\" (such as hello-world).";

/** The C++20 keywords and alternative tokens. */
const reservedWords = new Set([
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
]);

/** Names the generated code already uses. */
const generatedNames = new Set(["ecs", "nlohmann", "std", "main", "run", "create_component", "create_system"]);

/** The C++ and Automake identifier for a code project's name: "-" and "." become "_". */
export function toIdentifier(name: string): string {
  return name.replace(/[-.]/g, "_");
}

/** null when the name is usable for that kind of project, otherwise the reason (one sentence). */
export function validateProjectName(name: string, kind: ProjectKind): string | null {
  if (!/^[a-z][a-z0-9._-]*$/.test(name)) {
    return formReason;
  }
  if (kind === "resource-pak") {
    return null;
  }
  const identifier = toIdentifier(name);
  const prefix = `"${name}" cannot be used as the name of a ${kind}: `;
  if (identifier.includes("__")) {
    return `${prefix}its C++ name "${identifier}" has two underscores in a row.`;
  }
  if (reservedWords.has(identifier)) {
    return `${prefix}its C++ name "${identifier}" is a reserved word.`;
  }
  if (generatedNames.has(identifier)) {
    return `${prefix}the generated code already uses the name "${identifier}".`;
  }
  return null;
}
