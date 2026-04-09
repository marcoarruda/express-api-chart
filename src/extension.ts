import * as vscode from 'vscode';
import * as path from 'path';

type SourceRef = {
  file: string;
  line: number;
  column: number;
};

type DiagramNode = {
  id: string;
  label: string;
  kind: 'endpoint' | 'middleware' | 'router';
  source: SourceRef;
};

type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
};

type DiagramPayload = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

type EndpointNode = {
  id: string;
  method: string;
  path: string;
  middlewareCount: number;
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

type EndpointTreeNode = PathGroupNode | EndpointNode;

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const endpointTreeProvider = new EndpointTreeDataProvider(() => getMockGraph());

  context.subscriptions.push(
    vscode.window.createTreeView('expresstsObserver.endpoints', {
      treeDataProvider: endpointTreeProvider,
      showCollapseAll: true
    }),
    vscode.commands.registerCommand('expresstsObserver.openDiagram', () => {
      openDiagram(context);
    }),
    vscode.commands.registerCommand('expresstsObserver.refreshDiagram', () => {
      endpointTreeProvider.refresh();

      if (panel) {
        panel.webview.postMessage({
          type: 'graph',
          payload: getMockGraph()
        });
      }
    })
  );
}

export function deactivate() {}

function openDiagram(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    panel.webview.postMessage({ type: 'graph', payload: getMockGraph() });
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

  panel.webview.onDidReceiveMessage(() => {});

  setTimeout(() => {
    panel?.webview.postMessage({ type: 'graph', payload: getMockGraph() });
  }, 50);
}

class EndpointTreeDataProvider implements vscode.TreeDataProvider<EndpointTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<EndpointTreeNode | undefined>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly getGraph: () => DiagramPayload) {}

  refresh() {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: EndpointTreeNode): vscode.TreeItem {
    if ('groups' in element) {
      const childCount = element.groups.length + element.endpoints.length;
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'pathGroup';
      item.iconPath = new vscode.ThemeIcon('folder-library');
      item.description = `${childCount} item${childCount === 1 ? '' : 's'}`;
      item.tooltip = element.fullPath;
      return item;
    }

    const item = new vscode.TreeItem(element.method, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'endpoint';
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.description = `${element.middlewareCount} mw`;
    item.tooltip = `${element.method} ${element.path}\n${getRelativeSourceLabel(element.source.file)}`;
    item.command = {
      command: 'vscode.open',
      title: 'Open Endpoint Source',
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
  const middlewareCounts = getMiddlewareCounts(graph);

  return graph.nodes
    .filter((node): node is DiagramNode & { kind: 'endpoint' } => node.kind === 'endpoint')
    .map((node) => {
      const parsed = parseEndpointLabel(node.label);

      return {
        id: node.id,
        method: parsed.method,
        path: parsed.path,
        middlewareCount: middlewareCounts.get(node.id) ?? 0,
        source: node.source
      };
    });
}

function getMiddlewareCounts(graph: DiagramPayload) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const inboundEdges = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const sources = inboundEdges.get(edge.to) ?? [];
    sources.push(edge.from);
    inboundEdges.set(edge.to, sources);
  }

  const middlewareCounts = new Map<string, number>();

  for (const node of graph.nodes) {
    if (node.kind !== 'endpoint') {
      continue;
    }

    const visited = new Set<string>();
    const middlewareIds = new Set<string>();
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
        middlewareIds.add(currentId);
      }

      queue.push(...(inboundEdges.get(currentId) ?? []));
    }

    middlewareCounts.set(node.id, middlewareIds.size);
  }

  return middlewareCounts;
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
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'dist-webview', 'assets', 'index.js'))
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'dist-webview', 'assets', 'index.css'))
  );
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>ExpressTS Diagram</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getMockGraph(): DiagramPayload {
  return {
    nodes: [
      {
        id: 'router-api',
        label: '/api',
        kind: 'router',
        source: { file: 'src/app.ts', line: 10, column: 1 }
      },
      {
        id: 'mw-auth',
        label: 'authMiddleware',
        kind: 'middleware',
        source: { file: 'src/middlewares/auth.ts', line: 3, column: 1 }
      },
      {
        id: 'mw-audit',
        label: 'auditTrail',
        kind: 'middleware',
        source: { file: 'src/middlewares/audit.ts', line: 5, column: 1 }
      },
      {
        id: 'mw-validate-user',
        label: 'validateUserPayload',
        kind: 'middleware',
        source: { file: 'src/middlewares/validate-user.ts', line: 7, column: 1 }
      },
      {
        id: 'ep-users-get',
        label: 'GET /api/users',
        kind: 'endpoint',
        source: { file: 'src/routes/users.ts', line: 8, column: 1 }
      },
      {
        id: 'ep-users-post',
        label: 'POST /api/users',
        kind: 'endpoint',
        source: { file: 'src/routes/users.ts', line: 16, column: 1 }
      },
      {
        id: 'ep-users-id-get',
        label: 'GET /api/users/:id',
        kind: 'endpoint',
        source: { file: 'src/routes/users.ts', line: 24, column: 1 }
      },
      {
        id: 'ep-orders-get',
        label: 'GET /api/orders',
        kind: 'endpoint',
        source: { file: 'src/routes/orders.ts', line: 10, column: 1 }
      },
      {
        id: 'ep-health-get',
        label: 'GET /health',
        kind: 'endpoint',
        source: { file: 'src/routes/health.ts', line: 4, column: 1 }
      }
    ],
    edges: [
      { from: 'router-api', to: 'mw-auth', label: 'uses' },
      { from: 'mw-auth', to: 'mw-audit', label: 'uses' },
      { from: 'mw-audit', to: 'ep-users-get', label: 'handles' },
      { from: 'mw-audit', to: 'mw-validate-user', label: 'uses' },
      { from: 'mw-validate-user', to: 'ep-users-post', label: 'handles' },
      { from: 'mw-auth', to: 'ep-users-id-get', label: 'handles' },
      { from: 'mw-auth', to: 'ep-orders-get', label: 'handles' }
    ]
  };
}
