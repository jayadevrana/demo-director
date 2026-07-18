#!/usr/bin/env node
// Demo Director — MCP server entry point.
// Zero dependencies. Requires Node >= 22 (built-in WebSocket + fetch).
import { serve } from './src/rpc.js';
import { tools } from './src/tools.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`demo-director requires Node >= 22 (found ${process.versions.node})\n`);
  process.exit(1);
}

serve({ name: 'demo-director', version: '0.2.1', tools });
