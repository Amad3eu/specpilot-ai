import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { createServices } from './services.js';

// Ponto de entrada da API. Sem nenhuma variável de ambiente, sobe em modo de avaliação:
// provedor mock, Postgres embutido e cache em memória.
//
// Rodar: pnpm dev (na raiz)   ·   Só a API: pnpm --filter @specpilot/api dev

// O .env fica na raiz do monorepo. Variável já definida no ambiente vence o arquivo.
const envFile = join(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const services = await createServices();
const app = buildApp(services);

const port = Number(process.env.PORT ?? 3333);
// Só na própria máquina por padrão: a API não tem autenticação.
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });

const { provider, store, cache } = services.mode;
console.log(`SpecPilot API em http://${host}:${port}  ·  modelo: ${provider}  ·  dados: ${store}  ·  cache: ${cache}`);
if (provider === 'mock') {
  console.log(
    'Modo de avaliação: respostas do provedor mock, sem rede. Preencha uma chave no .env para usar um modelo real.',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => services.close())
      .finally(() => process.exit(0));
  });
}
