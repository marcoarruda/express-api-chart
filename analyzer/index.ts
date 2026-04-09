import * as path from 'path';
import * as vscode from 'vscode';
import * as ts from 'typescript';

export type SourceRef = {
  file: string;
  line: number;
  column: number;
};

export type DiagramNode = {
  id: string;
  label: string;
  kind: 'endpoint' | 'middleware' | 'router';
  source: SourceRef;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
};

export type DiagramPayload = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

type ImportBinding = {
  specifier: string;
  importedName: string | 'default' | '*';
};

type RouterInstance = {
  name: string;
  kind: 'app' | 'router';
  source: SourceRef;
};

type ParsedArg = {
  kind: 'identifier' | 'call' | 'expression';
  name: string;
  calleeName?: string;
  source: SourceRef;
};

type MiddlewareRef = ParsedArg;

type RouteRegistration = {
  instanceName: string;
  method: string;
  path: string;
  middlewares: MiddlewareRef[];
  source: SourceRef;
};

type MountRegistration = {
  instanceName: string;
  path: string;
  args: ParsedArg[];
  source: SourceRef;
};

type ModuleInfo = {
  filePath: string;
  imports: Map<string, ImportBinding>;
  instances: Map<string, RouterInstance>;
  routerFactories: Map<string, string>;
  exports: {
    default?: string;
    named: Map<string, string>;
  };
  routes: RouteRegistration[];
  mounts: MountRegistration[];
};

type RouterRef = {
  filePath: string;
  instanceName: string;
  kind: 'app' | 'router';
  source: SourceRef;
};

type ResolvedMount = {
  middlewares: MiddlewareRef[];
  targets: RouterRef[];
};

const ANALYZABLE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const SEARCH_EXCLUDE = '**/{node_modules,dist,dist-webview,.git,.vscode-test,coverage}/**';

export const EMPTY_GRAPH: DiagramPayload = { nodes: [], edges: [] };

export async function analyzeWorkspace(): Promise<DiagramPayload> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    return EMPTY_GRAPH;
  }

  const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.{ts,js,tsx,jsx,mts,cts,mjs,cjs}');
  const files = await vscode.workspace.findFiles(pattern, SEARCH_EXCLUDE);
  const modules = new Map<string, ModuleInfo>();

  for (const file of files) {
    if (!isAnalyzableFile(file.fsPath)) {
      continue;
    }

    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    const normalizedPath = normalizeFilePath(file.fsPath);
    modules.set(normalizedPath, parseModule(normalizedPath, content));
  }

  return buildGraph(modules);
}

