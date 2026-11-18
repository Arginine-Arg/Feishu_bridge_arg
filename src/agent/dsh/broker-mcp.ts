import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { NewSessionRequest } from '@agentclientprotocol/sdk';
import { brokerToolSpecs, type BrokerToolHost } from '../subagents/broker-tools';

export async function openDshBrokerMcp(input: {
  namespace: string;
  controller(): Promise<BrokerToolHost>;
  signal: AbortSignal;
}): Promise<{ descriptor: NewSessionRequest['mcpServers'][number]; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const auth = Buffer.from(`Bearer ${token}`);
  const tools = brokerToolSpecs(input.namespace).flatMap(namespace => namespace.tools.map(
    ({ name, description, inputSchema }) => ({ name, description, inputSchema: { ...inputSchema, type: 'object' as const } }),
  ));
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal]);
  const server = createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? '');
    if (req.url !== '/mcp' || received.length !== auth.length || !timingSafeEqual(auth, received)) {
      res.writeHead(404).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const mcp = new Server({ name: 'arg-bridge', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, context) => {
      if (!tools.some(tool => tool.name === params.name)) {
        return { isError: true, content: [{ type: 'text', text: 'Unknown Bridge tool' }] };
      }
      const result = await (await input.controller()).call(
        params.name, params.arguments, AbortSignal.any([signal, context.signal]),
      );
      return { isError: !result.success, content: [{ type: 'text', text: result.text }] };
    });
    res.once('close', () => { void mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start the local Broker MCP server');
  return {
    descriptor: {
      type: 'http', name: input.namespace, url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
    close: async () => {
      abort.abort();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
