"use client";

import { useState } from "react";
import { Table2 } from "lucide-react";
import type { PontoDoDia } from "@/server/consumo/agregacao";
import { compactar, condensarSerie } from "@/server/consumo/agregacao";
import { Tabela } from "@/components/ui";
import {
  cn,
  formatarNumero,
  formatarUsd,
  formatarUsdCurto,
} from "@/lib/utils";

/**
 * Custo por dia — colunas em HTML, não SVG.
 *
 * O gráfico precisa acompanhar a largura do cartão, e SVG responsivo exigiria
 * medir o contêiner. Com flex cada coluna já nasce proporcional, o alvo de
 * mouse é o elemento inteiro (e não um retângulo de 6px) e o foco por teclado
 * vem de graça, porque cada coluna é um botão de verdade.
 *
 * Uma série por vez, uma cor só: a categoria é o dia, que não tem identidade
 * nenhuma para uma cor carregar. Duas medidas nunca dividem o mesmo eixo — quem
 * quiser ver execuções troca a medida, e a escala inteira troca junto.
 */

type Medida = "custo" | "execucoes" | "tokens";

const MEDIDAS: { id: Medida; rotulo: string }[] = [
  { id: "custo", rotulo: "Custo" },
  { id: "execucoes", rotulo: "Execuções" },
  { id: "tokens", rotulo: "Tokens" },
];

const VALOR: Record<Medida, (p: PontoDoDia) => number> = {
  custo: (p) => p.custoUsd,
  execucoes: (p) => p.execucoes,
  tokens: (p) => p.tokens,
};

const FORMATO: Record<Medida, (v: number) => string> = {
  custo: formatarUsdCurto,
  execucoes: formatarNumero,
  tokens: compactar,
};

/** `2026-08-11` → `11/08`. O ano é o mesmo em todo o eixo; repeti-lo é ruído. */
function diaCurto(dia: string) {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

function diaPorExtenso(dia: string) {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;
}

/**
 * Topo do eixo arredondado para cima, para o tick não virar `$0,0731`.
 * Zero vira 1 só para não dividir por zero — a série toda fica no chão, que é
 * a leitura correta de "não se gastou nada".
 */
function topoDoEixo(maximo: number) {
  if (maximo <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximo));
  const passos = [1, 2, 2.5, 5, 10];
  for (const p of passos) {
    if (maximo <= p * magnitude) return p * magnitude;
  }
  return 10 * magnitude;
}