function buildGraph(modules: Map<string, ModuleInfo>): DiagramPayload {
  const graph: DiagramPayload = {
    nodes: [],
    edges: []
  };
  const nodeMap = new Map<string, DiagramNode>();
  const edgeKeys = new Set<string>();
  const routerResolutionCache = new Map<string, RouterRef | undefined>();
  const factoryResolutionCache = new Map<string, RouterRef | undefined>();
  const mountResolutionCache = new Map<string, ResolvedMount>();
  const mountedRouterKeys = new Set<string>();

  const addNode = (node: DiagramNode) => {
    if (nodeMap.has(node.id)) {
      return;
    }

    nodeMap.set(node.id, node);
    graph.nodes.push(node);
  };

  const addEdge = (from: string, to: string, label?: string) => {
    const edgeKey = `${from}:${to}:${label ?? ''}`;

    if (edgeKeys.has(edgeKey)) {
      return;
    }

    edgeKeys.add(edgeKey);
    graph.edges.push({ from, to, label });
  };

  const resolveRouterRef = (module: ModuleInfo, localName: string, seen = new Set<string>()): RouterRef | undefined => {
    const cacheKey = `${module.filePath}:${localName}`;

    if (routerResolutionCache.has(cacheKey)) {
      return routerResolutionCache.get(cacheKey);
    }

    if (seen.has(cacheKey)) {
      return undefined;
    }

    seen.add(cacheKey);

    const localInstance = module.instances.get(localName);

    if (localInstance) {
      const resolvedLocal: RouterRef = {
        filePath: module.filePath,
        instanceName: localName,
        kind: localInstance.kind,
        source: localInstance.source
      };
      routerResolutionCache.set(cacheKey, resolvedLocal);
      return resolvedLocal;
    }

    const binding = module.imports.get(localName);

    if (!binding || !isLocalModuleSpecifier(binding.specifier)) {
      routerResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const targetFile = resolveLocalModulePath(module.filePath, binding.specifier, modules);

    if (!targetFile) {
      routerResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const targetModule = modules.get(targetFile);

    if (!targetModule) {
      routerResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const exportedLocalName = binding.importedName === 'default'
      ? targetModule.exports.default
      : binding.importedName === '*'
        ? undefined
        : targetModule.exports.named.get(binding.importedName);

    if (!exportedLocalName) {
      routerResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const resolvedImport = resolveRouterRef(targetModule, exportedLocalName, seen);
    routerResolutionCache.set(cacheKey, resolvedImport);
    return resolvedImport;
  };

  const resolveMount = (module: ModuleInfo, mount: MountRegistration): ResolvedMount => {
    const cacheKey = `${module.filePath}:${mount.source.line}:${mount.source.column}:${mount.path}`;
    const cachedMount = mountResolutionCache.get(cacheKey);

    if (cachedMount) {
      return cachedMount;
    }

    const middlewares: MiddlewareRef[] = [];
    const targets: RouterRef[] = [];

    for (const arg of mount.args) {
      if (arg.kind === 'identifier' || arg.kind === 'call') {
        const target = arg.kind === 'identifier'
          ? resolveRouterRef(module, arg.name) ?? resolveRouterFactoryRef(module, arg.name)
          : arg.calleeName
            ? resolveRouterFactoryRef(module, arg.calleeName)
            : undefined;

        if (target) {
          targets.push(target);
          continue;
        }
      }

      middlewares.push(arg);
    }

    const resolvedMount = { middlewares, targets };
    mountResolutionCache.set(cacheKey, resolvedMount);
    return resolvedMount;
  };

  const resolveRouterFactoryRef = (module: ModuleInfo, localName: string, seen = new Set<string>()): RouterRef | undefined => {
    const cacheKey = `${module.filePath}:${localName}`;

    if (factoryResolutionCache.has(cacheKey)) {
      return factoryResolutionCache.get(cacheKey);
    }

    if (seen.has(cacheKey)) {
      return undefined;
    }

    seen.add(cacheKey);

    const returnedInstanceName = module.routerFactories.get(localName);

    if (returnedInstanceName) {
      const resolvedLocalFactory = resolveRouterRef(module, returnedInstanceName, seen);
      factoryResolutionCache.set(cacheKey, resolvedLocalFactory);
      return resolvedLocalFactory;
    }

    const binding = module.imports.get(localName);

    if (!binding || !isLocalModuleSpecifier(binding.specifier)) {
      factoryResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const targetFile = resolveLocalModulePath(module.filePath, binding.specifier, modules);

    if (!targetFile) {
      factoryResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const targetModule = modules.get(targetFile);

    if (!targetModule) {
      factoryResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const exportedLocalName = binding.importedName === 'default'
      ? targetModule.exports.default
      : binding.importedName === '*'
        ? undefined
        : targetModule.exports.named.get(binding.importedName);

    if (!exportedLocalName) {
      factoryResolutionCache.set(cacheKey, undefined);
      return undefined;
    }

    const resolvedImport = resolveRouterFactoryRef(targetModule, exportedLocalName, seen);
    factoryResolutionCache.set(cacheKey, resolvedImport);
    return resolvedImport;
  };

  for (const module of modules.values()) {
    for (const mount of module.mounts) {
      const resolvedMount = resolveMount(module, mount);

      for (const target of resolvedMount.targets) {
        mountedRouterKeys.add(getRouterKey(target));
      }
    }
  }

  const visitedRoutes = new Set<string>();
  const traverseRouter = (routerRef: RouterRef, basePath: string) => {
    const visitKey = `${getRouterKey(routerRef)}@${normalizePath(basePath)}`;

    if (visitedRoutes.has(visitKey)) {
      return;
    }

    visitedRoutes.add(visitKey);

    const module = modules.get(routerRef.filePath);

    if (!module) {
      return;
    }

    const routerNodeId = getRouterNodeId(routerRef, basePath);

    addNode({
      id: routerNodeId,
      label: normalizePath(basePath),
      kind: 'router',
      source: routerRef.source
    });

    for (const route of module.routes.filter((candidate) => candidate.instanceName === routerRef.instanceName)) {
      const routePath = joinPaths(basePath, route.path);
      const routeNodeId = getEndpointNodeId(route, routePath);
      const chain = [
        ...getScopedMiddlewares(module, routerRef.instanceName, route.path, resolveMount),
        ...route.middlewares
      ];

      addNode({
        id: routeNodeId,
        label: `${route.method} ${routePath}`,
        kind: 'endpoint',
        source: route.source
      });

      connectChain(routerNodeId, chain, routeNodeId, 'handles', addNode, addEdge);
    }

    for (const mount of module.mounts.filter((candidate) => candidate.instanceName === routerRef.instanceName)) {
      const resolvedMount = resolveMount(module, mount);

      if (resolvedMount.targets.length === 0) {
        continue;
      }

      const chain = [
        ...getScopedMiddlewares(module, routerRef.instanceName, mount.path, resolveMount),
        ...resolvedMount.middlewares
      ];
      const mountedPath = joinPaths(basePath, mount.path);

      for (const target of resolvedMount.targets) {
        const childRouterNodeId = getRouterNodeId(target, mountedPath);

        addNode({
          id: childRouterNodeId,
          label: normalizePath(mountedPath),
          kind: 'router',
          source: target.source
        });

        connectChain(routerNodeId, chain, childRouterNodeId, 'mounts', addNode, addEdge);
        traverseRouter(target, mountedPath);
      }
    }
  };

  for (const rootRouter of getRootRouters(modules, mountedRouterKeys)) {
    traverseRouter(rootRouter, '/');
  }

  return graph;
}

function connectChain(
  startNodeId: string,
  middlewares: MiddlewareRef[],
  endNodeId: string,
  label: string,
  addNode: (node: DiagramNode) => void,
  addEdge: (from: string, to: string, edgeLabel?: string) => void
) {
  let previousNodeId = startNodeId;

  for (const middleware of middlewares) {
    const middlewareNodeId = getMiddlewareNodeId(middleware);

    addNode({
      id: middlewareNodeId,
      label: middleware.name,
      kind: 'middleware',
      source: middleware.source
    });
    addEdge(previousNodeId, middlewareNodeId, 'uses');
    previousNodeId = middlewareNodeId;
  }

  addEdge(previousNodeId, endNodeId, label);
}

function getScopedMiddlewares(
  module: ModuleInfo,
  instanceName: string,
  targetPath: string,
  resolveMount: (module: ModuleInfo, mount: MountRegistration) => ResolvedMount
) {
  const middlewares: MiddlewareRef[] = [];

  for (const mount of module.mounts) {
    if (mount.instanceName !== instanceName) {
      continue;
    }

    const resolvedMount = resolveMount(module, mount);

    if (resolvedMount.targets.length > 0 || !pathMatches(mount.path, targetPath)) {
      continue;
    }

    middlewares.push(...resolvedMount.middlewares);
  }

  return middlewares;
}

function getRootRouters(modules: Map<string, ModuleInfo>, mountedRouterKeys: Set<string>) {
  const appRouters: RouterRef[] = [];
  const standaloneRouters: RouterRef[] = [];

  for (const module of modules.values()) {
    for (const instance of module.instances.values()) {
      const routerRef: RouterRef = {
        filePath: module.filePath,
        instanceName: instance.name,
        kind: instance.kind,
        source: instance.source
      };

      if (instance.kind === 'app') {
        appRouters.push(routerRef);
        continue;
      }

      if (!mountedRouterKeys.has(getRouterKey(routerRef))) {
        standaloneRouters.push(routerRef);
      }
    }
  }

  return (appRouters.length > 0 ? appRouters : standaloneRouters)
    .sort((left, right) => `${left.filePath}:${left.instanceName}`.localeCompare(`${right.filePath}:${right.instanceName}`));
}

function parseModule(filePath: string, content: string): ModuleInfo {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const moduleInfo: ModuleInfo = {
    filePath,
    imports: new Map(),
    instances: new Map(),
    routerFactories: new Map(),
    exports: { named: new Map() },
    routes: [],
    mounts: []
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      recordImports(moduleInfo, node);
    }

    if (ts.isVariableDeclaration(node)) {
      recordRequireImport(moduleInfo, node);
      recordRouterInstance(moduleInfo, node, sourceFile);
      recordVariableRouterFactory(moduleInfo, node);
    }

    if (ts.isFunctionDeclaration(node)) {
      recordFunctionDeclaration(moduleInfo, node);
    }

    if (ts.isExportAssignment(node)) {
      recordExportAssignment(moduleInfo, node);
    }

    if (ts.isExportDeclaration(node)) {
      recordNamedExports(moduleInfo, node);
    }

    if (ts.isExpressionStatement(node)) {
      recordCommonJsExports(moduleInfo, node.expression);
    }

    if (ts.isCallExpression(node)) {
      recordRouteOrMount(moduleInfo, node, sourceFile);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return moduleInfo;
}

function recordImports(moduleInfo: ModuleInfo, node: ts.ImportDeclaration) {
  const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  const importClause = node.importClause;

  if (!specifier || !importClause) {
    return;
  }

  if (importClause.name) {
    moduleInfo.imports.set(importClause.name.text, { specifier, importedName: 'default' });
  }

  if (!importClause.namedBindings) {
    return;
  }

  if (ts.isNamespaceImport(importClause.namedBindings)) {
    moduleInfo.imports.set(importClause.namedBindings.name.text, { specifier, importedName: '*' });
    return;
  }

  for (const element of importClause.namedBindings.elements) {
    moduleInfo.imports.set(element.name.text, {
      specifier,
      importedName: element.propertyName?.text ?? element.name.text
    });
  }
}

function recordRequireImport(moduleInfo: ModuleInfo, node: ts.VariableDeclaration) {
  const specifier = getRequireSpecifier(node.initializer);

  if (!specifier) {
    return;
  }

  if (ts.isIdentifier(node.name)) {
    moduleInfo.imports.set(node.name.text, { specifier, importedName: 'default' });
    return;
  }

  if (!ts.isObjectBindingPattern(node.name)) {
    return;
  }

  for (const element of node.name.elements) {
    if (!ts.isIdentifier(element.name)) {
      continue;
    }

    moduleInfo.imports.set(element.name.text, {
      specifier,
      importedName: ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
    });
  }
}

function recordRouterInstance(moduleInfo: ModuleInfo, node: ts.VariableDeclaration, sourceFile: ts.SourceFile) {
  if (!ts.isIdentifier(node.name) || !node.initializer || !ts.isCallExpression(node.initializer)) {
    return;
  }

  const kind = getInstanceKind(moduleInfo, node.initializer);

  if (!kind) {
    return;
  }

  moduleInfo.instances.set(node.name.text, {
    name: node.name.text,
    kind,
    source: getSourceRef(node.name, sourceFile)
  });

  if (hasExportModifier(node)) {
    moduleInfo.exports.named.set(node.name.text, node.name.text);
  }
}

function recordExportAssignment(moduleInfo: ModuleInfo, node: ts.ExportAssignment) {
  if (ts.isIdentifier(node.expression)) {
    moduleInfo.exports.default = node.expression.text;
  }
}

function recordFunctionDeclaration(moduleInfo: ModuleInfo, node: ts.FunctionDeclaration) {
  if (!node.name) {
    return;
  }

  const functionName = node.name.text;

  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
    moduleInfo.exports.named.set(functionName, functionName);
  }

  if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    moduleInfo.exports.default = functionName;
  }

  const returnedIdentifier = getReturnedIdentifierName(node.body);

  if (returnedIdentifier) {
    moduleInfo.routerFactories.set(functionName, returnedIdentifier);
  }
}

function recordVariableRouterFactory(moduleInfo: ModuleInfo, node: ts.VariableDeclaration) {
  if (!ts.isIdentifier(node.name) || !node.initializer) {
    return;
  }

  if (!ts.isArrowFunction(node.initializer) && !ts.isFunctionExpression(node.initializer)) {
    return;
  }

  const returnedIdentifier = getReturnedIdentifierName(node.initializer.body);

  if (!returnedIdentifier) {
    return;
  }

  moduleInfo.routerFactories.set(node.name.text, returnedIdentifier);

  if (hasExportModifier(node)) {
    moduleInfo.exports.named.set(node.name.text, node.name.text);
  }
}

function recordNamedExports(moduleInfo: ModuleInfo, node: ts.ExportDeclaration) {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.moduleSpecifier) {
    return;
  }

  for (const element of node.exportClause.elements) {
    moduleInfo.exports.named.set(element.name.text, element.propertyName?.text ?? element.name.text);
  }
}

function recordCommonJsExports(moduleInfo: ModuleInfo, expression: ts.Expression) {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return;
  }

  if (isModuleExports(expression.left) && ts.isIdentifier(expression.right)) {
    moduleInfo.exports.default = expression.right.text;
    return;
  }

  if (ts.isPropertyAccessExpression(expression.left) && isExportsObject(expression.left.expression) && ts.isIdentifier(expression.right)) {
    moduleInfo.exports.named.set(expression.left.name.text, expression.right.text);
    return;
  }

  if (!isModuleExports(expression.left) || !ts.isObjectLiteralExpression(expression.right)) {
    return;
  }

  for (const property of expression.right.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      moduleInfo.exports.named.set(property.name.text, property.name.text);
      continue;
    }

    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ts.isIdentifier(property.initializer)) {
      moduleInfo.exports.named.set(property.name.text, property.initializer.text);
    }
  }
}

function recordRouteOrMount(moduleInfo: ModuleInfo, node: ts.CallExpression, sourceFile: ts.SourceFile) {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return;
  }

  const methodName = node.expression.name.text;

  if (methodName === 'use') {
    const instanceName = getInstanceName(moduleInfo, node.expression.expression);

    if (!instanceName) {
      return;
    }

    const parsedMount = parseMountArguments(node.arguments, sourceFile);
    moduleInfo.mounts.push({
      instanceName,
      path: parsedMount.path,
      args: parsedMount.args,
      source: getSourceRef(node, sourceFile)
    });
    return;
  }

  if (!HTTP_METHODS.has(methodName)) {
    return;
  }

  const instanceName = getInstanceName(moduleInfo, node.expression.expression);

  if (instanceName) {
    const routePath = getLiteralPath(node.arguments[0]);

    if (routePath === undefined) {
      return;
    }

    moduleInfo.routes.push({
      instanceName,
      method: methodName.toUpperCase(),
      path: routePath,
      middlewares: getRouteMiddlewares(node.arguments.slice(1), sourceFile),
      source: getSourceRef(node, sourceFile)
    });
    return;
  }

  if (!ts.isCallExpression(node.expression.expression)) {
    return;
  }

  const routeBuilder = resolveRouteBuilder(moduleInfo, node.expression.expression);

  if (!routeBuilder) {
    return;
  }

  moduleInfo.routes.push({
    instanceName: routeBuilder.instanceName,
    method: methodName.toUpperCase(),
    path: routeBuilder.path,
    middlewares: getRouteMiddlewares(node.arguments, sourceFile),
    source: getSourceRef(node, sourceFile)
  });
}

function parseMountArguments(argumentsList: ts.NodeArray<ts.Expression>, sourceFile: ts.SourceFile) {
  const firstArgument = argumentsList[0];
  const pathArgument = getLiteralPath(firstArgument);
  const remainingArguments = pathArgument === undefined ? argumentsList : argumentsList.slice(1);

  return {
    path: pathArgument ?? '/',
    args: remainingArguments.flatMap((argument) => flattenArgument(argument, sourceFile))
  };
}

function getRouteMiddlewares(argumentsList: readonly ts.Expression[], sourceFile: ts.SourceFile) {
  const flattenedArguments = argumentsList.flatMap((argument) => flattenArgument(argument, sourceFile));

  if (flattenedArguments.length <= 1) {
    return [];
  }

  return flattenedArguments.slice(0, -1);
}

function resolveRouteBuilder(moduleInfo: ModuleInfo, node: ts.CallExpression): { instanceName: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return undefined;
  }

  if (node.expression.name.text === 'route') {
    const instanceName = getInstanceName(moduleInfo, node.expression.expression);
    const routePath = getLiteralPath(node.arguments[0]);

    if (!instanceName || routePath === undefined) {
      return undefined;
    }

    return { instanceName, path: routePath };
  }

  if (!HTTP_METHODS.has(node.expression.name.text) || !ts.isCallExpression(node.expression.expression)) {
    return undefined;
  }

  return resolveRouteBuilder(moduleInfo, node.expression.expression);
}

