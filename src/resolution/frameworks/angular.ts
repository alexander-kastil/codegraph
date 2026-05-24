/**
 * Angular Framework Resolver
 *
 * Extracts route nodes from Angular Routes arrays and resolves Angular DI patterns:
 *
 *   Route config patterns handled:
 *     { path: 'foo', component: FooComponent }
 *     { path: 'foo', loadComponent: () => import('./foo').then(m => m.Foo) }
 *     { path: 'foo', loadChildren: () => import('./foo.routes').then(m => m.fooRoutes) }
 *     { path: 'foo', canActivate: [AuthGuard] }
 *     { path: 'foo', component: Foo, children: [ ... ] }   (nested children all extracted)
 *
 *   DI resolution (resolve method):
 *     inject(ServiceClass) / constructor injection → resolves by class name + Angular
 *     file-name conventions (.service.ts, .guard.ts, .store.ts, …)
 *
 * Detection: @angular/core in package.json, or *.component.ts / *.routes.ts files.
 *
 * Route file identification: *.routes.ts, or files that import from @angular/router
 * and declare a typed Routes variable.
 *
 * Approach: regex over comment-stripped source (not AST). A balanced-brace reader
 * (`readBalancedBraces`) and a top-level property extractor (`topLevelValue`) isolate
 * each route object's own properties so nested children routes don't bleed into parent
 * property lookups.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

// Canonical Angular file suffixes for DI resolution priority
const ANGULAR_SUFFIXES = [
  '.service.ts',
  '.store.ts',
  '.guard.ts',
  '.resolver.ts',
  '.interceptor.ts',
  '.component.ts',
  '.directive.ts',
  '.pipe.ts',
];

// Angular guard property names
const GUARD_PROPS = ['canActivate', 'canDeactivate', 'canMatch', 'canLoad', 'canActivateChild'];

export const angularResolver: FrameworkResolver = {
  name: 'angular',
  languages: ['typescript'],

  detect(context: ResolutionContext): boolean {
    const pkg = context.readFile('package.json');
    if (pkg) {
      try {
        const json = JSON.parse(pkg);
        const deps = { ...json.dependencies, ...json.devDependencies };
        if ('@angular/core' in deps) return true;
      } catch { /* invalid JSON — fall through */ }
    }
    return context
      .getAllFiles()
      .some((f) => f.endsWith('.component.ts') || f.endsWith('.routes.ts'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Resolve Angular DI tokens (inject(ClassName), typed constructor params) to the
    // class node that implements the token, preferring Angular file-name conventions.
    const candidates = context
      .getNodesByName(ref.referenceName)
      .filter((n) => n.kind === 'class');
    if (candidates.length === 0) return null;
    const preferred = candidates.find((n) =>
      ANGULAR_SUFFIXES.some((s) => n.filePath.endsWith(s))
    );
    return {
      original: ref,
      targetNodeId: (preferred ?? candidates[0]!).id,
      confidence: preferred ? 0.85 : 0.7,
      resolvedBy: 'framework',
    };
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!/\.ts$/.test(filePath)) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'typescript');

    if (isRoutingFile(filePath, safe)) {
      extractRoutes(filePath, safe, now, nodes, references);
    }

    return { nodes, references };
  },
};

// ---------------------------------------------------------------------------
// Routing file detection
// ---------------------------------------------------------------------------

