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

type PanPosition = {
  x: number;
  y: number;
};

type ActivePan = {
  pointerId: number;
  originX: number;
  originY: number;
  startX: number;
  startY: number;
  isPanning: boolean;
};

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    openMermaidSource?: (nodeId: string) => void;
  }
}

type MermaidRenderResult = {
  svg: string;
  bindFunctions?: (element: Element) => void;
};

type MermaidApi = {
  initialize(config: unknown): void;
  render(id: string, text: string): Promise<MermaidRenderResult>;
};

const EDGE_LABEL_HORIZONTAL_PADDING = 8;
const EDGE_LABEL_VERTICAL_PADDING = 4;
const MERMAID_ROUTER_CLASS = 'router';
const MERMAID_MIDDLEWARE_CLASS = 'middleware';
const MERMAID_ENDPOINT_CLASS = 'endpoint';
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.2;
const FIT_VIEWPORT_PADDING = 40;
const PAN_OVERSCROLL = 120;
const PAN_START_THRESHOLD = 4;
const WHEEL_PAN_STEP = 1;
const WHEEL_ZOOM_SENSITIVITY = 0.0025;

const vscode = acquireVsCodeApi();
let currentRenderToken = 0;
let mermaidApiPromise: Promise<MermaidApi> | undefined;
let currentSourceByNodeId = new Map<string, SourceRef>();

window.openMermaidSource = openMermaidSource;
let currentSvg: SVGSVGElement | undefined;
let currentCanvas: HTMLDivElement | undefined;
let currentZoom = DEFAULT_ZOOM;
let currentPan: PanPosition = { x: 0, y: 0 };
let activePan: ActivePan | undefined;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="layout">
    <section class="viewer-shell">
      <div class="viewer-topbar">
        <div class="legend" aria-label="Diagram legend">
          <span class="legend-item legend-router">Router</span>
          <span class="legend-item legend-middleware">Middleware</span>
          <span class="legend-item legend-endpoint">Endpoint</span>
        </div>
        <div class="viewer-controls" aria-label="Diagram controls">
          <button type="button" class="control-button" data-action="zoom-out" aria-label="Zoom out">-</button>
          <button type="button" class="control-button control-button-value" data-action="reset-zoom" aria-label="Reset zoom">100%</button>
          <button type="button" class="control-button" data-action="zoom-in" aria-label="Zoom in">+</button>
          <button type="button" class="control-button control-button-wide" data-action="fit-diagram" aria-label="Fit diagram to window">Fit</button>
          <button type="button" class="control-button control-button-wide" data-action="center-diagram" aria-label="Center diagram">Center</button>
        </div>
      </div>
      <div id="graph" class="graph"></div>
    </section>
  </div>
