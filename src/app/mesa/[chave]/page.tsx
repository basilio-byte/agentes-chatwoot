import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Archive,
  ExternalLink,
  PenLine,
  ScrollText,
  Settings2,
} from "lucide-react";

import { Mesa } from "@/components/mesa";
import { Aviso, Badge, Card } from "@/components/ui";
import { UserRole } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import {
  EXTENSOES_DE_AUDIO,
  EXTENSOES_DE_IMAGEM,
  EXTENSOES_DE_PDF,
  EXTENSOES_DE_TEXTO,
} from "@/server/integrations/openai/classificar";
import { capacidadeDeMidia } from "@/server/integrations/openai/credenciais";
import { obterIntegracao } from "@/server/integrations/registry";
import { resolverToolsDoAgente } from "@/server/integrations/resolve";

/**
 * Mesa do agente: alguém da equipe manda um documento, LÊ o texto extraído e só
 * então manda o agente executar uma vez sobre ele.
 *
 * Fica FORA do route group `(painel)` de propósito. A sidebar de lá é `w-60
 * shrink-0` sem breakpoint nenhum: num telefone de 390px sobrariam ~150px de
 * conteúdo, e o caso real desta tela é justamente alguém fotografando um
 * documento no celular. O precedente é o `/login`, que já vive fora do grupo —
 * inclusive quanto ao `export const dynamic` logo abaixo.
 *
 * ⚠ Fora do grupo é também fora do `exigirSessao()` do layout dele, e o layout
 * raiz não exige nada. Quem protege o render é a guarda na primeira linha da
 * página. O `proxy.ts` protege só a navegação — e nem toda: o matcher pula
 * caminho com extensão, então uma `Agent.key` com ponto no meio passaria batido
 * por ele e chegaria aqui sem cookie nenhum.
 */

// A página consulta o banco, então não pode ser pré-renderizada: o build roda
// no Docker/CI sem Postgres. Mesmo motivo do `/login`.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ chave: string }> };

