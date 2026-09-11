import { z } from "zod";
import { db } from "@/lib/db";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { EFFORTS, normalizarEffort } from "@/server/agents/catalogo";
import { MODOS_DE_CAIXA } from "@/server/agents/equipe";
import { pedirParadaDaExecucao } from "@/server/execucoes/parada";
import { definirAgendamento } from "@/server/gestao/agendamentos";
import {
  arquivar,
  atualizarAgente,
  criarAgente,
  definirAtivo,
  definirEntrada,
  restaurar,
  type DadosDoAgente,
} from "@/server/gestao/agentes";
import { salvarEscopo } from "@/server/gestao/escopo";
import { definirGatilho } from "@/server/gestao/gatilho";
import {
  definirFerramentasDoAgente,
  definirIntegracaoDoAgente,
  definirIntegracaoGlobal,
} from "@/server/gestao/integracoes";
import { obterIntegracao } from "@/server/integrations/registry";
import { resolverToolsDoAgente } from "@/server/integrations/resolve";
import { conferirCitacoes } from "../citacoes";
import { contarMudancas, diffPorLinha, formatarDiff } from "../diff";
import { ferramenta, type FerramentaMcp } from "../executor";
import { recusar, responder } from "../formato";
import { aplicarAlteracao, carimbo, type Alteracao } from "../prompt";
import {
  acharAgente,
  agenteNaoEncontrado,
  autorDoMcp,
  campoAgente,
  camposEmPortugues,
  nomesDoCatalogo,
  traduzirDesfecho,
} from "./comum";

/**
 * Ferramentas que alteram produção. Todas exigem Administrador, e todas chamam
 * os MESMOS serviços do painel (`server/gestao/`) — nenhuma regra de negócio é
 * reescrita aqui. O que existe aqui é só o que o painel não precisa: fundir a
 * alteração parcial com o estado atual, e recusar em voz alta o que o
 * formulário nunca deixaria alguém mandar.
 *
 * ⚠ Ficam de fora de propósito, e não por esquecimento: excluir agente, ler ou
 * trocar credencial, gerar token de gatilho e mexer em contas.
 */

const ALTERA = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const ALTERA_E_PODE_PARAR_ATENDIMENTO = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
} as const;

/** Alteração parcial vazia não é "nada a fazer": é chamada malformada. */
function temCampoAlemDoAgente(args: object): boolean {
  return Object.entries(args).some(
    ([campo, valor]) => campo !== "agente" && valor !== undefined,
  );
}

/** Os campos do formulário do agente, como estão agora no banco. */
function dadosAtuais(agente: {
  name: string;
  description: string | null;
  systemPrompt: string;
  model: string;
  effort: string;
  maxTokens: number;
  maxToolIterations: number;
  routingDescription: string | null;
}): DadosDoAgente {
  return {
    name: agente.name,
    description: agente.description ?? "",
    systemPrompt: agente.systemPrompt,
    model: agente.model,
    effort: normalizarEffort(agente.effort),
    maxTokens: agente.maxTokens,
    maxToolIterations: agente.maxToolIterations,
    routingDescription: agente.routingDescription ?? "",
  };
}

