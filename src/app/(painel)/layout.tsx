import { exigirSessao } from "@/server/auth-guard";
import { sair } from "@/server/actions/auth";
import { Sidebar } from "@/components/sidebar";

export default async function PainelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessao = await exigirSessao();

  return (
    <div className="flex min-h-screen">
      <Sidebar
        usuario={{
          name: sessao.user.name,
          email: sessao.user.email,
          role: sessao.user.role,
        }}
        sair={sair}
      />

      <main className="flex-1 overflow-x-auto">
        <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
