#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient, httpRequester } from './client.js';
import { createSpecPilotServer } from './server.js';

// Ponto de entrada do servidor MCP, em stdio: é o transporte que IDEs e clientes de agente
// sobem como processo filho. A API do SpecPilot precisa estar no ar (pnpm dev, na raiz).
//
// Rodar: pnpm mcp   ·   Outra API: SPECPILOT_API_URL=http://host:porta pnpm mcp

const apiUrl = process.env.SPECPILOT_API_URL ?? 'http://localhost:3333';
const server = createSpecPilotServer(createClient(httpRequester(apiUrl)));

await server.connect(new StdioServerTransport());
// Em stdio, stdout é o protocolo: qualquer aviso vai para stderr.
console.error(`[MCP] servidor "specpilot" pronto em stdio, falando com ${apiUrl}`);
