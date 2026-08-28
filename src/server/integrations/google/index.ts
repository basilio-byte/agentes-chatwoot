import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import {
  chaveDeServicoSchema,
  lerConfigGoogle,
  normalizarNome,
  resolverCadastro,
  rotuloDoCadastro,
  type ChaveDeServico,
  type GoogleConfig,
  type TipoDeCadastro,
} from "./config";
import { GoogleApiError, GoogleClient } from "./client";
import { camposDoModelo, textoDoDocumento } from "./docs";
import {
  a1,
  casarComCabecalho,
  colunaParaLetra,
  cortarCelula,
  nomesAmbiguos,
  normalizarLinhas,
  paraRegistros,
  posicoesDasColunas,
  procurarNaColuna,
} from "./sheets";

/**
 * Google Workspace — Sheets, Docs e Drive por uma conta de serviço.
 *
 * ⚠ **Nenhuma tool aceita um id de arquivo.** Planilhas, documentos, modelos e
 * pastas são cadastrados por NOME na configuração, e as tools resolvem. Isso
 * não é conveniência: o cadastro é a **allowlist de arquivos**. Aceitar um id
 * cru deixaria o agente escrever em qualquer planilha que a conta de serviço
 * enxergasse — inclusive numa que ele alucinou o id. (O id APARECE no retorno
 * de uma listagem de pasta, mas como informação para uma pessoa cadastrar o
 * arquivo; não há por onde devolvê-lo.)
 *
 * ⚠ **Nada aqui tem desfazer.** Não existe tool de exclusão nem de
 * compartilhamento, de propósito, e há teste travando isso: dar a um modelo que
 * lê mensagem de cliente o poder de apagar arquivo ou de conceder acesso a
 * terceiros é risco sem contrapartida. Mesmo tratamento do `DELETE` da ZapSign.
 */

const TETO_DE_TEXTO = 12_000;

function contexto(ctx: ToolContext): {
  cliente: GoogleClient;
  config: GoogleConfig;
  chave: ChaveDeServico;
} {
  if (!ctx.credential) {
    throw new Error(
      "A chave de conta de serviço do Google não está configurada. Peça para o proprietário do painel cadastrá-la em Integrações.",
    );
  }

  const config = lerConfigGoogle(ctx.config);
  const chave = lerChave(ctx.credential);
  return { cliente: new GoogleClient(config, chave), config, chave };
}

/**
 * Lê o JSON cifrado da chave.
 *
 * A mensagem de falha é longa de propósito: este erro chega ao modelo, que vai
 * escrevê-lo em português para uma pessoa, e "credencial inválida" mandaria o
 * operador rotacionar uma chave que pode estar certa e mal colada.
 */
