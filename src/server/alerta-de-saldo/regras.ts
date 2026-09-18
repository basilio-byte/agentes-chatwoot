import { mesmoTelefone } from "@/server/integrations/clickup/telefone";
import {
  classificarSaldo,
  diasDeSaldo,
  SALDO_MINIMO_USD,
  type LeituraDeSaldo,
} from "@/server/consumo/saldo";

/**
 * Alerta de saldo da OpenRouter por WhatsApp — as regras, sem banco nem rede.
 *
 * Pedido do usuário em 18/09/2026: *"usar o número conectado para enviar
 * mensagem para 3 pessoas, quando o saldo estiver abaixo de 20 dólares"*. É o
 * que o fluxo "Notificar Saldo Openrouter" do n8n pretendia fazer e nunca fez
 * (o nó de decisão não tinha saída ligada). A mensagem sai pela caixa 31, que
 * é API não oficial: sem janela de 24 h, dá para iniciar conversa a qualquer
 * momento.
 *
 * Decisões do usuário no mesmo dia: manda a QUALQUER hora; repete no máximo a
 * cada 24 h enquanto o saldo continuar abaixo; e só Administrador para cima vê
 * e edita os números.
 */

export const MAX_DESTINATARIOS = 10;

/** Enquanto o saldo continua abaixo do limite, o aviso se repete neste intervalo. */
export const INTERVALO_ENTRE_AVISOS_MS = 24 * 60 * 60_000;

/**
 * De quanto em quanto tempo o vigia confere o saldo. O vigia roda de minuto em
 * minuto; ler a OpenRouter a cada minuto seria 1.440 leituras por dia para um
 * número que muda devagar. Com o cache de 5 min da leitura, o saldo que acaba
 * vira aviso em no máximo ~15 min.
 */
export const CONFERIR_A_CADA_MS = 10 * 60_000;

/** O botão de teste manda WhatsApp de verdade: um clique duplo não pode mandar dois. */
export const INTERVALO_ENTRE_TESTES_MS = 60_000;

export const PAGINA_DE_CREDITOS = "https://openrouter.ai/settings/credits";

export type Destinatario = { nome: string; telefone: string };

export type TipoDeAviso = "BAIXO" | "ZERADO" | "TESTE";

/**
 * O telefone em E.164 (`+5584999999999`), que é o que o Chatwoot aceita.
 *
 * Brasileiro com DDD, com ou sem o 55, com ou sem máscara. Estrangeiro só com
 * `+` na frente — sem ele, onze dígitos são DDD e número, não outro país.
 *
 * ⚠ O nono dígito fica como a pessoa digitou. Há conta de WhatsApp registrada
 * sem ele, e acrescentar por conta própria mandaria para um número que não
 * existe. Quem prova que chega é o botão de teste.
 */
export function normalizarTelefone(bruto: string): string | null {
  const texto = bruto.trim();
  const digitos = texto.replace(/\D/g, "");
  if (!digitos) return null;

  if (texto.startsWith("+") && !digitos.startsWith("55")) {
    return digitos.length >= 8 && digitos.length <= 15 ? `+${digitos}` : null;
  }

  // 12 ou 13 dígitos começando com 55 é o país na frente. Onze começando com 55
  // é o DDD 55 (Santa Maria), e o 55 fica.
  const nacional =
    digitos.startsWith("55") && (digitos.length === 12 || digitos.length === 13)
      ? digitos.slice(2)
      : digitos;

  return nacional.length === 10 || nacional.length === 11 ? `+55${nacional}` : null;
}

/** `+5584999999999` → `+55 84 99999-9999`. Estrangeiro volta como veio. */
export function formatarTelefone(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : e164;
}

/**
 * O mesmo número? Brasileiro com ou sem o nono dígito — é como o WhatsApp grava
 * e como a equipe digita. Estrangeiro, dígito por dígito.
 */
export function mesmoNumero(a: string, b: string): boolean {
  if (mesmoTelefone(a, b)) return true;
  const x = a.replace(/\D/g, "");
  return x.length >= 8 && x === b.replace(/\D/g, "");
}

/**
 * As linhas do formulário. Linha inteiramente vazia é ignorada; linha com nome
 * e sem telefone válido é recusada — sumir com ela em silêncio deixaria a
 * pessoa achando que vai receber.
 */
