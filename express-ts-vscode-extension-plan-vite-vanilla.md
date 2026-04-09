# ExpressTS VS Code Extension Plan (Vite Vanilla)

Paste each block in the terminal from the project root.

## 1) Create extension

```bash
mkdir expressts-observer
cd expressts-observer
npm init -y
npm install -D typescript @types/node @types/vscode vsce @vscode/test-electron esbuild vite
npm install vscode
npx tsc --init
mkdir -p src analyzer media/webview
```

## 2) Replace `package.json`

```bash
cat > package.json <<'EOF'
{
  "name": "expressts-observer",
  "displayName": "ExpressTS Observer",
  "description": "Observe Express TS routes and middlewares in a diagram",
  "version": "0.0.1",
  "publisher": "local",
  "engines": {
    "vscode": "^1.100.0"
  },
  "categories": ["Other"],
  "activationEvents": [
    "onCommand:expresstsObserver.openDiagram",
    "workspaceContains:**/package.json"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "expresstsObserver.openDiagram",
        "title": "ExpressTS: Open Diagram"
      },
      {
        "command": "expresstsObserver.refreshDiagram",
        "title": "ExpressTS: Refresh Diagram"
      }
    ]
  },
  "scripts": {
    "build:extension": "esbuild src/extension.ts --bundle --platform=node --external:vscode --outfile=dist/extension.js",
    "build:webview": "vite build --config media/webview/vite.config.ts",
    "build": "npm run build:webview && npm run build:extension",
    "watch:webview": "vite build --watch --config media/webview/vite.config.ts",
    "watch:extension": "esbuild src/extension.ts --bundle --platform=node --external:vscode --outfile=dist/extension.js --watch",
    "watch": "concurrently -c yellow,cyan \"npm:watch:webview\" \"npm:watch:extension\"",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/vscode": "^1.100.0",
    "@vscode/test-electron": "^2.5.2",
    "esbuild": "^0.25.0",
    "typescript": "^5.8.0",
    "vite": "^7.0.0",
    "vsce": "^2.15.0"
  },
  "dependencies": {
    "vscode": "^1.1.37"
  }
}
EOF
```

## 3) Add missing dev dependency used by watch script

```bash
npm install -D concurrently
```

## 4) Replace `tsconfig.json`

```bash
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022", "DOM"],
    "rootDir": ".",
    "strict": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "media/webview"]
}
EOF
```

## 5) Create extension entry

```bash
cat > src/extension.ts <<'EOF'
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

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('expresstsObserver.openDiagram', () => {
      openDiagram(context);
    }),
    vscode.commands.registerCommand('expresstsObserver.refreshDiagram', () => {
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
      const source = message.source as SourceRef;
      const uri = vscode.Uri.file(path.isAbsolute(source.file)
        ? source.file
        : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', source.file));

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const position = new vscode.Position(Math.max(0, source.line - 1), Math.max(0, source.column - 1));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  });

  panel.webview.html = getHtml(panel.webview, context);

  panel.webview.onDidReceiveMessage(() => {});

  setTimeout(() => {
    panel?.webview.postMessage({ type: 'graph', payload: getMockGraph() });
  }, 50);
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
EOF
```

## 6) Create Vite vanilla webview config

```bash
cat > media/webview/vite.config.ts <<'EOF'
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, '../../dist-webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});
EOF
```

## 7) Create Vite vanilla HTML

```bash
cat > media/webview/index.html <<'EOF'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ExpressTS Diagram</title>
    <script type="module" src="./main.ts"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
EOF
```

## 8) Create vanilla TS webview app

```bash
cat > media/webview/main.ts <<'EOF'
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

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="layout">
    <header>
      <h1>ExpressTS Diagram</h1>
      <p>Click a node to open its source file.</p>
    </header>
    <section>
      <div id="graph" class="graph"></div>
    </section>
  </div>
`;

const graphEl = document.querySelector<HTMLDivElement>('#graph')!;

window.addEventListener('message', (event: MessageEvent<{ type: string; payload: DiagramPayload }>) => {
  if (event.data.type === 'graph') {
    renderGraph(event.data.payload);
  }
});

function renderGraph(payload: DiagramPayload) {
  graphEl.innerHTML = '';

  const nodeMap = new Map(payload.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, number>();

  payload.nodes.forEach((node) => incoming.set(node.id, 0));
  payload.edges.forEach((edge) => incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1));

  const ordered = [...payload.nodes].sort((a, b) => (incoming.get(a.id) ?? 0) - (incoming.get(b.id) ?? 0));

  for (const node of ordered) {
    const card = document.createElement('button');
    card.className = `node node-${node.kind}`;
    card.type = 'button';
    card.innerHTML = `
      <strong>${escapeHtml(node.label)}</strong>
      <span>${node.kind}</span>
      <small>${escapeHtml(node.source.file)}:${node.source.line}</small>
    `;
    card.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openSource',
        source: node.source
      });
    });
    graphEl.appendChild(card);

    const related = payload.edges.filter((edge) => edge.from === node.id);
    for (const edge of related) {
      const target = nodeMap.get(edge.to);
      if (!target) continue;

      const arrow = document.createElement('div');
      arrow.className = 'edge';
      arrow.textContent = `↓ ${edge.label ?? ''} ${target.label}`;
      graphEl.appendChild(arrow);
    }
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
EOF
```

## 9) Create webview styles

```bash
cat > media/webview/style.css <<'EOF'
:root {
  color-scheme: dark;
  font-family: Arial, Helvetica, sans-serif;
}

body {
  margin: 0;
  background: #1e1e1e;
  color: #d4d4d4;
}

.layout {
  padding: 16px;
}

header {
  margin-bottom: 16px;
}

h1 {
  margin: 0 0 8px;
  font-size: 20px;
}

p {
  margin: 0;
  opacity: 0.8;
}

.graph {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.node {
  border: 1px solid #3a3a3a;
  background: #252526;
  color: inherit;
  text-align: left;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
}

.node strong,
.node span,
.node small {
  display: block;
}

.node small {
  opacity: 0.7;
  margin-top: 6px;
}

.node-router {
  border-color: #4e94ce;
}

.node-middleware {
  border-color: #c586c0;
}

.node-endpoint {
  border-color: #4ec9b0;
}

.edge {
  margin-left: 12px;
  opacity: 0.8;
  font-size: 13px;
}
EOF
```

## 10) Wire CSS import in Vite app

```bash
python - <<'PY'
from pathlib import Path
p = Path('media/webview/main.ts')
text = p.read_text()
p.write_text("import './style.css';\n" + text)
PY
```

## 11) Build the extension

```bash
npm run build
```

## 12) Open in VS Code and run extension host

```bash
code .
```

Then in VS Code:

1. Press `F5`
2. In the Extension Development Host, open command palette
3. Run `ExpressTS: Open Diagram`

## 13) Next implementation steps

Replace `getMockGraph()` in `src/extension.ts` with a real analyzer pipeline:

- scan workspace for `express()` and `Router()`
- parse TS AST
- collect `app.use`, `router.use`, `app.get/post/...`, `router.get/post/...`
- resolve mounted routers
- compose full endpoint paths
- attach file/line/column to every endpoint and middleware node
- post refreshed graph to the webview on file changes
