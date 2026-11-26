"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import {
  chatwootConfigSchema,
  chatwootSegredosSchema,
} from "@/server/integrations/chatwoot/config";
import {
  clienteDoAgente,
  obterConfigChatwoot,
  salvarSegredosDaConta,
  salvarSegredosDoBot,
} from "@/server/integrations/chatwoot/credenciais";
import { ausenciasDaConfig, lerAusenciasDoTexto } from "@/server/integrations/chatwoot/ausencias";
import { esquecerAusencias } from "@/server/integrations/chatwoot/ausencias-config";
import {
  configDoFormulario as configDaLimpezaDoFormulario,
  lerConfigDaLimpeza,
} from "@/server/limpeza-do-contato/regras";
import {
  configDoFormulario as configDoLeadDoFormulario,
  lerConfigDoLead,
} from "@/server/lead-no-crm/regras";
import { lerIdsDeCaixa } from "@/server/agents/equipe";
import { autorDaSessao } from "@/server/gestao/autor";
import { salvarEscopo } from "@/server/gestao/escopo";

export type EstadoEscopo = { ok?: string; erro?: string };

export type EstadoChatwoot = {
  ok?: string;
  erro?: string;
  /** Nem sucesso nem falha — ver ResultadoTeste.indeterminado. */
  aviso?: string;
  camposComErro?: Record<string, string>;
};

/** Config da instância — vale para todos os agentes. */
export async function salvarConfigChatwoot(
  _estado: EstadoChatwoot,
  formData: FormData,
): Promise<EstadoChatwoot> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const parsed = chatwootConfigSchema.safeParse({
    baseUrl: formData.get("baseUrl"),
    accountId: formData.get("accountId"),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  // ⚠ O formulário da instância não conhece as ausências da equipe: gravar só o
  // que ele manda as apagaria, e a conversa do financeiro voltaria para quem
  // está de férias sem ninguém perceber. Elas passam intactas.
  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { config: true },
  });
  // A limpeza do contato (`limpezaDoContato`) e o registro automático do lead
  // (`leadNoCrm`) também moram aqui e passam intactos.
  const config = {
    ...parsed.data,
    ausencias: ausenciasDaConfig(atual?.config),
    limpezaDoContato: lerConfigDaLimpeza(atual?.config),
    leadNoCrm: lerConfigDoLead(atual?.config),
  };

  await db.integration.upsert({
    where: { provider: IntegrationProvider.CHATWOOT },
    update: { config, enabled: formData.get("enabled") === "on" },
    create: {
      provider: IntegrationProvider.CHATWOOT,
      label: "Chatwoot",
      config,
      enabled: formData.get("enabled") === "on",
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.chatwoot.updated",
      entity: "Integration",
      entityId: IntegrationProvider.CHATWOOT,
    },
  });

  // Campo em branco mantém o valor atual — o formulário nunca devolve o segredo.
  await salvarSegredosDaConta({
    secretDaConta: String(formData.get("secretDaConta") ?? ""),
    tokenDeLeitura: String(formData.get("tokenDeLeitura") ?? ""),
  });

  revalidatePath("/integracoes");
  return { ok: "Configuração salva." };
}

export type EstadoAusencias = { ok?: string; erro?: string };

/**
 * Ausências da equipe: quem está fora, quem recebe no lugar e até que dia.
 * Vale para toda atribuição a uma pessoa (agentes, cobrança, vigia, prazos) —
 * ver `ausencias.ts`. Mexe só nessa chave da configuração do Chatwoot.
 */
export async function salvarAusencias(
  _estado: EstadoAusencias,
  formData: FormData,
): Promise<EstadoAusencias> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lido = lerAusenciasDoTexto(String(formData.get("ausencias") ?? ""));
  if ("erro" in lido) return { erro: lido.erro };

  const registro = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { config: true },
  });
  if (!registro) {
    return { erro: "Configure a instância do Chatwoot antes de cadastrar ausências." };
  }

  const anterior = ausenciasDaConfig(registro.config);
  await db.integration.update({
    where: { provider: IntegrationProvider.CHATWOOT },
    data: {
      config: { ...(registro.config as Record<string, unknown>), ausencias: lido.ausencias },
    },
  });
  esquecerAusencias();

  // Nomes e datas, sem dado de cliente: o que se quer saber depois é quem mexeu.
  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.chatwoot.ausencias.updated",
      entity: "Integration",
      entityId: IntegrationProvider.CHATWOOT,
      diff: { antes: anterior, depois: lido.ausencias },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok:
      lido.ausencias.length === 0
        ? "Nenhuma ausência cadastrada."
        : `${lido.ausencias.length} ausência(s) salva(s). Vale em até 30 segundos.`,
  };
}

