import path from "node:path";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import type { Node, SourceFile, StringLiteral } from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const clientRoot = path.join(root, "src", "client");
const tsconfigPath = path.join(root, "tsconfig.json");
const compiler = new API();
const parsedConfig = compiler.parseConfigFile(tsconfigPath);
const snapshot = compiler.updateSnapshot({ openProjects: [tsconfigPath] });
const loadedProject = snapshot.getProject(tsconfigPath);
if (loadedProject === undefined) throw new Error(`Could not load ${tsconfigPath}`);
const project = loadedProject;

const compilerOptions = parsedConfig.options;
if (Object.keys(compilerOptions).length === 0) throw new Error(`Could not read compiler options from ${tsconfigPath}`);

type Edge = { kind: "static" | "dynamic"; specifier: string; target: string };

function canonical(file: string): string {
  return path.normalize(path.resolve(file));
}

function isProductionClientFile(file: string): boolean {
  const normalized = canonical(file);
  return normalized.startsWith(`${canonical(clientRoot)}${path.sep}`)
    && !normalized.includes(`${path.sep}node_modules${path.sep}`)
    && !/\.(?:browser\.)?test\.[cm]?[jt]sx?$/.test(normalized);
}

function sourceFile(file: string): SourceFile {
  const value = project.program.getSourceFile(file);
  if (value === undefined) throw new Error(`Could not load ${file}`);
  return value;
}

function resolve(literal: StringLiteral, containingFile: string): string {
  const symbol = project.checker.getSymbolAtLocation(literal);
  const declaration = symbol?.declarations
    .map((handle) => handle.resolve(project))
    .find((node): node is Node => node !== undefined);
  if (declaration === undefined) throw new Error(`Could not resolve ${literal.text} from ${containingFile}`);
  return canonical(declaration.getSourceFile().fileName);
}

function isRuntimeImport(statement: ts.ImportDeclaration): boolean {
  const text = statement.getText();
  return !/^import\s+type\b/.test(text) && !/^import\s*\{\s*type\s+\w+\s*\}\s*from\b/.test(text);
}

function sourceEdges(file: string): readonly Edge[] {
  const source = sourceFile(file);
  const edges: Edge[] = [];
  const add = (kind: Edge["kind"], literal: StringLiteral) => {
    if (!literal.text.startsWith(".") && !literal.text.startsWith("@/")) return;
    if (path.extname(literal.text) === ".css") return;
    edges.push({ kind, specifier: literal.text, target: resolve(literal, file) });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && isRuntimeImport(statement) && ts.isStringLiteral(statement.moduleSpecifier)) add("static", statement.moduleSpecifier);
  }
  const visit = (node: Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) add("dynamic", argument);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return edges;
}

function closure(rootFile: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (!isProductionClientFile(file) || visited.has(file)) return;
    visited.add(file);
    for (const edge of sourceEdges(file)) visit(edge.target);
  };
  visit(canonical(rootFile));
  return visited;
}

function clientProductionFiles(): readonly string[] {
  return project.program.getSourceFileNames().map(canonical).filter(isProductionClientFile);
}

const app = canonical(path.join(clientRoot, "App.tsx"));
const ordinaryPage = canonical(path.join(clientRoot, "pages", "OrdinaryPage.tsx"));
const hook = canonical(path.join(clientRoot, "hooks", "use-paste-page.ts"));
const ordinaryPastePage = canonical(path.join(clientRoot, "components", "OrdinaryPastePage.tsx"));

const prohibitedClosureFiles = [
  ordinaryPage,
  hook,
  ordinaryPastePage,
  canonical(path.join(clientRoot, "autosave.ts")),
  canonical(path.join(clientRoot, "paste-sync.ts")),
  canonical(path.join(clientRoot, "paste-controller.ts")),
  canonical(path.join(clientRoot, "surface-apply.ts")),
  canonical(path.join(clientRoot, "history.ts")),
] as const;

const nonordinaryRoots = [
  "CreatePage.tsx",
  "PasswordPage.tsx",
  "ErrorPage.tsx",
  "LocalOnlyPastePage.tsx",
  "MarkdownPage.tsx",
].map((file) => canonical(path.join(clientRoot, "pages", file)));

afterAll(() => {
  snapshot.dispose();
  compiler.close();
});

describe("App ordinary lifecycle module graph", () => {
  it("keeps ordinary imports solely in OrdinaryPage", () => {
    const appEdges = sourceEdges(app);
    expect(appEdges.filter((edge) => edge.kind === "dynamic" && edge.specifier === "./pages/OrdinaryPage")).toHaveLength(1);
    expect(appEdges.some((edge) => edge.target === hook || edge.target === ordinaryPastePage)).toBe(false);

    const ordinaryEdges = sourceEdges(ordinaryPage);
    expect(ordinaryEdges.some((edge) => edge.kind === "static" && edge.target === hook)).toBe(true);
    expect(ordinaryEdges.some((edge) => edge.kind === "static" && edge.target === ordinaryPastePage)).toBe(true);

    for (const file of clientProductionFiles()) {
      if (file === ordinaryPage) continue;
      const directTargets = sourceEdges(file).map((edge) => edge.target);
      expect(directTargets).not.toContain(hook);
      expect(directTargets).not.toContain(ordinaryPastePage);
    }

    for (const pageRoot of nonordinaryRoots) {
      const pageClosure = closure(pageRoot);
      const prohibited = prohibitedClosureFiles.find((file) => pageClosure.has(file));
      if (prohibited !== undefined) throw new Error(`${path.basename(pageRoot)} reaches ${path.relative(clientRoot, prohibited)}`);
    }
  });
});