const criarAgenteMcp = ferramenta({
  name: "criar_agente",
  title: "Criar agente",
  description:
    "Cria um agente novo. Ele nasce DESLIGADO e só com o Chatwoot ligado (para poder transferir e escalar). Depois de criar: ligar integrações e escolher ferramentas, conferir o prompt e, só então, ligar_desligar_agente.",
  papel: UserRole.ADMIN,
  anotacoes: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  entrada: z.strictObject({
    nome: z.string().trim().min(2).max(80),
    prompt: z.string().min(20).max(100_000),
    modelo: z
      .string()
      .trim()
      .min(3)
      .describe(
        "Slug da OpenRouter no formato provedor/modelo (ex.: openai/gpt-5.6-luna). Precisa existir no catálogo.",
      ),
    descricao: z.string().trim().max(280).optional(),
    effort: z.enum(EFFORTS).optional().describe("Padrão medium."),
    maxTokens: z.number().int().min(256).max(200_000).optional().describe("Padrão 16384."),
    maxToolIterations: z.number().int().min(1).max(20).optional().describe("Padrão 12."),
    descricaoDeRoteamento: z
      .string()
      .trim()
      .max(400)
      .optional()
      .describe(
        "Quando um colega deve transferir a conversa para este agente. Vazio = nenhum colega o enxerga.",
      ),
  }),
  async executar(args, ctx) {
    // Os padrões são os mesmos do schema do banco (`Agent.effort`,
    // `maxTokens`, `maxToolIterations`).
    const criado = await criarAgente(
      {
        name: args.nome,
        description: args.descricao ?? "",
        systemPrompt: args.prompt,
        model: args.modelo,
        effort: args.effort ?? "medium",
        maxTokens: args.maxTokens ?? 16384,
        maxToolIterations: args.maxToolIterations ?? 12,
        routingDescription: args.descricaoDeRoteamento ?? "",
      },
      autorDoMcp(ctx),
    );
    if (!criado.ok) {
      return recusar(criado.erro, { campos: camposEmPortugues(criado.camposComErro) });
    }

    return responder({
      ok: "Agente criado, DESLIGADO — só atende quando alguém ligar.",
      key: criado.key,
      id: criado.id,
      proximosPassos: [
        "ligar_desligar_integracao_do_agente e definir_ferramentas_do_agente para o que ele precisa usar",
        "definir_escopo_do_agente se ele atende só algumas caixas",
        "ligar_desligar_agente quando estiver pronto",
      ],
      painel: `${ctx.baseUrl}/agentes/${criado.id}`,
    });
  },
});

const atualizarAgenteMcp = ferramenta({
  name: "atualizar_agente",
  title: "Atualizar agente",
  description:
    "Altera nome, descrição, modelo, effort, limites ou a descrição de roteamento de um agente. NÃO altera o prompt (para isso, propor_alteracao_de_prompt). Campo omitido fica como está; texto vazio esvazia descricao ou descricaoDeRoteamento. Mudar modelo ou effort cria uma versão no histórico. Vale a partir da próxima mensagem.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA,
  entrada: z
    .strictObject({
      agente: campoAgente,
      nome: z.string().trim().min(2).max(80).optional(),
      descricao: z.string().trim().max(280).optional(),
      modelo: z.string().trim().min(3).optional().describe("Slug da OpenRouter."),
      effort: z.enum(EFFORTS).optional(),
      maxTokens: z.number().int().min(256).max(200_000).optional(),
      maxToolIterations: z.number().int().min(1).max(20).optional(),
      descricaoDeRoteamento: z.string().trim().max(400).optional(),
    })
    .refine(temCampoAlemDoAgente, {
      message: "Informe pelo menos um campo para alterar.",
    }),
  async executar(args, ctx) {
    const agente = await acharAgente(args.agente);
    if (!agente) return agenteNaoEncontrado(args.agente);

    const dados: DadosDoAgente = {
      ...dadosAtuais(agente),
      ...(args.nome !== undefined ? { name: args.nome } : {}),
      ...(args.descricao !== undefined ? { description: args.descricao } : {}),
      ...(args.modelo !== undefined ? { model: args.modelo } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
      ...(args.maxToolIterations !== undefined
        ? { maxToolIterations: args.maxToolIterations }
        : {}),
      ...(args.descricaoDeRoteamento !== undefined
        ? { routingDescription: args.descricaoDeRoteamento }
        : {}),
    };

    // O prompt vai junto na escrita (o formulário é um só); a trava garante
    // que ele não volte a um texto antigo se alguém o alterou neste meio-tempo.
    const gravado = await atualizarAgente(agente.id, dados, autorDoMcp(ctx), {
      promptEsperado: agente.systemPrompt,
      nota:
        args.modelo !== undefined || args.effort !== undefined
          ? "Modelo ou effort alterado pelo MCP"
          : undefined,
    });
    if (!gravado.ok) {
      return recusar(gravado.erro, { campos: camposEmPortugues(gravado.camposComErro) });
    }

    return responder({
      ok: gravado.versao
        ? `Salvo. Modelo ou effort mudou, então a versão ${gravado.versao} entrou no histórico.`
        : "Salvo.",
      agente: agente.key,
    });
  },
});

const camposDeAlteracao = {
  novoPrompt: z
    .string()
    .min(20)
    .max(100_000)
    .optional()
    .describe(
      "O prompt INTEIRO, já alterado. Para mudar trechos, prefira substituicoes — reenviar tudo arrisca mudar o que não era para mudar.",
    ),
  substituicoes: z
    .array(
      z.strictObject({
        trecho: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            "Texto exato do prompt atual, copiado de ver_agente. Precisa aparecer uma vez só.",
          ),
        por: z.string().max(20_000).describe("O que entra no lugar. Vazio apaga o trecho."),
      }),
    )
    .min(1)
    .max(30)
    .optional()
    .describe("Trocas pontuais, aplicadas em ordem."),
};

