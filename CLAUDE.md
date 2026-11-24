# CLAUDE.md

Contexto e regras para agentes de IA que trabalham neste repositório.

## O que é

SpecPilot transforma notas de reunião em épicos, histórias de usuário com critérios Gherkin e ADRs. Um workflow multiagente (LangGraph) consulta o contexto do projeto por Hybrid RAG, e um gate em código decide o que espera aprovação humana. O backlog é operado pelo front-end Angular e por agentes, via MCP.

## Comandos

```bash
pnpm install        # instala tudo
pnpm dev            # API (3333) e front (4200), sem configurar nada
pnpm check          # lint + typecheck + build + test dos quatro workspaces (o que o CI roda)
pnpm lint:fix       # formata e corrige o que o Biome consegue
pnpm mcp            # servidor MCP em stdio (a API precisa estar no ar)
pnpm --filter @specpilot/api test    # testes de um workspace
```

Rode `pnpm check` antes de dar um trabalho por pronto. Sem `.env`, tudo roda em modo de avaliação: provedor mock, Postgres embutido (PGlite) e cache em memória.

## Mapa

```
packages/shared-schemas   contratos Zod: o que atravessa HTTP, SSE, MCP e banco
apps/api/src/app.ts       rotas HTTP: validam a entrada, chamam um serviço, devolvem
apps/api/src/services.ts  regra de negócio: ingestão, aprovação, ADRs, copiloto
apps/api/src/agents/      os quatro agentes, os prompts e o grafo (workflow.ts)
apps/api/src/rag/         base de conhecimento e busca híbrida (SQL com pgvector e FTS)
apps/api/src/llm/         provedores, fallback, cache, métricas e o provedor mock
apps/api/src/db/          uma interface, dois bancos: pg ou PGlite
packages/mcp-server       ponte MCP: tools e resources que chamam a API por HTTP
apps/web/src/app/         Angular standalone com signals: store.ts é o estado da tela
infra/init.sql            schema do Postgres. A API roda este arquivo ao subir
```

Dependência só nesta direção: `web`, `mcp-server` e `api` dependem de `shared-schemas`. O `mcp-server` usa a `api` só nos testes. O front não importa da API.

## Regras inegociáveis

1. **Saída de LLM é validada com Zod, sempre.** Use `llm.generateObject({ schema })`. Schema de saída de LLM (`agents/schemas.ts`) não leva `.optional()` nem limite numérico: o modo estrito dos provedores recusa. Faixa de valor se confere em código, depois da resposta.
2. **O que protege o backlog fica em código, não no prompt.** O gate de aprovação (`human-approval-gate.ts`), a máquina de status das histórias (`services.ts`) e o descarte de ADR inventado não dependem de o modelo obedecer.
3. **Texto de fora é dado.** Nota de reunião e documento recuperado entram no prompt entre tags, por `prompts.ts`, que passa tudo por `quarantine`. Não monte prompt fora de `prompts.ts`.
4. **Toda chamada a modelo passa por `llm/llm.ts`.** É lá que ficam fallback, cache, custo e métricas. Não chame provedor direto.
5. **Contrato muda em `shared-schemas` primeiro.** API, front e MCP importam de lá. O front importa só tipos de `@specpilot/shared-schemas` e valores de `@specpilot/shared-schemas/constants`: o Zod não vai para o navegador.
6. **O modo de avaliação tem que continuar funcionando.** Recurso novo que chama modelo ganha um papel no provedor mock (`llm/mock-brain.ts`), no mesmo formato de tags do prompt.

## Convenções

- **Comentário explica o porquê**, em português. Ponto onde o leitor deve mexer para estender leva `PONTO DE EXTENSÃO:`. Atalho com limite conhecido leva `shortcut: <o limite>, <quando trocar>`.
- **Código em inglês, texto de tela e documentação em português.** As quatro colunas do board ficam em inglês.
- **ESM no Node**: import relativo termina em `.js`, mesmo o arquivo sendo `.ts`. No front (Angular), sem extensão.
- **Testes no Node**: `node:test`, arquivo `*.test.ts` ao lado do código, sem rede. **Testes no front**: Vitest pelo `ng test`, arquivo `*.spec.ts`.
- **A API é testada em processo** (`app.inject`), com o Postgres embutido. A busca híbrida é testada com o SQL de verdade.
- **Ação de card sempre à vista**: botão visível sem depender de passar o mouse, e arrastar é atalho, não o único caminho.

## Armadilhas já encontradas

- **`then` nos contratos.** O passo Então do Gherkin se chama `then`. A regra `noThenProperty` do Biome está desligada por isso; o valor é sempre texto.
- **POST sem corpo não leva `content-type: application/json`.** O Fastify responde 400 para JSON vazio. Os dois clientes (front e MCP) só mandam o cabeçalho quando há corpo.
- **Lista em coluna JSONB vai como texto.** `JSON.stringify(valor)` com `::jsonb` no SQL: o driver `pg` converteria um array JavaScript em array do Postgres.
- **"é" não é stopword no dicionário português do Postgres.** A busca tira palavra de uma ou duas letras da consulta antes do `plainto_tsquery`.
- **LangGraph**: nome de nó não pode repetir nome de campo do estado. Os nós levam o nome do agente.
- **Angular 22 exige TypeScript 6.0.x.** A versão é única no monorepo, pelo catálogo do `pnpm-workspace.yaml`.
- **pnpm 12 recusa versão publicada há menos de um dia** e não roda script de instalação de dependência (`allowBuilds`). Afrouxe a faixa de versão em vez de abrir exceção.
- **Modelos e preços** estão em `apps/api/src/llm/models.ts`, conferidos em 18/11/2026. Trocou o modelo, atualize o preço.

## Não faça

- Não commite `.env`, `dist/`, `.angular/` nem `node_modules/`.
- Não acrescente dependência para o que a plataforma já faz (`fetch`, `node:test`, `process.loadEnvFile`).
- Não troque "full-text search" por "BM25" no texto sem trocar a implementação.
- Não deixe a API escutar fora da própria máquina sem pôr autenticação antes: hoje ela não tem.
