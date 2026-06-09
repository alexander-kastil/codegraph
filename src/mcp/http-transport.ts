/**
 * MCP HTTP Transport
 *
 * Exposes the MCP server over HTTP so agents can connect via a URL instead of
 * spawning a child process. Each POST to /mcp carries one JSON-RPC message;
 * the response is written back on the same connection. Notifications return 202.
 *
 * Server-initiated requests (roots/list) are not supported — the server
 * returns null immediately, so the MCPServer falls back to --path or cwd.
 */

import * as http from 'http';
import type {
  JsonRpcTransport,
  JsonRpcResponse,
  MessageHandler,
  JsonRpcRequest,
  JsonRpcNotification,
} from './transport';
import { ErrorCodes } from './transport';

export class HttpTransport implements JsonRpcTransport {
  private server: http.Server | null = null;
  // JSON-RPC request id → HTTP response waiting for sendResult/sendError
  private pending = new Map<string | number, http.ServerResponse>();
  private messageHandler: MessageHandler | null = null;
  readonly port: number;

  constructor(port = 3333) {
    this.port = port;
  }

  start(handler: MessageHandler): void {
    this.messageHandler = handler;
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        process.stderr.write(`[CodeGraph HTTP] ${err}\n`);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    });
    this.server.listen(this.port, () => {
      process.stderr.write(`[CodeGraph MCP] HTTP transport listening on :${this.port}\n`);
    });
  }

  stop(): void {
    for (const res of this.pending.values()) {
      if (!res.headersSent) { res.writeHead(503); res.end(); }
    }
    this.pending.clear();
    if (this.server) { this.server.close(); this.server = null; }
  }

  /** Not supported over HTTP — caller falls back to --path / cwd. */
  request(_method: string, _params?: unknown, _timeoutMs?: number): Promise<unknown> {
    return Promise.resolve(null);
  }

  /** Route a fully-formed JSON-RPC response back to the HTTP request that carries its id. */
  send(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) return;
    const res = this.pending.get(response.id);
    if (!res) return;
    this.pending.delete(response.id);
    writeJson(res, response);
  }

  sendResult(id: string | number, result: unknown): void {
    const res = this.pending.get(id);
    if (!res) return;
    this.pending.delete(id);
    writeJson(res, { jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    if (id === null) {
      process.stderr.write(`[CodeGraph MCP] Error ${code}: ${message}\n`);
      return;
    }
    const res = this.pending.get(id);
    if (!res) return;
    this.pending.delete(id);
    writeJson(res, { jsonrpc: '2.0', id, error });
  }

  /** No persistent connection in HTTP mode — notifications are dropped. */
  notify(_method: string, _params?: unknown): void {}

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (!url.startsWith('/mcp')) { res.writeHead(404); res.end(); return; }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, OPTIONS' });
      res.end();
      return;
    }

    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

    let body: string;
    try { body = await readBody(req); }
    catch { res.writeHead(400); res.end(); return; }

    let msg: unknown;
    try { msg = JSON.parse(body); }
    catch {
      writeJson(res, { jsonrpc: '2.0', id: null, error: { code: ErrorCodes.ParseError, message: 'Parse error' } });
      return;
    }

    const obj = msg as Record<string, unknown>;
    const hasMethod = typeof obj.method === 'string';
    const hasId = 'id' in obj;

    if (!hasMethod) { res.writeHead(400); res.end(); return; }

    if (hasId) {
      const id = obj.id as string | number;
      this.pending.set(id, res);
      if (this.messageHandler) await this.messageHandler(msg as JsonRpcRequest);
      // Guard: if handler never called sendResult/sendError (shouldn't happen)
      if (this.pending.has(id)) { this.pending.delete(id); res.writeHead(204); res.end(); }
    } else {
      if (this.messageHandler) await this.messageHandler(msg as JsonRpcNotification);
      res.writeHead(202);
      res.end();
    }
  }
}

function writeJson(res: http.ServerResponse, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