/**
 * Bot de um agente. Credencial é coisa de OWNER.
 */
export async function salvarBotDoAgente(
  agentId: string,
  _estado: EstadoChatwoot,
  formData: FormData,
): Promise<EstadoChatwoot> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const botName = String(formData.get("botName") ?? "").trim();
  if (botName.length < 2) {
    return {
      erro: "Confira os campos.",
      camposComErro: { botName: "Informe o nome do bot" },
    };
  }

  const botIdCru = String(formData.get("botId") ?? "").trim();
  const botId = botIdCru ? Number(botIdCru) : null;
  if (botIdCru && !Number.isInteger(botId)) {
    return {
      erro: "Confira os campos.",
      camposComErro: { botId: "Deve ser um número inteiro" },
    };
  }

  const parsed = chatwootSegredosSchema.safeParse({
    token: formData.get("token"),
    webhookSecret: formData.get("webhookSecret") ?? "",
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  await salvarSegredosDoBot({
    agentId,
    botName,
    botId,
    segredos: parsed.data,
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "agent.chatwoot_bot.rotated",
      entity: "Agent",
      entityId: agentId,
    },
  });

  revalidatePath(`/agentes/${agentId}`);
  return { ok: "Bot salvo. Use o botão de testar para confirmar." };
}

/** Testa config + token do bot contra a instância real. */
export async function testarConexaoDoAgente(
  agentId: string,
): Promise<EstadoChatwoot> {
  await exigirPapel(UserRole.ADMIN);

  const cliente = await clienteDoAgente(agentId);
  if (!cliente) {
    return {
      erro:
        "Falta configuração: confira a URL e o id da conta em Integrações, e o token do bot aqui.",
    };
  }

  const resultado = await cliente.testar();

  // Indeterminado não marca a integração como quebrada: token de Agent Bot
  // recusado num endpoint de usuário não é defeito de configuração.
  const status = resultado.ok
    ? IntegrationStatus.OK
    : resultado.indeterminado
      ? IntegrationStatus.NOT_CONFIGURED
      : IntegrationStatus.ERROR;

  await db.integration.update({
    where: { provider: IntegrationProvider.CHATWOOT },
    data: {
      status,
      lastCheckedAt: new Date(),
      lastError: resultado.ok || resultado.indeterminado ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  revalidatePath(`/agentes/${agentId}`);

  if (resultado.ok) return { ok: resultado.mensagem };
  return resultado.indeterminado
    ? { aviso: resultado.mensagem }
    : { erro: resultado.mensagem };
}

/** Só para a tela: nunca devolve o segredo em si. */
/**
 * Onde o agente atua: conta do Chatwoot e caixas de entrada.
 *
 * A conta fica no bot (é dele o token que fala com aquela conta); o escopo de
 * caixas fica no agente, porque vale também para o roteamento e para o roster —
 * um colega que não atua na caixa não deve nem aparecer para transferência.
 */
export async function salvarEscopoDoAgente(
  agentId: string,
  _estado: EstadoEscopo,
  formData: FormData,
): Promise<EstadoEscopo> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  // Aqui só se lê o formulário. Texto que não vira número segue como `NaN` e é
  // recusado pelo serviço, com a mesma frase e na mesma ordem de antes — a
  // regra mora em `server/gestao/escopo.ts`, que o MCP também chama.
  const contaBruta = String(formData.get("accountId") ?? "").trim();
  const minutosBruto = String(formData.get("fallbackMinutos") ?? "").trim();

  return salvarEscopo(
    agentId,
    {
      inboxMode: String(formData.get("inboxMode") ?? "all"),
      inboxIds: lerIdsDeCaixa(String(formData.get("inboxIds") ?? "")),
      accountId: contaBruta ? Number.parseInt(contaBruta, 10) : null,
      fallbackMinutos: minutosBruto ? Number.parseInt(minutosBruto, 10) : null,
      fallbackAtendente: String(formData.get("fallbackAtendente") ?? ""),
    },
    autorDaSessao(sessao),
  );
}

export async function resumoDoBot(agentId: string) {
  const [bot, { config, habilitada }] = await Promise.all([
    db.agentChatwootBot.findUnique({ where: { agentId } }),
    obterConfigChatwoot(),
  ]);

  return {
    configurado: Boolean(bot),
    botName: bot?.botName ?? "",
    botId: bot?.botId ?? null,
    hint: bot?.hint ?? null,
    rotatedAt: bot?.rotatedAt ?? null,
    instanciaOk: Boolean(config),
    habilitadaGlobalmente: habilitada,
  };
}

export type EstadoLimpeza = { ok?: string; erro?: string };

/**
 * A limpeza dos campos do contato depois da resolução (pedido do Diego,
 * 17/11/2026). Formulário PRÓPRIO, como as ausências: mexe só na chave
 * `limpezaDoContato` da configuração do Chatwoot.
 */
export async function salvarLimpezaDoContato(
  _estado: EstadoLimpeza,
  formData: FormData,
): Promise<EstadoLimpeza> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lido = configDaLimpezaDoFormulario({
    ligada: formData.get("ligada") === "on",
    campos: String(formData.get("campos") ?? ""),
  });
  if ("erro" in lido) return { erro: lido.erro };

  const registro = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { config: true },
  });
  if (!registro) return { erro: "Configure a instância do Chatwoot antes." };

  const anterior = lerConfigDaLimpeza(registro.config);
  await db.integration.update({
    where: { provider: IntegrationProvider.CHATWOOT },
    data: {
      config: { ...(registro.config as Record<string, unknown>), limpezaDoContato: lido.config },
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.chatwoot.limpeza_do_contato.updated",
      entity: "Integration",
      entityId: IntegrationProvider.CHATWOOT,
      diff: { antes: anterior, depois: lido.config },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: lido.config.ligada
      ? `Ligada: ${lido.config.campos.length} campo(s) do contato são limpos 15 min depois de a conversa ser resolvida.`
      : "Desligada: nenhum campo do contato é limpo.",
  };
}

export type EstadoLeadNoCrm = { ok?: string; erro?: string };

/**
 * O registro automático do lead no CRM Comercial (pedido do Diego, 26/11/2026).
 * Formulário PRÓPRIO, como a limpeza: mexe só na chave `leadNoCrm` da
 * configuração do Chatwoot. Ligar faz o sistema criar task no CRM da equipe —
 * por isso `ADMIN` e auditoria.
 */
export async function salvarLeadNoCrm(
  _estado: EstadoLeadNoCrm,
  formData: FormData,
): Promise<EstadoLeadNoCrm> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lido = configDoLeadDoFormulario({
    modo: String(formData.get("modo") ?? ""),
    agentes: String(formData.get("agentes") ?? ""),
    agenteDoCrm: String(formData.get("agenteDoCrm") ?? ""),
  });
  if ("erro" in lido) return { erro: lido.erro };

  // Chave que não existe nunca dispararia, e a tela diria "ligado" em silêncio.
  const chaves = [...lido.config.agentes, lido.config.agenteDoCrm];
  const existentes = await db.agent.findMany({
    where: { key: { in: chaves }, archivedAt: null },
    select: { key: true },
  });
  const faltam = chaves.filter((c) => !existentes.some((a) => a.key === c));
  if (faltam.length) return { erro: `Não há agente com a chave: ${faltam.join(", ")}.` };

  const registro = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { config: true },
  });
  if (!registro) return { erro: "Configure a instância do Chatwoot antes." };

  const anterior = lerConfigDoLead(registro.config);
  await db.integration.update({
    where: { provider: IntegrationProvider.CHATWOOT },
    data: {
      config: { ...(registro.config as Record<string, unknown>), leadNoCrm: lido.config },
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.chatwoot.lead_no_crm.updated",
      entity: "Integration",
      entityId: IntegrationProvider.CHATWOOT,
      diff: { antes: anterior, depois: lido.config },
    },
  });

  revalidatePath("/integracoes");
  const { modo, agentes } = lido.config;
  return {
    ok:
      modo === "ligado"
        ? `Ligado: o lead que passar de ${agentes.length} agente(s) comercial(is) a uma pessoa da equipe sem task vai para o CRM sozinho.`
        : modo === "sombra"
          ? "Em sombra: o sistema só anota o que registraria, sem criar task."
          : "Desligado: nada é registrado pelo sistema.",
  };
}
