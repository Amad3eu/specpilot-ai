# SpecPilot AI

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

O SpecPilot transforma a nota de uma reunião em backlog: épicos, histórias de usuário com critérios de aceite em Gherkin e Architecture Decision Records (ADRs). Antes de escrever, ele consulta o que o projeto já decidiu. Depois de escrever, separa o que pode ir direto para o board do que espera a aprovação de uma pessoa.

O backlog tem duas portas de entrada: um board em Angular, para pessoas, e um servidor MCP, para agentes em uma IDE. As duas falam com a mesma API e enxergam o mesmo estado.

![Board do SpecPilot: nota de reunião, workflow dos agentes e as quatro colunas, com um conflito de arquitetura apontado](docs/screenshots/board.png)

## Rode em um minuto

Precisa de Node.js 22 ou mais novo e do pnpm 12 (`corepack enable` ativa a versão fixada no `package.json`). Não precisa de chave de API, de Docker nem de arquivo de configuração.

```bash
pnpm install
pnpm dev
```

Abra `http://localhost:4200` e clique em um dos três exemplos de nota de reunião. Cada um mostra um caminho do workflow: histórias prontas e uma que espera aprovação, uma decisão que contradiz um ADR, e uma nota com prompt injection.

Sem configuração, o SpecPilot sobe em **modo de avaliação**:

| Peça | No modo de avaliação | Com configuração |
| --- | --- | --- |
| Modelo | Provedor mock: heurísticas determinísticas, sem rede | OpenAI, Gemini ou OpenRouter, com fallback entre eles |
| Dados | Postgres embutido (PGlite), zerado a cada subida | PostgreSQL 16 com pgvector |
| Cache | Memória do processo | Redis |

O workflow, a busca híbrida, o gate de aprovação e a trilha de auditoria são o mesmo código nos dois modos. O que muda é quem responde no lugar do modelo e onde os dados ficam.

## O que o projeto demonstra

- **Workflow multiagente com estado tipado**, em LangGraph: quatro agentes em sequência, cada um com uma responsabilidade.
- **Hybrid RAG em SQL**: busca vetorial (pgvector) e lexical (full-text search) fundidas por Reciprocal Rank Fusion.
- **Human-in-the-loop garantido em código**: a IA não põe item de alto impacto no board sem uma pessoa.
- **Model Context Protocol**: o mesmo backlog operado por um agente, com tools e resources.
- **Engenharia em volta do modelo**: saída estruturada validada com Zod, fallback entre provedores, cache, custo estimado e auditoria.

## Arquitetura geral

```mermaid
flowchart LR
  WEB["apps/web<br/>Angular: board,<br/>ADRs e copiloto"]
  IDE["IDE ou agente<br/>cliente MCP"]
  MCP["packages/mcp-server<br/>tools e resources"]

  subgraph api["apps/api (Fastify)"]
    direction TB
    ROUTES["Rotas HTTP e SSE"]
    FLOW["Workflow multiagente<br/>LangGraph"]
    RAG["Hybrid RAG<br/>vetorial + lexical, RRF"]
    LLM["Camada de LLM<br/>fallback, cache, custo"]
    ROUTES --> FLOW
    FLOW --> RAG
    FLOW --> LLM
  end

  PG[("PostgreSQL + pgvector<br/>ou Postgres embutido")]
  REDIS[("Redis<br/>ou memória")]
  PROV["OpenAI, Gemini, OpenRouter<br/>ou provedor mock"]

  WEB -->|"HTTP e SSE"| ROUTES
  IDE -->|"MCP, stdio"| MCP
  MCP -->|"HTTP"| ROUTES
  RAG --> PG
  ROUTES --> PG
  LLM --> PROV
  LLM --> REDIS
```

Os contratos de `packages/shared-schemas` (Zod) são o que atravessa cada seta: a API valida a entrada com eles, o servidor MCP valida a resposta da API, e o front usa os tipos.

