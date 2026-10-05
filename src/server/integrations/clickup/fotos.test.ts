import { describe, expect, it } from "vitest";
import {
  MAX_FOTOS_POR_LEITURA,
  anotacaoDaFoto,
  chaveDaLeitura,
  cortarDescricao,
  fotoMaisRecente,
  hostDeAnexoPermitido,
  inicioDaJanela,
  instrucaoDaFoto,
  nomeDoAnexo,
  selecionarFotos,
  ultimaLeituraDaTarefa,
} from "./fotos";
import type { ClickUpAnexo, ClickUpComentario } from "./tipos";

/**
 * As formas abaixo são as da tarefa real das fotos do jardim (01/10/2026):
 * nome de foto do WhatsApp, print colado chamado `image.png`, o upload segundos
 * antes do comentário, e o nome às vezes codificado no `comment_text`. Os
 * nomes de pessoa são inventados.
 */

const AGORA = Date.UTC(2026, 9, 5, 15, 0, 0);
const DIA = 86_400_000;
const URL = "https://t3089014.p.clickup-attachments.com/t3089014/abc/foto.jpeg";

function anexo(extra: Partial<ClickUpAnexo> & { id: string }): ClickUpAnexo {
  return {
    title: `${extra.id}.jpeg`,
    extension: "jpeg",
    size: 1000,
    url: URL,
    date: String(AGORA - DIA),
    ...extra,
  };
}

function comentario(texto: string, quando: number, autor = "Ana"): ClickUpComentario {
  return {
    id: `c-${quando}`,
    comment_text: texto,
    date: String(quando),
    user: { id: 1, username: autor },
  };
}

describe("quais fotos entram na leitura", () => {
  it("só as do período: a foto de oito dias atrás fica fora da semana", () => {
    const s = selecionarFotos(
      [
        anexo({ id: "nova", date: String(AGORA - 2 * DIA) }),
        anexo({ id: "velha", date: String(AGORA - 8 * DIA) }),
      ],
      AGORA - 7 * DIA,
    );

    expect(s.fotos.map((f) => f.id)).toEqual(["nova"]);
  });

  it("anexo apagado, escondido ou sem endereço não é lido", () => {
    const s = selecionarFotos(
      [
        anexo({ id: "apagada", deleted: true }),
        anexo({ id: "escondida", hidden: true }),
        anexo({ id: "sem-url", url: null }),
        anexo({ id: "viva" }),
      ],
      AGORA - 7 * DIA,
    );

    expect(s.fotos.map((f) => f.id)).toEqual(["viva"]);
  });

  it("PDF e HEIC não vão para a visão, e a contagem diz que existiam", () => {
    const s = selecionarFotos(
      [
        anexo({ id: "padrao", title: "Padrão.pdf", extension: "pdf" }),
        anexo({ id: "iphone", title: "IMG_1.HEIC", extension: "heic" }),
        anexo({ id: "foto" }),
      ],
      AGORA - 7 * DIA,
    );

    expect(s.fotos.map((f) => f.id)).toEqual(["foto"]);
    expect(s.semSerFoto).toBe(2);
  });

  it("a extensão sai do nome quando a API não a manda", () => {
    const s = selecionarFotos(
      [anexo({ id: "x", title: "canteiro.PNG", extension: null })],
      AGORA - 7 * DIA,
    );

    expect(s.fotos).toHaveLength(1);
  });

  it("⚠ a mesma foto publicada duas vezes é lida uma vez só — a mais antiga", () => {
    const s = selecionarFotos(
      [
        anexo({ id: "segunda", title: "WhatsApp Image 09.30.19.jpeg", size: 199609, date: String(AGORA - DIA) }),
        anexo({ id: "primeira", title: "WhatsApp Image 09.30.19.jpeg", size: 199609, date: String(AGORA - DIA - 60_000) }),
      ],
      AGORA - 7 * DIA,
    );

    expect(s.fotos.map((f) => f.id)).toEqual(["primeira"]);
    expect(s.repetidas).toBe(1);
  });

  it("prints com o mesmo nome e tamanhos diferentes são fotos diferentes", () => {
    const s = selecionarFotos(
      [
        anexo({ id: "a", title: "image.png", extension: "png", size: 2077117 }),
        anexo({ id: "b", title: "image.png", extension: "png", size: 2200543 }),
      ],
      AGORA - 7 * DIA,
    );

    expect(s.fotos).toHaveLength(2);
    expect(s.repetidas).toBe(0);
  });

  it("acima do teto ficam as MAIS RECENTES, em ordem de envio, e o resto é contado", () => {
    const anexos = Array.from({ length: MAX_FOTOS_POR_LEITURA + 3 }, (_, i) =>
      anexo({ id: `f${i}`, size: i, date: String(AGORA - DIA + i * 1000) }),
    );

    const s = selecionarFotos(anexos, AGORA - 7 * DIA);

    expect(s.fotos).toHaveLength(MAX_FOTOS_POR_LEITURA);
    expect(s.fotos[0].id).toBe("f3");
    expect(s.fotos.at(-1)?.id).toBe(`f${MAX_FOTOS_POR_LEITURA + 2}`);
    expect(s.foraDoTeto).toBe(3);
  });
});

