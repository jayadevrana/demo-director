// Minimal MCP (Model Context Protocol) stdio server.
// Implements newline-delimited JSON-RPC 2.0: initialize, tools/list, tools/call, ping.

export function serve({ name, version, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  let buf = '';
  let inFlight = 0;
  let stdinClosed = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  });
  // Drain in-flight tool calls before exiting when the client closes stdin.
  process.stdin.on('end', () => {
    stdinClosed = true;
    if (inFlight === 0) process.exit(0);
  });

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore garbage on stdin
    }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return;
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      return reply(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema: inputSchema ?? { type: 'object', properties: {} },
        })),
      });
    }
    if (method === 'tools/call') {
      const tool = byName.get(params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      inFlight++;
      try {
        const out = await tool.handler(params.arguments ?? {});
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        reply(id, {
          content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }],
          isError: true,
        });
      } finally {
        inFlight--;
        if (stdinClosed && inFlight === 0) process.exit(0);
      }
      return;
    }
    if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  }
}
