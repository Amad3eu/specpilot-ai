// O que outros pacotes do monorepo usam da API: o servidor MCP sobe a aplicação em processo
// nos testes da ponte.
export { buildApp } from './app.js';
export { ConflictError, createServices, NotFoundError, type ServiceOptions, type Services } from './services.js';