const UM_DOS_DOIS = {
  message: "Informe novoPrompt OU substituicoes — exatamente um dos dois.",
};

function umDosDois(x: { novoPrompt?: string; substituicoes?: unknown[] }) {
  return (x.novoPrompt === undefined) !== (x.substituicoes === undefined);
}

function alteracaoDe(x: {
  novoPrompt?: string;
  substituicoes?: { trecho: string; por: string }[];
}): Alteracao {
  return x.novoPrompt !== undefined
    ? { tipo: "inteiro", novoPrompt: x.novoPrompt }
    : { tipo: "substituicoes", substituicoes: x.substituicoes ?? [] };
}

const proporAlteracaoDePrompt = ferramenta({
  name: "propor_alteracao_de_prompt",
  title: "Propor alteração de prompt",
  description:
    "PASSO 1 de 2 para mudar o prompt de um agente. Não grava nada: calcula o resultado e devolve o diff (linhas com + e -), alertas (ferramentas citadas que o agente não tem ligadas, nomes de parâmetro de outro sistema) e dois carimbos, baseHash e hashDaProposta. Mostre o diff à pessoa e só chame aplicar_alteracao_de_prompt depois de um sim explícito.",
  papel: UserRole.ADMIN,
  anotacoes: { readOnlyHint: true },
  entrada: z
    .strictObject({ agente: campoAgente, ...camposDeAlteracao })
    .refine(umDosDois, UM_DOS_DOIS),
  async executar(args) {
    const agente = await acharAgente(args.agente);
    if (!agente) return agenteNaoEncontrado(args.agente);

    const r = aplicarAlteracao(agente.systemPrompt, alteracaoDe(args));
    if (!r.ok) return recusar(r.erro);
    if (r.antes === r.depois) return recusar("A alteração não muda nada no prompt.");
    if (r.depois.trim().length < 20) {
      return recusar("O prompt resultante teria menos de 20 caracteres.");
    }

    const linhas = diffPorLinha(r.antes, r.depois);
    const catalogo = nomesDoCatalogo();
    const efetivas = new Set((await resolverToolsDoAgente(agente.id)).keys());
    const antes = conferirCitacoes(r.antes, catalogo, efetivas);
    const depois = conferirCitacoes(r.depois, catalogo, efetivas);

    return responder({
      agente: agente.key,
      agenteLigado: agente.active,
      baseHash: carimbo(agente.systemPrompt),
      hashDaProposta: carimbo(r.prompt),
      mudancas: contarMudancas(linhas),
      caracteres: { antes: r.antes.length, depois: r.depois.length },
      diff: formatarDiff(linhas),
      alertas: {
        ferramentasCitadasNaoLigadas: depois.naoLigadas,
        trazidasPorEstaAlteracao: depois.naoLigadas.filter(
          (n) => !antes.naoLigadas.includes(n),
        ),
        parametrosDeOutroSistema: depois.parametrosSuspeitos,
      },
      proximoPasso:
        "Mostre o diff à pessoa. Só com um sim explícito, chame aplicar_alteracao_de_prompt com os MESMOS novoPrompt/substituicoes, mais baseHash e hashDaProposta.",
    });
  },
});

