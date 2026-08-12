"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export type Tema = "system" | "light" | "dark";

export const CHAVE_TEMA = "seahub:tema";

/**
 * Script que carimba o tema **antes da primeira pintura**.
 *
 * Vai inline no <head> porque qualquer coisa assíncrona chegaria depois do
 * primeiro quadro: quem escolheu claro veria o painel escuro piscar. Só carimba
 * escolha explícita — sem nada guardado, o CSS resolve por
 * `prefers-color-scheme` e o atributo continua ausente.
 */
export const SCRIPT_DO_TEMA = `try{var t=localStorage.getItem(${JSON.stringify(
  CHAVE_TEMA,
)});if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

/**
 * O tema é estado de FORA do React — mora no `localStorage` e é carimbado no
 * `<html>` por um script que roda antes de a aplicação existir. Por isso ele
 * entra por `useSyncExternalStore`, e não por `useState` + efeito: ler no
 * efeito dispararia uma segunda renderização em cascata a cada carga, e ainda
 * deixaria duas abas discordando entre si.
 */
const ouvintes = new Set<() => void>();

/**
 * `getSnapshot` precisa devolver o MESMO valor enquanto nada muda — se lesse o
 * `localStorage` a cada chamada, uma string nova por leitura faria o React
 * renderizar em laço.
 */
let cache: Tema | null = null;

function lerDoStorage(): Tema {
  try {
    const guardado = localStorage.getItem(CHAVE_TEMA);
    return guardado === "light" || guardado === "dark" ? guardado : "system";
  } catch {
    // Navegador com storage bloqueado: fica no tema do sistema.
    return "system";
  }
}

function snapshot(): Tema {
  cache ??= lerDoStorage();
  return cache;
}

/** No servidor não há escolha guardada — é sempre o tema do sistema. */
function snapshotDoServidor(): Tema {
  return "system";
}

function inscrever(aoMudar: () => void) {
  ouvintes.add(aoMudar);

  // Outra aba trocou o tema: esta acompanha em vez de ficar mostrando um botão
  // marcado que não corresponde ao que está na tela.
  const deOutraAba = (evento: StorageEvent) => {
    if (evento.key !== CHAVE_TEMA) return;
    cache = null;
    aplicarNoDocumento(snapshot());
    aoMudar();
  };

  window.addEventListener("storage", deOutraAba);
  return () => {
    ouvintes.delete(aoMudar);
    window.removeEventListener("storage", deOutraAba);
  };
}

function aplicarNoDocumento(tema: Tema) {
  const raiz = document.documentElement;
  if (tema === "system") delete raiz.dataset.theme;
  else raiz.dataset.theme = tema;
}

function escolher(tema: Tema) {
  cache = tema;
  aplicarNoDocumento(tema);
  try {
    if (tema === "system") localStorage.removeItem(CHAVE_TEMA);
    else localStorage.setItem(CHAVE_TEMA, tema);
  } catch {
    // Sem storage a escolha vale só nesta aba, o que ainda é melhor que nada.
  }
  for (const ouvinte of ouvintes) ouvinte();
}

const OPCOES: { id: Tema; rotulo: string; Icone: typeof Sun }[] = [
  { id: "system", rotulo: "Sistema", Icone: Monitor },
  { id: "light", rotulo: "Claro", Icone: Sun },
  { id: "dark", rotulo: "Escuro", Icone: Moon },
];

/**
 * Seletor de tema com três estados — e "sistema" precisa ser um deles, não a
 * ausência dos outros dois: quem usa o computador em claro de dia e escuro à
 * noite espera que o painel acompanhe.
 */
export function SeletorDeTema() {
  const tema = useSyncExternalStore(
    inscrever,
    snapshot,
    snapshotDoServidor,
  );

  return (
    <div
      role="group"
      aria-label="Tema do painel"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {OPCOES.map(({ id, rotulo, Icone }) => {
        const ativo = id === tema;
        return (
          <button
            key={id}
            type="button"
            title={rotulo}
            aria-label={rotulo}
            aria-pressed={ativo}
            onClick={() => escolher(id)}
            className={cn(
              "flex h-6 flex-1 items-center justify-center rounded-md transition",
              "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
              ativo
                ? "bg-surface text-foreground shadow-[var(--shadow-card)]"
                : "text-muted hover:text-foreground",
            )}
          >
            <Icone size={13} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
