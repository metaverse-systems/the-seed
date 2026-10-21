/*
 * Finds uses of a method of one of the tool's classes that are not a call: a property access that
 * is not immediately called (read as a value, passed on, `.bind`-ed), destructuring of an instance
 * and spreading of an instance. Members are resolved through the type checker, so a property of
 * the same name on another type is not reported, and a member is recognised whether it is declared
 * as a method or as a property holding a function (in a source file or in a declaration file).
 *
 * Not reported: the target of an assignment (`instance.method = replacement`) and access through
 * the class's `prototype` (`Build.prototype.getSteps`), which is not use of an instance's member.
 */
import path from "path";
import ts from "typescript";

/** The classes whose members are checked. */
export const METHOD_CLASSES = ["Build", "Config", "Scopes", "Package", "Template", "ResourcePak", "Installer"];

export interface DetachedUse {
  file: string;
  line: number;
  member: string;
  how: string;
}

export interface DetachedUseScan {
  detached: DetachedUse[];
  /** The number of references to a function member of each class that were examined. */
  examined: Record<string, number>;
}

/** Creates a program from a configuration file, optionally with further root files. */
export function programFromConfig(configPath: string, extraRoots: string[] = []): ts.Program {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  return ts.createProgram([...parsed.fileNames, ...extraRoots], { ...parsed.options, noEmit: true });
}

function isFunctionValued(declaration: ts.PropertyDeclaration): boolean {
  const initializer = declaration.initializer;
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return true;
  }
  return declaration.type !== undefined && ts.isFunctionTypeNode(declaration.type);
}

/** The listed class that declares this member as a function, if any. */
function listedClassOf(symbol: ts.Symbol | undefined): string | undefined {
  for (const declaration of symbol?.declarations ?? []) {
    const isFunctionMember =
      ts.isMethodDeclaration(declaration) || (ts.isPropertyDeclaration(declaration) && isFunctionValued(declaration));
    if (!isFunctionMember || !ts.isClassLike(declaration.parent) || !declaration.parent.name) {
      continue;
    }
    const name = declaration.parent.name.text;
    const file = path.basename(declaration.getSourceFile().fileName).replace(/(\.d)?\.ts$/, "");
    if (METHOD_CLASSES.includes(name) && file === name) {
      return name;
    }
  }
  return undefined;
}

function isListedClassType(type: ts.Type): boolean {
  for (const declaration of type.getSymbol()?.declarations ?? []) {
    if (ts.isClassLike(declaration) && declaration.name) {
      const file = path.basename(declaration.getSourceFile().fileName).replace(/(\.d)?\.ts$/, "");
      if (METHOD_CLASSES.includes(declaration.name.text) && file === declaration.name.text) {
        return true;
      }
    }
  }
  return false;
}

function isCalled(node: ts.Node): boolean {
  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  return current.parent !== undefined && ts.isCallExpression(current.parent) && current.parent.expression === current;
}

function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  );
}

function isThroughPrototype(access: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(access) && access.name.text === "prototype";
}

/** Scans the source files of the program that lie under one of the directories. */
export function findDetachedUses(program: ts.Program, directories: string[]): DetachedUseScan {
  const checker = program.getTypeChecker();
  const detached: DetachedUse[] = [];
  const examined: Record<string, number> = {};
  for (const name of METHOD_CLASSES) {
    examined[name] = 0;
  }
  const roots = directories.map((directory) => path.resolve(directory) + path.sep);

  const report = (node: ts.Node, member: string, how: string): void => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    detached.push({ file: source.fileName, line, member, how });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let symbol: ts.Symbol | undefined;
      if (ts.isPropertyAccessExpression(node)) {
        symbol = checker.getSymbolAtLocation(node.name);
      } else if (ts.isStringLiteralLike(node.argumentExpression)) {
        symbol = checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text);
      }
      const owner = listedClassOf(symbol);
      if (owner !== undefined && !isThroughPrototype(node.expression)) {
        examined[owner] += 1;
        if (!isCalled(node) && !isAssignmentTarget(node)) {
          report(node, owner + "." + (symbol?.getName() ?? "?"), "used without a call");
        }
      }
    } else if (ts.isObjectBindingPattern(node)) {
      const type = checker.getTypeAtLocation(node);
      for (const element of node.elements) {
        const key = element.propertyName ?? element.name;
        if (!element.dotDotDotToken && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
          const owner = listedClassOf(type.getProperty(key.text));
          if (owner !== undefined) {
            examined[owner] += 1;
            report(element, owner + "." + key.text, "destructured");
          }
        }
      }
    } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      if (isListedClassType(checker.getTypeAtLocation(node.expression))) {
        report(node, "an instance", "spread");
      }
    }
    ts.forEachChild(node, visit);
  };

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !roots.some((root) => path.resolve(source.fileName).startsWith(root))) {
      continue;
    }
    visit(source);
  }
  return { detached, examined };
}

/** Formats a use for a failure message. */
export function describeUse(use: DetachedUse): string {
  return use.file + ":" + use.line + " " + use.member + " " + use.how;
}