const HASH = /^[0-9a-f]{16}$/;

const aplicarAlteracaoDePrompt = ferramenta({
  name: "aplicar_alteracao_de_prompt",
  title: "Aplicar alteração de prompt",
  description:
    "PASSO 2 de 2: grava a alteração proposta e cria uma versão no histórico. Só chame depois que a pessoa aprovou o diff de propor_alteracao_de_prompt. Envie exatamente os mesmos novoPrompt/substituicoes, com baseHash e hashDaProposta daquela resposta: se o prompt mudou desde a proposta, ou se o resultado não for o que foi mostrado, nada é gravado. Vale em produção a partir da próxima mensagem.",
  papel: UserRole.ADMIN,
  anotacoes: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  entrada: z
    .strictObject({
      agente: campoAgente,
      ...camposDeAlteracao,
      baseHash: z.string().regex(HASH, "Copie o baseHash da proposta (16 caracteres)."),
      hashDaProposta: z
        .string()
        .regex(HASH, "Copie o hashDaProposta da proposta (16 caracteres)."),
      nota: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Por que mudou. Vai para o histórico de versões."),
    })
    .refine(umDosDois, UM_DOS_DOIS),
  async executar(args, ctx) {
    const agente = await acharAgente(args.agente);
    if (!agente) return agenteNaoEncontrado(args.agente);

    if (carimbo(agente.systemPrompt) !== args.baseHash) {
      return recusar(
        "O prompt deste agente mudou depois da proposta — alguém salvou outra versão. Nada foi gravado. Leia o agente de novo, proponha sobre o texto atual e mostre o novo diff.",
      );
    }

    const r = aplicarAlteracao(agente.systemPrompt, alteracaoDe(args));
    if (!r.ok) return recusar(r.erro);

    // A trava que faz "o que se aprovou é o que se grava" valer.
    if (carimbo(r.prompt) !== args.hashDaProposta) {
      return recusar(
        "O resultado não é o que foi proposto: hashDaProposta não confere. Nada foi gravado. Envie exatamente os mesmos novoPrompt/substituicoes da proposta aprovada — ou proponha de novo e mostre o novo diff.",
      );
    }

    const gravado = await atualizarAgente(
      agente.id,
      { ...dadosAtuais(agente), systemPrompt: r.prompt },
      autorDoMcp(ctx),
      {
        promptEsperado: agente.systemPrompt,
        nota: args.nota ? `Pelo MCP: ${args.nota}` : "Pelo MCP",
      },
    );
    if (!gravado.ok) {
      return recusar(gravado.erro, { campos: camposEmPortugues(gravado.camposComErro) });
    }

    return responder({
      ok: gravado.versao
        ? `Prompt gravado. A versão ${gravado.versao} entrou no histórico.`
        : "Prompt gravado.",
      agente: agente.key,
      versao: gravado.versao,
      novoBaseHash: carimbo(r.prompt),
      vigencia: agente.active
        ? "O agente está ligado: vale a partir da próxima mensagem."
        : "O agente está desligado: vale quando ele for ligado.",
    });
  },
});

const ligarDesligarAgente = ferramenta({
  name: "ligar_desligar_agente",
  title: "Ligar ou desligar agente",
  description:
    "Liga (passa a atender) ou desliga um agente, a partir da próxima mensagem. Agente arquivado não liga: restaure antes. Pedir o estado em que ele já está não muda nada.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({ agente: campoAgente, ligar: z.boolean() }),
  async executar({ agente: termo, ligar }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);
    return traduzirDesfecho(await definirAtivo(agente.id, ligar, autorDoMcp(ctx)), {
      agente: agente.key,
    });
  },
});

