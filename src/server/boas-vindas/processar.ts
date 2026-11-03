import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { IntegrationProvider, IntegrationStatus } from "@/generated/prisma/enums";
import { decifrar } from "@/lib/crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteComTokenDeUsuario, clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { portaDaCaixa } from "@/server/integrations/chatwoot/porta";
import {
  ehRecusaDefinitiva,
  NotificaMeClient,
} from "@/server/integrations/notificame/client";
import {
  chaveDoEnvio,
  conversaDoCliente,
  lerConfigBoasVindas,
  lerMacro,
  nomeParaOTemplate,
  notaDeEnvio,
  notaDeFalha,
  prefixoDoEnvio,
  PROVIDER_DO_BOAS_VINDAS,
  providenciaDoDono,
  textoDoTemplate,
  type MotivoDeFalha,
} from "./regras";

/**
 * O clique na macro "Disparar Template Boas Vindas", de ponta a ponta. Substitui o
 * fluxo do n8n de mesmo nome — e conserta o que ele tinha de errado:
 *
 * - ⚠ **Um clique, um envio.** O fluxo atualizava a data table "Etiquetas" por
 *   número e mandava o template UMA VEZ POR LINHA: quem tinha três linhas repetidas
 *   (88 números tinham) recebia três mensagens iguais. Aqui o envio é um só, e o
 *   mesmo número só recebe de novo depois de `minutosSemReenvio`.
 * - ⚠ **Reserva antes de enviar.** A linha nasce `reservado` com uma chave única
 *   (número + intervalo), e é a trava do banco que segura duas entregas ao mesmo
 *   tempo. Envio recusado libera o número; envio INCERTO (rede, 5xx) o segura — a
 *   mensagem pode ter saído, e repetir às cegas é o defeito de origem.
 * - **Falha nunca é silêncio.** O clique já atribuiu e etiquetou a conversa; se o
 *   template não saiu, quem clicou lê o motivo numa nota interna.
 * - **Não grava na tabela Etiquetas do n8n** (decisão do usuário, 03/11/2026). Os
 *   dois fluxos do n8n que ainda a leem — "Menu Boas Vindas 3.0" e "Menu BASE
 *   SEAHUB" — têm o gatilho desligado do resto do fluxo, então não respondem
 *   ninguém.
 * - **O endereço do Chatwoot é o atual.** A versão publicada do fluxo apontava para
 *   o servidor de antes da migração, e nota, reabertura e atribuição não
 *   aconteciam desde 25/09/2026.
 */

/** Tempo para as automações do Chatwoot rodarem antes de conferir a atribuição. */
const ESPERA_PARA_CONFERIR_MS = 3_000;

export type Desfecho = {
  resultado: "enviado" | "repetido" | "falhou" | "incerto" | "ignorado" | "desligado" | "teto";
  detalhe: string;
};

export type Opcoes = {
  agora?: Date;
  /** Espera entre atribuir e conferir; o teste troca por uma que não espera. */
  dormir?: (ms: number) => Promise<void>;
  /** Para teste: o cliente da NotificaMe. */
  notificame?: (token: string) => Pick<NotificaMeClient, "enviarTemplate" | "listarTemplates">;
};

const dormirDeVerdade = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mensagemDe(erro: unknown): string {
  return (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
}

/** Grava a entrega SEM nome nem telefone: a lista é lida pela equipe toda. */
export async function registrarEntrega(dados: {
  resultado: string;
  detalhe: string;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  try {
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER_DO_BOAS_VINDAS,
        externalId: `entrega:${randomUUID()}`,
        eventType: dados.eventType,
        payload: (dados.payload ?? {}) as Prisma.InputJsonValue,
        resultado: dados.resultado,
        detalhe: dados.detalhe.slice(0, 500),
        processedAt: new Date(),
      },
    });
  } catch (erro) {
    logger.warn({ erro: mensagemDe(erro) }, "template de boas-vindas: entrega não gravada");
  }
}

/** Nunca lança: é passo complementar, e o que ele deixa de fazer vira aviso na nota. */
async function tentar(acao: () => Promise<unknown>, seFalhar?: (erro: unknown) => void) {
  try {
    await acao();
  } catch (erro) {
    logger.warn({ erro: mensagemDe(erro) }, "template de boas-vindas: passo complementar falhou");
    seFalhar?.(erro);
  }
}

