import { z } from "zod";
import { IntegrationProvider, RunSource } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import type { ChatwootClient, MacroChatwoot } from "../chatwoot/client";
import { clienteDeLeitura, clienteDoAgente } from "../chatwoot/credenciais";
import { humanidadeDoDono, podeAgir } from "../chatwoot/regras";
import { baixarArquivo, mesmaOrigem } from "../openai/client";
import {
  escolherMaterial,
  lerPrefixos,
  limitarPassos,
  materiaisDisponiveis,
  PREFIXOS_PADRAO,
  textoComVariavel,
  type Material,
} from "@/server/materiais/macros";

/**
 * Materiais prontos — o agente manda ao cliente as imagens de um macro do
 * Chatwoot (`materiais/macros.ts` explica de onde vêm e por quê).
 *
 * Provider próprio, e não tool a mais do Chatwoot, pelo mesmo motivo dos
 * Prazos: tool nova no Chatwoot aparece para todo agente com as ferramentas
 * dele liberadas, e mandar arquivo ao cliente tem de ser escolha de quem
 * configura o agente.
 *
 * ⚠ O macro NÃO é executado. Pela API, a execução sairia em nome da pessoa dona
 * do token — e mensagem de `user` na conversa conta como "a equipe respondeu"
 * para os prazos, o NPS e a janela — e rodaria o resto do macro (atribuir,
 * etiquetar, mandar texto). Aqui só os arquivos saem, pelo robô da conversa.
 */

export const configMateriaisSchema = z.object({
  /** Só macros cujo nome começa por um destes prefixos viram material. */
  prefixos: z.unknown().optional().transform(lerPrefixos),
});

/** Teto por arquivo: as imagens dos macros de sala têm de 1 a 5 MB. */
const LIMITE_MB = 16;

/**
 * Cache dos macros na memória do processo: são 120 e poucos, a resposta passa
 * de 250 KB, e a lista muda quando a equipe mexe num macro — raro.
 */
const CACHE_MS = 5 * 60 * 1000;
let cache: { chave: string; em: number; macros: MacroChatwoot[] } | null = null;

async function macrosDaConta(cliente: ChatwootClient): Promise<MacroChatwoot[]> {
  const chave = `${cliente.baseUrl}#${cliente.contaId}`;
  if (cache && cache.chave === chave && Date.now() - cache.em < CACHE_MS) return cache.macros;
  const macros = await cliente.listarMacros();
  cache = { chave, em: Date.now(), macros };
  return macros;
}

/** Só para teste: esquece o cache entre um caso e outro. */
export function esquecerMacros() {
  cache = null;
}

/** Os materiais liberados hoje. A tela de Integrações mostra a mesma lista. */
export async function listarMateriais(prefixos: string[]): Promise<Material[]> {
  const leitura = await clienteDeLeitura();
  if (!leitura) {
    throw new Error(
      "Sem o token de leitura do Chatwoot (Integrações → Chatwoot), não dá para ler os macros.",
    );
  }
  return materiaisDisponiveis(await macrosDaConta(leitura.cliente), prefixos);
}

function listaParaOModelo(materiais: Material[]) {
  return materiais.map((m) => ({ material: m.nome, imagens: m.arquivos.length }));
}