const definirAgenteDeEntrada = ferramenta({
  name: "definir_agente_de_entrada",
  title: "Definir agente de entrada",
  description:
    "Torna este agente o de entrada: quem recebe a primeira mensagem de toda conversa nova e distribui. Só existe um — o anterior deixa de ser entrada na mesma operação.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({ agente: campoAgente }),
  async executar({ agente: termo }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);
    return traduzirDesfecho(await definirEntrada(agente.id, autorDoMcp(ctx)), {
      agente: agente.key,
    });
  },
});

const arquivarAgente = ferramenta({
  name: "arquivar_agente",
  title: "Arquivar agente",
  description:
    "Tira o agente de circulação: desliga, deixa de ser entrada e some da equipe (ninguém transfere para ele). Nada é apagado — prompt, versões e histórico ficam — e restaurar_agente desfaz. Não existe excluir por aqui.",
  papel: UserRole.ADMIN,
  anotacoes: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  entrada: z.strictObject({ agente: campoAgente }),
  async executar({ agente: termo }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);
    return traduzirDesfecho(await arquivar(agente.id, autorDoMcp(ctx)), {
      agente: agente.key,
    });
  },
});

const restaurarAgente = ferramenta({
  name: "restaurar_agente",
  title: "Restaurar agente",
  description:
    "Devolve um agente arquivado à lista — DESLIGADO. Voltar a atender é uma segunda decisão (ligar_desligar_agente), depois de conferir o prompt.",
  papel: UserRole.ADMIN,
  anotacoes: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  entrada: z.strictObject({ agente: campoAgente }),
  async executar({ agente: termo }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);
    return traduzirDesfecho(await restaurar(agente.id, autorDoMcp(ctx)), {
      agente: agente.key,
    });
  },
});

const definirEscopoDoAgente = ferramenta({
  name: "definir_escopo_do_agente",
  title: "Definir escopo do agente",
  description:
    "Onde o agente atua e para quem ele escala: caixas de entrada do Chatwoot, conta do bot, minutos de espera antes de entregar a uma pessoa e o responsável padrão. Campo omitido fica como está; null volta ao padrão.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA,
  entrada: z
    .strictObject({
      agente: campoAgente,
      modoDeCaixa: z
        .enum(MODOS_DE_CAIXA)
        .optional()
        .describe("all = qualquer caixa; specific = só as de caixas."),
      caixas: z
        .array(z.number().int().positive())
        .min(1)
        .max(100)
        .optional()
        .describe("Ids das caixas no Chatwoot. Só vale com modoDeCaixa specific."),
      contaChatwoot: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Id da conta do bot deste agente. null = herda a de Integrações."),
      minutosDeEspera: z
        .number()
        .int()
        .min(1)
        .nullable()
        .optional()
        .describe(
          "Quanto o cliente pode esperar resposta antes de a conversa ir para uma pessoa. null = padrão do sistema.",
        ),
      responsavelPadrao: z
        .string()
        .trim()
        .max(120)
        .nullable()
        .optional()
        .describe(
          "Nome ou e-mail do atendente que assume quando o agente escala. null = fila humana, sem escolher pessoa.",
        ),
    })
    .refine(temCampoAlemDoAgente, {
      message: "Informe pelo menos um campo para alterar.",
    }),
  async executar(args, ctx) {
    const agente = await acharAgente(args.agente);
    if (!agente) return agenteNaoEncontrado(args.agente);

    const modo = args.modoDeCaixa ?? agente.inboxMode;

    // ⚠ Com `all`, o serviço grava a lista de caixas vazia — mandar caixas sem
    // `specific` faria elas sumirem em silêncio, com resposta de sucesso.
    if (args.caixas !== undefined && modo !== "specific") {
      return recusar(
        'caixas só vale com modoDeCaixa "specific". Envie os dois juntos, ou tire caixas para o agente atender todas. Nada foi gravado.',
      );
    }

    const bot = await db.agentChatwootBot.findUnique({
      where: { agentId: agente.id },
      select: { accountId: true },
    });

    const desfecho = await salvarEscopo(
      agente.id,
      {
        inboxMode: modo,
        inboxIds: args.caixas ?? agente.inboxIds,
        accountId:
          args.contaChatwoot !== undefined ? args.contaChatwoot : (bot?.accountId ?? null),
        fallbackMinutos:
          args.minutosDeEspera !== undefined ? args.minutosDeEspera : agente.fallbackMinutos,
        fallbackAtendente:
          args.responsavelPadrao !== undefined
            ? args.responsavelPadrao
            : agente.fallbackAtendente,
      },
      autorDoMcp(ctx),
    );
    return traduzirDesfecho(desfecho, { agente: agente.key });
  },
});

