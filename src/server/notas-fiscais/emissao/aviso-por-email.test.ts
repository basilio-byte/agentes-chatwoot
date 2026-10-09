import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O e-mail de aviso, do lado do envio: a chave de idempotência da Resend.
 *
 * Ela existe para um reenvio depois de timeout não duplicar o e-mail, mas a Resend a guarda
 * por 24 horas e devolve o e-mail de ANTES quando a chave é a mesma. Por isso a chave tem de
 * mudar sempre que há notícia nova — nota rejeitada de novo depois de "Tentar de novo", cadastro
 * que mudou de problema — e só então (revisão de 09/10/2026: nada travava esse contrato).
 */
const email = vi.hoisted(() => ({
  configuracaoDeEmail: vi.fn(() => ({ chave: "re_teste", remetente: "Seahub <notas@exemplo.com.br>" })),
  enviarEmail: vi.fn<(config: unknown, mensagem: { idempotencia?: string }) => Promise<{ id: string }>>(async () => ({ id: "e-1" })),
}));
vi.mock("@/server/integrations/resend/client", () => email);
vi.mock("@/lib/db", () => ({ db: {} }));

import { dependenciasReais } from "./emitir";
import type { CobrancaSemNota, NotaComProblema } from "./regras";

const nota = (extra: Partial<NotaComProblema> = {}): NotaComProblema => ({
  chave: "conexa-900-030302",
  cobrancaId: 900,
  empresa: "SEAHUB",
  codigo: "03.03.02",
  valorCentavos: 14900,
  situacao: "REJEITADA",
  motivo: "E0903: o tipo de operação deve ser informado",
  tentativaEm: "2026-10-09T12:00:00.000Z",
  ...extra,
});
const retida: CobrancaSemNota = {
  chave: "retida:31560:10.05.01",
  cobrancaId: 31560,
  empresa: "SEAHUB",
  valorCentavos: 208280,
  tipo: "retida",
  detalhe: "o código 10.05.01 está em espera",
};

/** A chave de idempotência com que o e-mail saiu. */
async function chaveDoEnvio(notas: NotaComProblema[], semNota: CobrancaSemNota[] = []): Promise<string> {
  email.enviarEmail.mockClear();
  expect(await dependenciasReais().avisar(notas, ["suporte@seahubcoworking.com.br"], semNota)).toBe("enviado");
  expect(email.enviarEmail).toHaveBeenCalledTimes(1);
  return email.enviarEmail.mock.calls[0][1].idempotencia!;
}

describe("a chave de idempotência do e-mail de aviso", () => {
  beforeEach(() => {
    email.configuracaoDeEmail.mockImplementation(() => ({ chave: "re_teste", remetente: "Seahub <notas@exemplo.com.br>" }));
    email.enviarEmail.mockImplementation(async () => ({ id: "e-1" }));
  });

  it("a mesma lista, nas mesmas condições, tem a mesma chave: o reenvio depois de um timeout não duplica", async () => {
    const a = await chaveDoEnvio([nota()], [retida]);
    const b = await chaveDoEnvio([nota()], [retida]);
    expect(a).toBe(b);
    expect(a).toMatch(/^nfse-aviso-[0-9a-f]{40}$/);
  });

  it("⚠ a ordem das notas não muda a chave", async () => {
    const outra = nota({ chave: "conexa-901-030302", cobrancaId: 901 });
    expect(await chaveDoEnvio([nota(), outra])).toBe(await chaveDoEnvio([outra, nota()]));
  });

  it("⚠ a mesma nota rejeitada DE NOVO (nova tentativa) é outro fato: outra chave", async () => {
    const primeira = await chaveDoEnvio([nota({ tentativaEm: "2026-10-09T12:00:00.000Z" })]);
    const depoisDeTentarDeNovo = await chaveDoEnvio([nota({ tentativaEm: "2026-10-09T15:30:00.000Z" })]);
    expect(depoisDeTentarDeNovo).not.toBe(primeira);
  });

  it("⚠ o cadastro que MUDOU de problema é outra notícia: outra chave (a Resend devolveria o e-mail de antes)", async () => {
    const semTentativa = { tentativaEm: undefined, situacao: "FALHOU" as const };
    const cep = await chaveDoEnvio([nota({ ...semTentativa, motivo: "Cadastro do cliente: o CEP do cadastro (590) não tem 8 dígitos" })]);
    const documento = await chaveDoEnvio([nota({ ...semTentativa, motivo: "Cadastro do cliente: o cadastro está sem CPF ou CNPJ" })]);
    expect(documento).not.toBe(cep);
  });

  it("cobrança sem nota: cada caso tem a sua chave, e um caso novo muda a chave do e-mail", async () => {
    const so = await chaveDoEnvio([], [retida]);
    const com = await chaveDoEnvio([], [retida, { ...retida, chave: "decisao:7:CONFERIR", cobrancaId: 7, tipo: "conferir" }]);
    expect(com).not.toBe(so);
  });

  it("sem a Resend no servidor nada é enviado e o motivo é dito", async () => {
    email.configuracaoDeEmail.mockImplementation(() => null as never);
    email.enviarEmail.mockClear();
    expect(await dependenciasReais().avisar([nota()], ["a@b.com"], [])).toBe("sem provedor");
    expect(email.enviarEmail).not.toHaveBeenCalled();
  });

  it("falha da Resend vira 'falhou' (o aviso continua pendente), nunca exceção", async () => {
    email.enviarEmail.mockRejectedValueOnce(new Error("Resend respondeu 500"));
    expect(await dependenciasReais().avisar([nota()], ["a@b.com"], [])).toBe("falhou");
  });
});
