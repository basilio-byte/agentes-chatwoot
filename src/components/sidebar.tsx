"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  LogOut,
  MessagesSquare,
  Plug,
  ScrollText,
  Users,
} from "lucide-react";
import type { UserRole } from "@/generated/prisma/enums";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

const SECOES = [
  {
    titulo: "Atendimento",
    itens: [
      { href: "/agentes", label: "Agentes", icone: Bot },
      { href: "/conversas", label: "Conversas", icone: MessagesSquare },
      { href: "/execucoes", label: "Execuções", icone: ScrollText },
    ],
  },
  {
    titulo: "Configuração",
    itens: [
      { href: "/integracoes", label: "Integrações", icone: Plug },
      { href: "/usuarios", label: "Usuários", icone: Users },
    ],
  },
];

const PAPEL: Record<UserRole, string> = {
  OWNER: "Proprietário",
  ADMIN: "Administrador",
  VIEWER: "Leitura",
};

export function Sidebar({
  usuario,
  sair,
}: {
  usuario: { name?: string | null; email?: string | null; role: UserRole };
  sair: () => Promise<void>;
}) {
  const caminho = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col justify-between border-r border-line bg-surface">
      <div className="space-y-7 p-4">
        <Link href="/agentes" className="block px-2 pt-1" aria-label="Seahub Agentes">
          <Image
            src="/seahub-logo.png"
            alt="Seahub"
            width={104}
            height={36}
            className="logo-seahub h-6 w-auto"
            priority
          />
          <span className="mt-1.5 block text-[11px] tracking-wide text-muted">
            Agentes de atendimento
          </span>
        </Link>

        <nav className="space-y-6">
          {SECOES.map((secao) => (
            <div key={secao.titulo} className="space-y-1">
              <p className="px-2 text-[11px] font-medium tracking-wide text-muted/70 uppercase">
                {secao.titulo}
              </p>

              {secao.itens.map(({ href, label, icone: Icone }) => {
                const ativo = caminho === href || caminho.startsWith(`${href}/`);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={ativo ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition",
                      ativo
                        ? "bg-accent-soft font-medium text-accent"
                        : "text-muted hover:bg-foreground/[0.04] hover:text-foreground",
                    )}
                  >
                    <Icone size={16} aria-hidden />
                    {label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>

      <div className="space-y-3 border-t border-line p-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-medium text-accent"
          >
            {(usuario.name ?? usuario.email ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">
              {usuario.name ?? usuario.email}
            </p>
            <p className="truncate text-[11px] text-muted">
              {PAPEL[usuario.role]}
            </p>
          </div>
        </div>

        <form action={sair}>
          <Button variant="ghost" size="sm" className="w-full justify-start">
            <LogOut size={14} aria-hidden />
            Sair
          </Button>
        </form>
      </div>
    </aside>
  );
}
