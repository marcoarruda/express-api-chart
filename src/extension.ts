import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeWorkspace, EMPTY_GRAPH, type DiagramPayload, type SourceRef } from '../analyzer';

type EndpointNode = {
  id: string;
  method: string;
  path: string;
  middlewareCount: number;
  middlewares: MiddlewareNode[];
  source: SourceRef;
};

type MiddlewareNode = {
  id: string;
  label: string;
  order: number;
  source: SourceRef;
};

type PathGroupNode = {
  id: string;
  label: string;
  fullPath: string;
  groups: PathGroupNode[];
  endpoints: EndpointNode[];
};

type EndpointTreeRoot = {
  groups: PathGroupNode[];
  endpoints: EndpointNode[];
};

type EndpointTreeNode = PathGroupNode | EndpointNode | MiddlewareNode;

type TreeIconSet = {
  router: vscode.Uri;
  endpoint: vscode.Uri;
  middleware: vscode.Uri;
};

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const graphStore = new GraphStore();
  const endpointTreeProvider = new EndpointTreeDataProvider(() => graphStore.current, {
    router: vscode.Uri.file(path.join(context.extensionPath, 'media', 'tree-router.svg')),
    endpoint: vscode.Uri.file(path.join(context.extensionPath, 'media', 'tree-endpoint.svg')),
    middleware: vscode.Uri.file(path.join(context.extensionPath, 'media', 'tree-middleware.svg'))
  });
  const endpointTreeView = vscode.window.createTreeView('expresstsObserver.endpoints', {
    treeDataProvider: endpointTreeProvider,
    showCollapseAll: true
  });

  const graphSubscription = graphStore.onDidChange((graph) => {
    endpointTreeProvider.refresh();

    if (panel) {
      panel.webview.postMessage({ type: 'graph', payload: graph });
    }
  });

  context.subscriptions.push(
    endpointTreeView,
    graphSubscription,
    vscode.commands.registerCommand('expresstsObserver.openDiagram', async () => {
      await graphStore.refresh();
      await openDiagram(context, graphStore.current);
    }),
    vscode.commands.registerCommand('expresstsObserver.refreshDiagram', async () => {
      await graphStore.refresh(true);
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (isAnalyzableDocument(document)) {
        await graphStore.refresh(true);
      }
    })
  );

  void graphStore.refresh();
}

export function deactivate() {}

class GraphStore {
  private graph = EMPTY_GRAPH;
  private readonly listeners = new Set<(graph: DiagramPayload) => void>();
  private refreshPromise: Promise<DiagramPayload> | undefined;

  get current() {
    return this.graph;
  }

  onDidChange(listener: (graph: DiagramPayload) => void) {
    this.listeners.add(listener);
    listener(this.graph);

    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  async refresh(force = false) {
    if (this.refreshPromise && !force) {
      return this.refreshPromise;
    }

    this.refreshPromise = analyzeWorkspace()
      .then((graph) => {
        this.graph = graph;
        this.emit();
        return graph;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`ExpressTS Observer analysis failed: ${message}`);
        this.graph = EMPTY_GRAPH;
        this.emit();
        return this.graph;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });

    return this.refreshPromise;
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this.graph);
    }
  }
}

async function openDiagram(context: vscode.ExtensionContext, graph: DiagramPayload) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    panel.webview.postMessage({ type: 'graph', payload: graph });
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'expresstsObserver.diagram',
    'ExpressTS Diagram',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist-webview'))]
    }
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === 'openSource') {
      await openSource(message.source as SourceRef);
    }
  });

  panel.webview.html = getHtml(panel.webview, context);

  setTimeout(() => {
    panel?.webview.postMessage({ type: 'graph', payload: graph });
  }, 50);
}

class EndpointTreeDataProvider implements vscode.TreeDataProvider<EndpointTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<EndpointTreeNode | undefined>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly getGraph: () => DiagramPayload,
    private readonly icons: TreeIconSet
  ) {}

  refresh() {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: EndpointTreeNode): vscode.TreeItem {
    if ('groups' in element) {
      const childCount = element.groups.length + element.endpoints.length;
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'pathGroup';
      item.description = `${childCount} item${childCount === 1 ? '' : 's'}`;
      item.tooltip = element.fullPath;
      item.iconPath = this.icons.router;
      return item;
    }

    if ('method' in element) {
      const item = new vscode.TreeItem(
        element.method,
        element.middlewares.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = 'endpoint';
      item.description = `${element.middlewareCount} mw`;
      item.tooltip = `${element.method} ${element.path}\n${getRelativeSourceLabel(element.source.file)}`;
      item.iconPath = this.icons.endpoint;
      item.command = {
        command: 'vscode.open',
        title: 'Open Endpoint Source',
        arguments: [toSourceUri(element.source), { selection: toSourceSelection(element.source), preview: false }]
      };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'middleware';
    item.description = `${element.order}`;
    item.tooltip = `${element.label}\n${getRelativeSourceLabel(element.source.file)}`;
    item.iconPath = this.icons.middleware;
    item.command = {
      command: 'vscode.open',
      title: 'Open Middleware Source',
      arguments: [toSourceUri(element.source), { selection: toSourceSelection(element.source), preview: false }]
    };
    return item;
  }

  getChildren(element?: EndpointTreeNode): EndpointTreeNode[] {
    const tree = getEndpointTree(this.getGraph());

    if (!element) {
      return [...tree.groups, ...sortEndpoints(tree.endpoints)];
    }

    if ('groups' in element) {
      return [...sortGroups(element.groups), ...sortEndpoints(element.endpoints)];
    }

    if ('method' in element) {
      return element.middlewares;
    }

    return [];
  }
}

async function openSource(source: SourceRef) {
  const doc = await vscode.workspace.openTextDocument(toSourceUri(source));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const selection = toSourceSelection(source);

  editor.selection = new vscode.Selection(selection.start, selection.end);
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
}

function toSourceUri(source: SourceRef) {
  return vscode.Uri.file(
    path.isAbsolute(source.file)
      ? source.file
      : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', source.file)
  );
}

function toSourceSelection(source: SourceRef) {
  const position = new vscode.Position(Math.max(0, source.line - 1), Math.max(0, source.column - 1));
  return new vscode.Range(position, position);
}

function getRelativeSourceLabel(file: string) {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspacePath) {
    return file;
  }

  return path.isAbsolute(file) ? path.relative(workspacePath, file) : file;
}