export function lerDestinatarios(
  nomes: string[],
  telefones: string[],
): { destinatarios: Destinatario[] } | { erro: string } {
  const destinatarios: Destinatario[] = [];

  for (let i = 0; i < Math.max(nomes.length, telefones.length); i++) {
    const nome = (nomes[i] ?? "").trim();
    const bruto = (telefones[i] ?? "").trim();
    if (!nome && !bruto) continue;

    if (!bruto) return { erro: `Falta o telefone de ${nome}.` };
    const telefone = normalizarTelefone(bruto);
    if (!telefone) {
      return {
        erro: `"${bruto}" não parece um telefone. Use DDD e número, como (84) 99999-9999, ou +país para número de fora.`,
      };
    }

    const repetido = destinatarios.find((d) => mesmoNumero(d.telefone, telefone));
    if (repetido) {
      return { erro: `O telefone de ${nome || "uma das linhas"} é o mesmo de ${repetido.nome}.` };
    }

    destinatarios.push({ nome: nome || formatarTelefone(telefone), telefone });
  }

  if (destinatarios.length > MAX_DESTINATARIOS) {
    return { erro: `No máximo ${MAX_DESTINATARIOS} pessoas.` };
  }
  return { destinatarios };
}

/** O que está gravado no banco, lido sem confiar na forma. */
export function destinatariosSalvos(bruto: unknown): Destinatario[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.flatMap((d) => {
    const nome = typeof d?.nome === "string" ? d.nome.trim() : "";
    const telefone = typeof d?.telefone === "string" ? normalizarTelefone(d.telefone) : null;
    return telefone ? [{ nome: nome || formatarTelefone(telefone), telefone }] : [];
  });
}

/** `"20"`, `"20,50"`, `"US$ 20.5"` → número. Nulo quando não é um valor positivo. */
export function lerLimite(bruto: string): number | null {
  const limpo = bruto.replace(/[^\d,.-]/g, "").replace(",", ".");
  const valor = Number(limpo);
  if (!limpo || !Number.isFinite(valor) || valor <= 0 || valor > 100_000) return null;
  return Math.round(valor * 100) / 100;
}

export type EstadoDoAlerta = {
  abaixoDesde: Date | null;
  avisadoEm: Date | null;
  avisadoTipo: TipoDeAviso | null;
};

export type Decisao =
  /** Nada a fazer agora. `falha` distingue "desligado" de "não consegui conferir". */
  | { acao: "ignorar"; falha: boolean; motivo: string }
  /** Saldo acima do limite: o episódio, se havia, acabou. */
  | { acao: "normalizar"; saldoUsd: number }
  /** Abaixo do limite, mas o último aviso ainda não fez 24 h. */
  | { acao: "aguardar"; saldoUsd: number; proximoEm: Date }
  | {
      acao: "avisar";
      tipo: "BAIXO" | "ZERADO";
      saldoUsd: number;
      origem: "conta" | "chave";
      /** Primeiro aviso desde que o saldo caiu abaixo do limite. */
      iniciaEpisodio: boolean;
    };

/**
 * Avisa ou não avisa.
 *
 * ⚠ **Leitura que falha nunca vira aviso.** Mesma doutrina da tela: um timeout
 * nosso não é um fato sobre a conta deles, e um "saldo baixo" inventado manda
 * alguém recarregar à toa — o tipo de alarme falso que ensina a ignorar o
 * verdadeiro.
 *
 * O episódio começa quando o saldo cai abaixo do limite e termina quando volta
 * acima, que é o que acontece ao recarregar. Dentro dele: um aviso ao começar,
 * outro a cada 24 h, e um a mais, fora do intervalo, se o saldo ZERAR — é
 * quando os agentes param, e esperar o dia seguinte para dizer isso seria um
 * dia inteiro de cliente sem resposta.
 */
export function decidirAviso(args: {
  leitura: LeituraDeSaldo;
  ligado: boolean;
  limiteUsd: number;
  temDestinatarios: boolean;
  estado: EstadoDoAlerta;
  agora: Date;
}): Decisao {
  const { leitura, estado, agora } = args;

  if (!args.ligado) return { acao: "ignorar", falha: false, motivo: "alerta desligado" };
  if (!args.temDestinatarios) {
    return { acao: "ignorar", falha: false, motivo: "nenhum telefone cadastrado" };
  }
  if (leitura.estado === "sem_chave") {
    return { acao: "ignorar", falha: true, motivo: "sem chave da OpenRouter configurada" };
  }
  if (leitura.estado !== "lido") {
    return {
      acao: "ignorar",
      falha: true,
      motivo: `não consegui saber o saldo: ${leitura.motivo}`,
    };
  }

  const situacao = classificarSaldo(leitura.saldoUsd, args.limiteUsd);
  if (situacao === "ok") return { acao: "normalizar", saldoUsd: leitura.saldoUsd };

  const tipo = situacao === "esgotado" ? "ZERADO" : "BAIXO";
  const zerouAgora = tipo === "ZERADO" && estado.avisadoTipo !== "ZERADO";
  const passouOIntervalo =
    estado.avisadoEm == null ||
    agora.getTime() - estado.avisadoEm.getTime() >= INTERVALO_ENTRE_AVISOS_MS;

  if (passouOIntervalo || zerouAgora) {
    return {
      acao: "avisar",
      tipo,
      saldoUsd: leitura.saldoUsd,
      origem: leitura.origem,
      iniciaEpisodio: estado.abaixoDesde == null,
    };
  }

  return {
    acao: "aguardar",
    saldoUsd: leitura.saldoUsd,
    proximoEm: new Date(estado.avisadoEm!.getTime() + INTERVALO_ENTRE_AVISOS_MS),
  };
}

