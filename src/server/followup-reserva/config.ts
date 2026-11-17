import { z } from "zod";

/**
 * Configuração do follow-up de reserva: a linha `FOLLOWUP_RESERVA` de
 * `Integration`. O liga/desliga é o `enabled` da linha; aqui mora o resto.
 *
 * ⚠ Ligada começa em `sombra`: a rodada lê o Conexa e o Chatwoot, decide e
 * registra o que faria, sem mandar nada a ninguém. Passar para `ligado` é o que
 * fala com o cliente.
 */

/** Os marcadores que o texto aceita. Marcador desconhecido sairia literal ao cliente. */
export const MARCADORES = ["nome", "sala", "data", "inicio", "fim", "valor", "link"] as const;

export const TEXTO_PADRAO = [
  "Oi, {nome}! Passando para confirmar a sua reserva:",
  "",
  "🛋️ {sala}",
  "📅 {data}, das {inicio} às {fim}",
  "",
  "Ainda não identificamos o pagamento de {valor}. Se ainda não pagou, é por aqui: {link}",
  "Se já pagou, pode desconsiderar. 😊",
  "",
  "Está tudo certo para a sua reserva? Se precisar alterar ou cancelar, é só me avisar por aqui.",
].join("\n");

/** Os marcadores do texto, sem repetição, na ordem em que aparecem. */
export function marcadoresDoTexto(texto: string): string[] {
  return [...new Set([...texto.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]))];
}

export const followupConfigSchema = z
  .object({
    modo: z.enum(["sombra", "ligado"]).default("sombra"),
    /** Quanto antes do início da reserva o follow-up sai, no máximo. */
    horasAntesDoInicio: z.number().min(0.5).max(48).default(3),
    /** Nunca antes disto depois de a reserva ser criada: o cliente acabou de receber a confirmação. */
    minutosAposReserva: z.number().int().min(10).max(720).default(30),
    /** Horário em que a mensagem pode sair (São Paulo), de `horaDeInicio` até antes de `horaDeFim`. */
    horaDeInicio: z.number().int().min(0).max(23).default(8),
    horaDeFim: z.number().int().min(1).max(24).default(20),
    texto: z.string().trim().min(20).default(TEXTO_PADRAO),
  })
  .refine((c) => c.horaDeFim > c.horaDeInicio, {
    path: ["horaDeFim"],
    message: "o fim do horário tem de ser depois do começo",
  })
  .refine((c) => marcadoresDoTexto(c.texto).every((m) => (MARCADORES as readonly string[]).includes(m)), {
    path: ["texto"],
    message: "marcador desconhecido",
  })
  .refine((c) => marcadoresDoTexto(c.texto).includes("link"), {
    path: ["texto"],
    message: "o texto precisa ter {link}",
  });

export type FollowupConfig = z.infer<typeof followupConfigSchema>;

/** A config gravada, com os padrões no que faltar; inválida cai nos padrões. */
export function lerConfigFollowup(bruto: unknown): FollowupConfig {
  const lido = followupConfigSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : followupConfigSchema.parse({});
}

/**
 * O formulário da aba vira config — ou a primeira recusa, em texto para quem
 * preencheu. Número em branco é recusa, não zero.
 */
export function configDoFormulario(
  ler: (campo: string) => string | null,
): { config: FollowupConfig } | { erro: string } {
  const valor = (campo: string) => (ler(campo) ?? "").replace(/\r\n/g, "\n").trim();
  const numero = (campo: string) => {
    const bruto = valor(campo).replace(",", ".");
    return bruto === "" ? Number.NaN : Number(bruto);
  };

  const texto = valor("texto");
  const desconhecidos = marcadoresDoTexto(texto).filter(
    (m) => !(MARCADORES as readonly string[]).includes(m),
  );
  if (desconhecidos.length) {
    return {
      erro: `Texto: ${desconhecidos.map((m) => `{${m}}`).join(", ")} não é marcador conhecido. Use ${MARCADORES.map((m) => `{${m}}`).join(", ")}.`,
    };
  }
  if (texto && !marcadoresDoTexto(texto).includes("link")) {
    return { erro: "Texto: precisa ter {link}, que é o link da cobrança." };
  }

  const lido = followupConfigSchema.safeParse({
    modo: valor("modo"),
    horasAntesDoInicio: numero("horasAntesDoInicio"),
    minutosAposReserva: numero("minutosAposReserva"),
    horaDeInicio: numero("horaDeInicio"),
    horaDeFim: numero("horaDeFim"),
    texto,
  });
  if (!lido.success) {
    const campo = String(lido.error.issues[0]?.path?.[0] ?? "");
    const rotulo: Record<string, string> = {
      modo: "Modo",
      horasAntesDoInicio: "Horas antes do início (de 0,5 a 48)",
      minutosAposReserva: "Minutos depois de reservar (inteiro, de 10 a 720)",
      horaDeInicio: "Hora em que o envio começa (0 a 23)",
      horaDeFim: "Hora em que o envio para (1 a 24, depois do começo)",
      texto: "Texto (pelo menos 20 caracteres)",
    };
    return { erro: `${rotulo[campo] ?? campo}: valor inválido ou em branco.` };
  }
  return { config: lido.data };
}