/**
 * O título da aba é o nome do agente.
 *
 * A mesa existe para ficar aberta numa guia ao lado do trabalho, e ter duas
 * abertas é o normal — a da triagem e a da conferência. Com o título genérico
 * do painel as duas guias ficam idênticas, e o documento vai para a errada.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { chave } = await params;
  const agente = await db.agent.findFirst({
    where: { OR: [{ key: chave }, { id: chave }] },
    select: { name: true },
  });

  return { title: agente ? `Mesa · ${agente.name}` : "Mesa do agente" };
}

export default async function MesaPage({ params }: Props) {
  // Executar gasta crédito da OpenRouter — mesmo critério do playground, que
  // esconde da tela e ainda recusa na rota.
  await exigirPapel(UserRole.ADMIN);

  const { chave } = await params;

  // Por `key` OU por `id`: a URL é para favoritar e mandar por WhatsApp para um
  // colega, e um link copiado de qualquer lugar tem de abrir. Os dois campos
  // são únicos e indexados, então o OR não vira varredura.
  const agente = await db.agent.findFirst({
    where: { OR: [{ key: chave }, { id: chave }] },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      active: true,
      archivedAt: true,
    },
  });

  if (!agente) notFound();

  const configurar = `/agentes/${agente.id}`;

  if (agente.archivedAt) {
    // Arquivado saiu de circulação — e URL favoritada é circulação. Explicar é
    // melhor do que devolver 404: quem chegou por um link salvo precisa saber
    // que o agente existe e onde restaurá-lo, senão reporta link quebrado.
    return (
      <Moldura>
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <Archive size={16} className="text-muted" aria-hidden />
            <h1 className="text-base font-semibold tracking-tight">
              {agente.name} está arquivado
            </h1>
          </div>
          <p className="text-sm leading-relaxed text-muted">
            A mesa não abre para agente arquivado. Arquivar é tirar de
            circulação: ele não atende, não recebe transferência e não aparece
            no prompt de ninguém. Para usar a mesa de novo, restaure o agente —
            ele volta <strong>desligado</strong>, e ligar é uma segunda decisão.
          </p>
          <LinkExterno href={configurar}>
            <Settings2 size={14} aria-hidden />
            Abrir a configuração do agente
          </LinkExterno>
        </Card>
      </Moldura>
    );
  }

  // ⚠ `capacidadeDeMidia` devolve também a chave da OpenAI já decifrada. Daqui
  // para baixo o objeto inteiro não pode ser espalhado: só estes três campos
  // atravessam para o componente de cliente.
  const {
    ligada: midiaLigada,
    motivo: midiaMotivo,
    config,
  } = await capacidadeDeMidia(agente.id);

  // As tools que ESCREVEM, pelo mesmo `requiresConfirmation` que a tela do
  // agente já usa como rótulo de "escreve". Quem vai soltar o PDF de um cliente
  // dentro do prompt precisa saber o que está armando antes de clicar.
  const escritasPorIntegracao = new Map<string, string[]>();
  for (const tool of (await resolverToolsDoAgente(agente.id)).values()) {
    if (!tool.definicao.requiresConfirmation) continue;
    const rotulo = obterIntegracao(tool.provider)?.label ?? tool.provider;
    escritasPorIntegracao.set(rotulo, [
      ...(escritasPorIntegracao.get(rotulo) ?? []),
      tool.definicao.name,
    ]);
  }
  const escritas = [...escritasPorIntegracao.entries()]
    .map(([rotulo, nomes]) => ({ rotulo, nomes: nomes.sort() }))
    .sort((a, b) => a.rotulo.localeCompare(b.rotulo));
  const totalDeEscritas = escritas.reduce((soma, g) => soma + g.nomes.length, 0);

  /**
   * Tipos de arquivo que a mesa aceita AGORA.
   *
   * Sai da mesma lista fechada que o worker usa, e respeita os toggles por
   * tipo: oferecer áudio no seletor com `lerAudio` desligado é convidar a
   * pessoa a subir um arquivo que volta recusado — no celular, por dados
   * móveis.
   */
  const tipos = [
    config.lerImagem && { rotulo: "imagem", extensoes: EXTENSOES_DE_IMAGEM },
    config.lerAudio && { rotulo: "áudio", extensoes: EXTENSOES_DE_AUDIO },
    config.lerDocumento && {
      rotulo: "documento",
      extensoes: [...EXTENSOES_DE_PDF, ...EXTENSOES_DE_TEXTO],
    },
  ].filter((t): t is { rotulo: string; extensoes: string[] } => Boolean(t));

  /**
   * ⚠ Só extensões literais, nunca `image/*`.
   *
   * Foto tirada no iPhone é HEIC, e a visão da OpenAI recusa HEIC — 400 pago,
   * já barrado em `classificar.ts`. O Safari converte a foto para JPEG na hora
   * do envio quando o `accept` não menciona HEIC, e entrega o HEIC cru quando o
   * `accept` é curinga. A lista literal é o que faz a câmera do celular
   * produzir arquivo legível.
   */
  const accept = tipos
    .flatMap((t) => t.extensoes)
    .map((e) => `.${e}`)
    .join(",");

  return (
    <Moldura>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {agente.name}
          </h1>
          {!agente.active ? <Badge>desligado</Badge> : null}
          <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs text-muted">
            {agente.key}
          </code>
          <LinkExterno href={configurar} className="ml-auto">
            <Settings2 size={14} aria-hidden />
            Configurar
          </LinkExterno>
        </div>

        {agente.description ? (
          <p className="text-sm leading-relaxed text-muted">
            {agente.description}
          </p>
        ) : null}

        <p className="text-sm leading-relaxed text-muted">
          Mande um documento, confira o texto que o sistema extraiu dele e só
          então mande o agente executar.{" "}
          <strong className="font-medium text-foreground">
            Cada envio é independente
          </strong>{" "}
          — o agente não lembra do anterior, e não existe conversa aqui.
        </p>
      </header>

      {!agente.active ? (
        <Aviso>
          Este agente está desligado, e a mesa funciona mesmo assim. Desligado é
          pausa no atendimento; a mesa não é atendimento.
        </Aviso>
      ) : null}

      {!midiaLigada ? (
        <Aviso tone="warning">
          <strong className="font-medium">
            A leitura de mídia está desligada para este agente
          </strong>{" "}
          — {midiaMotivo ?? "motivo não informado"}. Sem ela o arquivo não vira
          texto e a mesa perde a razão de existir: sobra só o campo de texto.
          Quem liga é o toggle da OpenAI, primeiro em Integrações e depois na
          aba Integrações deste agente.
        </Aviso>
      ) : null}

      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <PenLine size={15} className="text-muted" aria-hidden />
          <h2 className="text-sm font-semibold">
            O que este agente pode gravar sozinho
          </h2>
          {totalDeEscritas > 0 ? (
            <Badge tone="warning">{totalDeEscritas}</Badge>
          ) : null}
        </div>

        {escritas.length === 0 ? (
          <p className="text-sm leading-relaxed text-muted">
            Nada. Com as integrações ligadas hoje, este agente só consulta e
            responde — nada do que ele fizer aqui altera sistema de terceiro.
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted">
              O agente grava direto, sem confirmação: não existe modo
              só-conferência. O texto do documento entra no prompt, e é ele que
              vai decidir estas ações.
            </p>
            <ul className="space-y-2">
              {escritas.map((grupo) => (
                <li key={grupo.rotulo} className="space-y-1">
                  <p className="text-xs font-medium">{grupo.rotulo}</p>
                  <div className="flex flex-wrap gap-1">
                    {/* O nome cru, e não um rótulo bonito: é exatamente esta
                        string que reaparece na lista de tools do resultado. */}
                    {grupo.nomes.map((nome) => (
                      <Badge key={nome} tone="warning">
                        {nome}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Mesa
        agentId={agente.id}
        accept={accept}
        podeLerArquivo={midiaLigada}
        podeFotografar={midiaLigada && config.lerImagem}
        tamanhoMaximoMb={config.tamanhoMaximoMb}
        tiposAceitos={tipos.map((t) => t.rotulo)}
        linkDeExecucoes={`/execucoes?agente=${agente.id}`}
      />

      <footer className="border-t border-line pt-4">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <ScrollText size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            O texto lido do documento fica gravado no registro desta execução, e
            qualquer pessoa com acesso ao painel consegue lê-lo em{" "}
            <Link
              href="/execucoes"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Execuções
            </Link>
            . Não mande aqui documento que a equipe não possa ler.
          </span>
        </p>
      </footer>
    </Moldura>
  );
}

/**
 * Moldura da página.
 *
 * Sem sidebar e com `max-w-3xl`: a coluna de leitura precisa caber inteira num
 * telefone, que é onde o documento costuma ser fotografado.
 */
function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6 sm:py-10">
      {children}
    </main>
  );
}

/**
 * Link que abre em outra guia.
 *
 * Os textos lidos vivem no estado do componente de cliente: sair da mesa
 * apagaria a leitura que a pessoa acabou de conferir, e ela teria de subir os
 * arquivos de novo — pagando a leitura de novo.
 */
function LinkExterno({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground ${
        className ?? ""
      }`}
    >
      {children}
      <ExternalLink size={12} aria-hidden />
    </Link>
  );
}