/** `US$ 18,42` — duas casas, sem o espaço inquebrável do `Intl`, que o WhatsApp mostra torto. */
export function dolar(valor: number): string {
  const numero = valor.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `US$ ${numero}`;
}

/** Arredonda para baixo: prometer o dia que talvez não exista é o erro caro. */
function quantoDura(dias: number): string {
  if (dias < 1) return "menos de um dia";
  const inteiro = Math.floor(dias);
  return inteiro === 1 ? "cerca de 1 dia" : `cerca de ${inteiro} dias`;
}

/** Em itálico inteiro: `_…_` só vale como marcação do WhatsApp se fechar no fim. */
const assinatura = (extra = "") =>
  `_Aviso automático do painel Seahub Agentes.${extra ? ` ${extra}` : ""}_`;

/**
 * O texto que chega no WhatsApp. `*negrito*` e `_itálico_` são do próprio
 * WhatsApp; a caixa é API, então o Chatwoot repassa o texto como está.
 */
export function textoDoAviso(args: {
  tipo: TipoDeAviso;
  /** Nulo só no teste, quando a leitura do saldo falhou. */
  saldoUsd: number | null;
  limiteUsd: number;
  origem?: "conta" | "chave";
  gastoDiarioUsd?: number;
  diasDaMedia?: number;
  /** Quem apertou o botão de teste. */
  autor?: string | null;
  /** No teste, por que o saldo não veio. */
  motivoSemSaldo?: string | null;
}): string {
  const saldo = args.saldoUsd;

  if (args.tipo === "TESTE") {
    const quem = args.autor?.trim() ? `por ${args.autor.trim()} ` : "";
    const agora =
      saldo == null
        ? `Não consegui ler o saldo agora${args.motivoSemSaldo ? ` (${args.motivoSemSaldo})` : ""}.`
        : `Saldo agora: ${dolar(saldo)}.`;
    return [
      "✅ *Teste do alerta de saldo da OpenRouter*",
      "",
      `Mandado ${quem}pelo painel. ${agora} O alerta sai quando o saldo fica abaixo de ${dolar(args.limiteUsd)}.`,
      "",
      "Se você recebeu esta mensagem, os alertas de saldo chegam até você.",
    ].join("\n");
  }

  if (args.tipo === "ZERADO") {
    return [
      "🚨 *Saldo da OpenRouter ZERADO*",
      "",
      `Saldo: ${dolar(saldo ?? 0)}. Os agentes de I.A. já não conseguem responder aos clientes: quem escreve recebe um aviso de instabilidade e fica esperando uma pessoa.`,
      "",
      `Recarregue agora em ${PAGINA_DE_CREDITOS}`,
      "",
      assinatura(),
    ].join("\n");
  }

  // O teto de uma chave pode ser bem menor que o saldo da conta: o texto diz
  // qual dos dois está falando, como a tela.
  const restam =
    args.origem === "chave"
      ? `Restam ${dolar(saldo ?? 0)} do teto da chave usada pelos agentes`
      : `Restam ${dolar(saldo ?? 0)}`;

  const dias =
    saldo != null && args.gastoDiarioUsd != null
      ? diasDeSaldo(saldo, args.gastoDiarioUsd)
      : null;
  const ritmo =
    dias != null
      ? `No ritmo dos últimos ${args.diasDaMedia ?? 7} dias (${dolar(args.gastoDiarioUsd!)} por dia), dura ${quantoDura(dias)}.`
      : null;

  return [
    "⚠️ *Saldo baixo na OpenRouter*",
    "",
    `${restam}, abaixo do limite de alerta de ${dolar(args.limiteUsd)}.`,
    ...(ritmo ? [ritmo] : []),
    "",
    `Quando o saldo acabar, os agentes de I.A. param de responder aos clientes. Recarregue em ${PAGINA_DE_CREDITOS}`,
    "",
    assinatura("Repete a cada 24 h enquanto o saldo estiver abaixo do limite."),
  ].join("\n");
}

/** O padrão quando ninguém configurou nada: o limite herdado do n8n. */
export const LIMITE_PADRAO_USD = SALDO_MINIMO_USD;
