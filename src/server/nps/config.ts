import { z } from "zod";
import { CHAVE_DE_CHECKBOX } from "@/server/conversa-marcada/evento";

/**
 * Configuração da pesquisa de satisfação: a linha `NPS` de `Integration`.
 *
 * Os padrões são os do fluxo "NPS SEAHUB" do n8n que esta função substitui
 * (15/09/2026) — o checkbox, a caixa, as duas listas do CRM e os textos, letra
 * por letra —, então ligar sem mexer em nada reproduz o que a equipe conhece. O
 * que mudou de propósito está em `regras.ts` e na seção do AGENTS.md.
 */

export const TEXTOS_PADRAO = {
  agradecimento:
    "Muito obrigado pelo seu contato! 😊\n\nA conversa será encerrada automaticamente após alguns minutos de inatividade.",
  convite:
    "Vou te encaminhar uma pesquisa de satisfação com uma pergunta sobre o nosso atendimento e serviço.:",
  pergunta:
    "De 1 à 5, o quanto você indicaria o Seahub?\n\n1- ⭐\n2- ⭐⭐\n3- ⭐⭐⭐\n4- ⭐⭐⭐⭐\n5- ⭐⭐⭐⭐⭐",
  lembrete:
    "Olá! 👋 Consegue responder nossa pesquisa do último atendimento? Sua opinião nos ajuda a melhorar sempre. 💙\n\nEste atendimento será encerrado automaticamente após 1 hora.\nSe precisar falar conosco novamente, basta enviar uma nova mensagem.",
  notaBaixa:
    "Agradecemos sua avaliação e sentimos muito que sua experiência não tenha sido ideal.🙏 Queremos melhorar.\n\nPode nos contar o que aconteceu para ajustarmos rapidamente?",
  notaAlta:
    "Muito obrigado pela sua avaliação!💙\n\nFicamos felizes em saber que teve uma boa experiência. Conte sempre com o Seahub!",
};

const texto = (padrao: string) => z.string().trim().min(1).default(padrao);

export const npsConfigSchema = z.object({
  /** A chave do checkbox da conversa que manda a pesquisa. */
  checkbox: z.string().regex(CHAVE_DE_CHECKBOX).default("nps_perdido"),
  /** Caixas em que a pesquisa vale. Marcar o checkbox noutra caixa não faz nada. */
  caixas: z.array(z.number().int().positive()).min(1).default([29]),
  /** Onde gravar a nota: apelido cadastrado no ClickUp ou id da lista. */
  listasDaNota: z
    .array(z.string().trim().min(1))
    .max(5)
    .default(["901306195904", "901302419821"]),
  campoDaNota: z.string().trim().min(1).default("NPS"),
  campoDoTelefone: z.string().trim().min(1).default("CELULAR"),
  horasAteLembrete: z.number().min(0.25).max(48).default(3),
  /** Depois do lembrete, sem nota, a conversa é resolvida. */
  horasAteEncerrar: z.number().min(0.25).max(48).default(1),
  /**
   * Depois da nota, a conversa é resolvida quando o cliente fica este tempo sem
   * escrever. Era 1 minuto no n8n; o usuário pediu 5 ou 10 (15/09/2026), para
   * quem responde "o que aconteceu?" ter tempo de contar.
   */
  minutosAposNota: z.number().int().min(1).max(120).default(10),
  /** O mesmo telefone não recebe a pesquisa de novo dentro deste intervalo. 0 = sem limite. */
  horasEntrePesquisas: z.number().int().min(0).max(720).default(24),
  textos: z
    .object({
      agradecimento: texto(TEXTOS_PADRAO.agradecimento),
      convite: texto(TEXTOS_PADRAO.convite),
      pergunta: texto(TEXTOS_PADRAO.pergunta),
      lembrete: texto(TEXTOS_PADRAO.lembrete),
      notaBaixa: texto(TEXTOS_PADRAO.notaBaixa),
      notaAlta: texto(TEXTOS_PADRAO.notaAlta),
    })
    .default(TEXTOS_PADRAO),
});

export type NpsConfig = z.infer<typeof npsConfigSchema>;

/**
 * A config gravada, com os padrões no que faltar. Só o formulário grava, e ele
 * valida antes: config inválida aqui é linha mexida à mão, e cai nos padrões.
 */
export function lerConfigNps(bruto: unknown): NpsConfig {
  const lido = npsConfigSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : npsConfigSchema.parse({});
}

const ROTULOS: Record<string, string> = {
  checkbox: "Checkbox (minúsculas, números e _)",
  caixas: "Caixas",
  listasDaNota: "Listas onde gravar a nota (até 5)",
  campoDaNota: "Campo da nota",
  campoDoTelefone: "Campo do telefone",
  horasAteLembrete: "Horas até o lembrete (de 0,25 a 48)",
  horasAteEncerrar: "Horas até encerrar sem nota (de 0,25 a 48)",
  minutosAposNota: "Minutos até encerrar depois da nota (inteiro, de 1 a 120)",
  horasEntrePesquisas: "Intervalo por telefone (inteiro, de 0 a 720 horas)",
  agradecimento: "Texto de agradecimento",
  convite: "Texto de convite",
  pergunta: "Texto da pergunta",
  lembrete: "Texto do lembrete",
  notaBaixa: "Resposta à nota de 1 a 3",
  notaAlta: "Resposta à nota 4 ou 5",
};

/**
 * O formulário da tela de Integrações vira config — ou a primeira recusa, em
 * texto para quem preencheu. Número em branco é recusa, não zero: `Number("")`
 * é 0, e "sem intervalo por telefone" não pode nascer de um campo esquecido.
 */
export function configDoFormulario(
  ler: (campo: string) => string | null,
): { config: NpsConfig } | { erro: string } {
  const valor = (campo: string) => (ler(campo) ?? "").replace(/\r\n/g, "\n").trim();
  const itens = (campo: string) =>
    valor(campo)
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const numero = (campo: string) => {
    const bruto = valor(campo).replace(",", ".");
    return bruto === "" ? Number.NaN : Number(bruto);
  };

  const caixas = itens("caixas").map(Number);
  if (caixas.length === 0 || caixas.some((n) => !Number.isInteger(n) || n <= 0)) {
    return {
      erro: "Caixas: informe o número de cada caixa do Chatwoot (ex.: 29), separados por vírgula.",
    };
  }

  const candidato = {
    checkbox: valor("checkbox"),
    caixas: [...new Set(caixas)],
    listasDaNota: [...new Set(itens("listasDaNota"))],
    campoDaNota: valor("campoDaNota"),
    campoDoTelefone: valor("campoDoTelefone"),
    horasAteLembrete: numero("horasAteLembrete"),
    horasAteEncerrar: numero("horasAteEncerrar"),
    minutosAposNota: numero("minutosAposNota"),
    horasEntrePesquisas: numero("horasEntrePesquisas"),
    textos: {
      agradecimento: valor("textoAgradecimento"),
      convite: valor("textoConvite"),
      pergunta: valor("textoPergunta"),
      lembrete: valor("textoLembrete"),
      notaBaixa: valor("textoNotaBaixa"),
      notaAlta: valor("textoNotaAlta"),
    },
  };

  const lido = npsConfigSchema.safeParse(candidato);
  if (!lido.success) {
    const caminho = (lido.error.issues[0]?.path ?? []).map(String);
    const chave = caminho.at(-1) ?? "";
    return { erro: `${ROTULOS[chave] ?? caminho.join(".")}: valor inválido ou em branco.` };
  }
  return { config: lido.data };
}