export function GraficoDiario({ pontos: diarios }: { pontos: PontoDoDia[] }) {
  const [medida, setMedida] = useState<Medida>("custo");
  const [emFoco, setEmFoco] = useState<number | null>(null);
  const [verTabela, setVerTabela] = useState(false);

  // A tabela continua dia a dia; só o gráfico condensa. É onde a limitação
  // existe — na largura da coluna, não no dado.
  const { pontos, diasPorColuna } = condensarSerie(diarios);
  const valores = pontos.map(VALOR[medida]);
  const topo = topoDoEixo(Math.max(0, ...valores));
  const formatar = FORMATO[medida];

  // Três marcas bastam: topo, meio e a base. Mais linhas competem com as barras.
  const marcas = [topo, topo / 2, 0];

  // Rótulos do eixo x: com muitos dias, só o primeiro, o do meio e o último —
  // o resto vira uma faixa cinza ilegível.
  const passo = pontos.length <= 10 ? 1 : Math.ceil(pontos.length / 6);

  const ativo = emFoco != null ? pontos[emFoco] : null;

  /** Uma coluna é um dia, ou um bloco de dias quando o período é longo. */
  const rotuloDaColuna = (ponto: PontoDoDia) =>
    diasPorColuna > 1
      ? `${diaPorExtenso(ponto.dia)} + ${diasPorColuna - 1} dia(s)`
      : diaPorExtenso(ponto.dia);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Medida do gráfico"
          className="flex gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
        >
          {MEDIDAS.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={m.id === medida}
              onClick={() => setMedida(m.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition",
                "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
                m.id === medida
                  ? "bg-surface text-foreground shadow-[var(--shadow-card)]"
                  : "text-muted hover:text-foreground",
              )}
            >
              {m.rotulo}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setVerTabela((v) => !v)}
          aria-pressed={verTabela}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Table2 size={13} aria-hidden />
          {verTabela ? "Ver gráfico" : "Ver tabela"}
        </button>
      </div>

      {verTabela ? (
        <Tabela
          cabecalho={
            <>
              <th scope="col">Dia</th>
              <th scope="col" className="text-right">Custo</th>
              <th scope="col" className="text-right">Execuções</th>
              <th scope="col" className="text-right">Tokens</th>
            </>
          }
        >
          {diarios.map((p) => (
            <tr key={p.dia}>
              <td className="whitespace-nowrap">{diaPorExtenso(p.dia)}</td>
              <td className="text-right tabular-nums">
                {formatarUsd(p.custoUsd)}
              </td>
              <td className="text-right tabular-nums">
                {formatarNumero(p.execucoes)}
              </td>
              <td className="text-right tabular-nums">
                {formatarNumero(p.tokens)}
              </td>
            </tr>
          ))}
        </Tabela>
      ) : (
        <div className="relative">
          {/* O balão fica fora da área de plotagem, no topo: dentro dela ele
              taparia justamente a coluna que se está lendo. */}
          <div className="mb-2 h-9">
            {ativo ? (
              <div className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs shadow-[var(--shadow-flutuante)]">
                <span className="font-medium">{rotuloDaColuna(ativo)}</span>
                <span className="text-muted">
                  {formatarUsd(ativo.custoUsd)} ·{" "}
                  {formatarNumero(ativo.execucoes)} execução(ões) ·{" "}
                  {formatarNumero(ativo.tokens)} tokens
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted">
                {diasPorColuna > 1
                  ? `Período longo: cada coluna soma ${diasPorColuna} dias. A tabela continua dia a dia.`
                  : "Passe o mouse (ou navegue com Tab) por um dia para ver o detalhe."}
              </p>
            )}
          </div>

          <div className="flex gap-3">
            {/* Eixo y à esquerda, fora do plot: dentro, os números encostariam
                nas primeiras colunas. Posicionado por `top` igual ao da grade,
                e não por `justify-between`, senão o número fica meia linha
                abaixo do traço a que se refere. */}
            <div className="relative h-40 w-14 shrink-0">
              {marcas.map((m) => (
                <span
                  key={m}
                  className="absolute right-0 -translate-y-1/2 text-right text-[10px] text-muted tabular-nums"
                  style={{ top: `${(1 - m / topo) * 100}%` }}
                >
                  {formatar(m)}
                </span>
              ))}
            </div>

            <div className="min-w-0 flex-1">
              <div className="relative h-40">
                {/* Grade sólida e fininha, um passo acima da superfície. */}
                {marcas.map((m) => (
                  <span
                    key={m}
                    aria-hidden
                    className="absolute right-0 left-0 border-t border-chart-grid"
                    style={{ top: `${(1 - m / topo) * 100}%` }}
                  />
                ))}

                <div
                  className="absolute inset-0 flex items-end gap-[2px]"
                  onMouseLeave={() => setEmFoco(null)}
                >
                  {pontos.map((ponto, i) => {
                    const valor = VALOR[medida](ponto);
                    const altura = (valor / topo) * 100;
                    return (
                      <button
                        key={ponto.dia}
                        type="button"
                        // O alvo é a coluna inteira, da base ao topo do plot:
                        // barra de 2px de altura seria impossível de acertar.
                        className="group flex h-full min-w-0 flex-1 items-end justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                        onMouseEnter={() => setEmFoco(i)}
                        onFocus={() => setEmFoco(i)}
                        onBlur={() => setEmFoco(null)}
                        aria-label={`${rotuloDaColuna(ponto)}: ${formatarUsd(
                          ponto.custoUsd,
                        )}, ${ponto.execucoes} execução(ões), ${
                          ponto.tokens
                        } tokens`}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            // Teto de 24px: em período curto uma coluna
                            // esticada até o fim da faixa vira um bloco.
                            "block w-full max-w-6 rounded-t-[4px] bg-accent transition-opacity",
                            emFoco != null && emFoco !== i && "opacity-40",
                          )}
                          style={{
                            // Altura mínima visível só quando houve gasto: dia
                            // zerado tem de ficar rente ao chão, senão parece
                            // que teve movimento.
                            height:
                              valor > 0
                                ? `max(2px, ${altura.toFixed(2)}%)`
                                : "0",
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-1.5 flex gap-[2px]">
                {pontos.map((ponto, i) => (
                  <span
                    key={ponto.dia}
                    className="min-w-0 flex-1 text-center text-[10px] whitespace-nowrap text-muted tabular-nums"
                  >
                    {i % passo === 0 || i === pontos.length - 1
                      ? diaCurto(ponto.dia)
                      : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