| Workspace | Papel |
| --- | --- |
| `apps/api` | API Fastify: workflow multiagente, Hybrid RAG, guardrails, camada de LLM e trilha de auditoria |
| `apps/web` | Angular 22, standalone e com signals: entrada da nota, board Kanban, ADRs, base de conhecimento e copiloto |
| `packages/shared-schemas` | Contratos Zod: `Epic`, `UserStory`, `Adr`, `AuditLog`, `StreamEvent` e os pedidos de cada rota |
| `packages/mcp-server` | Servidor MCP em stdio, com 4 tools e 2 resources |
| `infra` | `docker-compose.yml` (PostgreSQL 16 com pgvector, Redis 7) e `init.sql` |

## Fluxo multiagente com aprovação humana

```mermaid
flowchart TB
  NOTE(["Nota de reunião"]) --> GUARD["Inspeção da nota<br/>frase com cara de instrução?"]
  GUARD --> CR["1 · ContextRetriever<br/>busca híbrida em ADRs e regras"]
  CR --> PA["2 · ProductAnalyst<br/>épicos, histórias e Gherkin,<br/>validados com Zod"]
  PA --> AR["3 · ArchitectReviewer<br/>conflitos com ADRs aceitos<br/>e ADRs novos a propor"]
  AR --> GATE{"4 · HumanApprovalGate<br/>regra em código"}

  GATE -->|"alto impacto, confiança baixa,<br/>conflito com ADR ou nota suspeita"| PEND["Pending Approval"]
  GATE -->|"demais histórias"| READY["Ready"]
  PEND -->|"uma pessoa aprova<br/>no board ou por MCP"| READY
  PEND -->|"rejeita"| OUT(["Fora do board"])
  READY --> WIP["In Progress"] --> DONE["Done"]

  AR -.->|"ADR proposto"| ADR["Aba de ADRs"]
  ADR -.->|"aceito por uma pessoa:<br/>indexado na base"| CR
```

Cada agente vê só o que precisa. O analista não recebe a lista de ADRs; o revisor não reescreve histórias; o gate não chama modelo. O grafo não grava nada: devolve o backlog com o status de cada item, e quem persiste é a camada de serviço.

O gate (`apps/api/src/agents/human-approval-gate.ts`) segura uma história quando:

- o impacto é alto (dinheiro, autenticação, dado pessoal, migração);
- a confiança do agente fica abaixo de 70%;
- ela depende de uma decisão em conflito com um ADR aceito;
- a nota de origem trazia texto com cara de instrução para o modelo.

Um ADR aceito por uma pessoa é indexado na base de conhecimento. Na próxima reunião, ele já é contexto dos agentes.

![Aba de ADRs: três aceitos, um proposto esperando decisão, e a busca na base de conhecimento](docs/screenshots/adrs.png)

## Ponte MCP

```mermaid
sequenceDiagram
  participant A as Agente na IDE
  participant M as Servidor MCP (stdio)
  participant API as API do SpecPilot
  participant B as Board (Angular)

  A->>M: tools/call ingest_meeting_notes
  M->>API: POST /api/ingest
  API-->>M: histórias, conflitos e ADRs propostos
  M-->>A: resumo em texto, com o id de cada história
  A->>M: resources/read specpilot://backlog/summary
  M->>API: GET /api/backlog/summary
  API-->>A: o que espera aprovação
  Note over A: uma pessoa confirma a aprovação
  A->>M: tools/call approve_story (storyId, approvedBy)
  M->>API: POST /api/stories/:id/approve
  API-->>M: história em Ready, auditoria com actor = mcp
  B->>API: GET /api/backlog
  API-->>B: o board mostra o que o agente fez
```

O servidor MCP não tem banco nem modelo: cada tool é uma chamada HTTP à API. Por isso o board e o agente nunca divergem, mesmo no modo de avaliação, em que o estado vive na memória da API.

