import { describe, expect, it } from "vitest";
import { ClickUpApiError } from "@/server/integrations/clickup/client";
import { tasksQueAindaBarram } from "./vigentes";
import type { TaskRegistrada } from "./mensagem";

const task = (id: string | null): TaskRegistrada => ({
  id,
  url: id ? `https://app.clickup.com/t/${id}` : null,
  nome: null,
  em: new Date("2026-09-28T15:08:00Z"),
});

describe("tasksQueAindaBarram", () => {
  it("⚠ a task GANHA não barra: é o caso da conversa 14342 (reserva nova de cliente avulsa)", async () => {
    const r = await tasksQueAindaBarram([task("a")], async () => ({
      status: { type: "custom" },
      tags: [{ name: "ganho" }],
    }));
    expect(r).toEqual([]);
  });

  it("⚠ lead ainda aberto continua barrando: é a trava da conversa 10912", async () => {
    const r = await tasksQueAindaBarram([task("a")], async () => ({ status: { type: "open" }, tags: [] }));
    expect(r.map((t) => t.id)).toEqual(["a"]);
  });

  it("fechada, arquivada e apagada (404) não barram", async () => {
    const r = await tasksQueAindaBarram([task("fechada"), task("arquivada"), task("apagada")], async (id) => {
      if (id === "fechada") return { status: { type: "closed" } };
      if (id === "arquivada") return { archived: true, status: { type: "open" } };
      throw new ClickUpApiError(404, "Task not found");
    });
    expect(r).toEqual([]);
  });

  it("⚠ na dúvida, barra: erro que não é 404, e task sem id para conferir", async () => {
    const r = await tasksQueAindaBarram([task("a"), task(null)], async () => {
      throw new ClickUpApiError(500, "erro do ClickUp");
    });
    expect(r.map((t) => t.id)).toEqual(["a", null]);

    const rede = await tasksQueAindaBarram([task("b")], async () => {
      throw new Error("queda de rede");
    });
    expect(rede).toHaveLength(1);
  });

  it("mistura: só as que já não valem saem", async () => {
    const r = await tasksQueAindaBarram([task("ganha"), task("aberta")], async (id) =>
      id === "ganha" ? { status: { type: "custom" }, tags: [{ name: "ganho" }] } : { status: { type: "open" } },
    );
    expect(r.map((t) => t.id)).toEqual(["aberta"]);
  });
});
