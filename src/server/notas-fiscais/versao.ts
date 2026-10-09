import { createHash } from "node:crypto";

/**
 * A "versão" da configuração das notas fiscais: uma impressão digital do JSON que está
 * gravado. A tela a leva escondida no formulário, e quem salva confere que ela ainda é a
 * de agora.
 *
 * ⚠ Existe por causa do formulário que ficou aberto: ele guarda o que viu quando abriu —
 * emissão LIGADA, lista de códigos em espera —, e salvá-lo depois de o sistema ter
 * desligado a emissão sozinho, ou de outra pessoa ter mexido na espera, religava a emissão
 * e apagava o motivo da pausa sem ninguém ter lido (revisão de 09/10/2026). Salvar a tela
 * "é a pessoa dizendo que viu o aviso": só vale se ela viu mesmo.
 *
 * O `jsonb` do Postgres devolve as chaves em outra ordem: o hash é do JSON ordenado.
 */
export function versaoDaConfig(bruto: unknown, habilitada = false): string {
  // A chave geral (`Integration.enabled`) mora fora do JSON e também é desligada por outra
  // pessoa: entra na impressão, senão salvar uma tela velha religava a integração.
  return createHash("sha256")
    .update(JSON.stringify(ordenar({ configuracao: bruto ?? {}, habilitada: !!habilitada })))
    .digest("hex")
    .slice(0, 16);
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([chave, v]) => [chave, ordenar(v)]),
    );
  }
  return valor;
}

/** A mensagem de quem tentou salvar uma tela que ficou para trás (ou que veio sem versão). */
export const TELA_DESATUALIZADA =
  "Esta tela está desatualizada: a configuração mudou depois que você a abriu (por exemplo, o sistema desligou a emissão sozinho, ou outra pessoa salvou). Recarregue a página para ver o estado de agora e salve de novo.";