export const materiaisIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.MATERIAIS,
  label: "Fotos e materiais prontos",
  descricao:
    "O agente manda ao cliente as imagens dos macros do Chatwoot — capa e fotos das salas, formatos do auditório, catálogos — pelo robô da conversa.",
  configSchema: configMateriaisSchema,
  credentialLabel: null,

  async testarConexao(ctx) {
    const { prefixos } = configMateriaisSchema.parse(ctx.config);
    try {
      const materiais = await listarMateriais(prefixos);
      return {
        ok: materiais.length > 0,
        mensagem: materiais.length
          ? `${materiais.length} material(is) liberado(s) nos macros do Chatwoot.`
          : "Nenhum macro global com anexo começa pelos prefixos configurados.",
      };
    } catch (erro) {
      return { ok: false, mensagem: erro instanceof Error ? erro.message : String(erro) };
    }
  },

  tools: [
    {
      name: "materiais_enviar",
      categoria: "Materiais",
      description:
        "Manda ao cliente, no WhatsApp, as imagens (ou o arquivo) de um material pronto da equipe: capa e fotos de cada sala, formatos do auditório, catálogo de valores. Chame SEM material para ver a lista do que existe; depois, com o nome. Sai também o texto que a equipe escreveu no macro (ex.: pacotes de horas do catálogo): não o repita nem refaça os valores. Tudo sai na hora, antes do seu texto — no texto, só comente o que foi enviado. Não mande de novo o que já foi enviado nesta conversa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        material: z
          .string()
          .optional()
          .describe("O nome do material, como a lista devolve. Omita para ver a lista."),
      }),
      async execute(entrada, ctx) {
        const { material } = entrada as { material?: string };
        const { prefixos } = configMateriaisSchema.parse(ctx.config);

        if (!prefixos.length) {
          return {
            enviado: false,
            erro: "Nenhum material está liberado na configuração (Integrações → Materiais). Não há como mandar imagem por aqui: siga sem ela.",
          };
        }

        let materiais: Material[];
        try {
          materiais = await listarMateriais(prefixos);
        } catch (erro) {
          return {
            enviado: false,
            erro: `Não consegui ler os materiais: ${erro instanceof Error ? erro.message : String(erro)}`,
            comoSeguir: "Siga sem as imagens; se o cliente insistir, encaminhe para a equipe.",
          };
        }

        // ⚠ Lista vazia é falta de configuração, não "não existe": sem isto o
        // modelo chutaria nomes até o teto de etapas.
        if (!materiais.length) {
          return {
            enviado: false,
            erro: "Nenhum macro global do Chatwoot com imagem começa pelos prefixos configurados. Falta configuração: siga sem as imagens.",
          };
        }

        if (!material?.trim()) return { materiais: listaParaOModelo(materiais) };

        const escolha = escolherMaterial(material, materiais);
        if (escolha.tipo === "nenhum") {
          return {
            enviado: false,
            erro: `Não há material chamado "${material}".`,
            materiais: listaParaOModelo(materiais),
          };
        }
        if (escolha.tipo === "ambiguo") {
          return {
            enviado: false,
            erro: `"${material}" corresponde a mais de um material. Chame de novo com o nome exato de um deles.`,
            candidatos: escolha.candidatos,
          };
        }

        const escolhido = escolha.material;
        const passos = limitarPassos(escolhido.passos);
        const arquivos = passos.flatMap((p) => (p.tipo === "arquivo" ? [p.arquivo] : []));
        const nomes = arquivos.map((a) => a.nome);
        const textos = passos.flatMap((p) => (p.tipo === "texto" ? [p.texto] : []));

        const forma = ondeManda(ctx);
        if (forma === "simular") {
          return {
            enviado: false,
            simulacao: true,
            material: escolhido.nome,
            arquivos: nomes,
            ...(textos.length ? { textos } : {}),
            observacao:
              "No playground nada é enviado. Num atendimento, estas imagens (e o texto da equipe, se houver) chegariam ao cliente agora, antes do seu texto.",
          };
        }
        if (forma === "semConversa") {
          return {
            enviado: false,
            erro: "Só dá para mandar imagem ao cliente numa conversa do Chatwoot — nada foi enviado.",
          };
        }

        // O modelo repete chamada, e o proxy chegou a duplicar pedidos: no mesmo
        // turno, o mesmo material sai uma vez só.
        const jaEnviados = ctx.sinais ? (ctx.sinais.materiaisEnviados ??= []) : [];
        if (jaEnviados.includes(escolhido.id)) {
          return {
            enviado: false,
            jaEnviado: true,
            observacao: "Este material já foi enviado neste turno. Não chame de novo.",
          };
        }

        const porta = ctx.canalAgentId ?? ctx.agentId;
        const robo = await clienteDoAgente(porta);
        if (!robo) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }
        const conversa = ctx.chatwootConversationId!;

        // Mesma régua de toda resposta: com uma pessoa dona da conversa, ou com
        // ela resolvida, o robô não fala — nem com imagem.
        const aoVivo = await robo.obterConversa(conversa);
        const veredito = podeAgir({
          status: aoVivo.status,
          assigneeId: aoVivo.assigneeId,
          donoEhHumano: humanidadeDoDono(aoVivo.assigneeTipo),
        });
        if (!veredito.pode) {
          return {
            enviado: false,
            erro: `A conversa não está com o robô agora (${veredito.motivo}) — nada foi enviado.`,
          };
        }

        const enviados: string[] = [];
        let textosEnviados = 0;
        const textosPulados: string[] = [];
        // Na ordem do macro: é assim que a equipe manda (o catálogo abre com o
        // texto dos pacotes e fecha com a imagem da tabela).
        for (const passo of passos) {
          if (passo.tipo === "texto") {
            // ⚠ Texto com variável do Chatwoot sairia com as chaves à mostra.
            if (textoComVariavel(passo.texto)) {
              textosPulados.push(passo.texto.slice(0, 60));
              continue;
            }
            try {
              await robo.enviarMensagem(conversa, passo.texto);
              textosEnviados++;
              if (ctx.sinais) ctx.sinais.avisouCliente = true;
            } catch (erro) {
              const motivo = erro instanceof Error ? erro.message : String(erro);
              if (enviados.length || textosEnviados) jaEnviados.push(escolhido.id);
              return {
                enviado: enviados.length > 0 || textosEnviados > 0,
                material: escolhido.nome,
                ...(enviados.length ? { enviados } : {}),
                erro: `Falhei ao mandar o texto do macro: ${motivo.slice(0, 200)}`,
                comoSeguir:
                  enviados.length || textosEnviados
                    ? "Parte do material chegou ao cliente. Não chame de novo; diga que a equipe manda o resto se ele precisar."
                    : "Nada chegou ao cliente. Não tente de novo agora; siga sem o material.",
              };
            }
            continue;
          }
          const arquivo = passo.arquivo;
          try {
            // O endereço vem do macro, mas só se baixa da própria instância.
            if (!mesmaOrigem(arquivo.url, robo.baseUrl)) {
              throw new Error("o arquivo não está no Chatwoot");
            }
            const baixado = await baixarArquivo(arquivo.url, { limiteMb: LIMITE_MB });
            await robo.enviarArquivo(conversa, {
              nome: arquivo.nome,
              tipo: arquivo.tipo || baixado.mimeType,
              bytes: baixado.bytes,
            });
            enviados.push(arquivo.nome);
            // O cliente recebeu algo neste turno: a rede de segurança não
            // dispara, e o turno não é refeito (reenviaria as imagens).
            if (ctx.sinais) ctx.sinais.avisouCliente = true;
          } catch (erro) {
            const motivo = erro instanceof Error ? erro.message : String(erro);
            if (enviados.length || textosEnviados) jaEnviados.push(escolhido.id);
            return {
              enviado: enviados.length > 0 || textosEnviados > 0,
              material: escolhido.nome,
              ...(enviados.length ? { enviados } : {}),
              erro: `Falhei ao mandar "${arquivo.nome}": ${motivo.slice(0, 200)}`,
              comoSeguir:
                enviados.length || textosEnviados
                  ? "Parte do material chegou ao cliente. Não chame de novo; diga que a equipe manda o resto se ele precisar."
                  : "Nada chegou ao cliente. Não tente de novo agora; siga sem as imagens.",
            };
          }
        }

        jaEnviados.push(escolhido.id);
        return {
          enviado: true,
          material: escolhido.nome,
          enviados,
          ...(textosEnviados ? { textosEnviados } : {}),
          ...(textosPulados.length
            ? { textosPulados, avisoDosTextos: "Parte do texto do macro não saiu (tem variável do Chatwoot). Não invente o conteúdo: diga que a equipe confirma o restante." }
            : {}),
          observacao: textosEnviados
            ? "As imagens e o texto da equipe já chegaram ao cliente, antes do seu texto. Não repita nem refaça os valores; no texto, comente em uma linha o que foi enviado. Não chame de novo para o mesmo material."
            : "As imagens já chegaram ao cliente, antes do seu texto. No texto, comente em uma linha o que foi enviado; não chame de novo para o mesmo material.",
        };
      },
    },
  ],
};

/** Onde a imagem pode sair: numa conversa do Chatwoot, simulada no playground. */
function ondeManda(ctx: ToolContext): "enviar" | "simular" | "semConversa" {
  if (ctx.source === RunSource.PLAYGROUND) return "simular";
  if (ctx.source === RunSource.CHATWOOT && ctx.chatwootConversationId) return "enviar";
  return "semConversa";
}

export { PREFIXOS_PADRAO };