function flattenArgument(argument: ts.Expression, sourceFile: ts.SourceFile): ParsedArg[] {
  if (ts.isArrayLiteralExpression(argument)) {
    return argument.elements.flatMap((element) => ts.isExpression(element) ? flattenArgument(element, sourceFile) : []);
  }

  if (ts.isSpreadElement(argument)) {
    return [{
      kind: 'expression',
      name: getExpressionLabel(argument.expression, sourceFile),
      source: getSourceRef(argument.expression, sourceFile)
    }];
  }

  if (ts.isIdentifier(argument)) {
    return [{
      kind: 'identifier',
      name: argument.text,
      source: getSourceRef(argument, sourceFile)
    }];
  }

  if (ts.isCallExpression(argument)) {
    const calleeName = getCallExpressionName(argument.expression);

    return [{
      kind: calleeName ? 'call' : 'expression',
      name: getExpressionLabel(argument, sourceFile),
      calleeName,
      source: getSourceRef(argument, sourceFile)
    }];
  }

  return [{
    kind: 'expression',
    name: getExpressionLabel(argument, sourceFile),
    source: getSourceRef(argument, sourceFile)
  }];
}

function getExpressionLabel(expression: ts.Expression, sourceFile: ts.SourceFile) {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return 'anonymous';
  }

  const text = expression.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function getInstanceKind(moduleInfo: ModuleInfo, initializer: ts.CallExpression): 'app' | 'router' | undefined {
  if (ts.isIdentifier(initializer.expression)) {
    const binding = moduleInfo.imports.get(initializer.expression.text);

    if (binding?.specifier === 'express' && (binding.importedName === 'default' || binding.importedName === '*')) {
      return 'app';
    }

    if (binding?.specifier === 'express' && binding.importedName === 'Router') {
      return 'router';
    }
  }

  if (!ts.isPropertyAccessExpression(initializer.expression)) {
    return undefined;
  }

  if (initializer.expression.name.text !== 'Router' || !ts.isIdentifier(initializer.expression.expression)) {
    return undefined;
  }

  const binding = moduleInfo.imports.get(initializer.expression.expression.text);
  return binding?.specifier === 'express' && (binding.importedName === 'default' || binding.importedName === '*')
    ? 'router'
    : undefined;
}

