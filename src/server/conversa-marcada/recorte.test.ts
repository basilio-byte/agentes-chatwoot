import { describe, expect, it } from "vitest";
import type { MensagemDoCiclo } from "@/server/conversa-encerrada/ciclo";
import { recortarAtendimentoAtual } from "./recorte";

const MARCADO_EM = 1_789_489_687;

let proximoId = 1;
const msg = (content: string, message_type: number, created_at: number): MensagemDoCiclo => ({
  id: proximoId++,
  content,
  message_type,
  created_at,
  sender: null,
});

describe("recortarAtendimentoAtual", () => {
  it("conversa aberta: depois da última resolução até a marcação", () => {
    proximoId = 1;
    const mensagens = [
      msg("assunto de agosto", 0, MARCADO_EM - 3_000_000),
      msg("Conversa foi marcada como resolvida por Socorro", 2, MARCADO_EM - 2_999_000),
      msg("quero reservar o auditório", 0, MARCADO_EM - 900),
      msg("claro, qual dia?", 1, MARCADO_EM - 800),
      msg("Sistema de Automação adicionou crm_clickup", 2, MARCADO_EM),
      msg("mensagem depois da marcação", 0, MARCADO_EM + 600),
    ];

    const recorte = recortarAtendimentoAtual(mensagens, MARCADO_EM);

    expect(recorte.achouOInicio).toBe(true);
    expect(recorte.mensagens.map((m) => m.content)).toEqual([
      "quero reservar o auditório",
      "claro, qual dia?",
      "Sistema de Automação adicionou crm_clickup",
    ]);
  });

  it("⚠ conversa já resolvida: o atendimento que terminou nela, não um vazio", () => {
    proximoId = 1;
    const mensagens = [
      msg("assunto de agosto", 0, MARCADO_EM - 3_000_000),
      msg("Conversa foi marcada como resolvida por Socorro", 2, MARCADO_EM - 2_999_000),
      msg("quero reservar o auditório", 0, MARCADO_EM - 7_200),
      msg("reservado!", 1, MARCADO_EM - 7_000),
      msg("Conversa foi marcada como resolvida por Regis Costa", 2, MARCADO_EM - 3_600),
      msg("Sistema de Automação adicionou crm_clickup", 2, MARCADO_EM),
    ];

    const recorte = recortarAtendimentoAtual(mensagens, MARCADO_EM);

    expect(recorte.achouOInicio).toBe(true);
    expect(recorte.mensagens.map((m) => m.content)).toEqual([
      "quero reservar o auditório",
      "reservado!",
      "Conversa foi marcada como resolvida por Regis Costa",
    ]);
  });

  it("primeiro atendimento da conversa: tudo até a marcação, sem início achado", () => {
    proximoId = 1;
    const recorte = recortarAtendimentoAtual(
      [msg("oi", 0, MARCADO_EM - 600), msg("olá", 1, MARCADO_EM - 500)],
      MARCADO_EM,
    );
    expect(recorte.achouOInicio).toBe(false);
    expect(recorte.mensagens).toHaveLength(2);
  });
});