`;

const graphEl = document.querySelector<HTMLDivElement>('#graph')!;
const topbarEl = document.querySelector<HTMLDivElement>('.viewer-topbar')!;
const zoomValueEl = document.querySelector<HTMLButtonElement>('[data-action="reset-zoom"]')!;

document.querySelector<HTMLDivElement>('.viewer-controls')?.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-action]');

  if (!button) {
    return;
  }

  switch (button.dataset.action) {
    case 'zoom-out':
      setZoom(currentZoom - ZOOM_STEP);
      centerDiagram();
      break;
    case 'zoom-in':
      setZoom(currentZoom + ZOOM_STEP);
      centerDiagram();
      break;
    case 'reset-zoom':
      resetZoom();
      break;
    case 'fit-diagram':
      fitDiagramToViewport();
      break;
    case 'center-diagram':
      centerDiagram();
      break;
  }
});

graphEl.addEventListener('pointerdown', (event) => {
  if (!currentCanvas || !shouldStartPanning(event)) {
    return;
  }

  activePan = {
    pointerId: event.pointerId,
    originX: event.clientX,
    originY: event.clientY,
    startX: currentPan.x,
    startY: currentPan.y,
    isPanning: false
  };
});

graphEl.addEventListener('pointermove', (event) => {
  if (!activePan || activePan.pointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - activePan.originX;
  const deltaY = event.clientY - activePan.originY;

  if (!activePan.isPanning) {
    const distance = Math.hypot(deltaX, deltaY);

    if (distance < PAN_START_THRESHOLD) {
      return;
    }

    activePan.isPanning = true;
    graphEl.setPointerCapture(event.pointerId);
    graphEl.classList.add('is-panning');
    event.preventDefault();
  }

  currentPan = {
    x: activePan.startX + deltaX,
    y: activePan.startY + deltaY
  };

  applyCanvasTransform();
});

graphEl.addEventListener('pointerup', stopPanning);
graphEl.addEventListener('pointercancel', stopPanning);
graphEl.addEventListener(
  'wheel',
  (event) => {
    if (!currentCanvas || !currentSvg) {
      return;
    }

    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      zoomAtPoint(event.clientX, event.clientY, -event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      return;
    }

    currentPan = {
      x: currentPan.x - event.deltaX * WHEEL_PAN_STEP,
      y: currentPan.y - event.deltaY * WHEEL_PAN_STEP
    };

    applyCanvasTransform();
  },
  { passive: false }
);

window.addEventListener('message', (event: MessageEvent<{ type: string; payload: DiagramPayload }>) => {
  if (event.data.type === 'graph') {
    void renderGraph(event.data.payload);
  }
});

async function renderGraph(payload: DiagramPayload) {
  const renderToken = ++currentRenderToken;
  graphEl.replaceChildren();
  currentSvg = undefined;
  currentCanvas = undefined;
  currentPan = { x: 0, y: 0 };
  resetZoomLabel();

  if (payload.nodes.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No Express routers or endpoints were found in the current workspace.';
    graphEl.appendChild(emptyState);
    return;
  }

  const mermaid = await getMermaidApi();

  if (renderToken !== currentRenderToken) {
    return;
  }

  const renderId = `expressts-mermaid-${renderToken}`;
  const { definition, sourceByNodeId } = buildMermaidDefinition(payload);
  currentSourceByNodeId = sourceByNodeId;

  try {
    const renderResult = await mermaid.render(renderId, definition);

    if (renderToken !== currentRenderToken) {
      return;
    }

    const container = document.createElement('div');
    container.className = 'graph-canvas mermaid-canvas';
    container.innerHTML = renderResult.svg;
    graphEl.appendChild(container);

    padMermaidEdgeLabels(container);

    currentCanvas = container;
    currentSvg = container.querySelector<SVGSVGElement>('svg') ?? undefined;
    initializeSvgMetrics(currentSvg);

    renderResult.bindFunctions?.(container);
    bindNodeClicks(container, sourceByNodeId);
    decorateNodeAccessibility(container, sourceByNodeId);
    resetZoom();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = document.createElement('div');
    failure.className = 'empty-state';
    failure.textContent = `Unable to render Mermaid diagram: ${message}`;
    graphEl.appendChild(failure);
  }
}

async function getMermaidApi() {
  mermaidApiPromise ??= import('mermaid').then((module) => {
    const mermaid = module.default as MermaidApi;

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      themeVariables: {
        lineColor: '#cbd5e1',
        defaultLinkColor: '#cbd5e1',
        arrowheadColor: '#cbd5e1'
      },
      flowchart: {
        htmlLabels: true,
        curve: 'basis',
        useMaxWidth: false,
        nodeSpacing: 36,
        rankSpacing: 54,
        padding: 18
      }
    });

    return mermaid;
  });

  return mermaidApiPromise;
}

function buildMermaidDefinition(payload: DiagramPayload) {
  const sourceByNodeId = new Map<string, SourceRef>();
  const mermaidIdByNodeId = new Map<string, string>();
  const nodeById = new Map(payload.nodes.map((node) => [node.id, node]));
  const lines = ['flowchart TD'];

  payload.nodes.forEach((node, index) => {
    const mermaidId = `node_${index}`;
    mermaidIdByNodeId.set(node.id, mermaidId);
    sourceByNodeId.set(mermaidId, node.source);

    lines.push(`${mermaidId}["${getMermaidNodeLabel(node)}"]:::${getMermaidClassName(node.kind)}`);
    lines.push(`click ${mermaidId} openMermaidSource`);
  });

  payload.edges.forEach((edge) => {
    const from = mermaidIdByNodeId.get(edge.from);
    const to = mermaidIdByNodeId.get(edge.to);

    if (!from || !to) {
      return;
    }

    const edgeLabel = edge.label ? `|${escapeMermaidEdgeLabel(edge.label)}|` : '';
    lines.push(`${from} -->${edgeLabel} ${to}`);
  });

  lines.push(...buildRouterVerticalLayout(payload, nodeById, mermaidIdByNodeId));

  lines.push(`classDef ${MERMAID_ROUTER_CLASS} fill:#18263d,stroke:#60a5fa,color:#eef2ff,stroke-width:2px;`);
  lines.push(`classDef ${MERMAID_MIDDLEWARE_CLASS} fill:#2d1f3d,stroke:#c084fc,color:#f3e8ff,stroke-width:2px;`);
  lines.push(`classDef ${MERMAID_ENDPOINT_CLASS} fill:#3a1b22,stroke:#f87171,color:#fee2e2,stroke-width:2px;`);

  return {
    definition: lines.join('\n'),
    sourceByNodeId
  };
}

