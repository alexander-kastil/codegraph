import { describe, it, expect } from 'vitest';
import { angularResolver } from '../src/resolution/frameworks/angular';
import type { UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

// ---------------------------------------------------------------------------
// Unit tests: extract() — pure function, no DB needed
// ---------------------------------------------------------------------------

describe('angularResolver.extract()', () => {
  it('emits a route node for a direct component route', () => {
    const content = `
import { Routes } from '@angular/router';
import { Dashboard } from './dashboard';
export const routes: Routes = [
  { path: 'dashboard', component: Dashboard },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    expect(result.nodes).toHaveLength(1);
    const route = result.nodes[0]!;
    expect(route.kind).toBe('route');
    expect(route.name).toBe('/dashboard');
    expect(route.qualifiedName).toContain('/dashboard');
  });

  it('emits a references edge from route to direct component', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  { path: 'home', component: HomeComponent },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    const ref = result.references.find((r) => r.referenceName === 'HomeComponent');
    expect(ref).toBeDefined();
    expect(ref!.referenceKind).toBe('references');
  });

  it('emits a references edge to the lazy-loaded component class', () => {
    const content = `
import { Routes } from '@angular/router';
export const dashboardRoutes: Routes = [
  {
    path: 'containers',
    loadComponent: () => import('./containers/containers').then(m => m.Containers),
  },
];
`;
    const result = angularResolver.extract!('dashboard.routes.ts', content);
    expect(result.nodes).toHaveLength(1);
    const ref = result.references.find((r) => r.referenceName === 'Containers');
    expect(ref).toBeDefined();
    expect(ref!.referenceKind).toBe('references');
  });

  it('emits import + references edges for loadChildren', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  {
    path: 'setup',
    loadChildren: () => import('./setup/setup.routes').then(m => m.setupRoutes),
  },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    const importRef = result.references.find((r) => r.referenceKind === 'imports');
    expect(importRef).toBeDefined();
    expect(importRef!.referenceName).toBe('./setup/setup.routes');

    const symbolRef = result.references.find(
      (r) => r.referenceKind === 'references' && r.referenceName === 'setupRoutes'
    );
    expect(symbolRef).toBeDefined();
  });

  it('emits guard references from canActivate', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  { path: 'admin', component: AdminComponent, canActivate: [AuthGuard, RoleGuard] },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    const refs = result.references.map((r) => r.referenceName);
    expect(refs).toContain('AuthGuard');
    expect(refs).toContain('RoleGuard');
  });

  it('skips pure redirect routes', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', component: Dashboard },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.name).toBe('/dashboard');
  });

  it('skips wildcard ** routes', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  { path: 'home', component: Home },
  { path: '**', redirectTo: 'home' },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.name).toBe('/home');
  });

  it('extracts nested children routes as independent route nodes', () => {
    const content = `
import { Routes } from '@angular/router';
import { Dashboard } from './dashboard';
export const dashboardRoutes: Routes = [
  {
    path: '',
    component: Dashboard,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'containers' },
      {
        path: 'containers',
        loadComponent: () => import('./containers/containers').then(m => m.Containers),
      },
      {
        path: 'overview',
        loadComponent: () => import('./overview/overview').then(m => m.Overview),
      },
    ],
  },
];
`;
    const result = angularResolver.extract!('dashboard.routes.ts', content);
    const names = result.nodes.map((n) => n.name);
    // Parent route (component: Dashboard) + two child routes
    expect(names).toContain('/');
    expect(names).toContain('/containers');
    expect(names).toContain('/overview');
    expect(result.nodes).toHaveLength(3);
  });

  it('does not bleed loadComponent from children into the parent route', () => {
    const content = `
import { Routes } from '@angular/router';
import { Layout } from './layout';
export const routes: Routes = [
  {
    path: 'app',
    component: Layout,
    children: [
      { path: 'page', loadComponent: () => import('./page').then(m => m.Page) },
    ],
  },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    const parentRoute = result.nodes.find((n) => n.name === '/app')!;
    expect(parentRoute).toBeDefined();

    // Parent route references Layout, not Page
    const parentRefs = result.references.filter((r) => r.fromNodeId === parentRoute.id);
    const refNames = parentRefs.map((r) => r.referenceName);
    expect(refNames).toContain('Layout');
    expect(refNames).not.toContain('Page');
  });

  it('handles route params in paths', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  {
    path: 'services/:id',
    loadChildren: () => import('./services/service.routes').then(m => m.serviceRoutes),
  },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    expect(result.nodes[0]!.name).toBe('/services/:id');
  });

  it('extracts all guard types (canDeactivate, canMatch)', () => {
    const content = `
import { Routes } from '@angular/router';
export const routes: Routes = [
  {
    path: 'edit',
    component: EditComponent,
    canActivate: [AuthGuard],
    canDeactivate: [UnsavedChangesGuard],
    canMatch: [FeatureFlagGuard],
  },
];
`;
    const result = angularResolver.extract!('app.routes.ts', content);
    const refs = result.references.map((r) => r.referenceName);
    expect(refs).toContain('AuthGuard');
    expect(refs).toContain('UnsavedChangesGuard');
    expect(refs).toContain('FeatureFlagGuard');
  });

  it('does not process non-routing TypeScript files', () => {
    const content = `
export class UserService {
  private path = 'api/users';
  getData() { return fetch(this.path); }
}
`;
    const result = angularResolver.extract!('user.service.ts', content);
    expect(result.nodes).toHaveLength(0);
    expect(result.references).toHaveLength(0);
  });

  it('detects non-standard routing files via @angular/router import', () => {
    const content = `
import { Routes } from '@angular/router';
export const appRouting: Routes = [
  { path: 'home', component: HomeComponent },
];
`;
    // File doesn't end in .routes.ts but imports from @angular/router with Routes type
    const result = angularResolver.extract!('routing-module.ts', content);
    expect(result.nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: detect()
// ---------------------------------------------------------------------------

describe('angularResolver.detect()', () => {
  it('returns true when @angular/core is in dependencies', () => {
    const ctx = mockContext({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^17.0.0' } }),
      files: [],
    });
    expect(angularResolver.detect(ctx)).toBe(true);
  });

  it('returns true when @angular/core is in devDependencies', () => {
    const ctx = mockContext({
      'package.json': JSON.stringify({ devDependencies: { '@angular/core': '^17.0.0' } }),
      files: [],
    });
    expect(angularResolver.detect(ctx)).toBe(true);
  });

  it('returns true when .component.ts files exist', () => {
    const ctx = mockContext({
      'package.json': JSON.stringify({}),
      files: ['src/app/home/home.component.ts'],
    });
    expect(angularResolver.detect(ctx)).toBe(true);
  });

  it('returns true when .routes.ts files exist', () => {
    const ctx = mockContext({
      'package.json': JSON.stringify({}),
      files: ['src/app/app.routes.ts'],
    });
    expect(angularResolver.detect(ctx)).toBe(true);
  });

  it('returns false for a non-Angular project', () => {
    const ctx = mockContext({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      files: ['src/App.tsx', 'src/index.ts'],
    });
    expect(angularResolver.detect(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: resolve()
// ---------------------------------------------------------------------------

describe('angularResolver.resolve()', () => {
  it('resolves a service reference, preferring .service.ts convention', () => {
    const serviceNode: Node = {
      id: 'class:src/state/config.service.ts:ConfigService:1',
      kind: 'class',
      name: 'ConfigService',
      qualifiedName: 'ConfigService',
      filePath: 'src/state/config.service.ts',
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 0,
      language: 'typescript',
      updatedAt: Date.now(),
    };
    const ctx = mockContext({ files: [] }, [serviceNode]);
    const ref = makeUnresolvedRef('ConfigService');
    const resolved = angularResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe(serviceNode.id);
    expect(resolved!.confidence).toBe(0.85);
  });

  it('falls back to any class node when no convention match', () => {
    const node: Node = {
      id: 'class:src/stores/wizard.store.ts:WizardStore:1',
      kind: 'class',
      name: 'WizardStore',
      qualifiedName: 'WizardStore',
      filePath: 'src/stores/wizard.ts', // no angular suffix
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
      language: 'typescript',
      updatedAt: Date.now(),
    };
    const ctx = mockContext({ files: [] }, [node]);
    const ref = makeUnresolvedRef('WizardStore');
    const resolved = angularResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.confidence).toBe(0.7);
  });

  it('returns null when no class node exists', () => {
    const ctx = mockContext({ files: [] }, []);
    const ref = makeUnresolvedRef('NonExistentService');
    expect(angularResolver.resolve(ref, ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: extract() → resolve() chain
//
// These tests drive the two halves of the resolver together — extract() to
// produce route nodes + unresolved references, then resolve() with a mock
// context that mirrors what the TypeScript extractor would contribute — to
// verify the full route→component linking works end-to-end without needing
// a SQLite database.
// ---------------------------------------------------------------------------

describe('Angular integration — extract() + resolve() chain', () => {
  it('route node produced by extract() resolves to the component class via resolve()', () => {
    const routingContent = `
import { Routes } from '@angular/router';
import { Dashboard } from './dashboard';
export const routes: Routes = [
  { path: 'dashboard', component: Dashboard },
];
`;
    // Step 1: extract route nodes and references from the routing file
    const { nodes: routeNodes, references } = angularResolver.extract!('src/app.routes.ts', routingContent);
    expect(routeNodes).toHaveLength(1);
    const route = routeNodes[0]!;
    expect(route.kind).toBe('route');
    expect(route.name).toBe('/dashboard');

    // Step 2: simulate the class node the TypeScript extractor creates for Dashboard
    const dashboardNode = makeClassNode('Dashboard', 'src/dashboard.component.ts');

    // Step 3: resolve the component reference — should link to the Dashboard class
    const ref = references.find((r) => r.referenceName === 'Dashboard' && r.referenceKind === 'references');
    expect(ref).toBeDefined();
    const ctx = mockContext({ files: ['src/dashboard.component.ts'] }, [dashboardNode]);
    const resolved = angularResolver.resolve(ref!, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe(dashboardNode.id);
    expect(resolved!.resolvedBy).toBe('framework');
  });

  it('lazy loadComponent reference resolves to the imported component class', () => {
    const routingContent = `
import { Routes } from '@angular/router';
export const dashboardRoutes: Routes = [
  {
    path: 'overview',
    loadComponent: () => import('./overview/overview').then(m => m.Overview),
  },
];
`;
    const { nodes: routeNodes, references } = angularResolver.extract!('src/dashboard.routes.ts', routingContent);
    expect(routeNodes).toHaveLength(1);
    expect(routeNodes[0]!.name).toBe('/overview');

    const overviewNode = makeClassNode('Overview', 'src/overview/overview.component.ts');
    const ref = references.find((r) => r.referenceName === 'Overview');
    expect(ref).toBeDefined();
    const ctx = mockContext({ files: ['src/overview/overview.component.ts'] }, [overviewNode]);
    const resolved = angularResolver.resolve(ref!, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe(overviewNode.id);
  });

  it('nested children all produce route nodes and each resolves its own component', () => {
    const routingContent = `
import { Routes } from '@angular/router';
import { Layout } from './layout';
export const routes: Routes = [
  {
    path: 'items',
    component: Layout,
    children: [
      { path: '', redirectTo: 'list', pathMatch: 'full' },
      { path: 'list', loadComponent: () => import('./list').then(m => m.List) },
    ],
  },
];
`;
    const { nodes, references } = angularResolver.extract!('src/app.routes.ts', routingContent);
    const names = nodes.map((n) => n.name);

    // Parent + child are both extracted; the redirect-only empty path is skipped
    expect(names).toContain('/items');
    expect(names).toContain('/list');
    expect(nodes.filter((n) => n.name === '/').length).toBe(0);

    // Parent route references Layout; child references List
    const layoutRef = references.find((r) => r.referenceName === 'Layout');
    const listRef = references.find((r) => r.referenceName === 'List');
    expect(layoutRef).toBeDefined();
    expect(listRef).toBeDefined();

    // Each resolves independently to the right class node
    const layoutNode = makeClassNode('Layout', 'src/layout.component.ts');
    const listNode = makeClassNode('List', 'src/list.component.ts');
    const ctx = mockContext({ files: [] }, [layoutNode, listNode]);

    expect(angularResolver.resolve(layoutRef!, ctx)!.targetNodeId).toBe(layoutNode.id);
    expect(angularResolver.resolve(listRef!, ctx)!.targetNodeId).toBe(listNode.id);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockContextOptions {
  'package.json'?: string;
  files: string[];
}

function makeClassNode(name: string, filePath: string): Node {
  return {
    id: `class:${filePath}:${name}:1`,
    kind: 'class',
    name,
    qualifiedName: name,
    filePath,
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    language: 'typescript',
    updatedAt: Date.now(),
  };
}

function mockContext(opts: MockContextOptions, nodes: Node[] = []) {
  return {
    getNodesInFile: () => [],
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: (p: string) => (p === 'package.json' ? (opts['package.json'] ?? null) : null),
    getProjectRoot: () => '/',
    getAllFiles: () => opts.files,
  };
}

function makeUnresolvedRef(name: string): UnresolvedRef {
  return {
    fromNodeId: 'test:node:1',
    referenceName: name,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'src/app.ts',
    language: 'typescript',
  };
}
