import type { GuardrailReport } from '@specpilot/shared-schemas';

// Duas defesas contra prompt injection, e nenhuma delas depende do modelo obedecer.
//
//   isolamento   nota de reunião e documento recuperado entram no prompt entre tags, como
//                dado. `quarantine` tira do texto qualquer coisa que feche ou abra essas tags.
//   detecção     `inspectNotes` aponta frase com cara de instrução. A nota não é barrada (uma
//                transcrição pode citar a frase), mas tudo o que sair dela vai para aprovação
//                humana: quem decide é o gate do workflow, em código.

/** As tags que os prompts usam para separar dado de instrução. */
const PROMPT_TAGS = ['notas', 'contexto', 'adrs', 'historias', 'fontes', 'backlog', 'pergunta'];
const TAG_LOOKALIKE = new RegExp(`<\\s*/?\\s*(?:${PROMPT_TAGS.join('|')})\\s*>`, 'gi');

/** Texto de fora nunca fecha a tag em que foi colocado. */
export const quarantine = (text: string) => text.replace(TAG_LOOKALIKE, '');

// shortcut: lista de frases conhecidas, em português e inglês. Paráfrase e outro idioma
// escapam. Em produção, some um classificador de injeção; o isolamento acima continua valendo.
const INJECTION_RULES: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'pede para ignorar as instruções',
    pattern:
      /\b(?:ignore|desconsidere|esqueca|disregard|forget)\b.{0,40}\b(?:instrucoes|instructions|regras|rules|prompt)\b/,
  },
  {
    reason: 'pede para revelar o prompt do sistema',
    pattern:
      /\b(?:revele|mostre|exiba|imprima|reveal|show|print)\b.{0,40}\b(?:system prompt|prompt d[eo] sistema|instrucoes do sistema)\b/,
  },
  {
    reason: 'tenta mudar o papel do assistente',
    pattern:
      /\b(?:voce agora e|a partir de agora voce|you are now|aja como se nao|modo desenvolvedor|developer mode)\b/,
  },
  {
    reason: 'tenta pular a aprovação humana',
    pattern: /\b(?:aprove|aprovar|approve)\b.{0,40}\b(?:automaticamente|sem revisao|todas as historias|all stories)\b/,
  },
];

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');

/** Aponta frases com cara de instrução para o modelo dentro de um texto que deveria ser só dado. */
export function inspectNotes(text: string): GuardrailReport {
  const normalized = normalize(text);
  const reasons = INJECTION_RULES.filter(({ pattern }) => pattern.test(normalized)).map(({ reason }) => reason);
  return { flagged: reasons.length > 0, reasons };
}
