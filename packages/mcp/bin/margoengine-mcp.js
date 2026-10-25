#!/usr/bin/env node
// The `margoengine-mcp` command: a Model Context Protocol server over stdio (see the package README).
import { runCli } from '../dist/index.js';

process.exitCode = await runCli(process.argv.slice(2));