function getInstanceName(moduleInfo: ModuleInfo, expression: ts.Expression) {
  return ts.isIdentifier(expression) && moduleInfo.instances.has(expression.text)
    ? expression.text
    : undefined;
}

function getCallExpressionName(expression: ts.LeftHandSideExpression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  return undefined;
}

function getLiteralPath(expression: ts.Expression | undefined) {
  if (!expression) {
    return undefined;
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text || '/';
  }

  return undefined;
}

function hasExportModifier(node: ts.Node) {
  return !!node.parent?.parent
    && ts.isVariableStatement(node.parent.parent)
    && !!node.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return !!node.modifiers?.some((modifier) => modifier.kind === kind);
}

function getReturnedIdentifierName(body: ts.ConciseBody | undefined) {
  if (!body) {
    return undefined;
  }

  if (ts.isIdentifier(body)) {
    return body.text;
  }

  if (!ts.isBlock(body)) {
    return undefined;
  }

  let returnedIdentifier: string | undefined;
  let hasConflictingReturn = false;

  const visit = (node: ts.Node) => {
    if (hasConflictingReturn) {
      return;
    }

    if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      return;
    }

    if (ts.isReturnStatement(node)) {
      if (!node.expression || !ts.isIdentifier(node.expression)) {
        hasConflictingReturn = true;
        return;
      }

      if (returnedIdentifier && returnedIdentifier !== node.expression.text) {
        hasConflictingReturn = true;
        return;
      }

      returnedIdentifier = node.expression.text;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(body);

  return hasConflictingReturn ? undefined : returnedIdentifier;
}

function getRequireSpecifier(expression: ts.Expression | undefined) {
  if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') {
    return undefined;
  }

  const firstArgument = expression.arguments[0];
  return ts.isStringLiteral(firstArgument) ? firstArgument.text : undefined;
}

