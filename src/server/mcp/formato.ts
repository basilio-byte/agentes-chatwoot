import { formatarData } from "@/lib/utils";
import type { ResultadoDeFerramenta } from "./protocolo";

/**
 * Como as ferramentas do MCP escrevem o que devolvem. Puro e testado.
 *
 * JSON indentado, e só em `content`: `structuredContent` repetiria o mesmo
 * volume, e há cliente que entrega os dois ao modelo — pagando o levantamento
 * de um agente com prompt longo duas vezes.
 */

export function responder(dados: unknown): ResultadoDeFerramenta {
  return { texto: JSON.stringify(dados, null, 2) };
}

/** Recusa que o modelo lê e corrige. `contexto` leva o que ajuda a corrigir. */
export function recusar(
  mensagem: string,
  contexto?: Record<string, unknown>,
): ResultadoDeFerramenta {
  return {
    erro: true,
    texto: contexto ? JSON.stringify({ erro: mensagem, ...contexto }, null, 2) : mensagem,
  };
}

/**
 * Data para ler, no horário de São Paulo. ⚠ Nunca ISO cru: o container roda em
 * UTC, e um assistente que relata "rodou às 15h" sobre um `T15:00Z` erra por
 * três horas diante de quem perguntou.
 */
export function quando(data: Date | null | undefined): string | null {
  return data ? formatarData(data) : null;
}

/** Corta por caractere (não por unidade UTF-16, que partiria emoji) e diz quanto sobrou. */
export function recortarTexto(
  texto: string | null | undefined,
  maximo: number,
): string | null {
  if (texto == null) return null;
  const caracteres = [...texto];
  if (caracteres.length <= maximo) return texto;
  return `${caracteres.slice(0, maximo).join("")}… [+${caracteres.length - maximo} caracteres]`;
}

/** Mesma régua de `tokensAproximadosDaTool`: ordem de grandeza, não tokenização. */
export function tokensAproximados(texto: string): number {
  return Math.round(texto.length / 3.6);
}

export function arredondarUsd(valor: number): number {
  return Math.round(valor * 1_000_000) / 1_000_000;
}

const CARA_DE_SEGREDO = /token|secret|senha|password|private|credencial|api_?key/i;

/**
 * Telefone de pessoa da equipe (quem recebe o aviso do presente de
 * aniversário). Não é segredo, mas na tela só Administrador vê — e o token do
 * MCP de quem tem papel Leitura não pode ser o caminho lateral até ele.
 */
const DADO_PESSOAL = /^telefones?$/i;

/**
 * Config de integração é não sensível por contrato — segredo mora cifrado em
 * `IntegrationCredential`. Mas uma chave com cara de segredo não sai daqui nem
 * assim: basta alguém um dia gravar um token no lugar errado.
 */
export function semSegredos(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(semSegredos);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor).map(([chave, v]) => [
        chave,
        CARA_DE_SEGREDO.test(chave) || DADO_PESSOAL.test(chave) ? "[omitido]" : semSegredos(v),
      ]),
    );
  }
  return valor;
}