export function lerChave(credencial: string): ChaveDeServico {
  let bruto: unknown;
  try {
    bruto = JSON.parse(credencial);
  } catch {
    throw new Error(
      "A chave do Google guardada não é um JSON válido. Cole de novo o arquivo baixado do Google Cloud, inteiro, sem editar.",
    );
  }

  const parsed = chaveDeServicoSchema.safeParse(bruto);
  if (!parsed.success) {
    throw new Error(
      `A chave do Google guardada está incompleta: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Falha de escrita que pode ter sido aplicada mesmo assim.
 *
 * ⚠ A Sheets e o Docs **não têm idempotência** — sem ETag, sem `If-Match`, sem
 * chave de requisição. Um `5xx`, um timeout de 30 s ou uma queda de rede depois
 * do envio não dizem se a linha entrou. E o runner entrega a exceção ao modelo
 * como resultado de tool comum, o que o ensina a corrigir e chamar de novo:
 * duas linhas da mesma pessoa, e o `atualizar_linha` do próximo atendimento
 * recusando alterar qualquer uma por achar duas ocorrências. O cadastro trava
 * até alguém abrir a planilha à mão.
 *
 * `4xx` (inclusive `429`) é recusa **antes** de aplicar: relança, para o modelo
 * receber a mensagem traduzida e se corrigir.
 */
function escritaIndeterminada(
  erro: unknown,
  dados: Record<string, unknown> & { oQueFazer: string },
): never | Record<string, unknown> {
  const status = erro instanceof GoogleApiError ? erro.status : 0;
  if (status >= 400 && status < 500) throw erro;

  return {
    ...dados,
    resultado: "indeterminado",
    erro: erro instanceof Error ? erro.message : String(erro),
    avisoImportante:
      "A gravação PODE ter acontecido — a falha foi depois do envio, e o Google não permite desfazer nem repetir com segurança. NÃO chame esta ferramenta de novo com os mesmos dados. Não diga ao cliente que ficou registrado nem que não ficou.",
  };
}

/**
 * A frase de recusa quando o casamento com o cabeçalho não fecha.
 *
 * Uma função só, usada pela inserção e pela atualização, porque as duas
 * recusam pelos mesmos motivos — e duas redações da mesma recusa divergiriam na
 * primeira edição, ensinando ao modelo coisas diferentes sobre o mesmo estado.
 */
function motivoDoCabecalho(
  motivo: "desconhecidas" | "duplicadas" | "cabecalhoVazio" | "cabecalhoAmbiguo",
  problematicas: string[],
  aba: string,
): string {
  switch (motivo) {
    case "cabecalhoVazio":
      return `A aba "${aba}" não tem cabeçalho na linha 1. NADA foi alterado. Confira o nome da aba com a ferramenta de ver estrutura.`;
    case "duplicadas":
      return `Você informou a mesma coluna mais de uma vez: ${problematicas.join(
        ", ",
      )}. NADA foi alterado — mande cada coluna uma vez só.`;
    case "cabecalhoAmbiguo":
      // Problema da planilha, não do agente: nenhuma reformulação do pedido
      // resolve, então o retorno manda escalar em vez de tentar de novo.
      return `A aba "${aba}" tem mais de uma coluna com o mesmo nome (${problematicas.join(
        ", ",
      )}), e não dá para saber em qual gravar. NADA foi alterado. Avise que uma pessoa precisa renomear as colunas repetidas — não é algo que você possa resolver.`;
    case "desconhecidas":
      return `Estas colunas não existem no cabeçalho desta aba: ${problematicas.join(
        ", ",
      )}. NADA foi alterado. Corrija os nomes usando o cabeçalho abaixo e chame de novo.`;
  }
}

/** Recusa nomeando o que existe, para o modelo se corrigir no mesmo turno. */
function naoCadastrado(termo: string, tipo: TipoDeCadastro, nomes: string[]) {
  const rotulo = rotuloDoCadastro(tipo);
  const feminino = rotulo === "planilha" || rotulo === "pasta";

  // ⚠ Lista vazia é OUTRA conversa. "Use um dos nomes abaixo" seguido de nada
  // manda o agente chutar, receber a mesma frase e chutar de novo, até o teto
  // de iterações — e o estado é o mais comum de todos: integração ligada no
  // primeiro dia, antes de alguém cadastrar. Falta configuração, e o agente
  // precisa dizer isso em vez de tentar resolver.
  if (nomes.length === 0) {
    return {
      erro: `Não há ${rotulo === "modelo" ? "modelo" : rotulo} nenhum${
        feminino ? "a" : ""
      } cadastrad${feminino ? "a" : "o"} nesta instalação, então não há onde procurar "${termo}". Isto é configuração faltando no painel: avise que ninguém cadastrou ainda — não é algo que você possa resolver nem contornar.`,
      [`${tipo}Cadastradas`]: nomes,
      nadaFoiAlterado: true,
    };
  }

  return {
    erro: `"${termo}" não é ${feminino ? "uma" : "um"} ${rotulo} cadastrad${
      feminino ? "a" : "o"
    }. Use exatamente um dos nomes abaixo — só esses estão liberados para este painel.`,
    [`${tipo}Cadastradas`]: nomes,
    nadaFoiAlterado: true,
  };
}

/** Lê o cabeçalho da aba. É a primeira linha, e ela manda em toda gravação. */
async function lerCabecalho(
  cliente: GoogleClient,
  planilhaId: string,
  aba: string,
): Promise<string[]> {
  const resposta = await cliente.lerValores(planilhaId, a1(aba, "1:1"));
  const bruto = resposta.values?.[0];
  if (!Array.isArray(bruto)) return [];
  return bruto.map((c) => (c === null || c === undefined ? "" : String(c)));
}

const parSchema = z.object({
  coluna: z
    .string()
    .min(1)
    .describe("Nome da coluna, exatamente como está escrito no cabeçalho da aba."),
  valor: z
    .string()
    .describe(
      "O valor a gravar, como texto. Data no formato AAAA-MM-DD. CPF, CNPJ, telefone e CEP com os zeros à esquerda.",
    ),
});

export const googleIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.GOOGLE,
  label: "Google Workspace",
  descricao:
    "Lê e escreve em planilhas do Google Sheets, lê e gera documentos do Google Docs e navega em pastas do Drive. Os arquivos são cadastrados por nome — o agente só alcança o que estiver na lista.",
  configSchema: z.object({}).loose(),
  credentialLabel:
    "JSON da chave de conta de serviço (Google Cloud → IAM → Contas de serviço → Chaves)",

  async testarConexao(ctx) {
    if (!ctx.credential) {
      return {
        ok: false,
        mensagem: "Cole o JSON da chave de conta de serviço antes de testar.",
      };
    }

    try {
      const { cliente } = contexto(ctx);
      return await cliente.testar();
    } catch (erro) {
      return {
        ok: false,
        mensagem: erro instanceof Error ? erro.message : "Falha desconhecida.",
      };
    }
  },

  tools: [
    // ─── Planilhas ──────────────────────────────────────────────────────────
    {
      name: "google_sheets_ver_estrutura",
      categoria: "Planilhas",
      description:
        "Mostra quais planilhas estão disponíveis e, para uma delas, as abas e o cabeçalho de cada coluna. Chame SEM parâmetro nenhum para descobrir os nomes das planilhas. Chame com a planilha e a aba antes de gravar, quando não souber os nomes exatos das colunas — eles precisam bater com o cabeçalho.",
      inputSchema: z.object({
        planilha: z
          .string()
          .optional()
          .describe(
            "Nome cadastrado da planilha. Omita para listar as planilhas disponíveis.",
          ),
        aba: z
          .string()
          .optional()
          .describe("Nome da aba cujo cabeçalho você quer ver."),
      }),
      async execute(entrada, ctx) {
        const { planilha, aba } = entrada as { planilha?: string; aba?: string };
        const { cliente, config } = contexto(ctx);

        if (!planilha) {
          const cadastradas = config.planilhas.map((p) => p.nome);
          return {
            planilhasCadastradas: cadastradas,
            comoUsar: cadastradas.length
              ? "Chame de novo informando uma destas planilhas para ver as abas e o cabeçalho."
              : "Não há planilha nenhuma cadastrada nesta instalação. Avise que falta configuração no painel — não há como você contornar isso.",
          };
        }

        const { id, nomes } = resolverCadastro(planilha, config, "planilhas");
        if (!id) return naoCadastrado(planilha, "planilhas", nomes);

        const estrutura = await cliente.estruturaDaPlanilha(id);
        const abas = (estrutura.sheets ?? []).map((s) => ({
          nome: s.properties?.title ?? "",
          // ⚠ Isto é a grade ALOCADA, não o preenchido: uma aba nova nasce com
          // 1000 linhas vazias. Sem o rótulo, o modelo lê "1000" e diz ao
          // cliente que há mil registros.
          linhasAlocadas: s.properties?.gridProperties?.rowCount ?? null,
        }));

        if (!aba) {
          return {
            planilha,
            titulo: estrutura.properties?.title ?? planilha,
            abas,
            observacao:
              "linhasAlocadas é o tamanho da grade da aba, não a quantidade de registros preenchidos.",
          };
        }

        const cabecalho = await lerCabecalho(cliente, id, aba);
        return {
          planilha,
          aba,
          cabecalho: cabecalho.filter((c) => c.trim()),
          observacao: cabecalho.some((c) => c.trim())
            ? "Use estes nomes de coluna, exatamente assim, ao gravar."
            : "Esta aba não tem cabeçalho na linha 1 — não dá para gravar por nome de coluna nela.",
        };
      },
    },

    {
      name: "google_sheets_ler_intervalo",
      categoria: "Planilhas",
      description:
        "Lê as linhas de uma aba e devolve como registros, usando a primeira linha como nome das colunas. Use para consultar o que já está gravado. A quantidade de linhas por chamada é limitada: quando a resposta vier truncada, chame de novo com daLinha igual ao proximaLinha que veio na resposta — é assim que se percorre o resto. Nunca conclua que um registro não existe sem ter chegado ao fim.",
      inputSchema: z.object({
        planilha: z.string().min(1).describe("Nome cadastrado da planilha."),
        aba: z.string().min(1).describe("Nome da aba."),
        // Faixa de LINHAS, e não notação A1 livre. Um "C1:D10" traria duas
        // colunas que seriam casadas com as duas PRIMEIRAS do cabeçalho — os
        // valores da coluna C apareceriam sob o nome da coluna A, com todo o
        // ar de resposta correta. Faixa de linhas é sempre da largura inteira,
        // então o casamento com o cabeçalho não tem como desalinhar.
        daLinha: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe("Primeira linha de dados a ler. A linha 1 é o cabeçalho."),
        ateLinha: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe("Última linha a ler. Omita para ler até o fim."),
      }),
      async execute(entrada, ctx) {
        const { planilha, aba, daLinha, ateLinha } = entrada as {
          planilha: string;
          aba: string;
          daLinha?: number;
          ateLinha?: number;
        };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(planilha, config, "planilhas");
        if (!id) return naoCadastrado(planilha, "planilhas", nomes);

        const cabecalho = await lerCabecalho(cliente, id, aba);
        if (cabecalho.filter((c) => c.trim()).length === 0) {
          return {
            erro: `A aba "${aba}" não tem cabeçalho na linha 1, então não dá para montar registros. Confira o nome da aba com a ferramenta de ver estrutura.`,
          };
        }

        // A leitura recusa pelo mesmo motivo que a escrita: com duas colunas de
        // nome equivalente, o registro montado por nome mostraria vazia uma
        // coluna preenchida — e o agente pediria ao cliente um dado que já está
        // na planilha.
        const ambiguas = nomesAmbiguos(cabecalho);
        if (ambiguas.length > 0) {
          return { erro: motivoDoCabecalho("cabecalhoAmbiguo", ambiguas, aba) };
        }

        // Sempre a partir da 2: a linha 1 é o cabeçalho, e devolvê-la como
        // registro faria o modelo ler "CPF" como o CPF de alguém.
        //
        // A faixa vai de `A` até a última coluna DO CABEÇALHO, e não `2:50`
        // aberto: assim a largura do que volta é a mesma do cabeçalho por
        // construção, e não por sorte. (`2:` sozinho nem é notação A1 válida.)
        const inicio = daLinha ?? 2;

        // A Sheets normaliza faixa invertida em silêncio: `A40:F20` vira
        // `A20:F40`. O bloco 20–40 voltaria rotulado como começando na 40, e o
        // agente diria ao cliente que o cadastro está na linha 43 quando está
        // na 23. Recusar é barato; conferir depois é impossível.
        if (ateLinha !== undefined && ateLinha < inicio) {
          return {
            erro: `A faixa está invertida: ateLinha (${ateLinha}) é menor que daLinha (${inicio}). Nada foi lido.`,
          };
        }

        const ultima = colunaParaLetra(Math.max(cabecalho.length - 1, 0));
        const faixa = `A${inicio}:${ultima}${ateLinha ?? ""}`;

        const resposta = await cliente.lerValores(id, a1(aba, faixa));
        const todas = normalizarLinhas(resposta.values, cabecalho.length);
        const cortadas = todas.slice(0, config.limiteDeLinhas);
        const truncado = todas.length > cortadas.length;

        return {
          planilha,
          aba,
          primeiraLinha: inicio,
          colunas: cabecalho.filter((c) => c.trim()),
          linhas: paraRegistros(cabecalho, cortadas),
          // `linhasDevolvidas`, e não `total`: o nome antigo sugeria o total da
          // aba, e o modelo concluía que tinha visto tudo.
          linhasDevolvidas: cortadas.length,
          truncado,
          // O ponteiro da continuação. Sem ele, "peça uma faixa menor" levava o
          // agente a reler o COMEÇO com outro tamanho, receber `truncado:
          // false` e concluir que percorreu a planilha inteira.
          ...(truncado ? { proximaLinha: inicio + cortadas.length } : {}),
        };
      },
    },

    {
      name: "google_sheets_procurar_linha",
      categoria: "Planilhas",
      description:
        "Procura uma linha pelo valor de uma coluna — por exemplo, achar o cliente pelo CPF antes de cadastrar de novo. Use SEMPRE antes de adicionar uma linha que não pode aparecer duas vezes: a planilha aceita duplicata sem reclamar e não existe desfazer. A comparação ignora pontuação, acento e maiúsculas.",
      inputSchema: z.object({
        planilha: z.string().min(1).describe("Nome cadastrado da planilha."),
        aba: z.string().min(1).describe("Nome da aba."),
        coluna: z
          .string()
          .min(1)
          .describe('Nome da coluna onde procurar, como está no cabeçalho. Ex.: "CPF".'),
        valor: z.string().min(1).describe("O valor procurado, com ou sem pontuação."),
      }),
      async execute(entrada, ctx) {
        const { planilha, aba, coluna, valor } = entrada as {
          planilha: string;
          aba: string;
          coluna: string;
          valor: string;
        };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(planilha, config, "planilhas");
        if (!id) return naoCadastrado(planilha, "planilhas", nomes);

        const achado = await localizar(cliente, id, aba, coluna, valor);
        if ("erro" in achado) return achado;

        if (achado.linhas.length === 0) {
          return { encontrado: false, ocorrencias: 0, planilha, aba };
        }

        const linha = achado.linhas[0];
        const dados = await cliente.lerValores(id, a1(aba, `${linha}:${linha}`));
        const normalizada = normalizarLinhas(dados.values, achado.cabecalho.length);

        return {
          encontrado: true,
          ocorrencias: achado.linhas.length,
          planilha,
          aba,
          dados: paraRegistros(achado.cabecalho, normalizada)[0] ?? {},
          ...(achado.linhas.length > 1
            ? {
                avisoImportante: `Há ${achado.linhas.length} linhas com esse valor nesta aba. Os dados acima são da primeira. Não presuma qual é a certa — confirme com a pessoa antes de alterar qualquer coisa.`,
              }
            : {}),
        };
      },
    },

    {
      name: "google_sheets_adicionar_linha",
      categoria: "Planilhas",
      description:
        "Acrescenta UMA linha ao final de uma aba. Informe os valores por NOME DE COLUNA: o sistema lê o cabeçalho da aba e põe cada valor no lugar certo, então a ordem em que você mandar não importa. Coluna do cabeçalho que você não informar fica em branco. Se algum nome de coluna não existir no cabeçalho, NADA é gravado e a resposta traz o cabeçalho real para você corrigir e chamar de novo. Grave datas como AAAA-MM-DD e CPF, CNPJ, telefone e CEP com os zeros à esquerda. NÃO EXISTE DESFAZER: confira os dados antes de chamar, e procure antes se a linha não puder aparecer duas vezes.",
      requiresConfirmation: true,
      inputSchema: z.object({
        planilha: z.string().min(1).describe("Nome cadastrado da planilha."),
        aba: z.string().min(1).describe("Nome da aba onde gravar."),
        dados: z
          .array(parSchema)
          .min(1)
          .describe("Os valores da linha, um item por coluna."),
      }),
      async execute(entrada, ctx) {
        const { planilha, aba, dados } = entrada as {
          planilha: string;
          aba: string;
          dados: { coluna: string; valor: string }[];
        };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(planilha, config, "planilhas");
        if (!id) return naoCadastrado(planilha, "planilhas", nomes);

        const cabecalho = await lerCabecalho(cliente, id, aba);
        const casamento = casarComCabecalho(
          cabecalho,
          dados.map((d) => ({ coluna: d.coluna, valor: cortarCelula(d.valor) })),
        );

        if (!casamento.ok) {
          // Nada gravado, e o retorno diz isso em letras claras: gravar a linha
          // pela metade e devolver sucesso faria o agente confirmar ao cliente
          // um registro que está faltando justamente o campo que ele errou.
          return {
            gravado: false,
            nadaFoiAlterado: true,
            planilha,
            aba,
            erro: motivoDoCabecalho(casamento.motivo, casamento.problematicas, aba),
            cabecalhoReal: cabecalho.filter((c) => c.trim()),
          };
        }

        const ultimaColuna = colunaParaLetra(cabecalho.length - 1);

        let resposta: { updates?: { updatedRange?: string } };
        try {
          resposta = await cliente.acrescentarLinha(
            id,
            aba,
            casamento.linha,
            ultimaColuna,
          );
        } catch (erro) {
          return escritaIndeterminada(erro, {
            planilha,
            aba,
            oQueFazer:
              "Use a ferramenta de procurar linha para conferir se ela entrou antes de qualquer nova tentativa.",
          });
        }

        // Onde caiu de VERDADE, lido da resposta do Google — o `range` que
        // mandamos é onde procurar a tabela, não onde escrever.
        const faixa = resposta.updates?.updatedRange ?? null;

        return {
          gravado: true,
          planilha,
          aba,
          linha: faixa,
          colunasGravadas: casamento.gravadas,
          // Última defesa contra o deslocamento: a faixa escrita tem de começar
          // na coluna A. Se a Sheets detectou a tabela a partir de outra
          // coluna, os valores saíram de lugar e o único jeito de saber é este.
          ...(faixa && !/![A-Z]*A\d/.test(faixa)
            ? {
                avisoImportante: `A linha foi gravada em ${faixa}, que não começa na coluna A como esperado — os valores podem ter saído deslocados. Avise que uma pessoa precisa conferir esta linha na planilha.`,
              }
            : {}),
        };
      },
    },

    {
      name: "google_sheets_atualizar_linha",
      categoria: "Planilhas",
      description:
        "Corrige ou completa uma linha que já existe. Você identifica a linha pelo valor de uma coluna (por exemplo o CPF), não pelo número dela — o sistema localiza na hora e recusa se achar nenhuma ou mais de uma. Só as colunas que você informar mudam; as outras ficam como estão. Use isto em vez de gravar uma segunda linha do mesmo cliente. NÃO EXISTE DESFAZER.",
      requiresConfirmation: true,
      inputSchema: z.object({
        planilha: z.string().min(1).describe("Nome cadastrado da planilha."),
        aba: z.string().min(1).describe("Nome da aba."),
        colunaChave: z
          .string()
          .min(1)
          .describe('Coluna que identifica a linha, como no cabeçalho. Ex.: "CPF".'),
        valorChave: z
          .string()
          .min(1)
          .describe("O valor que identifica a linha a alterar."),
        dados: z
          .array(parSchema)
          .min(1)
          .describe("As colunas a alterar, e os novos valores."),
      }),
      async execute(entrada, ctx) {
        const { planilha, aba, colunaChave, valorChave, dados } = entrada as {
          planilha: string;
          aba: string;
          colunaChave: string;
          valorChave: string;
          dados: { coluna: string; valor: string }[];
        };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(planilha, config, "planilhas");
        if (!id) return naoCadastrado(planilha, "planilhas", nomes);

        const achado = await localizar(cliente, id, aba, colunaChave, valorChave);
        if ("erro" in achado) return achado;

        // ⚠ Localizar aqui dentro, e não aceitar o número da linha do modelo,
        // é o que impede a pior falha desta integração. O histórico que o
        // modelo recebe é texto puro — nenhuma chamada de ferramenta anterior
        // chega até ele —, então num turno seguinte ele só poderia CHUTAR o
        // número. E um humano que insira ou remova uma linha entre a busca e a
        // escrita desloca tudo. Nos dois casos o resultado é sobrescrever o
        // registro de outra pessoa, com `200` de resposta.
        if (achado.linhas.length === 0) {
          return {
            atualizado: false,
            nadaFoiAlterado: true,
            erro: `Não achei nenhuma linha com ${colunaChave} = "${valorChave}" na aba "${aba}". Confira o valor, ou use a ferramenta de adicionar linha se o registro ainda não existir.`,
          };
        }

        if (achado.linhas.length > 1) {
          return {
            atualizado: false,
            nadaFoiAlterado: true,
            erro: `Achei ${achado.linhas.length} linhas com ${colunaChave} = "${valorChave}" (linhas ${achado.linhas.join(
              ", ",
            )}). Não vou alterar nenhuma no escuro. Avise que há registros duplicados e peça que uma pessoa resolva.`,
          };
        }

        const posicoes = posicoesDasColunas(
          achado.cabecalho,
          dados.map((d) => ({ coluna: d.coluna, valor: cortarCelula(d.valor) })),
        );
        if (!posicoes.ok) {
          return {
            atualizado: false,
            nadaFoiAlterado: true,
            erro: motivoDoCabecalho(posicoes.motivo, posicoes.problematicas, aba),
            cabecalhoReal: achado.cabecalho.filter((c) => c.trim()),
          };
        }

        const linha = achado.linhas[0];
        // Célula a célula: um `values.update` da faixa inteira apagaria todas
        // as colunas que o agente não informou.
        try {
          await cliente.atualizarCelulas(
            id,
            posicoes.alvos.map((alvo) => ({
              range: a1(aba, `${alvo.letra}${linha}`),
              values: [[alvo.valor]],
            })),
          );
        } catch (erro) {
          return escritaIndeterminada(erro, {
            planilha,
            aba,
            linha,
            oQueFazer: `Use a ferramenta de procurar linha com ${colunaChave} = "${valorChave}" para conferir o que está gravado antes de qualquer nova tentativa.`,
          });
        }

        return {
          atualizado: true,
          planilha,
          aba,
          linha,
          colunasAtualizadas: posicoes.alvos.map((a) => a.coluna),
        };
      },
    },

    // ─── Documentos do Google ───────────────────────────────────────────────
    {
      name: "google_docs_ler",
      categoria: "Documentos do Google",
      description:
        "Lê um documento do Google Docs cadastrado e devolve o texto puro, incluindo o conteúdo das tabelas. Use para consultar um procedimento interno, um modelo de resposta ou os termos de um contrato. Formatação, imagens e comentários não vêm.",
      inputSchema: z.object({
        documento: z.string().min(1).describe("Nome cadastrado do documento."),
      }),
      async execute(entrada, ctx) {
        const { documento } = entrada as { documento: string };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(documento, config, "documentos");
        if (!id) return naoCadastrado(documento, "documentos", nomes);

        const bruto = await cliente.lerDocumento(id);
        const texto = textoDoDocumento(bruto);

        return {
          documento,
          titulo: bruto.title ?? documento,
          texto:
            texto.length > TETO_DE_TEXTO
              ? `${texto.slice(0, TETO_DE_TEXTO)}\n[…texto cortado: o documento é maior do que cabe aqui]`
              : texto,
          truncado: texto.length > TETO_DE_TEXTO,
        };
      },
    },

    {
      name: "google_docs_criar_de_modelo",
      categoria: "Documentos do Google",
      description:
        "Gera um documento novo a partir de um modelo cadastrado, trocando os campos escritos entre chaves duplas pelos valores informados, e devolve o link. Chame PRIMEIRO só com o modelo, sem os campos, para ver quais campos ele pede — nada é criado nessa chamada. Depois chame de novo com todos eles: campo do modelo que você deixar de informar sai impresso como {{assim}} no documento. Se algum campo que você informou não existir no modelo, nada é gerado. NÃO EXISTE DESFAZER — o documento criado não pode ser apagado por aqui.",
      requiresConfirmation: true,
      inputSchema: z.object({
        modelo: z.string().min(1).describe("Nome cadastrado do modelo."),
        nome: z
          .string()
          .min(3)
          .optional()
          .describe(
            "Nome do documento que será criado. Omita, junto com os campos, para só consultar os campos do modelo.",
          ),
        campos: z
          .array(
            z.object({
              campo: z
                .string()
                .min(1)
                .describe(
                  'Nome do campo SEM as chaves, como veio da consulta ao modelo. Ex.: "cliente".',
                ),
              valor: z.string(),
            }),
          )
          .optional()
          .describe(
            "Os valores que substituem os campos do modelo. Omita para só consultar quais campos existem.",
          ),
        pasta: z
          .string()
          .optional()
          .describe("Nome cadastrado da pasta de destino. Omita para usar a padrão."),
      }),
      async execute(entrada, ctx) {
        const { modelo, nome, campos, pasta } = entrada as {
          modelo: string;
          nome?: string;
          campos?: { campo: string; valor: string }[];
          pasta?: string;
        };
        const { cliente, config } = contexto(ctx);

        const alvo = resolverCadastro(modelo, config, "modelos");
        if (!alvo.id) return naoCadastrado(modelo, "modelos", alvo.nomes);

        // ⚠ Ler o modelo ANTES de qualquer coisa. Se a conferência viesse
        // depois do `files.copy`, o documento já existiria, o erro voltaria ao
        // modelo como resultado normal, ele corrigiria e chamaria de novo — e
        // cada tentativa deixaria no Drive um documento órfão com `{{campo}}`
        // impresso, que nenhuma tool apaga.
        const original = await cliente.lerDocumento(alvo.id);
        const disponiveis = camposDoModelo(textoDoDocumento(original));

        // Consulta: sem campos não há o que preencher, e criar um documento com
        // todos os marcadores crus seria o pior desfecho possível. Esta é a
        // porta que o agente usa para descobrir o que o modelo pede — o
        // equivalente ao `zapsign_ver_modelo`, aqui embutido para não custar
        // uma tool inteira no prompt de todo agente.
        if (!campos || campos.length === 0 || !nome) {
          return {
            criado: false,
            nadaFoiAlterado: true,
            modelo,
            camposDoModelo: disponiveis.map((d) => d.nome),
            comoUsar:
              "Chame de novo com o nome do documento e um valor para CADA um destes campos. Campo que ficar de fora sai impresso como {{assim}} no documento final.",
          };
        }

        let pastaId = config.driveCompartilhadoId || undefined;
        if (pasta) {
          const achada = resolverCadastro(pasta, config, "pastas");
          if (!achada.id) return naoCadastrado(pasta, "pastas", achada.nomes);
          pastaId = achada.id;
        }

        if (!pastaId) {
          // Falha antes de gastar chamada: sem Drive compartilhado o `copy`
          // devolveria `403 storageQuotaExceeded`, e essa mensagem não diz a um
          // modelo — nem a um operador — o que precisa ser feito.
          return {
            criado: false,
            nadaFoiAlterado: true,
            erro: "Não há pasta de destino configurada para arquivos novos. Uma conta de serviço não pode ser dona de arquivo, então criar documento exige um Drive compartilhado cadastrado na configuração da integração. Avise que essa configuração está faltando — não é algo que você possa resolver.",
          };
        }

        // Casa o pedido do agente com o campo do modelo pelo NOME (tolerante a
        // caixa e acento), mas guarda o LITERAL para a substituição — que é
        // exata e com `matchCase`. Conferir por um e substituir pelo outro era
        // o defeito que a ordem da checagem existia para impedir e não impedia:
        // um modelo escrito `{{ Cliente }}` aprovava o pedido `cliente`,
        // copiava o arquivo, e trocava zero ocorrências.
        const pedidos = campos.map((c) => ({
          ...c,
          alvo: disponiveis.find((d) => normalizarNome(d.nome) === normalizarNome(c.campo)),
        }));

        const faltando = pedidos.filter((p) => !p.alvo).map((p) => p.campo);
        if (faltando.length > 0) {
          return {
            criado: false,
            nadaFoiAlterado: true,
            erro: `O modelo "${modelo}" não tem estes campos: ${faltando.join(
              ", ",
            )}. Nada foi criado. Use exatamente os campos abaixo.`,
            camposDoModelo: disponiveis.map((d) => d.nome),
          };
        }

        // ⚠ E o caminho inverso, que é o mais provável: campo que EXISTE no
        // modelo e o agente não informou. Ele sai impresso como `{{Vigência}}`
        // no contrato, com `occurrencesChanged` nem sendo consultado (não há
        // request para ele), e o retorno anterior dizia `criado: true` sem
        // ressalva nenhuma — o agente confirmava um contrato pronto que não
        // estava. Recusa antes de copiar, como o outro lado.
        const naoInformados = disponiveis
          .filter(
            (d) => !pedidos.some((p) => normalizarNome(p.campo) === normalizarNome(d.nome)),
          )
          .map((d) => d.nome);

        if (naoInformados.length > 0) {
          return {
            criado: false,
            nadaFoiAlterado: true,
            erro: `Faltou valor para estes campos do modelo: ${naoInformados.join(
              ", ",
            )}. Nada foi criado — um documento com o campo cru impresso é pior que nenhum. Informe TODOS os campos e chame de novo; se você não tiver algum desses dados, pergunte antes.`,
            camposDoModelo: disponiveis.map((d) => d.nome),
          };
        }

        const copia = await cliente.copiarArquivo(alvo.id, nome, pastaId);

        const respostas = await cliente.atualizarDocumento(
          copia.id,
          pedidos.map((p) => ({
            replaceAllText: {
              // O literal do modelo, não `{{${p.campo}}}` remontado.
              // `replaceAllText` sem `tabId` vale para TODAS as abas — que é o
              // que se quer aqui, ao contrário do `insertText`.
              containsText: { text: p.alvo!.literal, matchCase: true },
              replaceText: p.valor,
            },
          })),
        );

        // `occurrencesChanged: 0` volta com HTTP 200. Com o literal certo isso
        // não deveria acontecer, mas continua conferido: o documento já existe
        // quando esta linha roda, e um contrato com campo cru impresso é pior
        // que nenhum.
        const naoTrocados = pedidos
          .filter(
            (_, i) =>
              (respostas.replies?.[i]?.replaceAllText?.occurrencesChanged ?? 0) === 0,
          )
          .map((p) => p.campo);

        return {
          criado: true,
          documentoId: copia.id,
          nome: copia.name,
          // Link INTERNO: o arquivo nasce num Drive compartilhado e não existe
          // tool de compartilhamento. Mandar isto ao cliente faz ele ver "Você
          // precisa de acesso" — o nome do campo diz isso ao modelo.
          linkInterno: copia.webViewLink ?? null,
          camposSubstituidos: pedidos.length - naoTrocados.length,
          ...(naoTrocados.length > 0
            ? {
                avisoImportante: `O documento foi criado, mas estes campos NÃO foram encontrados no texto e ficaram impressos como estavam: ${naoTrocados.join(
                  ", ",
                )}. Não diga que o documento está completo — avise que ele precisa de revisão humana antes de ir para o cliente.`,
              }
            : {}),
        };
      },
    },

    {
      name: "google_docs_anexar_texto",
      categoria: "Documentos do Google",
      description:
        "Acrescenta um parágrafo ao FINAL de um documento cadastrado. Use para registrar em ata, log ou lista de ocorrências. O texto vai sempre no fim: esta ferramenta não altera, não apaga e não escreve no meio do que já está escrito.",
      requiresConfirmation: true,
      inputSchema: z.object({
        documento: z.string().min(1).describe("Nome cadastrado do documento."),
        texto: z.string().min(1).describe("O parágrafo a acrescentar."),
      }),
      async execute(entrada, ctx) {
        const { documento, texto } = entrada as {
          documento: string;
          texto: string;
        };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(documento, config, "documentos");
        if (!id) return naoCadastrado(documento, "documentos", nomes);

        // ⚠ Documento com mais de uma aba: RECUSA, não escolhe.
        //
        // `endOfSegmentLocation` sem `tabId` aplica a requisição à PRIMEIRA
        // aba, e `insertText` não está entre as três requisições que valem
        // para todas (só `replaceAllText`, `deleteNamedRange` e
        // `replaceNamedRangeContent` são). Numa ata com abas `2025` e `2026`,
        // a ocorrência de hoje seria gravada no fim do arquivo morto, com
        // `anexado: true` e uma descrição de tool afirmando "ao FINAL do
        // documento". Ninguém descobriria.
        //
        // Escolher a última aba sozinho seria adivinhar: "o final" de um
        // documento com abas não é uma coisa só. Recusar nomeando as abas é o
        // desfecho honesto — e o custo é a leitura a mais, no mesmo turno.
        const bruto = await cliente.lerDocumento(id);
        const abas = (bruto.tabs ?? []).length;
        if (abas > 1) {
          return {
            anexado: false,
            nadaFoiAlterado: true,
            erro: `O documento "${documento}" tem ${abas} abas, e esta ferramenta não sabe em qual escrever — escrever na errada seria pior que não escrever. Avise que este documento precisa ser editado por uma pessoa, ou que a equipe cadastre um documento de aba única para o registro.`,
          };
        }

        // ⚠ `endOfSegmentLocation`, e nunca um `index` calculado. Os índices do
        // Docs são UTF-16 e cascateiam: toda inserção desloca os maiores, e um
        // índice calculado antes da requisição já está errado quando ela chega.
        // Aqui não há cálculo nenhum — o Google resolve o fim do segmento.
        try {
          await cliente.atualizarDocumento(id, [
            {
              insertText: {
                text: `\n${texto}`,
                endOfSegmentLocation: {},
              },
            },
          ]);
        } catch (erro) {
          return escritaIndeterminada(erro, {
            documento,
            oQueFazer:
              "Use a ferramenta de ler documento para conferir se o parágrafo entrou antes de qualquer nova tentativa.",
          });
        }

        return { anexado: true, documento, caracteres: texto.length };
      },
    },

    // ─── Arquivos e pastas ──────────────────────────────────────────────────
    {
      name: "google_drive_listar_pasta",
      categoria: "Arquivos e pastas",
      description:
        "Lista o que existe numa pasta cadastrada do Drive: nome, tipo, tamanho, data da última alteração e link. Mostra só o primeiro nível — o conteúdo de uma subpasta não aparece aqui.",
      inputSchema: z.object({
        pasta: z.string().min(1).describe("Nome cadastrado da pasta."),
        tipo: z
          .enum(["tudo", "pastas", "planilhas", "documentos"])
          .optional()
          .describe("Filtra o que trazer. Omita para trazer tudo."),
      }),
      async execute(entrada, ctx) {
        const { pasta, tipo } = entrada as {
          pasta: string;
          tipo?: "tudo" | "pastas" | "planilhas" | "documentos";
        };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(pasta, config, "pastas");
        if (!id) return naoCadastrado(pasta, "pastas", nomes);

        const filtro = MIME_POR_TIPO[tipo ?? "tudo"];
        const q = [
          `'${literalDaQuery(id)}' in parents`,
          // Sem isto a lixeira aparece na listagem como se fosse conteúdo vivo.
          "trashed = false",
          ...(filtro ? [`mimeType = '${filtro}'`] : []),
        ].join(" and ");

        const resposta = await cliente.listarArquivos(q, config.limiteDeLinhas);
        return {
          pasta,
          itens: (resposta.files ?? []).map(formatarArquivo),
          total: resposta.files?.length ?? 0,
          // `nextPageToken` presente = havia mais, e não trouxemos. Dizer isso
          // é o que impede o modelo de afirmar que a pasta só tem isso.
          truncado: Boolean(resposta.nextPageToken),
        };
      },
    },

    {
      name: "google_drive_buscar_arquivo",
      categoria: "Arquivos e pastas",
      description:
        "Procura arquivos pelo COMEÇO do nome, dentro de uma pasta cadastrada. ATENÇÃO: a busca do Google casa o início do nome, não um pedaço do meio — procurar por \"contrato\" acha \"Contrato da Ana\" e NÃO acha \"Modelo de contrato\". E procura só no primeiro nível da pasta, não nas subpastas. Se não achar, tente a primeira palavra do nome ou liste a pasta inteira.",
      inputSchema: z.object({
        termo: z.string().min(2).describe("O começo do nome do arquivo."),
        pasta: z.string().min(1).describe("Nome cadastrado da pasta onde procurar."),
      }),
      async execute(entrada, ctx) {
        const { termo, pasta } = entrada as { termo: string; pasta: string };
        const { cliente, config } = contexto(ctx);

        const { id, nomes } = resolverCadastro(pasta, config, "pastas");
        if (!id) return naoCadastrado(pasta, "pastas", nomes);

        const q = [
          `'${literalDaQuery(id)}' in parents`,
          "trashed = false",
          `name contains '${literalDaQuery(termo)}'`,
        ].join(" and ");

        const resposta = await cliente.listarArquivos(q, config.limiteDeLinhas);
        const itens = (resposta.files ?? []).map(formatarArquivo);

        return {
          termo,
          pasta,
          itens,
          total: itens.length,
          truncado: Boolean(resposta.nextPageToken),
          ...(itens.length === 0
            ? {
                observacao:
                  "Nada encontrado. Lembre que a busca casa o COMEÇO do nome — tente a primeira palavra, ou liste a pasta.",
              }
            : {}),
        };
      },
    },
  ],
};

