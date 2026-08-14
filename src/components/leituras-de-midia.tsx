import { FileText, Image as ImageIcon, Mic, Paperclip } from "lucide-react";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import type { LeituraRecente } from "@/server/actions/openai";
import { Badge, EmptyState, Meta } from "@/components/ui";
import { formatarData } from "@/lib/utils";

/**
 * Últimas leituras de anexo.
 *
 * Responde "está lendo mesmo?" sem obrigar ninguém a abrir log de container —
 * mesmo papel das Entregas recebidas na tela do agente. O conteúdo inteiro do
 * que foi lido aparece na entrada da execução, em Execuções: aqui a pergunta é
 * se funcionou, não o que dizia.
 */

const ICONE: Record<MediaKind, React.ReactNode> = {
  [MediaKind.AUDIO]: <Mic size={13} aria-hidden />,
  [MediaKind.IMAGE]: <ImageIcon size={13} aria-hidden />,
  [MediaKind.DOCUMENT]: <FileText size={13} aria-hidden />,
  [MediaKind.UNSUPPORTED]: <Paperclip size={13} aria-hidden />,
};

const ROTULO: Record<MediaKind, string> = {
  [MediaKind.AUDIO]: "áudio",
  [MediaKind.IMAGE]: "imagem",
  [MediaKind.DOCUMENT]: "documento",
  [MediaKind.UNSUPPORTED]: "não lido",
};

function tomDoStatus(status: string) {
  if (status === MediaStatus.OK) return "success" as const;
  if (status === MediaStatus.ERROR) return "danger" as const;
  return "neutral" as const;
}

export function LeiturasDeMidia({ leituras }: { leituras: LeituraRecente[] }) {
  if (leituras.length === 0) {
    return (
      <EmptyState
        icone={<Paperclip size={18} aria-hidden />}
        titulo="Nenhum anexo lido ainda"
        descricao="Assim que um cliente mandar áudio, foto ou documento numa caixa com a leitura ligada, o resultado aparece aqui."
      />
    );
  }

  return (
    <ul className="max-h-96 space-y-1.5 overflow-y-auto">
      {leituras.map((l) => (
        <li key={l.id} className="rounded-lg border border-line p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">{ICONE[l.kind]}</span>
            <span className="text-sm font-medium">
              {l.nomeArquivo || ROTULO[l.kind]}
            </span>
            <Badge tone={tomDoStatus(l.status)}>{l.status.toLowerCase()}</Badge>
            {l.model ? (
              <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {l.model}
              </code>
            ) : null}
            <span className="ml-auto text-xs text-muted">
              {formatarData(l.createdAt)}
            </span>
          </div>

          {l.texto ? <Meta className="mt-1 block">{l.texto}…</Meta> : null}
          {l.erro ? (
            <Meta className="mt-1 block text-danger">{l.erro}</Meta>
          ) : null}

          <Meta className="mt-1 block">
            {l.segundosDeAudio != null ? `${l.segundosDeAudio}s de áudio · ` : ""}
            {l.inputTokens + l.outputTokens > 0
              ? `${l.inputTokens} + ${l.outputTokens} tokens · `
              : ""}
            {l.duracaoMs != null ? `${(l.duracaoMs / 1000).toFixed(1)}s para ler` : ""}
          </Meta>
        </li>
      ))}
    </ul>
  );
}
