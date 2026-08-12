"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Select } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Barra de filtros que vive na URL.
 *
 * Uma barra só, acima de tudo que ela recorta — filtro dentro de cada cartão
 * faria dois gráficos da mesma tela mostrarem períodos diferentes. Estado na
 * URL, e não em `useState`, porque o recorte precisa sobreviver ao F5 e poder
 * ser colado para outra pessoa.
 *
 * Os valores atuais chegam por prop, do servidor: assim o componente não
 * precisa de `useSearchParams` e continua servindo uma página que é renderizada
 * inteira no servidor a cada troca.
 */

export type Opcao = { valor: string; rotulo: string };

export type Campo =
  | { tipo: "select"; chave: string; rotulo: string; opcoes: Opcao[] }
  | { tipo: "data"; chave: string; rotulo: string }
  | { tipo: "segmento"; chave: string; rotulo: string; opcoes: Opcao[] };

export function Filtros({
  campos,
  valores,
  className,
  acoes,
}: {
  campos: Campo[];
  valores: Record<string, string | undefined | null>;
  className?: string;
  /** Botões à direita — exportar, por exemplo. */
  acoes?: React.ReactNode;
}) {
  const router = useRouter();
  const caminho = usePathname();
  const [pendente, iniciar] = useTransition();

  function aplicar(mudancas: Record<string, string | null>) {
    const params = new URLSearchParams();
    for (const [chave, valor] of Object.entries({ ...valores, ...mudancas })) {
      if (valor) params.set(chave, valor);
    }
    const busca = params.toString();
    iniciar(() => router.push(busca ? `${caminho}?${busca}` : caminho));
  }

  const algumAtivo = campos.some((c) => valores[c.chave]);

  return (
    <div
      className={cn(
        "flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow-card)]",
        // Sem esqueleto ao refazer a busca: a tela anterior fica no lugar,
        // levemente apagada. Trocar por um esqueleto faria a página pular.
        pendente && "opacity-60",
        className,
      )}
    >
      {campos.map((campo) => (
        <div key={campo.chave} className="space-y-1">
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">
            {campo.rotulo}
          </p>

          {campo.tipo === "segmento" ? (
            <div
              role="group"
              aria-label={campo.rotulo}
              className="flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
            >
              {campo.opcoes.map((o) => {
                const ativo = (valores[campo.chave] ?? "") === o.valor;
                return (
                  <button
                    key={o.valor}
                    type="button"
                    aria-pressed={ativo}
                    onClick={() => aplicar({ [campo.chave]: o.valor || null })}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition",
                      "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
                      ativo
                        ? "bg-surface text-foreground shadow-[var(--shadow-card)]"
                        : "text-muted hover:text-foreground",
                    )}
                  >
                    {o.rotulo}
                  </button>
                );
              })}
            </div>
          ) : campo.tipo === "data" ? (
            <input
              type="date"
              aria-label={campo.rotulo}
              value={valores[campo.chave] ?? ""}
              onChange={(e) =>
                aplicar({ [campo.chave]: e.target.value || null })
              }
              className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] focus-visible:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/30"
            />
          ) : (
            <Select
              aria-label={campo.rotulo}
              value={valores[campo.chave] ?? ""}
              onChange={(e) =>
                aplicar({ [campo.chave]: e.target.value || null })
              }
              className="h-8 max-w-56 text-[13px]"
            >
              {campo.opcoes.map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.rotulo}
                </option>
              ))}
            </Select>
          )}
        </div>
      ))}

      <div className="ml-auto flex items-end gap-2">
        {algumAtivo ? (
          <button
            type="button"
            onClick={() =>
              aplicar(Object.fromEntries(campos.map((c) => [c.chave, null])))
            }
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={13} aria-hidden />
            Limpar
          </button>
        ) : null}
        {acoes}
      </div>
    </div>
  );
}
