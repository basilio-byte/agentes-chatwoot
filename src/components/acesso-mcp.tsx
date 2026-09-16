"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import {
  gerarTokenMcp,
  revogarTokenMcp,
  type EstadoTokenMcp,
} from "@/server/actions/mcp";
import {
  Aviso,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Meta,
  TituloDeBloco,
} from "@/components/ui";
import { formatarData } from "@/lib/utils";

export type TokenDaLista = {
  id: string;
  nome: string;
  hint: string;
  criadoEm: Date | string;
  usadoEm: Date | string | null;
  revogadoEm: Date | string | null;
  dono: { id: string; nome: string };
};

function Copiar({ texto, rotulo }: { texto: string; rotulo: string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        } catch {
          // Sem permissão de área de transferência: o texto continua na tela,
          // selecionável.
        }
      }}
    >
      {copiado ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      {copiado ? "Copiado" : rotulo}
    </Button>
  );
}

export function AcessoMcp({
  url,
  meuId,
  rotuloDoPapel,
  podeAlterar,
  souOwner,
  tokens,
}: {
  url: string;
  meuId: string;
  rotuloDoPapel: string;
  podeAlterar: boolean;
  souOwner: boolean;
  tokens: TokenDaLista[];
}) {
  const [estado, gerar, gerando] = useActionState<EstadoTokenMcp, FormData>(
    gerarTokenMcp,
    {},
  );
  const [resultado, setResultado] = useState<EstadoTokenMcp | null>(null);
  const [ocupado, iniciar] = useTransition();

  const comando = estado.token
    ? `claude mcp add --transport http --scope user seahub-agentes ${url} --header "Authorization: Bearer ${estado.token}"`
    : null;

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <TituloDeBloco icone={<ShieldCheck size={15} aria-hidden />}>
          O que o assistente consegue fazer
        </TituloDeBloco>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted">
          <li>
            O mesmo que a <strong>sua conta</strong> ({rotuloDoPapel})
            {podeAlterar
              ? ": ler tudo e operar os agentes — criar, editar, ligar e desligar agente, integração, ferramenta, gatilho e agendamento, e parar execução."
              : ": só consultar — agentes, prompts, ferramentas, integrações, execuções e consumo."}
          </li>
          <li>
            O papel é relido a cada chamada. Se ele mudar, o token acompanha na
            hora; conta desativada perde o acesso.
          </li>
          <li>
            Prompt muda em dois passos: o assistente mostra a diferença e só grava
            depois que você aprova.
          </li>
          <li>
            Toda alteração vai para a auditoria em seu nome, marcada como feita
            pelo MCP.
          </li>
          <li>
            <strong>Nunca</strong>, qualquer que seja o papel: ver ou trocar
            credencial, gerar token de gatilho, mexer em contas ou excluir agente.
            Isso fica só aqui no painel.
          </li>
        </ul>
      </Card>

      <Card className="space-y-4">
        <TituloDeBloco
          icone={<KeyRound size={15} aria-hidden />}
          descricao="Um token por lugar onde ele vai ficar — assim dá para revogar um sem derrubar os outros."
        >
          Gerar token
        </TituloDeBloco>

        <form action={gerar} className="flex flex-wrap items-end gap-3">
          {/* Campo curto não ocupa a linha inteira: um input de 900 px para
              caber "Claude Code no notebook" faz a tela parecer esticada. */}
          <div className="min-w-56 max-w-sm flex-1">
            <Field
              label="Nome"
              hint="Onde ele vai ficar. Ex.: Claude Code no notebook."
              erro={estado.camposComErro?.nome}
            >
              <Input name="nome" required maxLength={60} />
            </Field>
          </div>
          <Button type="submit" disabled={gerando}>
            {gerando ? "Gerando…" : "Gerar token"}
          </Button>
        </form>

        {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

        {estado.token && comando ? (
          <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/[0.05] p-3">
            <p className="text-[13px] font-medium text-warning">
              Copie agora — este token não aparece de novo.
            </p>

            <div className="space-y-1.5">
              <Meta className="block">Token</Meta>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 rounded bg-foreground/[0.06] px-2 py-1.5 font-mono text-xs break-all">
                  {estado.token}
                </code>
                <Copiar texto={estado.token} rotulo="Copiar token" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Meta className="block">Para conectar o Claude Code, rode no terminal:</Meta>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 rounded bg-foreground/[0.06] px-2 py-1.5 font-mono text-xs break-all">
                  {comando}
                </code>
                <Copiar texto={comando} rotulo="Copiar comando" />
              </div>
            </div>

            <Meta className="block">
              Em outro cliente de MCP: endereço{" "}
              <code className="font-mono">{url}</code>, transporte HTTP, e o
              cabeçalho <code className="font-mono">Authorization: Bearer</code>{" "}
              seguido do token.
            </Meta>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-3">
        <TituloDeBloco
          descricao={
            souOwner
              ? "Como proprietário, você vê e revoga os tokens de todo mundo."
              : undefined
          }
        >
          Tokens
        </TituloDeBloco>

        {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}
        {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}

        {tokens.length === 0 ? (
          <p className="text-sm text-muted">Nenhum token gerado ainda.</p>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.nome}</span>
                    {t.revogadoEm ? (
                      <Badge tone="danger">revogado</Badge>
                    ) : (
                      <Badge tone="success">ativo</Badge>
                    )}
                    {t.dono.id !== meuId ? <Badge>{t.dono.nome}</Badge> : null}
                  </div>
                  <Meta className="block">
                    <code className="font-mono">{t.hint}</code> · criado em{" "}
                    {formatarData(t.criadoEm)} ·{" "}
                    {t.usadoEm
                      ? `último uso em ${formatarData(t.usadoEm)}`
                      : "nunca usado"}
                    {t.revogadoEm ? ` · revogado em ${formatarData(t.revogadoEm)}` : ""}
                  </Meta>
                </div>

                {!t.revogadoEm ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={ocupado}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Revogar "${t.nome}"? Quem o estiver usando perde o acesso na próxima chamada.`,
                        )
                      ) {
                        return;
                      }
                      iniciar(async () => setResultado(await revogarTokenMcp(t.id)));
                    }}
                  >
                    Revogar
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