function bindNodeClicks(container: HTMLElement, sourceByNodeId: Map<string, SourceRef>) {
  container.addEventListener('click', (event) => {
    const nodeEl = getInteractiveNode(event, container);

    if (!nodeEl) {
      return;
    }

    const source = getSourceForElement(nodeEl, sourceByNodeId);

    if (!source) {
      return;
    }

    vscode.postMessage({
      type: 'openSource',
      source
    });
  });
}

function padMermaidEdgeLabels(container: HTMLElement) {
  const edgeLabels = container.querySelectorAll<SVGGElement>('.edgeLabel');

  edgeLabels.forEach((edgeLabel) => {
    const labelGroup = edgeLabel.querySelector<SVGGElement>('.label');
    const foreignObject = labelGroup?.querySelector<SVGForeignObjectElement>('foreignObject');
    const htmlLabel = foreignObject?.querySelector<HTMLElement>('.labelBkg');

    if (!labelGroup || !foreignObject || !htmlLabel) {
      return;
    }

    htmlLabel.style.boxSizing = 'border-box';
    htmlLabel.style.display = 'table';
    htmlLabel.style.padding = `${EDGE_LABEL_VERTICAL_PADDING}px ${EDGE_LABEL_HORIZONTAL_PADDING}px`;
    htmlLabel.style.borderRadius = '999px';

    const bounds = htmlLabel.getBoundingClientRect();

    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    foreignObject.setAttribute('width', String(bounds.width));
    foreignObject.setAttribute('height', String(bounds.height));
    labelGroup.setAttribute('transform', `translate(${-bounds.width / 2}, ${-bounds.height / 2})`);
  });
}

function decorateNodeAccessibility(container: HTMLElement, sourceByNodeId: Map<string, SourceRef>) {
  for (const nodeId of sourceByNodeId.keys()) {
    const nodeEl = container.querySelector<SVGElement>(`[data-id="${nodeId}"]`);

    if (!nodeEl) {
      continue;
    }

    nodeEl.setAttribute('tabindex', '0');
    nodeEl.setAttribute('role', 'button');
    nodeEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      const source = getSourceForElement(nodeEl, sourceByNodeId);

      if (!source) {
        return;
      }

      vscode.postMessage({
        type: 'openSource',
        source
      });
    });
  }
}

function getInteractiveNode(event: Event, container: HTMLElement) {
  for (const entry of event.composedPath()) {
    if (!(entry instanceof Element)) {
      continue;
    }

    if (!container.contains(entry)) {
      continue;
    }

    if (entry.hasAttribute('data-id')) {
      return entry;
    }

    const nodeEl = entry.closest('[data-id]');

    if (nodeEl && container.contains(nodeEl)) {
      return nodeEl;
    }
  }

  return undefined;
}

function getSourceForElement(nodeEl: Element, sourceByNodeId: Map<string, SourceRef>) {
  const nodeId = nodeEl.getAttribute('data-id');

  if (!nodeId) {
    return undefined;
  }

  return sourceByNodeId.get(nodeId);
}

function openMermaidSource(nodeId: string) {
  const source = currentSourceByNodeId.get(nodeId);

  if (!source) {
    return;
  }

  vscode.postMessage({
    type: 'openSource',
    source
  });
}

function getMermaidNodeLabel(node: DiagramNode) {
  const sourceLabel = escapeHtml(`${node.source.file}:${node.source.line}`);
  const title = escapeHtml(node.label);
  const kind = escapeHtml(node.kind.toUpperCase());

  return `${title}<br /><span class='mermaid-node-kind'>${kind}</span><br /><span class='mermaid-node-source'>${sourceLabel}</span>`;
}