const ligarDesligarIntegracao = ferramenta({
  name: "ligar_desligar_integracao",
  title: "Ligar ou desligar integração (global)",
  description:
    "Liga ou desliga uma integração para TODOS os agentes, a partir do próximo turno — mesmo os que a têm ligada. Desligar CHATWOOT tira de todos as ferramentas de transferência (eles seguem respondendo, mas não passam a conversa a colega nem a pessoa); desligar OPENAI para a leitura de áudio, imagem e documento. Não mexe em configuração nem credencial — isso é só pelo painel.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({
    provider: z.enum(IntegrationProvider),
    ligar: z.boolean(),
  }),
  async executar({ provider, ligar }, ctx) {
    return traduzirDesfecho(
      await definirIntegracaoGlobal(provider, ligar, autorDoMcp(ctx)),
      { provider },
    );
  },
});

const ligarDesligarIntegracaoDoAgente = ferramenta({
  name: "ligar_desligar_integracao_do_agente",
  title: "Ligar ou desligar integração do agente",
  description:
    "Segundo nível do toggle: liga ou desliga uma integração para UM agente. Ele só enxerga as ferramentas dela se estiver ligada aqui E globalmente. Desligar o CHATWOOT de um agente não o cala — só tira dele as ferramentas de transferência.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({
    agente: campoAgente,
    provider: z.enum(IntegrationProvider),
    ligar: z.boolean(),
  }),
  async executar({ agente: termo, provider, ligar }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);
    return traduzirDesfecho(
      await definirIntegracaoDoAgente(agente.id, provider, ligar, autorDoMcp(ctx)),
      { agente: agente.key, provider },
    );
  },
});

const definirFerramentasDoAgenteMcp = ferramenta({
  name: "definir_ferramentas_do_agente",
  title: "Definir ferramentas do agente",
  description:
    'Define quais ferramentas de uma integração o agente pode usar: os nomes, ou "todas". Cada ferramenta liberada entra no prompt de toda mensagem — libere só o necessário. A integração precisa estar ligada para o agente. Não existe lista vazia (no banco, vazio significa todas): para tirar todas, desligue a integração para ele.',
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({
    agente: campoAgente,
    provider: z.enum(IntegrationProvider),
    ferramentas: z
      .union([z.literal("todas"), z.array(z.string().trim().min(1)).min(1).max(200)])
      .describe('Nomes exatos (ver_integracao lista todos), ou "todas".'),
  }),
  async executar({ agente: termo, provider, ferramentas }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);

    const definicao = obterIntegracao(provider);
    if (!definicao) return recusar("Esta integração não tem implementação no sistema.");
    if (definicao.tools.length === 0) {
      return recusar(
        `${definicao.label} não tem ferramentas: ela só liga ou desliga (ligar_desligar_integracao_do_agente).`,
      );
    }

    const validas = definicao.tools.map((t) => t.name);
    const lista = ferramentas === "todas" ? validas : ferramentas;

    // O painel filtra nome inválido em silêncio porque só oferece nomes
    // válidos. Aqui o nome vem digitado — recusar é o que evita "liberei a
    // ferramenta" sem ter liberado.
    const invalidas = lista.filter((n) => !validas.includes(n));
    if (invalidas.length > 0) {
      return recusar(
        `Nomes que não existem em ${definicao.label}: ${invalidas.join(", ")}. Nada foi gravado.`,
        { validas },
      );
    }

    // Gravar a lista num vínculo inexistente o CRIARIA ligado — definir
    // ferramentas não pode ligar uma integração pela porta dos fundos.
    const vinculo = await db.agentIntegration.findFirst({
      where: { agentId: agente.id, integration: { provider } },
      select: { enabled: true },
    });
    if (!vinculo?.enabled) {
      return recusar(
        `${definicao.label} está desligada para ${agente.key}. Ligue antes com ligar_desligar_integracao_do_agente. Nada foi gravado.`,
      );
    }

    const desfecho = await definirFerramentasDoAgente(
      agente.id,
      provider,
      lista,
      autorDoMcp(ctx),
    );
    const unicas = [...new Set(lista)];
    return traduzirDesfecho(desfecho, {
      agente: agente.key,
      provider,
      liberadas: unicas.length === validas.length ? "todas" : unicas.sort(),
    });
  },
});