/**
 * Quem escreve a nota: o robô da caixa, e o token de Integrações quando a caixa
 * não tem robô nosso (a 31 e a 34 são WAHA). Nota de pessoa conta como "a equipe
 * escreveu" para os prazos e o NPS — por isso o robô sempre que houver.
 */
async function escritorDa(
  conversa: number,
  caixa: number | null,
  leitor: ChatwootClient | null,
): Promise<Pick<ChatwootClient, "enviarMensagem"> | null> {
  const porta = await portaDaCaixa(conversa, caixa);
  const robo = porta ? await clienteDoAgente(porta) : null;
  return robo ?? leitor;
}

async function deixarNota(
  conversa: number,
  caixa: number | null,
  texto: string,
  leitor: ChatwootClient | null,
): Promise<boolean> {
  let escreveu = false;
  await tentar(async () => {
    const escritor = await escritorDa(conversa, caixa, leitor);
    if (!escritor) return;
    await escritor.enviarMensagem(conversa, texto, { privado: true });
    escreveu = true;
  });
  return escreveu;
}

async function anotarEstado(agora: Date, desfecho: Desfecho) {
  if (desfecho.resultado === "desligado" || desfecho.resultado === "ignorado") return;
  const deuCerto = desfecho.resultado === "enviado" || desfecho.resultado === "repetido";
  await tentar(() =>
    db.integration.update({
      where: { provider: IntegrationProvider.BOAS_VINDAS },
      data: {
        lastCheckedAt: agora,
        status: deuCerto ? IntegrationStatus.OK : IntegrationStatus.ERROR,
        lastError: deuCerto ? null : desfecho.detalhe.slice(0, 300),
      },
    }),
  );
}

