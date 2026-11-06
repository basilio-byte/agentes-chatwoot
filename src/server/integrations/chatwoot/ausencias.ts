import { z } from "zod";

/**
 * Ausência de uma pessoa da equipe, com substituto e dia de volta.
 *
 * Pedido de 06/11/2026: o Laércio (financeiro) sai de férias até 19/11 e "quem
 * chegar para ele no Chatwoot" deve ir para o Felipe. Os agentes mandam para ele
 * POR NOME, escrito em quatro prompts, e a cobrança por etiqueta também. Em vez
 * de reescrever prompt (versões novas, e a lembrança de desfazer no dia da
 * volta), a troca mora no resolver de nomes — o ponto por onde TODA atribuição a
 * uma pessoa passa — e some sozinha na data.
 *
 * Puro e testado. O que lê o banco está em `ausencias-config.ts`.
 */

/** `AAAA-MM-DD` que existe no calendário (2026-02-30 não). */
function dataIsoValida(texto: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return false;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ano < 2020 || ano > 2100) return false;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

export const ausenciaSchema = z.object({
  /** Quem está ausente, como o prompt o chama ("Laercio") ou o nome completo. */
  nome: z.string().trim().min(2).max(80),
  /** Quem recebe no lugar. */
  substituto: z.string().trim().min(2).max(80),
  /** Último dia da ausência, inclusive (`AAAA-MM-DD`, dia de São Paulo). */
  ate: z.string().refine(dataIsoValida, "Data inválida"),
});

export type Ausencia = z.infer<typeof ausenciaSchema>;

export const MAXIMO_DE_AUSENCIAS = 20;

/** O que o resolver precisa: as ausências e o "hoje" de São Paulo (`AAAA-MM-DD`). */
export type OpcoesDeAusencia = { ausencias: Ausencia[]; hoje: string };

/** Vale até o FIM do último dia: no dia `ate` ainda vale, no seguinte não. */
export function ausenciaVigente(ausencia: Ausencia, hoje: string): boolean {
  return hoje <= ausencia.ate;
}

/** `2026-11-19` → `19/11/2026`. */
export function dataBR(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

/** Tira acento e caixa, para comparar "Laércio" com "laercio". */
export function normalizarNome(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * As ausências como a tela mostra: uma por linha,
 * `Laercio -> Felipe até 19/11/2026`.
 */
export function ausenciasEmTexto(ausencias: Ausencia[]): string {
  return ausencias.map((a) => `${a.nome} -> ${a.substituto} até ${dataBR(a.ate)}`).join("\n");
}

const LINHA = /^(.+?)\s*(?:->|→|=>)\s*(.+?)\s+at[eé]\s+(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})\s*$/i;

/**
 * Lê o texto da tela. Devolve o erro com o número da linha, em português:
 * quem salva precisa saber qual linha o sistema recusou, porque uma ausência
 * que não valeu deixa a conversa ir para quem está de férias, sem aviso.
 */
export function lerAusenciasDoTexto(texto: string): { ausencias: Ausencia[] } | { erro: string } {
  const linhas = texto.split(/\r?\n/);
  const ausencias: Ausencia[] = [];

  for (const [i, bruta] of linhas.entries()) {
    const linha = bruta.trim();
    if (!linha) continue;

    const m = LINHA.exec(linha);
    if (!m) {
      return {
        erro: `Ausências, linha ${i + 1} ("${linha.slice(0, 40)}"): use "nome -> substituto até dd/mm/aaaa".`,
      };
    }

    const [, nome, substituto, dataBruta] = m;
    const ate = dataBruta.includes("/") ? dataBruta.split("/").reverse().join("-") : dataBruta;

    const lida = ausenciaSchema.safeParse({ nome, substituto, ate });
    if (!lida.success) {
      return { erro: `Ausências, linha ${i + 1}: a data "${dataBruta}" não existe no calendário.` };
    }
    if (normalizarNome(lida.data.nome) === normalizarNome(lida.data.substituto)) {
      return { erro: `Ausências, linha ${i + 1}: a pessoa não pode ser o próprio substituto.` };
    }
    if (ausencias.some((a) => normalizarNome(a.nome) === normalizarNome(lida.data.nome))) {
      return { erro: `Ausências, linha ${i + 1}: "${lida.data.nome}" já aparece em outra linha.` };
    }
    ausencias.push(lida.data);
  }

  if (ausencias.length > MAXIMO_DE_AUSENCIAS) {
    return { erro: `Ausências: no máximo ${MAXIMO_DE_AUSENCIAS} linhas.` };
  }
  return { ausencias };
}

/**
 * As ausências guardadas na configuração do Chatwoot. Leitura TOLERANTE: config
 * mexida à mão ou de versão antiga não derruba o atendimento — a linha inválida
 * é ignorada e o resto vale.
 */
export function ausenciasDaConfig(config: unknown): Ausencia[] {
  const bruto = (config as { ausencias?: unknown } | null | undefined)?.ausencias;
  if (!Array.isArray(bruto)) return [];
  return bruto.flatMap((item) => {
    const lida = ausenciaSchema.safeParse(item);
    return lida.success ? [lida.data] : [];
  });
}
