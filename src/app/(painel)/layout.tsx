import Link from "next/link";
import { Bot, Plug, ScrollText, LogOut } from "lucide-react";
import { exigirSessao } from "@/server/auth-guard";
import { sair } from "@/server/actions/auth";
import { Button } from "@/components/ui";

const NAV = [
  { href: "/agentes", label: "Agentes", icon: Bot },
  { href: "/integracoes", label: "Integrações", icon: Plug },
  { href: "/execucoes", label: "Execuções", icon: ScrollText },
];

export default async function PainelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessao = await exigirSessao();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col justify-between border-r border-line bg-surface p-4">
        <div className="space-y-6">
          <Link href="/agentes" className="block">
            <span className="text-sm font-semibold">Seahub Agentes</span>
          </Link>

          <nav className="space-y-1">
            {NAV.map(({ href, label, icon: Icone }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent-soft"
              >
                <Icone size={16} aria-hidden />
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="space-y-2 border-t border-line pt-4">
          <p className="truncate text-xs text-muted">{sessao.user.email}</p>
          <p className="text-xs text-muted">{sessao.user.role}</p>
          <form action={sair}>
            <Button variant="ghost" size="sm" className="w-full justify-start">
              <LogOut size={14} aria-hidden />
              Sair
            </Button>
          </form>
        </div>
      </aside>

      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  );
}
