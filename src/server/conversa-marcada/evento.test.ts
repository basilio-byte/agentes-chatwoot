import { describe, expect, it } from "vitest";
import { lerCheckboxesMarcados, lerChavesDeCheckbox } from "./evento";

const DESMARCADOS = {
  nps_espaos: null,
  atendimento: null,
  nps_perdido: null,
  pausar_automao: null,
  passar_para_crm: null,
};

/** O formato da entrega real do Chatwoot (15/09/2026), com dados fictícios. */
const entrega = (
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  event: "conversation_updated",
  id: 12345,
  inbox_id: 29,
  status: "open",
  updated_at: 1789489687.2531722,
  custom_attributes: depois,
  meta: { sender: { name: "Maria", phone_number: "+558487654321" } },
  changed_attributes: [
    {
      updated_at: {
        previous_value: "2026-09-15T15:48:17.583Z",
        current_value: "2026-09-15T16:28:07.034Z",
      },
    },
    { custom_attributes: { previous_value: antes, current_value: depois } },
  ],
  ...extra,
});

describe("lerCheckboxesMarcados", () => {
  it("a virada para marcado, no formato da entrega real", () => {
    expect(
      lerCheckboxesMarcados(
        entrega(DESMARCADOS, { ...DESMARCADOS, passar_para_crm: true }),
      ),
    ).toEqual({
      conversationId: 12345,
      inboxId: 29,
      marcadoEm: 1789489687.2531722,
      atributos: ["passar_para_crm"],
      contatoNome: "Maria",
      telefone: "+558487654321",
    });
  });

  it("desmarcar não dispara — é o próprio sistema limpando", () => {
    expect(
      lerCheckboxesMarcados(
        entrega({ ...DESMARCADOS, passar_para_crm: true }, DESMARCADOS),
      ),
    ).toBeNull();
  });

  it("⚠ checkbox que continua marcado não dispara de novo", () => {
    // Outra mudança na mesma conversa — o dono respondeu. A conversa vem com o
    // atributo marcado, mas `changed_attributes` não fala dele.
    const payload = entrega(DESMARCADOS, DESMARCADOS, {
      custom_attributes: { ...DESMARCADOS, passar_para_crm: true },
      changed_attributes: [
        {
          waiting_since: {
            previous_value: "2026-09-15T16:30:56.305Z",
            current_value: null,
          },
        },
      ],
    });
    expect(lerCheckboxesMarcados(payload)).toBeNull();
  });

  it("⚠ sem changed_attributes, o estado sozinho não dispara", () => {
    const payload = entrega(DESMARCADOS, DESMARCADOS, {
      custom_attributes: { passar_para_crm: true },
      changed_attributes: undefined,
    });
    expect(lerCheckboxesMarcados(payload)).toBeNull();
  });

  it("dois marcados de uma vez, e só os que viraram", () => {
    const lido = lerCheckboxesMarcados(
      entrega(
        { ...DESMARCADOS, nps_perdido: true },
        { ...DESMARCADOS, nps_perdido: true, passar_para_crm: true, atendimento: "true" },
      ),
    );
    expect(lido?.atributos).toEqual(["atendimento", "passar_para_crm"]);
  });

  it("outro evento ou id inválido não é marcação", () => {
    const marcado = { ...DESMARCADOS, passar_para_crm: true };
    expect(
      lerCheckboxesMarcados(
        entrega(DESMARCADOS, marcado, { event: "conversation_status_changed" }),
      ),
    ).toBeNull();
    expect(lerCheckboxesMarcados(entrega(DESMARCADOS, marcado, { id: "abc" }))).toBeNull();
    expect(lerCheckboxesMarcados(null)).toBeNull();
  });

  it("sem instante na entrega, vale a chegada", () => {
    const lido = lerCheckboxesMarcados(
      entrega(DESMARCADOS, { ...DESMARCADOS, passar_para_crm: true }, { updated_at: null }),
      1_789_489_700_000,
    );
    expect(lido?.marcadoEm).toBe(1_789_489_700);
  });
});

describe("lerChavesDeCheckbox", () => {
  it("uma por linha ou separadas por vírgula, sem repetir", () => {
    expect(lerChavesDeCheckbox("passar_para_crm\n atendimento ; passar_para_crm,,")).toEqual({
      chaves: ["passar_para_crm", "atendimento"],
      invalidas: [],
    });
  });

  it("⚠ chave fora do formato volta como inválida, em vez de virar checkbox que nunca dispara", () => {
    // O rótulo que aparece na tela do Chatwoot não é a chave do atributo.
    expect(lerChavesDeCheckbox("Passar para CRM\npassar_para_crm")).toEqual({
      chaves: ["passar_para_crm"],
      invalidas: ["Passar para CRM"],
    });
  });
});