| Tool | O que faz | Só leitura |
| --- | --- | --- |
| `ingest_meeting_notes` | Roda o workflow sobre uma nota de reunião | não |
| `list_backlog_stories` | Lista histórias, com filtro por status | sim |
| `approve_story` | Aprova uma história pendente, em nome de uma pessoa | não |
| `search_architecture_docs` | Busca híbrida em ADRs, regras e documentos | sim |

| Resource | Conteúdo |
| --- | --- |
| `specpilot://backlog/summary` | Quantas histórias há em cada coluna e quais esperam aprovação |
| `specpilot://adrs/index` | Os ADRs do projeto, com status e decisão |

Para ligar em um cliente MCP, rode `pnpm build` uma vez e deixe a API no ar (`pnpm dev`):

```json
{
  "mcpServers": {
    "specpilot": {
      "command": "node",
      "args": ["/caminho/para/specpilot-ai/packages/mcp-server/dist/index.js"],
      "env": { "SPECPILOT_API_URL": "http://localhost:3333" }
    }
  }
}
```

O cliente aponta para o arquivo compilado, e não para `pnpm mcp`: em stdio, a saída padrão é o protocolo, e o pnpm escreve nela a linha do script antes de rodar.

## Como executar

```bash
pnpm dev          # API em http://127.0.0.1:3333 e front em http://localhost:4200
pnpm check        # lint + typecheck + build + testes dos quatro workspaces (o que o CI roda)
pnpm mcp          # servidor MCP em stdio
```

Para usar um modelo real, copie `.env.example` para `.env` e preencha uma chave (`OPENAI_API_KEY`, `GEMINI_API_KEY` ou `OPENROUTER_API_KEY`). Para persistir os dados e usar Redis:

```bash
docker compose -f infra/docker-compose.yml up -d
# no .env:
# DATABASE_URL=postgres://specpilot:specpilot@localhost:5432/specpilot
# REDIS_URL=redis://localhost:6379
```

A API roda `infra/init.sql` ao subir, e o arquivo é idempotente. A barra no topo da tela mostra qual modelo, banco e cache estão em uso.

## Trade-offs de engenharia

**Hybrid RAG e multiagentes em vez de fine-tuning.** O que o SpecPilot precisa saber muda toda semana: um ADR novo, uma regra revista. Isso é problema de conhecimento, e conhecimento que muda fica em um índice, não nos pesos de um modelo. Um ADR aceito hoje vale na próxima ingestão, sem retreino, e a resposta aponta a fonte. Fine-tuning resolveria formato e estilo, que aqui já saem do schema Zod e de dois prompts curtos. O custo é manter o pipeline de dados e pagar uma busca por requisição.

**Por que busca híbrida.** ADR e regra de projeto têm muito termo exato: "ADR-003", "PIX", o nome de uma tabela. A busca vetorial acha o parecido no sentido e erra o termo exato; a lexical faz o contrário. A fusão por RRF usa só a posição em cada ranking, então não depende de calibrar escalas diferentes. O título do documento pesa mais que o corpo no índice lexical, e há um piso de similaridade para a busca não devolver "os menos distantes" quando nada é relevante.

**Por que vários agentes e não um prompt grande.** Cada agente tem um contrato de saída pequeno e testável, e vê só o contexto de que precisa. O preço é latência: são duas chamadas de modelo em sequência, mais a busca. O gate é o único passo que decide o que entra no board, e por isso não é um agente com prompt: é uma função.

**Isolamento de contexto contra prompt injection.** Uma nota de reunião é texto de fora e pode conter instrução. São três defesas, e nenhuma depende de o modelo obedecer:

1. A nota e os documentos recuperados entram no prompt entre tags, como dado, e o texto de fora é limpo de qualquer coisa que feche essas tags.
2. A saída do modelo tem que passar por um schema. Texto livre não chega ao backlog.
3. Uma nota com frase suspeita não é barrada, porque uma transcrição pode citar a frase. Mas tudo o que sair dela vai para aprovação humana.

