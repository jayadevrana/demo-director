#!/usr/bin/env node
// Standalone doctor: `npm run check` — same report as the check_setup MCP tool.
import { tools } from '../src/tools.js';

const check = tools.find((t) => t.name === 'check_setup');
console.log(JSON.stringify(await check.handler({}), null, 2));