function isRoutingFile(filePath: string, safe: string): boolean {
  if (filePath.endsWith('.routes.ts')) return true;
  // Non-standard names: must import from @angular/router AND declare a Routes variable
  return (
    /from\s+['"]@angular\/router['"]/.test(safe) &&
    /:\s*Routes\b/.test(safe)
  );
}

// ---------------------------------------------------------------------------
// Route extraction
// ---------------------------------------------------------------------------

function extractRoutes(
  filePath: string,
  safe: string,
  now: number,
  nodes: Node[],
  references: UnresolvedRef[]
): void {
  // Match every `path: 'value'` property key. The backreference \1 ensures the
  // closing quote matches the opening one (handles ', ", `).
  // Angular route paths never contain quote characters, so this simple regex is safe.
  const pathRe = /\bpath\s*:\s*(['"`])([^'"`]*)\1/g;
  let m: RegExpExecArray | null;

  while ((m = pathRe.exec(safe)) !== null) {
    const pathVal = m[2]!;
    const pathKeyPos = m.index;

    // Locate the enclosing route object by scanning backward for the unmatched `{`.
    // Angular route path strings never contain `{`/`}`, so this backward scan is reliable.
    const objStart = findObjectStart(safe, pathKeyPos);
    if (objStart === -1) continue;

    const obj = readBalancedBraces(safe, objStart);
    if (!obj) continue;

    const objText = obj.text;

    // Skip routes that have no navigable handler (pure redirects, wildcards).
    // Routes with both redirectTo AND component/loadComponent are unusual but valid.
    const hasHandler =
      /\bcomponent\s*:/.test(objText) ||
      /\bloadComponent\s*:/.test(objText) ||
      /\bloadChildren\s*:/.test(objText);
    if (!hasHandler || pathVal === '**') continue;

    const line = lineAt(safe, pathKeyPos);
    const routeId = `route:${filePath}:${line}:${pathVal || 'root'}`;

    nodes.push({
      id: routeId,
      kind: 'route',
      name: `/${pathVal}`,
      qualifiedName: `${filePath}::/${pathVal}`,
      filePath,
      startLine: line,
      endLine: lineAt(safe, obj.end - 1),
      startColumn: 0,
      endColumn: 0,
      language: 'typescript',
      updatedAt: now,
    });

    // component: ClassName  (synchronous, already-imported class)
    const compVal = topLevelValue(objText, 'component');
    if (compVal) {
      const compName = compVal.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (compName) {
        references.push(makeRef(routeId, compName, 'references', line, filePath));
      }
    }

    // loadComponent: () => import('./path').then(m => m.ClassName)
    const lcVal = topLevelValue(objText, 'loadComponent');
    if (lcVal) {
      const lcName = lcVal.match(/\.then\s*\(\s*\w+\s*=>\s*\w+\.([A-Za-z_$][\w$]*)\s*\)/)?.[1];
      if (lcName) {
        references.push(makeRef(routeId, lcName, 'references', line, filePath));
      }
    }

    // loadChildren: () => import('./path').then(m => m.childRoutes)
    // Emit an `imports` edge to the route file and a `references` edge to the exported
    // routes constant, so the graph shows both the file dependency and the symbol link.
    const lkVal = topLevelValue(objText, 'loadChildren');
    if (lkVal) {
      const importPath = lkVal.match(/import\s*\(\s*(['"`])([^'"`]+)\1\s*\)/)?.[2];
      const exportName = lkVal.match(/\.then\s*\(\s*\w+\s*=>\s*\w+\.([A-Za-z_$][\w$]*)\s*\)/)?.[1];
      if (importPath) {
        references.push(makeRef(routeId, importPath, 'imports', line, filePath));
      }
      if (exportName) {
        references.push(makeRef(routeId, exportName, 'references', line, filePath));
      }
    }

    // canActivate / canDeactivate / canMatch / canLoad / canActivateChild: [Guard, ...]
    for (const guardProp of GUARD_PROPS) {
      const guardVal = topLevelValue(objText, guardProp);
      if (!guardVal) continue;
      // Extract class-like identifiers (3+ chars) from the guard array
      const guardRe = /\b([A-Za-z_$][\w$]{2,})\b/g;
      let gm: RegExpExecArray | null;
      while ((gm = guardRe.exec(guardVal)) !== null) {
        references.push(makeRef(routeId, gm[1]!, 'references', line, filePath));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Balanced-brace and property helpers
// ---------------------------------------------------------------------------

/**
 * Scan backward from `from` to find the `{` of the innermost enclosing object.
 * Works reliably for Angular route objects whose path strings never contain `{`/`}`.
 */
function findObjectStart(safe: string, from: number): number {
  let depth = 0;
  for (let i = from - 1; i >= 0; i--) {
    const ch = safe[i]!;
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * Read a balanced `{...}` block starting at `start` (must point at `{`).
 * String-aware: braces inside string literals are not counted.
 */
function readBalancedBraces(
  s: string,
  start: number
): { text: string; end: number } | null {
  if (s[start] !== '{') return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { text: s.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Find the raw value of `propName` at the top level (depth 1 inside the outer `{`) of
 * `objText`. Returns the trimmed value text up to the next sibling `,` or `}`, or null
 * when the property is not found at the top level.
 *
 * Skips string literals and nested `{}/[]/()` blocks so deeply nested route objects
 * (inside `children: [...]`) don't match top-level property queries.
 */
function topLevelValue(objText: string, propName: string): string | null {
  const propRe = new RegExp(`\\b${propName}\\s*:\\s*`);
  let depth = 0;
  let inStr: string | null = null;
  let i = 0;

  while (i < objText.length) {
    const ch = objText[i]!;

    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }

    // Only inspect characters at depth 1 (directly inside the outer braces)
    if (depth === 1) {
      const rest = objText.slice(i);
      const m = propRe.exec(rest);
      if (m && m.index === 0) {
        const valueStart = i + m[0].length;
        return readValueToDelimiter(objText, valueStart);
      }
    }
    i++;
  }
  return null;
}

/**
 * Read a property value starting at `start`, stopping at the next top-level
 * `,` or enclosing `}`/`]`/`)` at depth 0. Returns the trimmed value text.
 */
function readValueToDelimiter(s: string, start: number): string {
  let depth = 0;
  let inStr: string | null = null;

  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) { inStr = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return s.slice(start, i).trim();
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) return s.slice(start, i).trim();
  }
  return s.slice(start).trim();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function lineAt(safe: string, index: number): number {
  return safe.slice(0, index).split('\n').length;
}

function makeRef(
  fromNodeId: string,
  referenceName: string,
  referenceKind: UnresolvedRef['referenceKind'],
  line: number,
  filePath: string
): UnresolvedRef {
  return {
    fromNodeId,
    referenceName,
    referenceKind,
    line,
    column: 0,
    filePath,
    language: 'typescript',
  };
}
