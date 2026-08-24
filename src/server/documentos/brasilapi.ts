import { logger } from "@/lib/logger";

/**
 * Consulta de CNPJ na BrasilAPI, sobre os dados abertos da Receita Federal.
 *
 * É a **única** consulta oficial gratuita útil aqui. Para CPF e CNH não existe
 * equivalente: a da Receita é página web com captcha e a do Serpro é paga —
 * por isso nesses dois o que temos é só dígito verificador.
 *
 * ⚠ **A BrasilAPI é um projeto comunitário, não do governo.** É gratuita e sem
 * chave, e por isso mesmo não tem compromisso de disponibilidade. Toda falha
 * aqui é tratada como "não deu para consultar", nunca como "empresa não
 * existe": concluir inexistência a partir de um serviço fora do ar seria
 * recusar um cliente por causa de um problema nosso.
 *
 * O shape abaixo é lido de forma tolerante de propósito — campo que faltar vira
 * `null` em vez de quebrar a leitura inteira.
 */

const BASE = "https://brasilapi.com.br/api/cnpj/v1";
const TIMEOUT_MS = 10_000;

export type EmpresaConsultada = {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  situacao: string | null;
  dataSituacao: string | null;
  inicioAtividade: string | null;
  atividadePrincipal: string | null;
  municipio: string | null;
  uf: string | null;
};

export type ResultadoDaConsulta =
  | { achou: true; empresa: EmpresaConsultada }
  | { achou: false; motivo: string; indeterminado?: boolean };

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

export function lerEmpresa(bruto: unknown, cnpj: string): EmpresaConsultada {
  const b = (bruto ?? {}) as Record<string, unknown>;
  return {
    cnpj: texto(b.cnpj) ?? cnpj,
    razaoSocial: texto(b.razao_social),
    nomeFantasia: texto(b.nome_fantasia),
    situacao: texto(b.descricao_situacao_cadastral),
    dataSituacao: texto(b.data_situacao_cadastral),
    inicioAtividade: texto(b.data_inicio_atividade),
    atividadePrincipal: texto(b.cnae_fiscal_descricao),
    municipio: texto(b.municipio),
    uf: texto(b.uf),
  };
}

export async function consultarCNPJ(
  numero: string,
): Promise<ResultadoDaConsulta> {
  const limpo = numero.replace(/\D/g, "");

  try {
    const resposta = await fetch(`${BASE}/${limpo}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });

    // 404 é a única resposta que autoriza dizer "não existe" — e mesmo assim,
    // com a ressalva de que a base é um retrato dos dados abertos.
    if (resposta.status === 404) {
      return {
        achou: false,
        motivo: "CNPJ não encontrado na base pública da Receita",
      };
    }

    if (!resposta.ok) {
      return {
        achou: false,
        indeterminado: true,
        motivo: `a consulta pública respondeu ${resposta.status} — não dá para afirmar nada sobre este CNPJ agora`,
      };
    }

    return { achou: true, empresa: lerEmpresa(await resposta.json(), limpo) };
  } catch (erro) {
    logger.warn(
      { cnpj: limpo, erro: erro instanceof Error ? erro.message : erro },
      "consulta de CNPJ falhou",
    );
    return {
      achou: false,
      indeterminado: true,
      motivo:
        "não consegui falar com a consulta pública de CNPJ — trate como não conferido, não como inválido",
    };
  }
}
