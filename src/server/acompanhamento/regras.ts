/**
 * Acompanhamento de contratos: do contrato gerado até pagamento e assinatura.
 *
 * Pedido do Diego (10/11/2026), que escreveu a especificação como prompt de um
 * "Agente 3". Aqui ela vira rotina do sistema, e o motivo é concreto, não
 * preferência: **nenhuma ferramenta de agente manda mensagem a cliente** (são
 * oito no Chatwoot, e nenhuma envia), e um agente não cabe na fila — o teto é
 * de 12 passos de ferramenta por execução e cada task consome de 4 a 6. Por
 * fora, o comportamento é o que ele descreveu: mesmos textos, mesmos
 * marcadores, mesma cadência, mesmos status.
 *
 * ⚠⚠ **Esta capacidade é a exceção consciente à regra que cala o robô quando a
 * conversa tem dono.** Em todo o resto do sistema, conversa atribuída a uma
 * pessoa significa silêncio — é o que impede o robô de falar por cima de quem
 * está atendendo. Aqui ele FALA, e o Diego pediu isso sabendo (10/11/2026).
 * Por isso as travas de `podeFalar` não são enfeite: são o que separa "o
 * sistema lembrou o cliente do link" de "o robô cortou o vendedor no meio de
 * uma frase".
 */

/** Chave das reservas desta capacidade em `WebhookEvent`. */
export const PROVIDER_ACOMPANHAMENTO = "ACOMPANHAMENTO";

/** "Base de clientes", a mesma lista do aviso de cobrança e da renovação. */
export const LISTA_BASE_DE_CLIENTES = "900701122530";

/**
 * ⚠⚠ **O status tem EMOJI no nome, e o filtro da API é literal.** A lista
 * "Base de clientes" chama o status de `🏃‍♂️onboarding` (e o de contrato, de
 * `📝 contrato`) — conferido em `GET /list/900701122530` em 10/11/2026.
 * Filtrar por `"onboarding"` devolve ZERO tarefas, e a rodada diria "nada a
 * enviar" para sempre, sem erro nenhum. Já `ongoing` é limpo.
 */
export const STATUS_ALVO = "🏃‍♂️onboarding";
export const STATUS_FINAL = "ongoing";

/**
 * O mesmo status para COMPARAR, sem depender do emoji.
 *
 * O nome exato é obrigatório no filtro da API; aqui, não — e amarrar a
 * comparação ao emoji faria a capacidade parar no dia em que alguém o
 * removesse da tela. Nenhum outro status da lista contém "onboarding".
 */
export function ehOStatusAlvo(status: string | null | undefined) {
  return (status ?? "").toLowerCase().includes("onboarding");
}

export const ETIQUETA_PAGAMENTO = "pagamento pendente";
export const ETIQUETA_ASSINATURA = "falta assinatura";

/** De dez em dez minutos, como o Diego especificou. */
export const CONFERIR_A_CADA_MS = 10 * 60_000;

/**
 * Quantas tasks a rodada trata por vez.
 *
 * ⚠ O teto protege o TOKEN do ClickUp, que é o mesmo que os agentes usam para
 * gravar no CRM durante o atendimento — e, aqui, protege também o cliente: ao
 * ligar pela primeira vez pode haver uma fila acumulada, e dez mensagens por
 * rodada é diferente de quarenta de uma vez.
 */
export const TAREFAS_POR_RODADA = 10;

/**
 * Quanto tempo o sistema espera depois de alguém ter falado na conversa.
 *
 * É o coração da exceção: o vendedor está com a conversa, e uma mensagem
 * automática no meio de uma troca viva é exatamente o estrago que a regra
 * original evita. Dez minutos sem ninguém falar é uma conversa parada, não uma
 * conversa em andamento.
 */
export const ESPERA_APOS_FALA_MS = 10 * 60_000;

export type Etapa = "inicial" | "pagamento" | "assinatura" | "final";

/** Os links daquela contratação, lidos do registro do agente que os gerou. */
export type LinksDaContratacao = {
  pagamento: string | null;
  assinatura: string | null;
  /** O token do documento na ZapSign — é por ele que se confere a assinatura. */
  documentoZapSign: string | null;
  /** O id do contrato no Conexa — é por ele que se confere o pagamento. */
  contratoConexa: number | null;
};

export type Confirmacoes = { pago: boolean; assinado: boolean };

/**
 * Qual mensagem mandar agora — ou nenhuma.
 *
 * A ordem é a do Diego: a inicial vem antes de tudo; as de confirmação só
 * valem enquanto FALTA a outra metade; e quando as duas fecham, vai a final,
 * mesmo que as intermediárias nunca tenham saído.
 *
 * ⚠ **Com um link só, não manda nada.** O Agente 2 cria o contrato e o
 * documento no mesmo turno: ter apenas um significa que o outro FALHOU, e aí
 * há uma pessoa para resolver — mandar meia mensagem ao cliente só
 * atrapalharia. A rodada registra a espera em vez de ficar calada.
 */
