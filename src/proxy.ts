import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Convenção `proxy` do Next 16 (era `middleware` até o 15).
// Só a config compartilhada — sem providers, para continuar rodando no edge
// (bcrypt e Prisma não rodam lá).
export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    // Só as páginas. Ficam de fora, de propósito:
    //
    //  - `/api/*`: um redirect para o login devolveria HTML onde o cliente
    //    espera JSON. ⚠ Cada rota em /api/ checa a própria sessão.
    //  - `/_next/*`: assets e o otimizador de imagem.
    //  - qualquer caminho com extensão (`.png`, `.svg`, `.woff2`…) e os ícones
    //    gerados pelo Next. Sem isto o proxy engole os arquivos de `public/`, e
    //    o otimizador — que busca a imagem server-side, **sem o cookie do
    //    usuário** — recebe o HTML do login no lugar do PNG.
    //
    // Páginas não têm extensão, então continuam protegidas.
    "/((?!api|_next|favicon\\.ico|icon|apple-icon|opengraph-image|.*\\.[\\w]+$).*)",
  ],
};
