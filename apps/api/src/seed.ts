import { type Adr, adrLabel } from '@specpilot/shared-schemas';

// O que o projeto de exemplo "já decidiu" antes da primeira reunião. É o contexto histórico
// que a busca híbrida recupera e contra o qual o revisor de arquitetura compara a nota.
// Entra uma vez, quando a base de conhecimento está vazia.

export const SEED_ADRS: Array<Pick<Adr, 'title' | 'context' | 'decision' | 'consequences'>> = [
  {
    title: 'PostgreSQL como banco de dados padrão',
    context:
      'Os serviços precisam de transação, consulta relacional e busca vetorial. Manter mais de um banco dobra o trabalho de operação, backup e monitoramento.',
    decision:
      'Todo serviço persiste em PostgreSQL 16. Busca vetorial usa a extensão pgvector no mesmo banco. Outro banco de dados só entra com um ADR novo.',
    consequences:
      'Um banco só para operar e fazer backup. Carga que não cabe no modelo relacional precisa de justificativa escrita.',
  },
  {
    title: 'API REST com contrato OpenAPI',
    context:
      'Os clientes da API são o front-end, parceiros e agentes de IA. Todos precisam de um contrato estável, que dê para versionar e testar.',
    decision:
      'As APIs públicas são REST, descritas em OpenAPI e versionadas no caminho (/v1). Mudança que quebra contrato exige versão nova.',
    consequences:
      'O contrato vira fonte de testes e de clientes gerados. Consulta muito aninhada custa mais de uma chamada.',
  },
  {
    title: 'Autenticação por OAuth 2.0 / OIDC com provedor central',
    context:
      'Guardar senha é risco de segurança e de LGPD. As empresas clientes já têm provedor de identidade e pedem login único.',
    decision:
      'O login é delegado a um provedor OIDC central. Nenhum serviço guarda senha nem implementa tela de login própria.',
    consequences:
      'Login único e segundo fator ficam por conta do provedor. Ambiente de desenvolvimento precisa de um provedor de teste.',
  },
];

export const SEED_RULES: Array<{ title: string; content: string }> = [
  {
    title: 'Regra de dados pessoais (LGPD)',
    content:
      'CPF, e-mail e telefone são dados pessoais. Nunca aparecem em log nem em mensagem de erro: são mascarados antes de gravar. Exportação com dado pessoal exige perfil de administrador e fica registrada na trilha de auditoria. O prazo de retenção é de 12 meses depois do fim do contrato.',
  },
  {
    title: 'Definition of Ready do backlog',
    content:
      'Uma história só entra em desenvolvimento com persona, benefício e critérios de aceite escritos em Gherkin (Dado, Quando, Então). História que mexe com pagamento, autenticação ou dado pessoal precisa da aprovação de uma pessoa do produto antes de ir para Ready.',
  },
  {
    title: 'Regra de pagamentos',
    content:
      'Toda cobrança passa pelo gateway de pagamentos homologado. O sistema não guarda número de cartão. Pagamento por PIX precisa de confirmação por webhook assinado, e o pedido só é liberado depois da confirmação.',
  },
];

/** O texto de um ADR na base de conhecimento. O título leva o número: é o termo exato que a busca lexical acha. */
export const adrDocument = (adr: Pick<Adr, 'number' | 'title' | 'context' | 'decision' | 'consequences'>) => ({
  kind: 'adr' as const,
  title: `${adrLabel(adr.number)}: ${adr.title}`,
  content: `Contexto: ${adr.context}\n\nDecisão: ${adr.decision}\n\nConsequências: ${adr.consequences}`,
});