describe("a anotação escrita junto da foto", () => {
  it("liga a foto ao comentário que a publicou, sem a linha do nome do arquivo", () => {
    const foto = anexo({
      id: "f",
      title: "WhatsApp Image 2026-08-31 at 09.26.00.jpeg",
      date: String(AGORA - DIA),
      user: { id: 2, username: "Ana" },
    });
    const c = comentario(
      "WhatsApp Image 2026-08-31 at 09.26.00.jpeg\na grama foi colocada, porém faltou grama para completar\n",
      AGORA - DIA + 43_000,
    );

    expect(anotacaoDaFoto(foto, [c])).toEqual({
      texto: "a grama foi colocada, porém faltou grama para completar",
      autor: "Ana",
    });
  });

  it("casa o nome codificado no comentário (%20) com o nome do anexo", () => {
    const foto = anexo({
      id: "f",
      title: "WhatsApp Image 2026-08-31 at 09.28.00 (2).jpeg",
      date: String(AGORA - DIA),
    });
    const c = comentario(
      "WhatsApp%20Image%202026-08-31%20at%2009.28.00%20(2).jpeg\nmato da calçada\n",
      AGORA - DIA + 11_000,
    );

    expect(anotacaoDaFoto(foto, [c]).texto).toBe("mato da calçada");
  });

  it("comentário só com nomes de arquivo não vira anotação", () => {
    const foto = anexo({ id: "f", title: "a.jpeg", date: String(AGORA - DIA) });
    const c = comentario("a.jpeg\nb.jpeg\n", AGORA - DIA + 5_000, "Bruno");

    expect(anotacaoDaFoto(foto, [c])).toEqual({ texto: null, autor: "Bruno" });
  });

  it("⚠ `image.png` pega o comentário mais próximo DEPOIS do upload, não outro", () => {
    const foto = anexo({ id: "f", title: "image.png", extension: "png", date: String(AGORA - DIA) });
    const antes = comentario("image.png\npoda da cerca\n", AGORA - DIA - 5 * 60_000);
    const certo = comentario("image.png\nimage.png\n", AGORA - DIA + 40_000);
    const depois = comentario("image.png\nfolhas na calçada\n", AGORA - DIA + 70_000);

    expect(anotacaoDaFoto(foto, [depois, antes, certo]).texto).toBeNull();
  });

  it("comentário de outra semana não empresta anotação", () => {
    const foto = anexo({ id: "f", title: "a.jpeg", date: String(AGORA - 3 * DIA) });
    const c = comentario("a.jpeg\npoldar\n", AGORA - DIA);

    expect(anotacaoDaFoto(foto, [c])).toEqual({ texto: null, autor: null });
  });

  it("sem comentário, quem mandou é quem subiu o anexo", () => {
    const foto = anexo({ id: "f", user: { id: 3, username: "Carla" } });

    expect(anotacaoDaFoto(foto, [])).toEqual({ texto: null, autor: "Carla" });
  });
});

describe("de onde se pode baixar", () => {
  it("aceita os servidores de anexo do ClickUp", () => {
    expect(hostDeAnexoPermitido(URL)).toBe(true);
    expect(hostDeAnexoPermitido("https://attachments.clickup.com/x/y.png")).toBe(true);
  });

  it("⚠ recusa qualquer outro endereço — o token do ClickUp só vai para o ClickUp", () => {
    expect(hostDeAnexoPermitido("https://exemplo.com/foto.jpg")).toBe(false);
    expect(hostDeAnexoPermitido("https://clickup-attachments.com.exemplo.com/x")).toBe(false);
    expect(hostDeAnexoPermitido("http://t1.p.clickup-attachments.com/x")).toBe(false);
    expect(hostDeAnexoPermitido("não é url")).toBe(false);
  });
});