/**
 * Escapa um valor para dentro de um literal da query do Drive.
 *
 * ⚠ A barra invertida vem PRIMEIRO. Inverter a ordem faria o segundo `replace`
 * escapar a barra que o primeiro acabou de inserir, dobrando-a. A documentação
 * de busca do Drive manda escapar os dois caracteres; escapar só a aspa faz um
 * nome com barra virar sintaxe inválida e o Google devolver `400` — o modelo
 * queima uma iteração e o cliente ouve "tive um problema" em vez de "não
 * achei".
 */
function literalDaQuery(valor: string): string {
  return valor.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const MIME_POR_TIPO: Record<string, string | null> = {
  tudo: null,
  pastas: "application/vnd.google-apps.folder",
  planilhas: "application/vnd.google-apps.spreadsheet",
  documentos: "application/vnd.google-apps.document",
};

const ROTULO_MIME: Record<string, string> = {
  "application/vnd.google-apps.folder": "pasta",
  "application/vnd.google-apps.spreadsheet": "planilha",
  "application/vnd.google-apps.document": "documento",
  "application/vnd.google-apps.presentation": "apresentação",
  "application/pdf": "PDF",
};

function formatarArquivo(a: {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}) {
  return {
    nome: a.name,
    tipo: ROTULO_MIME[a.mimeType] ?? a.mimeType,
    // O id vai no retorno, mas nenhuma tool o aceita de volta — é informação
    // para uma pessoa que vá cadastrar o arquivo, não atalho para o modelo.
    id: a.id,
    tamanhoBytes: a.size ? Number(a.size) : null,
    alteradoEm: a.modifiedTime ?? null,
    // INTERNO: só quem tem acesso ao Drive da Seahub abre. Mandar ao cliente
    // faz ele ver "Você precisa de acesso" — e não existe tool de
    // compartilhamento para consertar isso depois. O nome do campo é o que diz
    // isso ao modelo.
    linkInterno: a.webViewLink ?? null,
  };
}

/**
 * Acha em que linha está o valor procurado numa coluna.
 *
 * Compartilhado entre procurar e atualizar de propósito: as duas precisam da
 * MESMA conta de deslocamento entre índice do array e número da linha, e é
 * exatamente o tipo de conta que diverge quando é escrita duas vezes.
 */
async function localizar(
  cliente: GoogleClient,
  planilhaId: string,
  aba: string,
  coluna: string,
  valor: string,
): Promise<
  { cabecalho: string[]; linhas: number[] } | { erro: string; cabecalhoReal?: string[] }
> {
  const cabecalho = await lerCabecalho(cliente, planilhaId, aba);
  const posicoes = posicoesDasColunas(cabecalho, [{ coluna, valor: "" }]);

  if (!posicoes.ok) {
    return {
      erro: `A coluna "${coluna}" não existe no cabeçalho da aba "${aba}".`,
      cabecalhoReal: cabecalho.filter((c) => c.trim()),
    };
  }

  const letra = posicoes.alvos[0].letra;
  // A partir da linha 2: a 1 é o cabeçalho. É esse `2` que vira o número da
  // linha real lá embaixo — ler a coluna inteira e somar 1 daria o vizinho.
  const resposta = await cliente.lerValores(planilhaId, a1(aba, `${letra}2:${letra}`), {
    porColuna: true,
  });

  // ⚠ `majorDimension=COLUMNS` devolve UM array com a coluna inteira. Sem ele
  // viriam mil arrays de um elemento, e o `[0]` pegaria só a primeira célula.
  const valores = (resposta.values?.[0] ?? []).map((c) =>
    c === null || c === undefined ? "" : String(c),
  );

  return { cabecalho, linhas: procurarNaColuna(valores, valor, 2) };
}