export function etapaAEnviar(
  links: LinksDaContratacao,
  confirmacoes: Confirmacoes,
  jaEnviadas: ReadonlySet<Etapa>,
): Etapa | null {
  const { pago, assinado } = confirmacoes;

  if (pago && assinado) return jaEnviadas.has("final") ? null : "final";

  if (!jaEnviadas.has("inicial")) {
    if (!links.pagamento || !links.assinatura) return null;
    return "inicial";
  }

  // As de confirmação citam o link que ainda falta: sem ele, não há mensagem
  // honesta a mandar.
  if (pago && !assinado && links.assinatura) {
    return jaEnviadas.has("pagamento") ? null : "pagamento";
  }
  if (assinado && !pago && links.pagamento) {
    return jaEnviadas.has("assinatura") ? null : "assinatura";
  }

  return null;
}

/** Quem escreveu por último na conversa. */
export type Remetente = "cliente" | "equipe" | "robo" | "desconhecido";

export type ConversaParaFalar = {
  /** `open`, `pending`, `resolved`… como o Chatwoot devolve. */
  status: string;
  ultimaMensagem: { deQuem: Remetente; em: Date } | null;
};

export type Permissao = { pode: true } | { pode: false; motivo: string };

/**
 * O robô pode falar nesta conversa AGORA?
 *
 * ⚠ Esta função é a exceção inteira. Ela não decide se a mensagem é devida —
 * isso é `etapaAEnviar` — e sim se este é um momento em que falar não atropela
 * ninguém.
 *
 * - **Conversa resolvida: não.** Resolver é decisão de uma pessoa, e o nosso
 *   lembrete não reabre o assunto por conta própria. Quem reabre é o passo que
 *   trata a conversa fechada, antes de chegar aqui.
 * - **A equipe falou há pouco: não.** O vendedor está no meio de uma troca. O
 *   lembrete espera a rodada seguinte, e a seguinte — a mensagem continua
 *   devida, só não é urgente.
 * - **O cliente falou há pouco e ninguém respondeu: não.** Ele está esperando
 *   uma PESSOA. Entrar com "segue o link de pagamento" por cima de uma
 *   pergunta sem resposta é o pior caso possível desta capacidade.
 * - **Remetente de tipo desconhecido conta como equipe.** A dúvida pende para
 *   o silêncio, como em todo o resto do sistema.
 */
export function podeFalar(
  conversa: ConversaParaFalar,
  agora: Date,
  esperaMs = ESPERA_APOS_FALA_MS,
): Permissao {
  const status = conversa.status.trim().toLowerCase();
  if (status === "resolved") {
    return { pode: false, motivo: "a conversa está resolvida" };
  }

  const ultima = conversa.ultimaMensagem;
  if (!ultima) return { pode: true };

  const desde = agora.getTime() - ultima.em.getTime();
  if (desde >= esperaMs) return { pode: true };

  const minutos = Math.max(1, Math.round(desde / 60_000));
  if (ultima.deQuem === "cliente") {
    return {
      pode: false,
      motivo: `o cliente escreveu há ${minutos} min e ainda não foi respondido`,
    };
  }
  if (ultima.deQuem === "equipe" || ultima.deQuem === "desconhecido") {
    return { pode: false, motivo: `a equipe escreveu há ${minutos} min` };
  }

  // A última foi do próprio robô: não há ninguém para atropelar.
  return { pode: true };
}

/** A task ainda está no ciclo? */
export function aindaNoCiclo(estado: {
  status: string;
  etiquetas: readonly string[];
}): boolean {
  if (!ehOStatusAlvo(estado.status)) return false;
  const tem = new Set(estado.etiquetas.map((e) => e.trim().toLowerCase()));
  return tem.has(ETIQUETA_PAGAMENTO) || tem.has(ETIQUETA_ASSINATURA);
}

/**
 * O marcador que fica no comentário da task.
 *
 * Mantém a convenção que o Diego escreveu — é o que a equipe vê na task. ⚠ Mas
 * ele NÃO é a trava de idempotência: `clickup_listar_comentarios` devolve só os
 * 25 comentários mais recentes, e numa task movimentada o marcador sai da
 * janela. Quem impede a mensagem repetida é a reserva em `WebhookEvent`.
 */
export const MARCADOR = "🤖 [Acomp. Contrato]";

const DESCRICAO_DA_ETAPA: Record<Etapa, string> = {
  inicial: "Mensagem inicial enviada",
  pagamento: "Pagamento confirmado",
  assinatura: "Assinatura confirmada",
  final: "Processo concluído — pagamento e assinatura confirmados",
};