const ligarDesligarGatilho = ferramenta({
  name: "ligar_desligar_gatilho",
  title: "Ligar ou desligar gatilho HTTP",
  description:
    "Liga ou desliga o gatilho HTTP do agente (a URL que sistemas externos chamam para acioná-lo). Só funciona se o token já foi gerado — gerar e rotacionar é só pelo painel, pelo Proprietário. Ligar limpa uma pausa automática por excesso de chamadas.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({ agente: campoAgente, ligar: z.boolean() }),
  async executar({ agente: termo, ligar }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);
    return traduzirDesfecho(await definirGatilho(agente.id, ligar, autorDoMcp(ctx)), {
      agente: agente.key,
    });
  },
});

const ligarDesligarAgendamento = ferramenta({
  name: "ligar_desligar_agendamento",
  title: "Ligar ou desligar agendamento",
  description:
    "Liga ou desliga um agendamento (execução por horário) no banco e no relógio. Ligar exige o agente ligado e uma frequência válida, e limpa a pausa automática por falhas.",
  papel: UserRole.ADMIN,
  anotacoes: ALTERA_E_PODE_PARAR_ATENDIMENTO,
  entrada: z.strictObject({
    agendamento: z
      .string()
      .trim()
      .min(1)
      .describe("Id do agendamento, de listar_agendamentos."),
    ligar: z.boolean(),
  }),
  async executar({ agendamento, ligar }, ctx) {
    return traduzirDesfecho(
      await definirAgendamento(agendamento, ligar, autorDoMcp(ctx)),
      { agendamento },
    );
  },
});

const pararExecucao = ferramenta({
  name: "parar_execucao",
  title: "Parar execução",
  description:
    "Pede a uma execução em andamento (status RUNNING) que pare, em segundos. O custo até ali continua cobrado; o cliente não recebe mensagem de contorno, e fica uma nota interna dizendo quem parou. Execução órfã, sem processo vivo, é encerrada na hora.",
  papel: UserRole.ADMIN,
  anotacoes: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  entrada: z.strictObject({
    id: z.string().trim().min(1).describe("Id da execução, de listar_execucoes."),
  }),
  async executar({ id }, ctx) {
    return traduzirDesfecho(await pedirParadaDaExecucao(id, autorDoMcp(ctx)), {
      execucao: id,
    });
  },
});

export const FERRAMENTAS_DE_ESCRITA: FerramentaMcp[] = [
  criarAgenteMcp,
  atualizarAgenteMcp,
  proporAlteracaoDePrompt,
  aplicarAlteracaoDePrompt,
  ligarDesligarAgente,
  definirAgenteDeEntrada,
  arquivarAgente,
  restaurarAgente,
  definirEscopoDoAgente,
  ligarDesligarIntegracao,
  ligarDesligarIntegracaoDoAgente,
  definirFerramentasDoAgenteMcp,
  ligarDesligarGatilho,
  ligarDesligarAgendamento,
  pararExecucao,
];
