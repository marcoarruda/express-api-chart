import './style.css';

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