export function comentarioDaEtapa(etapa: Etapa, agora: Date) {
  return `${MARCADOR} ${DESCRICAO_DA_ETAPA[etapa]} em ${dataHora(agora)}`;
}

/** A chave da reserva: uma task, uma etapa, uma mensagem. */
export function chaveDaEtapa(taskId: string, etapa: Etapa) {
  return `${etapa}:${taskId}`;
}

export type DadosDaMensagem = {
  nome: string;
  linkPagamento?: string | null;
  linkAssinatura?: string | null;
};

/**
 * Os textos, como o Diego escreveu — palavra por palavra.
 *
 * ⚠ **Sem carimbo de robô**, ao contrário das notas internas do sistema. Aqui
 * quem lê é o cliente, e o sistema está falando pela Seahub como os agentes já
 * falam. Quem precisa saber que foi automático é a equipe, e para ela fica a
 * nota interna no mesmo fio.
 */
export function mensagemDaEtapa(etapa: Etapa, dados: DadosDaMensagem): string {
  const nome = primeiroNome(dados.nome);
  const ola = nome ? `Olá, ${nome}!` : "Olá!";
  const boaNoticia = nome ? `Boa notícia, ${nome}!` : "Boa notícia!";
  const confirmamos = nome ? `${nome}, confirmamos tudo!` : "Confirmamos tudo!";

  if (etapa === "inicial") {
    return [
      `${ola} Tudo bem? 😊`,
      "",
      "Seu contrato com o Seahub está pronto para as próximas etapas! Preparamos dois links para você:",
      "",
      `💳 Link de pagamento: ${dados.linkPagamento}`,
      `✍️ Link de assinatura: ${dados.linkAssinatura}`,
      "",
      "Assim que identificarmos o pagamento e a assinatura, enviaremos toda a documentação referente à sua contratação.",
      "",
      "Qualquer dúvida, estamos à disposição!",
    ].join("\n");
  }

  if (etapa === "pagamento") {
    return [
      `${boaNoticia} ✅`,
      "",
      "Identificamos o seu pagamento com sucesso! Agora só falta a assinatura do contrato para finalizarmos tudo:",
      "",
      `✍️ ${dados.linkAssinatura}`,
      "",
      "Assim que assinar, te avisamos e liberamos a documentação. Obrigado! 🙏",
    ].join("\n");
  }

  if (etapa === "assinatura") {
    return [
      `${boaNoticia} ✅`,
      "",
      "Identificamos a assinatura do seu contrato com sucesso! Agora só falta a confirmação do pagamento para finalizarmos tudo:",
      "",
      `💳 ${dados.linkPagamento}`,
      "",
      "Assim que o pagamento for identificado, te avisamos e liberamos a documentação. Obrigado! 🙏",
    ].join("\n");
  }

  return [
    `${confirmamos} 🎉`,
    "",
    "✅ Pagamento identificado",
    "✅ Assinatura identificada",
    "",
    "Muito obrigado pela confiança no Seahub! A documentação referente à sua contratação já foi enviada por e-mail, com todas as orientações necessárias.",
    "",
    "Qualquer dúvida, é só chamar por aqui. Seja bem-vindo(a)! 🙌",
  ].join("\n");
}

/**
 * A nota interna que fica para o vendedor, no mesmo fio.
 *
 * ⚠ É ela que torna a exceção honesta: o cliente vê uma mensagem normal da
 * Seahub, e quem está com a conversa vê que foi o sistema que falou, o quê e
 * quando. Sem isso, o vendedor leria uma mensagem que ele não escreveu, em
 * nome dele.
 */
export function notaParaOVendedor(etapa: Etapa, taskUrl: string | null) {
  const o = {
    inicial: "os links de pagamento e assinatura",
    pagamento: "o aviso de pagamento confirmado",
    assinatura: "o aviso de assinatura confirmada",
    final: "a confirmação final (pagamento e assinatura)",
  }[etapa];
  const fim = taskUrl ? ` Task: ${taskUrl}` : "";
  return `${MARCADOR} Enviei ao cliente ${o}. Mensagem automática do acompanhamento de contrato; a conversa continua com você.${fim}`;
}

/**
 * "Maria Eduarda de Medeiros" → "Maria".
 *
 * ⚠ Devolve `null` quando não há nome, e quem monta a frase trata o caso. A
 * primeira versão devolvia um texto de reserva, e a saudação saía "Olá, tudo
 * bem! Tudo bem? 😊". Na prática o campo `RESPONSÁVEL` é obrigatório para o
 * contrato existir, então isto quase nunca acontece — mas "quase nunca" não é
 * nunca, e a mensagem vai para um cliente.
 */
export function primeiroNome(nome: string | null | undefined): string | null {
  const limpo = (nome ?? "").trim().replace(/\s+/g, " ");
  return limpo ? limpo.split(" ")[0] : null;
}

function dataHora(d: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(d)
    .replace(",", "");
}
