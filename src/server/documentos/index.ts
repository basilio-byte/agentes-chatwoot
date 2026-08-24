import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "../integrations/types";
import { consultarCNPJ } from "./brasilapi";
import {
  formatarCNPJ,
  formatarCPF,
  validarCNPJ,
  validarCPF,
  validarRegistroCNH,
} from "./digitos";

/**
 * Conferência de documento — CPF, CNH e CNPJ.
 *
 * Integração **sem credencial**: não há conta para configurar, porque o que ela
 * usa é algoritmo público (dígito verificador) e uma consulta gratuita e sem
 * chave (CNPJ na base aberta da Receita). Ainda assim mora no registry, e não
 * solta como função avulsa, porque precisa do que o registry resolve: liga e
 * desliga global, liga e desliga por agente, allowlist e um lugar conhecido no
 * painel.
 *
 * ⚠ **O que estas tools NÃO fazem: dizer se o documento é falso.** Elas provam
 * que um número é bem formado e, no caso do CNPJ, que a empresa existe e está
 * ativa. Não existe consulta oficial gratuita de CPF nem de CNH — a da Receita
 * é página com captcha, a do Serpro é paga. Antifraude de verdade é contratação
 * de serviço, não isto aqui. As descrições abaixo dizem isso ao modelo, porque
 * é ele quem vai escrever a conclusão para uma pessoa ler.
 */
export const documentosIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.DOCUMENTOS,
  label: "Documentos (CPF, CNH, CNPJ)",
  descricao:
    "Confere se um número de documento é bem formado e consulta CNPJ na base pública da Receita. Não detecta falsificação — para isso é preciso um serviço especializado.",
  // Sem conta, sem chave, sem endpoint privado: não há o que configurar.
  configSchema: z.object({}),
  credentialLabel: null,

  async testarConexao() {
    // O único caminho externo é a consulta de CNPJ. Testa com um número real e
    // público (Correios) — se ele voltar, a saída de rede está viva.
    const r = await consultarCNPJ("34028316000103");

    if (r.achou) {
      return {
        ok: true,
        mensagem: `Consulta pública de CNPJ respondendo (${r.empresa.razaoSocial ?? "sem razão social"}). A conferência de CPF e CNH é offline e não depende de rede.`,
      };
    }

    return {
      ok: false,
      indeterminado: true,
      mensagem: `A consulta pública de CNPJ não respondeu (${r.motivo}). A conferência de CPF e CNH continua funcionando — ela é offline.`,
    };
  },

  tools: [
    {
      name: "documento_conferir_cpf",
      categoria: "Documentos",
      description:
        "Confere se um número de CPF é bem formado (11 dígitos e dígito verificador correto). Use SEMPRE esta ferramenta em vez de calcular de cabeça — conta de dígito verificador feita por estimativa erra. ATENÇÃO: um CPF bem formado não é um CPF que existe, nem prova que pertence a quem enviou o documento. Não há consulta oficial gratuita para isso.",
      inputSchema: z.object({
        cpf: z.string().min(1).describe("O número, com ou sem pontuação."),
      }),
      async execute(entrada) {
        const { cpf } = entrada as { cpf: string };
        const r = validarCPF(cpf);

        return {
          bemFormado: r.valido,
          numero: r.valido ? formatarCPF(r.numero) : r.numero,
          motivo: r.motivo,
          observacao: r.valido
            ? "O número é válido em formato. Isso NÃO confirma que ele existe nem que é da pessoa — confira o nome contra o cadastro."
            : "Número mal formado: provável erro de digitação ou leitura ruim da foto.",
        };
      },
    },

    {
      name: "documento_conferir_cnh",
      categoria: "Documentos",
      description:
        "Confere se o número de REGISTRO de uma CNH (11 dígitos) é bem formado. Use sempre esta ferramenta em vez de calcular. ATENÇÃO: se o dígito não conferir, NÃO declare o documento falso — peça conferência humana. O algoritmo tem variantes e não há base oficial gratuita para consultar situação de CNH.",
      inputSchema: z.object({
        registro: z
          .string()
          .min(1)
          .describe(
            "O número de REGISTRO da CNH, 11 dígitos. Não é o número do documento nem o código de segurança.",
          ),
      }),
      async execute(entrada) {
        const { registro } = entrada as { registro: string };
        const r = validarRegistroCNH(registro);

        return {
          bemFormado: r.valido,
          numero: r.numero,
          motivo: r.motivo,
          observacao: r.valido
            ? "Formato consistente. Não confirma que a CNH existe, está ativa ou é da pessoa — confira nome e validade contra o cadastro."
            : "Formato inconsistente. Trate como PENDENTE DE CONFERÊNCIA HUMANA, não como documento falso.",
        };
      },
    },

    {
      name: "documento_conferir_cnpj",
      categoria: "Documentos",
      description:
        "Confere um CNPJ: primeiro o dígito verificador (offline) e, se estiver bem formado, consulta a base pública da Receita Federal para trazer razão social, situação cadastral e município. É a única consulta de base oficial disponível aqui — CPF e CNH não têm equivalente gratuito.",
      inputSchema: z.object({
        cnpj: z.string().min(1).describe("O número, com ou sem pontuação."),
      }),
      async execute(entrada) {
        const { cnpj } = entrada as { cnpj: string };

        // Dígito verificador primeiro: número mal formado não merece uma
        // requisição de rede, e a resposta local é melhor que um 404 ambíguo.
        const formato = validarCNPJ(cnpj);
        if (!formato.valido) {
          return {
            bemFormado: false,
            numero: formato.numero,
            motivo: formato.motivo,
            observacao: "Número mal formado — não cheguei a consultar a Receita.",
          };
        }

        const consulta = await consultarCNPJ(formato.numero);

        if (!consulta.achou) {
          return {
            bemFormado: true,
            numero: formatarCNPJ(formato.numero),
            consultou: false,
            motivo: consulta.motivo,
            observacao: consulta.indeterminado
              ? "O número é válido em formato, mas a consulta pública não respondeu. Trate como NÃO CONFERIDO — não como inexistente."
              : "O número é válido em formato, mas não foi encontrado na base pública.",
          };
        }

        const ativa = (consulta.empresa.situacao ?? "").toUpperCase() === "ATIVA";

        return {
          bemFormado: true,
          numero: formatarCNPJ(formato.numero),
          consultou: true,
          empresa: consulta.empresa,
          observacao: ativa
            ? "Empresa encontrada e ativa na Receita."
            : `Atenção: situação cadastral é "${consulta.empresa.situacao ?? "desconhecida"}", não ATIVA.`,
        };
      },
    },
  ],
};
