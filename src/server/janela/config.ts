import { z } from "zod";

/**
 * Configuração da janela de 24 h: a linha `JANELA` de `Integration`.
 *
 * Só a caixa 29 por padrão, e não é descuido. É a única caixa da Seahub em que
 * a janela existe E o Chatwoot não sabe dela: a 31 e a 34 são WAHA (API não
 * oficial, sem janela nenhuma), e a 30 é `Channel::Instagram`, em que o próprio
 * Chatwoot já controla o prazo de resposta. A automação 31 etiqueta TODAS as
 * caixas como abertas; marcar a 31 ou a 34 como fechadas mandaria a equipe
 * ligar para quem ainda pode receber mensagem.
 */

export const INSTRUCAO_PADRAO =
  "Vendedor, se o cliente não responder até lá, fazer ligação ou mandar áudio pelo WhatsApp.";

export const janelaConfigSchema = z.object({
  caixas: z.array(z.number().int().positive()).min(1).default([29]),
  /**
   * Quantos minutos antes de fechar a nota sai. O fluxo do n8n avisava com 1 h.
   * O piso de 15 existe porque a conferência roda a cada 5 min: um trecho menor
   * poderia passar inteiro entre duas conferências.
   */
  minutosDeAviso: z.number().int().min(15).max(240).default(60),
  instrucao: z.string().trim().min(1).max(500).default(INSTRUCAO_PADRAO),
});

export type JanelaConfig = z.infer<typeof janelaConfigSchema>;

/**
 * A config gravada, com os padrões no que faltar. Só o formulário grava, e ele
 * valida antes: config inválida aqui é linha mexida à mão, e cai nos padrões.
 */
export function lerConfigJanela(bruto: unknown): JanelaConfig {
  const lido = janelaConfigSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : janelaConfigSchema.parse({});
}

const ROTULOS: Record<string, string> = {
  caixas: "Caixas",
  minutosDeAviso: "Minutos de aviso (inteiro, de 15 a 240)",
  instrucao: "Texto da nota (até 500 caracteres)",
};

/**
 * O formulário vira config, ou a primeira recusa em texto para quem preencheu.
 * Número em branco é recusa, não zero: `Number("")` é 0.
 */
export function configDoFormulario(
  ler: (campo: string) => string | null,
): { config: JanelaConfig } | { erro: string } {
  const valor = (campo: string) => (ler(campo) ?? "").replace(/\r\n/g, "\n").trim();

  const caixas = valor("caixas")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  if (caixas.length === 0 || caixas.some((n) => !Number.isInteger(n) || n <= 0)) {
    return {
      erro: "Caixas: informe o número de cada caixa do Chatwoot (ex.: 29), separados por vírgula.",
    };
  }

  const minutos = valor("minutosDeAviso");
  const lido = janelaConfigSchema.safeParse({
    caixas: [...new Set(caixas)],
    minutosDeAviso: minutos === "" ? Number.NaN : Number(minutos),
    instrucao: valor("instrucao"),
  });
  if (!lido.success) {
    const chave = String(lido.error.issues[0]?.path?.[0] ?? "");
    return { erro: `${ROTULOS[chave] ?? chave}: valor inválido ou em branco.` };
  }
  return { config: lido.data };
}