function isModuleExports(expression: ts.Expression) {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'module'
    && expression.name.text === 'exports';
}

function isExportsObject(expression: ts.Expression) {
  return ts.isIdentifier(expression) && expression.text === 'exports';
}

function getRouterKey(routerRef: RouterRef) {
  return `${routerRef.filePath}:${routerRef.instanceName}`;
}

function getRouterNodeId(routerRef: RouterRef, mountedPath: string) {
  return `router:${getRouterKey(routerRef)}:${normalizePath(mountedPath)}`;
}

function getMiddlewareNodeId(middleware: MiddlewareRef) {
  return `middleware:${middleware.source.file}:${middleware.source.line}:${middleware.source.column}:${middleware.name}`;
}

function getEndpointNodeId(route: RouteRegistration, fullPath: string) {
  return `endpoint:${route.source.file}:${route.source.line}:${route.source.column}:${route.method}:${fullPath}`;
}

function resolveLocalModulePath(fromFilePath: string, specifier: string, modules: Map<string, ModuleInfo>) {
  const basePath = normalizeFilePath(path.resolve(path.dirname(fromFilePath), specifier));
  const extensionlessBasePath = stripRuntimeExtension(basePath);
  const candidates = [
    basePath,
    extensionlessBasePath,
    ...ANALYZABLE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...ANALYZABLE_EXTENSIONS.map((extension) => `${extensionlessBasePath}${extension}`),
    ...ANALYZABLE_EXTENSIONS.map((extension) => normalizeFilePath(path.join(basePath, `index${extension}`))),
    ...ANALYZABLE_EXTENSIONS.map((extension) => normalizeFilePath(path.join(extensionlessBasePath, `index${extension}`)))
  ];

  return candidates.map(normalizeFilePath).find((candidate) => modules.has(candidate));
}

function isLocalModuleSpecifier(specifier: string) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isAnalyzableFile(filePath: string) {
  return ANALYZABLE_EXTENSIONS.includes(path.extname(filePath).toLowerCase()) && !filePath.endsWith('.d.ts');
}

function normalizeFilePath(filePath: string) {
  return path.normalize(filePath);
}

function stripRuntimeExtension(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (!['.js', '.mjs', '.cjs'].includes(extension)) {
    return filePath;
  }

  return filePath.slice(0, -extension.length);
}

function joinPaths(basePath: string, childPath: string) {
  const segments = [...getPathSegments(basePath), ...getPathSegments(childPath)];
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function pathMatches(scopePath: string, targetPath: string) {
  const normalizedScope = normalizePath(scopePath);
  const normalizedTarget = normalizePath(targetPath);

  if (normalizedScope === '/') {
    return true;
  }

  return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
}

function normalizePath(routePath: string) {
  const segments = getPathSegments(routePath);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function getPathSegments(routePath: string) {
  return routePath.split('/').map((segment) => segment.trim()).filter(Boolean);
}

function getSourceRef(node: ts.Node, sourceFile: ts.SourceFile): SourceRef {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return {
    file: normalizeFilePath(sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1
  };
}