function getEndpointTree(graph: DiagramPayload): EndpointTreeRoot {
  const endpoints = getEndpoints(graph);
  const root: EndpointTreeRoot = {
    groups: [],
    endpoints: []
  };

  for (const endpoint of endpoints) {
    const segments = getPathSegments(endpoint.path);

    if (segments.length === 0) {
      root.endpoints.push(endpoint);
      continue;
    }

    let currentGroups = root.groups;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      let group = currentGroups.find((candidate) => candidate.label === segment);

      if (!group) {
        group = {
          id: currentPath,
          label: segment,
          fullPath: currentPath,
          groups: [],
          endpoints: []
        };
        currentGroups.push(group);
      }

      currentGroups = group.groups;

      if (segment === segments[segments.length - 1]) {
        group.endpoints.push(endpoint);
      }
    }
  }

  return root;
}

function getEndpoints(graph: DiagramPayload): EndpointNode[] {
  const middlewareChains = getMiddlewareChains(graph);

  return graph.nodes
    .filter((node): node is DiagramPayload['nodes'][number] & { kind: 'endpoint' } => node.kind === 'endpoint')
    .map((node) => {
      const parsed = parseEndpointLabel(node.label);
      const middlewares = middlewareChains.get(node.id) ?? [];

      return {
        id: node.id,
        method: parsed.method,
        path: parsed.path,
        middlewareCount: middlewares.length,
        middlewares,
        source: node.source
      };
    });
}

function getMiddlewareChains(graph: DiagramPayload) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const inboundEdges = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const sources = inboundEdges.get(edge.to) ?? [];
    sources.push(edge.from);
    inboundEdges.set(edge.to, sources);
  }

  const middlewareChains = new Map<string, MiddlewareNode[]>();

  for (const node of graph.nodes) {
    if (node.kind !== 'endpoint') {
      continue;
    }

    const visited = new Set<string>();
    const middlewareChain: MiddlewareNode[] = [];
    const queue = [...(inboundEdges.get(node.id) ?? [])];

    while (queue.length > 0) {
      const currentId = queue.shift();

      if (!currentId || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);

      const currentNode = nodeById.get(currentId);

      if (!currentNode) {
        continue;
      }

      if (currentNode.kind === 'middleware') {
        middlewareChain.push({
          id: currentId,
          label: currentNode.label,
          order: 0,
          source: currentNode.source
        });
      }

      queue.unshift(...(inboundEdges.get(currentId) ?? []));
    }

    middlewareChain.reverse().forEach((middleware, index) => {
      middleware.order = index + 1;
    });
    middlewareChains.set(node.id, middlewareChain);
  }

  return middlewareChains;
}

function getPathSegments(routePath: string) {
  const normalizedPath = routePath.trim();

  if (normalizedPath === '/' || normalizedPath.length === 0) {
    return [];
  }

  return normalizedPath.split('/').filter(Boolean);
}

function sortGroups(groups: PathGroupNode[]) {
  return [...groups].sort((left, right) => left.fullPath.localeCompare(right.fullPath));
}

function sortEndpoints(endpoints: EndpointNode[]) {
  return [...endpoints].sort((left, right) => {
    const pathComparison = left.path.localeCompare(right.path);

    if (pathComparison !== 0) {
      return pathComparison;
    }

    return left.method.localeCompare(right.method);
  });
}

function parseEndpointLabel(label: string) {
  const match = label.match(/^(\S+)\s+(.+)$/);

  if (!match) {
    return {
      method: 'ROUTE',
      path: label
    };
  }

  return {
    method: match[1].toUpperCase(),
    path: match[2]
  };
}

function getHtml(webview: vscode.Webview, context: vscode.ExtensionContext) {
  const safeWebview = webview as vscode.Webview & {
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
    cspSource: string;
  };
  const scriptUri = safeWebview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'dist-webview', 'assets', 'index.js'))
  );
  const styleUri = safeWebview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'dist-webview', 'assets', 'index.css'))
  );
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta property="csp-nonce" nonce="${nonce}" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${safeWebview.cspSource} https:; style-src ${safeWebview.cspSource} 'unsafe-inline'; script-src ${safeWebview.cspSource} 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>ExpressTS Diagram</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function isAnalyzableDocument(document: vscode.TextDocument) {
  return ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(
    path.extname(document.uri.fsPath).toLowerCase()
  );
}