export async function processarMacro(corpo: unknown, opcoes: Opcoes = {}): Promise<Desfecho> {
  const agora = opcoes.agora ?? new Date();
  const dormir = opcoes.dormir ?? dormirDeVerdade;

  const lida = lerMacro(corpo);
  if (!lida.ok) {
    await registrarEntrega({ resultado: "ignorado", detalhe: lida.motivo, eventType: "macro ignorada" });
    return { resultado: "ignorado", detalhe: lida.motivo };
  }
  const macro = lida.macro;
  const eventType = `macro na conversa #${macro.conversaId}`;
  const base = { conversaId: macro.conversaId, caixaId: macro.caixaId };

  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    select: { enabled: true, config: true, credential: true },
  });
  const config = lerConfigBoasVindas(linha?.config);
  // Sem este token não há nota nem atribuição — mas o envio, que é o que importa,
  // não depende dele.
  const leitor = await clienteComTokenDeUsuario();

  /** Encerra sem enviar: quem clicou lê o motivo na conversa em que clicou. */
  const naoEnviou = async (
    resultado: Desfecho["resultado"],
    motivo: MotivoDeFalha,
    detalhe: string,
  ): Promise<Desfecho> => {
    await deixarNota(macro.conversaId, macro.caixaId, notaDeFalha(motivo), leitor);
    await registrarEntrega({ resultado, detalhe, eventType, payload: base });
    const desfecho = { resultado, detalhe };
    await anotarEstado(agora, desfecho);
    return desfecho;
  };

  if (!linha?.enabled) {
    return naoEnviou("desligado", { tipo: "desligado" }, "o envio está desligado em Integrações");
  }
  if (!linha.credential || !config.canalId) {
    return naoEnviou("falhou", { tipo: "sem-credencial" }, "falta o token ou o canal da NotificaMe");
  }
  if (!macro.telefone) {
    return naoEnviou("falhou", { tipo: "sem-telefone" }, "o contato não tem telefone válido");
  }
  const telefone = macro.telefone;

  // 1. Esse número já recebeu o template há pouco?
  const recente = await db.webhookEvent.findFirst({
    where: {
      provider: PROVIDER_DO_BOAS_VINDAS,
      externalId: { startsWith: prefixoDoEnvio(telefone) },
      resultado: { in: ["enviado", "reservado", "incerto"] },
      createdAt: { gte: new Date(agora.getTime() - config.minutosSemReenvio * 60_000) },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const jaMandado = (desde: Date | null) => {
    const minutosAtras = desde ? Math.max(1, Math.round((agora.getTime() - desde.getTime()) / 60_000)) : 1;
    return naoEnviou(
      "repetido",
      { tipo: "repetido", minutosAtras, espera: config.minutosSemReenvio },
      `o mesmo número recebeu o template há ${minutosAtras} min`,
    );
  };
  if (recente) return jaMandado(recente.createdAt);

  // 2. Freio contra laço.
  const naUltimaHora = await db.webhookEvent.count({
    where: {
      provider: PROVIDER_DO_BOAS_VINDAS,
      externalId: { startsWith: "envio:" },
      resultado: { in: ["enviado", "incerto"] },
      createdAt: { gte: new Date(agora.getTime() - 3_600_000) },
    },
  });
  if (naUltimaHora >= config.tetoPorHora) {
    return naoEnviou(
      "teto",
      { tipo: "teto", teto: config.tetoPorHora },
      `o teto de ${config.tetoPorHora} envios por hora foi atingido`,
    );
  }

  // 3. Reserva. A chave única é a trava contra duas entregas ao mesmo tempo.
  let reservaId: string;
  try {
    const reserva = await db.webhookEvent.create({
      data: {
        provider: PROVIDER_DO_BOAS_VINDAS,
        externalId: chaveDoEnvio(telefone, agora, config.minutosSemReenvio),
        eventType,
        payload: base as Prisma.InputJsonValue,
        resultado: "reservado",
      },
      select: { id: true },
    });
    reservaId = reserva.id;
  } catch (erro) {
    if ((erro as { code?: string }).code === "P2002") return jaMandado(null);
    throw erro;
  }

  /** Recusa definitiva libera o número: a chave volta a ficar livre para a próxima tentativa. */
  const liberarReserva = (detalhe: string) =>
    tentar(() =>
      db.webhookEvent.update({
        where: { id: reservaId },
        data: {
          externalId: `falha:${randomUUID()}`,
          resultado: "falhou",
          detalhe: detalhe.slice(0, 500),
          processedAt: new Date(),
        },
      }),
    );

  // 4. O envio.
  let token: string;
  try {
    token = decifrar(linha.credential);
  } catch (erro) {
    logger.error({ erro: mensagemDe(erro) }, "template de boas-vindas: falha ao decifrar o token da NotificaMe");
    await liberarReserva("não consegui abrir o token guardado da NotificaMe");
    return naoEnviou("falhou", { tipo: "sem-credencial" }, "não consegui abrir o token guardado da NotificaMe");
  }

  const notificame = (opcoes.notificame ?? ((t: string) => new NotificaMeClient(t)))(token);
  const nome = nomeParaOTemplate(macro.nome);

  let aceito: { id: string | null; status: string | null };
  try {
    aceito = await notificame.enviarTemplate({
      canalId: config.canalId,
      para: telefone,
      template: config.template,
      idioma: config.idioma,
      parametros: [{ nome: config.parametro, texto: nome }],
    });
  } catch (erro) {
    const detalhe = mensagemDe(erro);
    if (ehRecusaDefinitiva(erro)) {
      await liberarReserva(detalhe);
      return naoEnviou("falhou", { tipo: "recusado", detalhe }, detalhe);
    }
    // Rede, prazo, 5xx: a mensagem pode ter saído. A reserva FICA, e segura o reenvio.
    await tentar(() =>
      db.webhookEvent.update({
        where: { id: reservaId },
        data: { resultado: "incerto", detalhe: detalhe.slice(0, 500), processedAt: new Date() },
      }),
    );
    await deixarNota(macro.conversaId, macro.caixaId, notaDeFalha({ tipo: "incerto", detalhe }), leitor);
    const desfecho: Desfecho = { resultado: "incerto", detalhe };
    await anotarEstado(agora, desfecho);
    return desfecho;
  }

  // Aceito. Grava já, antes do resto: se o processo cair daqui para baixo, a linha
  // não fica "reservado" para sempre.
  await tentar(() =>
    db.webhookEvent.update({
      where: { id: reservaId },
      data: {
        resultado: "enviado",
        detalhe: "template aceito pela NotificaMe",
        processedAt: new Date(),
        payload: { ...base, notificame: aceito.id } as Prisma.InputJsonValue,
      },
    }),
  );

  // 5. Depois do envio: texto real, conversa do cliente, dono, nota. Nada daqui lança.
  const problemas: string[] = [];
  let destino: string | null = null;
  let conversaDaNota = macro.conversaId;
  let caixaDaNota = macro.caixaId;
  let texto: string | null = null;

  await tentar(async () => {
    const modelo = (await notificame.listarTemplates(config.canalId)).find((t) => t.nome === config.template);
    if (modelo?.corpo) texto = textoDoTemplate(modelo.corpo, { [config.parametro]: nome });
  });

  if (!leitor) {
    problemas.push(
      "falta o token de leitura em Integrações → Chatwoot: não deu para conferir nem atribuir a conversa do cliente.",
    );
  } else if (macro.contatoId != null) {
    await tentar(
      async () => {
        const achada = conversaDoCliente(await leitor.conversasDoContato(macro.contatoId!), config.caixaDoCliente);
        if (achada != null) {
          conversaDaNota = achada;
          caixaDaNota = config.caixaDoCliente;
        } else {
          problemas.push(
            `o cliente ainda não tem conversa na caixa ${config.caixaDoCliente}; esta nota ficou na conversa em que você clicou.`,
          );
        }
      },
      () => problemas.push("não consegui procurar a conversa do cliente; esta nota ficou na conversa em que você clicou."),
    );
  }

  // O dono só é cuidado na conversa do cliente (caixa do WhatsApp oficial). A
  // conversa em que se clicou já foi atribuída pela própria macro.
  if (leitor && caixaDaNota === config.caixaDoCliente) {
    await tentar(
      async () => {
        const vivo = await leitor.obterConversa(conversaDaNota);
        const providencia = providenciaDoDono(
          {
            status: vivo.status,
            assigneeId: vivo.assigneeId,
            assigneeTipo: vivo.assigneeTipo,
            assigneeNome: vivo.assigneeNome,
          },
          macro.clique?.id ?? null,
        );

        if (providencia.acao === "manter") {
          destino = `A conversa já estava com ${providencia.com} e continua com essa pessoa.`;
          return;
        }

        // Reabre ANTES de atribuir: a automação do Chatwoot que tira o dono de
        // conversa resolvida desfaz a atribuição no mesmo segundo.
        if (providencia.reabrir) await leitor.alternarStatus(conversaDaNota, "open");
        if (!providencia.atribuir || !macro.clique) {
          destino = "Conversa reaberta, sem dono: a macro não disse quem clicou.";
          return;
        }

        const quem = macro.clique.nome ?? "quem clicou";
        await leitor.atribuir(conversaDaNota, { assigneeId: macro.clique.id });
        // As automações rodam logo depois, fora da nossa vista: a nota só diz o que ficou.
        await dormir(ESPERA_PARA_CONFERIR_MS);
        let depois = await leitor.obterConversa(conversaDaNota);
        if (depois.assigneeId !== macro.clique.id) {
          if (depois.status !== "open") await leitor.alternarStatus(conversaDaNota, "open");
          await leitor.atribuir(conversaDaNota, { assigneeId: macro.clique.id });
          await dormir(ESPERA_PARA_CONFERIR_MS);
          depois = await leitor.obterConversa(conversaDaNota);
        }
        if (depois.assigneeId === macro.clique.id) {
          destino = `Conversa atribuída a ${quem}.`;
        } else {
          problemas.push(
            `atribuí a conversa a ${quem}, mas ela ficou ${
              depois.assigneeNome ? `com ${depois.assigneeNome}` : "sem dono"
            } — provavelmente uma automação do Chatwoot desfez.`,
          );
        }
      },
      (erro) => problemas.push(`não consegui reabrir ou atribuir a conversa (${mensagemDe(erro)}).`),
    );
  }

  const escreveu = await deixarNota(
    conversaDaNota,
    caixaDaNota,
    notaDeEnvio({ template: config.template, texto, quem: macro.clique?.nome ?? null, destino, problemas }),
    leitor,
  );
  if (!escreveu) problemas.push("não consegui deixar a nota interna.");

  const detalhe = ["template aceito pela NotificaMe", ...(destino ? [destino] : []), ...problemas].join(" · ");
  await tentar(() =>
    db.webhookEvent.update({ where: { id: reservaId }, data: { detalhe: detalhe.slice(0, 500) } }),
  );
  const desfecho: Desfecho = { resultado: "enviado", detalhe };
  await anotarEstado(agora, desfecho);
  return desfecho;
}