function getMermaidClassName(kind: DiagramNode['kind']) {
  switch (kind) {
    case 'router':
      return MERMAID_ROUTER_CLASS;
    case 'middleware':
      return MERMAID_MIDDLEWARE_CLASS;
    case 'endpoint':
      return MERMAID_ENDPOINT_CLASS;
  }
}

function escapeMermaidEdgeLabel(value: string) {
  return value.replaceAll('|', '/').replaceAll('"', '&quot;');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setZoom(nextZoom: number) {
  currentZoom = clampZoom(nextZoom);
  updateZoomLabel();

  if (!currentSvg || !currentCanvas) {
    return;
  }

  const { width, height } = getSvgBaseSize(currentSvg);
  currentSvg.style.width = `${width * currentZoom}px`;
  currentSvg.style.height = `${height * currentZoom}px`;
  applyCanvasTransform();
}

function zoomAtPoint(clientX: number, clientY: number, zoomDelta: number) {
  if (!currentSvg || !currentCanvas || zoomDelta === 0) {
    return;
  }

  const previousZoom = currentZoom;
  const nextZoom = clampZoom(currentZoom * (1 + zoomDelta));

  if (nextZoom === previousZoom) {
    return;
  }

  const canvasRect = currentCanvas.getBoundingClientRect();
  const anchorX = clientX - canvasRect.left;
  const anchorY = clientY - canvasRect.top;
  const ratio = nextZoom / previousZoom;

  currentPan = {
    x: clientX - graphEl.getBoundingClientRect().left - anchorX * ratio,
    y: clientY - graphEl.getBoundingClientRect().top - anchorY * ratio
  };

  setZoom(nextZoom);
}

function resetZoom() {
  setZoom(DEFAULT_ZOOM);
  centerDiagram();
}

function fitDiagramToViewport() {
  if (!currentSvg) {
    return;
  }

  const { width, height } = getSvgBaseSize(currentSvg);
  const topbarOffset = topbarEl.offsetHeight + 12;
  const availableWidth = Math.max(graphEl.clientWidth - FIT_VIEWPORT_PADDING * 2, 1);
  const availableHeight = Math.max(graphEl.clientHeight - topbarOffset - FIT_VIEWPORT_PADDING, 1);
  const fittedZoom = Math.min(availableWidth / width, availableHeight / height);

  setZoom(fittedZoom);
  centerDiagram();
}

function centerDiagram() {
  requestAnimationFrame(() => {
    if (!currentCanvas) {
      return;
    }

    currentPan = {
      x: Math.round((graphEl.clientWidth - currentCanvas.offsetWidth) / 2),
      y: Math.round((graphEl.clientHeight - currentCanvas.offsetHeight) / 2)
    };

    applyCanvasTransform();
  });
}

function buildRouterVerticalLayout(
  payload: DiagramPayload,
  nodeById: Map<string, DiagramNode>,
  mermaidIdByNodeId: Map<string, string>
) {
  const outgoingByNodeId = new Map<string, DiagramEdge[]>();

  payload.edges.forEach((edge) => {
    const existing = outgoingByNodeId.get(edge.from);

    if (existing) {
      existing.push(edge);
      return;
    }

    outgoingByNodeId.set(edge.from, [edge]);
  });

  const layoutLines: string[] = [];

  payload.nodes
    .filter((node) => node.kind === 'router')
    .forEach((routerNode) => {
      const chains = (outgoingByNodeId.get(routerNode.id) ?? [])
        .map((edge) => traceVerticalChain(edge.to, nodeById, outgoingByNodeId))
        .filter((chain): chain is { head: string; tail: string } => Boolean(chain))
        .sort((left, right) => compareNodesBySource(left.head, right.head, nodeById));

      for (let index = 1; index < chains.length; index += 1) {
        const previousTail = mermaidIdByNodeId.get(chains[index - 1].tail);
        const currentHead = mermaidIdByNodeId.get(chains[index].head);

        if (!previousTail || !currentHead) {
          continue;
        }

        layoutLines.push(`${previousTail} ~~~ ${currentHead}`);
      }
    });

  return layoutLines;
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function traceVerticalChain(
  startNodeId: string,
  nodeById: Map<string, DiagramNode>,
  outgoingByNodeId: Map<string, DiagramEdge[]>
) {
  const startNode = nodeById.get(startNodeId);

  if (!startNode || startNode.kind === 'router') {
    return undefined;
  }

  const visited = new Set<string>([startNodeId]);
  let tailNodeId = startNodeId;

  while (true) {
    const nextEdges = (outgoingByNodeId.get(tailNodeId) ?? []).filter((edge) => {
      const nextNode = nodeById.get(edge.to);
      return nextNode && nextNode.kind !== 'router';
    });

    if (nextEdges.length !== 1) {
      break;
    }

    const nextNodeId = nextEdges[0].to;

    if (visited.has(nextNodeId)) {
      break;
    }

    visited.add(nextNodeId);
    tailNodeId = nextNodeId;
  }

  return {
    head: startNodeId,
    tail: tailNodeId
  };
}

function compareNodesBySource(leftNodeId: string, rightNodeId: string, nodeById: Map<string, DiagramNode>) {
  const leftNode = nodeById.get(leftNodeId);
  const rightNode = nodeById.get(rightNodeId);

  if (!leftNode || !rightNode) {
    return 0;
  }

  if (leftNode.source.file !== rightNode.source.file) {
    return leftNode.source.file.localeCompare(rightNode.source.file);
  }

  if (leftNode.source.line !== rightNode.source.line) {
    return leftNode.source.line - rightNode.source.line;
  }

  return leftNode.source.column - rightNode.source.column;
}

function initializeSvgMetrics(svg: SVGSVGElement | undefined) {
  if (!svg) {
    return;
  }

  const { width, height } = getSvgBaseSize(svg);
  svg.dataset.baseWidth = `${width}`;
  svg.dataset.baseHeight = `${height}`;
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

function getSvgBaseSize(svg: SVGSVGElement) {
  const storedWidth = Number(svg.dataset.baseWidth);
  const storedHeight = Number(svg.dataset.baseHeight);

  if (storedWidth > 0 && storedHeight > 0) {
    return { width: storedWidth, height: storedHeight };
  }

  const viewBox = svg.viewBox.baseVal;

  if (viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }

  const bounds = svg.getBBox();
  return {
    width: Math.max(bounds.width, 1),
    height: Math.max(bounds.height, 1)
  };
}

function updateZoomLabel() {
  zoomValueEl.textContent = `${Math.round(currentZoom * 100)}%`;
}

function resetZoomLabel() {
  currentZoom = DEFAULT_ZOOM;
  updateZoomLabel();
}

function applyCanvasTransform() {
  if (!currentCanvas) {
    return;
  }

  currentPan = clampPan(currentPan);

  currentCanvas.style.transform = `translate(${Math.round(currentPan.x)}px, ${Math.round(currentPan.y)}px)`;
}

function clampPan(position: PanPosition) {
  if (!currentCanvas) {
    return position;
  }

  const viewportWidth = graphEl.clientWidth;
  const viewportHeight = graphEl.clientHeight;
  const canvasWidth = currentCanvas.offsetWidth;
  const canvasHeight = currentCanvas.offsetHeight;
  const centeredX = Math.round((viewportWidth - canvasWidth) / 2);
  const centeredY = Math.round((viewportHeight - canvasHeight) / 2);

  const minX = canvasWidth <= viewportWidth
    ? centeredX - PAN_OVERSCROLL
    : viewportWidth - canvasWidth - PAN_OVERSCROLL;
  const maxX = canvasWidth <= viewportWidth
    ? centeredX + PAN_OVERSCROLL
    : PAN_OVERSCROLL;
  const minY = canvasHeight <= viewportHeight
    ? centeredY - PAN_OVERSCROLL
    : viewportHeight - canvasHeight - PAN_OVERSCROLL;
  const maxY = canvasHeight <= viewportHeight
    ? centeredY + PAN_OVERSCROLL
    : PAN_OVERSCROLL;

  return {
    x: Math.min(maxX, Math.max(minX, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y))
  };
}

function shouldStartPanning(event: PointerEvent) {
  for (const entry of event.composedPath()) {
    if (!(entry instanceof Element)) {
      continue;
    }

    if (entry.closest('[data-id], button, [role="button"]')) {
      return false;
    }

    if (entry === graphEl) {
      break;
    }
  }

  return true;
}

function stopPanning(event: PointerEvent) {
  if (!activePan || activePan.pointerId !== event.pointerId) {
    return;
  }

  const wasPanning = activePan.isPanning;
  activePan = undefined;

  if (!wasPanning) {
    return;
  }

  graphEl.classList.remove('is-panning');

  if (graphEl.hasPointerCapture(event.pointerId)) {
    graphEl.releasePointerCapture(event.pointerId);
  }
}