describe("a instrução e o cache", () => {
  it("a instrução leva o critério inteiro e manda não adivinhar", () => {
    const instrucao = instrucaoDaFoto("  Canteiros: sem mato nem folhas secas.  ");

    expect(instrucao).toContain("Canteiros: sem mato nem folhas secas.");
    expect(instrucao).toMatch(/não dá para ver em vez de adivinhar/);
  });

  it("⚠ critério diferente é leitura diferente — senão a avaliação nova sairia velha", () => {
    const a = chaveDaLeitura("anexo-1", instrucaoDaFoto("critério A"));
    const b = chaveDaLeitura("anexo-1", instrucaoDaFoto("critério B"));

    expect(a).not.toBe(b);
    expect(a).toBe(chaveDaLeitura("anexo-1", instrucaoDaFoto("critério A")));
    expect(a.startsWith("clickup:anexo-1:")).toBe(true);
  });

  it("o nome que vai à leitura tem extensão, mesmo quando o título não tem", () => {
    expect(nomeDoAnexo({ id: "1", title: "canteiro", extension: "jpg" })).toBe("canteiro.jpg");
    expect(nomeDoAnexo({ id: "1", title: "canteiro.JPG", extension: "jpg" })).toBe("canteiro.JPG");
  });

  it("descrição longa é cortada e diz que foi", () => {
    expect(cortarDescricao("curta")).toBe("curta");
    expect(cortarDescricao("x".repeat(20), 10)).toBe("xxxxxxxxxx … [descrição cortada]");
  });
});

describe("a janela da rotina diária", () => {
  it("sem leitura anterior, olha os últimos dias pedidos", () => {
    expect(inicioDaJanela({ agoraMs: AGORA, dias: 7, ultimaLeitura: null })).toBe(AGORA - 7 * DIA);
  });

  it("⚠ com leitura anterior, começa nela — sem buraco nem repetição", () => {
    const ontem = new Date(AGORA - DIA);
    expect(inicioDaJanela({ agoraMs: AGORA, dias: 7, ultimaLeitura: ontem })).toBe(AGORA - DIA);
  });

  it("leitura anterior mais velha que o limite não alarga a janela", () => {
    const antiga = new Date(AGORA - 30 * DIA);
    expect(inicioDaJanela({ agoraMs: AGORA, dias: 7, ultimaLeitura: antiga })).toBe(AGORA - 7 * DIA);
  });

  it("a foto do instante exato da leitura anterior já foi lida por ela", () => {
    const s = selecionarFotos(
      [anexo({ id: "na-borda", date: String(AGORA - DIA) }), anexo({ id: "depois", date: String(AGORA - DIA + 1) })],
      AGORA - DIA,
    );
    expect(s.fotos.map((f) => f.id)).toEqual(["depois"]);
  });

  it("⚠ vale o instante em que os anexos foram lidos, não o da gravação", () => {
    const leitura = AGORA - DIA;
    const r = ultimaLeituraDaTarefa(
      [
        {
          input: { tarefaId: "t1" },
          output: { lido: true, lidoAteMs: leitura },
          createdAt: new Date(leitura + 20_000),
        },
      ],
      "t1",
    );
    expect(r?.getTime()).toBe(leitura);
  });

  it("leitura que não leu, de outra tarefa, não empurra a janela", () => {
    const r = ultimaLeituraDaTarefa(
      [
        { input: { tarefaId: "t1" }, output: { lido: false, erro: "desligada" }, createdAt: new Date(AGORA) },
        { input: { tarefaId: "outra" }, output: { lido: true, lidoAteMs: AGORA }, createdAt: new Date(AGORA) },
        { input: { tarefaId: "t1" }, output: { lido: true, lidoAteMs: AGORA - 3 * DIA }, createdAt: new Date(AGORA - 3 * DIA) },
      ],
      "t1",
    );
    expect(r?.getTime()).toBe(AGORA - 3 * DIA);
  });

  it("a foto mais recente olha a tarefa inteira e ignora o que não é foto", () => {
    expect(
      fotoMaisRecente([
        anexo({ id: "a", date: String(AGORA - 9 * DIA) }),
        anexo({ id: "pdf", title: "x.pdf", extension: "pdf", date: String(AGORA) }),
        anexo({ id: "apagada", deleted: true, date: String(AGORA) }),
      ]),
    ).toBe(AGORA - 9 * DIA);
    expect(fotoMaisRecente([])).toBeNull();
  });
});
