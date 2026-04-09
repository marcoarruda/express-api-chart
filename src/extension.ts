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
  source: SourceRef;
};

type PathGroup = {
  path: string;
  endpoints: EndpointNode[];
};

type EndpointTreeNode = PathGroup | EndpointNode;

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
    if ('endpoints' in element) {
      const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'pathGroup';
      item.iconPath = new vscode.ThemeIcon('folder-library');
      item.description = `${element.endpoints.length} endpoint${element.endpoints.length === 1 ? '' : 's'}`;
      return item;
    }

    const item = new vscode.TreeItem(element.method, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'endpoint';
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.description = getRelativeSourceLabel(element.source.file);
    item.tooltip = `${element.method} ${element.path}`;
    item.command = {
      command: 'vscode.open',
      title: 'Open Endpoint Source',
      arguments: [toSourceUri(element.source), { selection: toSourceSelection(element.source), preview: false }]
    };
    return item;
  }

  getChildren(element?: EndpointTreeNode): EndpointTreeNode[] {
    if (!element) {
      return getPathGroups(this.getGraph());
    }

    if ('endpoints' in element) {
      return [...element.endpoints].sort((left, right) => left.method.localeCompare(right.method));
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

function getPathGroups(graph: DiagramPayload): PathGroup[] {
  const endpoints = getEndpoints(graph);
  const groups = new Map<string, EndpointNode[]>();

  for (const endpoint of endpoints) {
    const existing = groups.get(endpoint.path) ?? [];
    existing.push(endpoint);
    groups.set(endpoint.path, existing);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupPath, groupedEndpoints]) => ({
      path: groupPath,
      endpoints: groupedEndpoints
    }));
}

function getEndpoints(graph: DiagramPayload): EndpointNode[] {
  return graph.nodes
    .filter((node): node is DiagramNode & { kind: 'endpoint' } => node.kind === 'endpoint')
    .map((node) => {
      const parsed = parseEndpointLabel(node.label);

      return {
        id: node.id,
        method: parsed.method,
        path: parsed.path,
        source: node.source
      };
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
        id: 'ep-users-get',
        label: 'GET /api/users',
        kind: 'endpoint',
        source: { file: 'src/routes/users.ts', line: 8, column: 1 }
      }
    ],
    edges: [
      { from: 'router-api', to: 'mw-auth', label: 'uses' },
      { from: 'mw-auth', to: 'ep-users-get', label: 'handles' }
    ]
  };
}
