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

type NodePosition = {
  x: number;
  y: number;
};

type GraphLayout = {
  width: number;
  height: number;
  positions: Map<string, NodePosition>;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_WIDTH = 220;
const NODE_HEIGHT = 104;
const HORIZONTAL_GAP = 56;
const VERTICAL_GAP = 124;
const CANVAS_PADDING = 40;

const vscode = acquireVsCodeApi();

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="layout">
    <header>
      <h1>ExpressTS Diagram</h1>
      <p>Flowchart view of routers, middlewares, and endpoints. Click any node to open its source.</p>
    </header>
    <section>
      <div class="legend" aria-label="Diagram legend">
        <span class="legend-item legend-router">Router</span>
        <span class="legend-item legend-middleware">Middleware</span>
        <span class="legend-item legend-endpoint">Endpoint</span>
      </div>
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
  graphEl.replaceChildren();

  if (payload.nodes.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No Express routers or endpoints were found in the current workspace.';
    graphEl.appendChild(emptyState);
    return;
  }

  const layout = buildGraphLayout(payload);
  const positions = layout.positions;
  const canvas = document.createElement('div');
  canvas.className = 'graph-canvas';
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));

  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'edge-arrow');
  marker.setAttribute('markerWidth', '10');
  marker.setAttribute('markerHeight', '10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('orient', 'auto-start-reverse');

  const markerPath = document.createElementNS(SVG_NS, 'path');
  markerPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  markerPath.setAttribute('class', 'edge-arrow-head');
  marker.appendChild(markerPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const edge of payload.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);

    if (!from || !to) {
      continue;
    }

    const startX = from.x + NODE_WIDTH / 2;
    const startY = from.y + NODE_HEIGHT;
    const endX = to.x + NODE_WIDTH / 2;
    const endY = to.y;
    const deltaY = Math.max(48, (endY - startY) / 2);
    const controlOneY = startY + deltaY;
    const controlTwoY = endY - deltaY;

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      `M ${startX} ${startY} C ${startX} ${controlOneY}, ${endX} ${controlTwoY}, ${endX} ${endY}`
    );
    path.setAttribute('class', 'edge-path');
    path.setAttribute('marker-end', 'url(#edge-arrow)');
    svg.appendChild(path);

    if (edge.label) {
      const label = document.createElement('div');
      label.className = 'edge-label';
      label.textContent = edge.label;
      label.style.left = `${(startX + endX) / 2}px`;
      label.style.top = `${startY + (endY - startY) / 2}px`;
      canvas.appendChild(label);
    }
  }

  canvas.appendChild(svg);

  for (const node of payload.nodes) {
    const position = positions.get(node.id);

    if (!position) {
      continue;
    }

    const card = document.createElement('button');
    card.className = `node node-${node.kind}`;
    card.type = 'button';
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;

    const title = document.createElement('strong');
    title.textContent = node.label;

    const kind = document.createElement('span');
    kind.className = 'node-kind';
    kind.textContent = node.kind;

    const source = document.createElement('small');
    source.textContent = `${node.source.file}:${node.source.line}`;

    card.append(title, kind, source);
    card.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openSource',
        source: node.source
      });
    });

    canvas.appendChild(card);
  }

  graphEl.appendChild(canvas);
}

function buildGraphLayout(payload: DiagramPayload): GraphLayout {
  const nodeIds = payload.nodes.map((node) => node.id);
  const incoming = new Map<string, number>();
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();

  for (const nodeId of nodeIds) {
    incoming.set(nodeId, 0);
    predecessors.set(nodeId, []);
    successors.set(nodeId, []);
  }

  for (const edge of payload.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    predecessors.get(edge.to)?.push(edge.from);
    successors.get(edge.from)?.push(edge.to);
  }

  const queue = nodeIds
    .filter((nodeId) => (incoming.get(nodeId) ?? 0) === 0)
    .sort((left, right) => left.localeCompare(right));
  const topoOrder: string[] = [];
  const remainingIncoming = new Map(incoming);

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    topoOrder.push(nodeId);

    for (const nextNodeId of successors.get(nodeId) ?? []) {
      const nextIncoming = (remainingIncoming.get(nextNodeId) ?? 0) - 1;
      remainingIncoming.set(nextNodeId, nextIncoming);

      if (nextIncoming === 0) {
        queue.push(nextNodeId);
        queue.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  for (const nodeId of nodeIds) {
    if (!topoOrder.includes(nodeId)) {
      topoOrder.push(nodeId);
    }
  }

  const ranks = new Map<string, number>();

  for (const nodeId of topoOrder) {
    const rank = Math.max(0, ...((predecessors.get(nodeId) ?? []).map((previousNodeId) => (ranks.get(previousNodeId) ?? 0) + 1)));
    ranks.set(nodeId, rank);
  }

  const rows = new Map<number, DiagramNode[]>();

  for (const node of payload.nodes) {
    const rank = ranks.get(node.id) ?? 0;
    const row = rows.get(rank) ?? [];
    row.push(node);
    rows.set(rank, row);
  }

  const orderedRows = [...rows.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, row]) => row.sort((left, right) => left.label.localeCompare(right.label)));

  const widestRow = orderedRows.reduce((max, row) => Math.max(max, row.length), 1);
  const width = widestRow * NODE_WIDTH + Math.max(0, widestRow - 1) * HORIZONTAL_GAP + CANVAS_PADDING * 2;
  const height = orderedRows.length * NODE_HEIGHT + Math.max(0, orderedRows.length - 1) * VERTICAL_GAP + CANVAS_PADDING * 2;
  const positions = new Map<string, NodePosition>();

  orderedRows.forEach((row, rowIndex) => {
    const rowWidth = row.length * NODE_WIDTH + Math.max(0, row.length - 1) * HORIZONTAL_GAP;
    const startX = (width - rowWidth) / 2;
    const y = CANVAS_PADDING + rowIndex * (NODE_HEIGHT + VERTICAL_GAP);

    row.forEach((node, columnIndex) => {
      const x = startX + columnIndex * (NODE_WIDTH + HORIZONTAL_GAP);
      positions.set(node.id, { x, y });
    });
  });

  return { width, height, positions };
}
