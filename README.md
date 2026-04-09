# ExpressTS Observer

ExpressTS Observer is a VS Code extension that scans an Express.js codebase and turns routers, mounted paths, endpoints, and middleware chains into an interactive diagram.

The extension is designed for Express projects written in JavaScript or TypeScript and works through static analysis of your workspace files. It gives you two complementary views:

- an Endpoints tree in the Activity Bar for quick navigation
- a Mermaid-based diagram webview for route and middleware flow visualization

> Media placeholder: hero overview GIF
> Suggested file: `docs/media/overview-diagram.gif`
> Show: opening the Activity Bar view, clicking Open Diagram, and panning/zooming around a real API graph.

## What It Shows

ExpressTS Observer builds a graph with three node types:

- Routers
- Middleware
- Endpoints

It resolves route flow across mounted routers and shows how middleware chains connect to each endpoint.

Typical output includes:

- root app or router nodes
- mounted route prefixes such as `/api`, `/users`, or `/auth`
- HTTP endpoints such as `GET /users/:id`
- middleware nodes connected in execution order before the final route handler

## Features

### Endpoint Explorer

The extension adds an Endpoints view to the Activity Bar. Routes are grouped by path segments, and each endpoint expands to reveal the middleware chain discovered for that route.

From the tree you can:

- inspect grouped paths
- see middleware counts per endpoint
- open endpoint source locations directly
- open middleware source locations directly

> Media placeholder: endpoint tree screenshot
> Suggested file: `docs/media/endpoints-tree.png`
> Show: nested path groups, a selected endpoint, and expanded middleware children.

### Interactive Diagram

The diagram opens in a webview and renders the route graph with Mermaid. The UI supports:

- zoom in and out
- fit to viewport
- center diagram
- click-through navigation to source
- pan with pointer drag or wheel scrolling
- viewport persistence while switching tabs

> Media placeholder: diagram controls screenshot
> Suggested file: `docs/media/diagram-controls.png`
> Show: top toolbar, node legend, and a medium-size route graph.

### Source Navigation

Each discovered router, middleware, and endpoint is tied to a source location. Clicking a node in the tree or diagram opens the relevant file and jumps to the matching line.

> Media placeholder: source navigation GIF
> Suggested file: `docs/media/source-navigation.gif`
> Show: click a node in the diagram and jump to the handler in the editor.

### Automatic Refresh

The graph refreshes when analyzable files are saved. You can also manually refresh the analysis from the view toolbar.

## Supported Patterns

The analyzer currently supports common Express routing styles, including:

- `express()` app instances
- `express.Router()` and `Router()` router instances
- `app.use()` and `router.use()` mounts
- local router imports through relative paths
- routers exported directly from a module
- exported factory functions that return a local router instance
- route builder chains such as `router.route('/users').get(...).post(...)`
- middleware passed inline, via identifiers, via arrays, or through simple call expressions
- CommonJS and ES module import/export patterns

This means the extension can follow flows such as:

```ts
import express from 'express';
import usersRouter from './routes/users';

const app = express();

app.use('/api', authMiddleware, usersRouter);
app.get('/health', healthCheck);
```

and nested router factories such as:

```ts
export function createUsersRouter() {
  const router = Router();

  router.get('/users', listUsers);
  return router;
}
```

## Usage

1. Open a workspace that contains an Express.js project.
2. Open the ExpressTS Observer view from the Activity Bar.
3. Expand the Endpoints tree to inspect routes and middleware.
4. Click Open Diagram to render the visual graph.
5. Click any endpoint or middleware entry to jump to source.
6. Save a file or use Refresh Diagram to update the graph.

## Known Limitations

This extension uses static AST analysis, so there are clear boundaries to what it can resolve.

- Route paths must be string literals to be recognized reliably.
- Dynamically generated paths or runtime-composed routers are not fully resolved.
- Only local relative module imports are followed when tracing router relationships.
- The analysis focuses on Express-oriented routing constructs, not arbitrary framework wrappers.
- The extension scans the current workspace files and ignores generated folders such as `node_modules`, `dist`, and `dist-webview`.
- If you use patterns that hide route registration behind heavy abstraction, the graph may be partial.

## Development

### Scripts

- `npm run build` builds the extension and the webview bundle
- `npm run build:extension` builds the VS Code extension entrypoint
- `npm run build:webview` builds the Mermaid webview app
- `npm run watch` watches both the extension and the webview during development
- `npm run package` creates a VSIX package

### Local Run

1. Install dependencies with `npm ci`.
2. Build once with `npm run build`.
3. Launch the extension in a VS Code Extension Development Host.

## Release

The repository includes a GitHub Actions release workflow that:

- installs dependencies
- reads the pushed Git tag as the release version and writes it into `package.json`
- builds the extension
- packages the VSIX
- publishes to the VS Code Marketplace
- creates a GitHub release with the generated VSIX attached

The package keeps a default development version in `package.json`, and the release workflow overrides it during CI before packaging and publishing. If you need to set it manually, run:

```sh
RELEASE_VERSION=0.0.2 npm run set:version
```

## Suggested Media Plan

If you want the README to feel complete, generate these four assets first:

1. `docs/media/overview-diagram.gif`
   Capture prompt: a polished VS Code screen recording showing the Activity Bar icon, the Endpoints tree, opening the diagram, and a short pan/zoom interaction.
2. `docs/media/endpoints-tree.png`
   Capture prompt: a crisp screenshot of grouped routes with one endpoint expanded to show middleware order.
3. `docs/media/diagram-controls.png`
   Capture prompt: a full diagram screenshot with visible legend and controls, using a moderately complex API graph.
4. `docs/media/source-navigation.gif`
   Capture prompt: click a diagram node and jump to the exact Express handler in code.

Once you generate them, replace each placeholder block with a normal Markdown image reference, for example:

```md
![Overview of the ExpressTS Observer diagram](docs/media/overview-diagram.gif)
```

## Good Demo Scenarios

If you want better promotional images or GIFs, stage the extension against an Express sample app that includes:

- one root app
- two or three mounted routers
- shared auth middleware
- route-level middleware arrays
- at least one nested path such as `/api/v1/users`
- a mix of `GET`, `POST`, `PATCH`, and `DELETE` endpoints

That will produce a diagram with enough structure to look useful without becoming visually noisy.