A detecção é por lista de frases conhecidas, em português e inglês. Paráfrase escapa, e é por isso que a terceira defesa não depende da primeira.

**Controle de custos.** Toda chamada passa por um ponto só, que mede tokens, latência e custo estimado pela tabela de preços. Respostas ficam em cache por uma hora, com chave que inclui modelo, instrução e pergunta: colar a mesma nota duas vezes não paga duas vezes. O contexto é limitado a três trechos. Dois níveis de modelo: o `balanced` escreve histórias e revisa arquitetura, e o `fast` responde ao copiloto. O custo é estimativa de tabela, sem desconto de cache de prompt.

**Postgres embutido no modo de avaliação.** Sem `DATABASE_URL`, a API usa o PGlite: um Postgres compilado para WebAssembly, com pgvector, dentro do processo. Assim o modo sem configuração não é uma segunda implementação da busca. É o mesmo SQL, e os testes rodam contra ele. O custo são cerca de 3 segundos a mais na subida, e os dados somem quando o processo para.

**MCP como ponte HTTP.** O servidor MCP poderia embutir a lógica. Ficou como cliente da API para o board e o agente compartilharem estado, e para as regras valerem uma vez só. O custo é precisar da API no ar.

**`approve_story` por MCP.** Um agente consegue aprovar uma história, e isso enfraquece o gate se o cliente MCP não pedir confirmação. A tool exige o nome de quem aprovou, a descrição manda usá-la só depois de uma pessoa confirmar, e a auditoria registra que a aprovação veio por MCP. A garantia real depende de o cliente pedir confirmação para tools que não são de leitura.

**Validação no servidor, tipos no front.** O front importa só os tipos dos contratos. Levar o Zod para o navegador custava 444 kB, mais do que o resto da aplicação; a tela confia na API, que valida tudo.

## Status e limites

- **Testado**: 81 testes automatizados (6 dos contratos, 51 da API, 8 da ponte MCP, 16 do front), todos em modo de avaliação, e o fluxo principal conferido em um navegador de verdade.
- **Não exercitado ainda**: nenhum modelo real foi chamado, e o caminho com o PostgreSQL do docker-compose e com Redis não foi rodado. A interface de banco é a mesma (o SQL é testado no Postgres embutido), mas o adaptador do Redis só tem a versão em memória testada.
- **O provedor mock não é um modelo.** Ele reconhece requisito, tema e tecnologia por lista de palavras, e o embedding dele é um hash de palavras, que não entende sinônimo. Serve para avaliar a aplicação de ponta a ponta; qualidade de extração e de busca semântica, só com provedor real.
- **A API não tem autenticação.** Por padrão ela só escuta em `127.0.0.1`.
- **Um workflow por vez.** O custo de cada execução sai da diferença de um acumulado da sessão, o que só vale sem ingestões simultâneas.
- **Busca lexical é full-text search do Postgres**, não BM25.

## Estrutura

```
specpilot-ai/
├── apps/
│   ├── api/                  Fastify, LangGraph, Hybrid RAG, guardrails, auditoria
│   │   └── src/
│   │       ├── agents/       os quatro agentes, os prompts e o grafo
│   │       ├── rag/          base de conhecimento e busca híbrida
│   │       ├── llm/          provedores, fallback, cache, métricas, provedor mock
│   │       ├── backlog/      SQL de épicos, histórias, ADRs e auditoria
│   │       └── db/           PostgreSQL ou Postgres embutido
│   └── web/                  Angular 22: board, ADRs, base de conhecimento, copiloto
├── packages/
│   ├── shared-schemas/       contratos Zod
│   └── mcp-server/           tools e resources MCP
├── infra/                    docker-compose.yml e init.sql
├── .github/workflows/ci.yml  lint, typecheck, build e testes
├── .env.example
└── CLAUDE.md                 regras de arquitetura para agentes de IA
```

## Licença

[MIT](LICENSE)
