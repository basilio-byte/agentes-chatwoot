import { Radio } from "lucide-react";
import { Aviso, Badge, Card, Meta } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export type Entrega = {
  id: string;
  eventType: string;
  resultado: string | null;
  detalhe: string | null;
  createdAt: Date;
};

const TOM: Record<string, "success" | "danger" | "neutral" | "accent"> = {
  agendado: "success",
  rejeitado: "danger",
  ignorado: "neutral",
};

/**
 * Últimas entregas que o Chatwoot fez neste webhook.
 *
 * Responde a pergunta que o log de container respondia mal: "o Chatwoot está
 * chamando?". Sem nada aqui, o problema é do lado de lá (bot sem URL, sem
 * vínculo com a caixa); com entregas recusadas, é o secret.
 */
export function EntregasDoWebhook({ entregas }: { entregas: Entrega[] }) {
  const recusadas = entregas.filter((e) => e.resultado === "rejeitado").length;

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Radio size={15} aria-hidden className="text-muted" />
          Entregas recebidas
        </h2>
        <p className="text-xs text-muted">
          O que o Chatwoot mandou para este webhook, mais recente primeiro.
        </p>
      </div>

      {entregas.length === 0 ? (
        <Aviso>
          Nada chegou ainda. Se você já mandou mensagem na caixa, o problema está
          do lado do Chatwoot: confira se o bot tem a <strong>URL do webhook</strong>{" "}
          preenchida e se ele está <strong>vinculado à caixa de entrada</strong>.
        </Aviso>
      ) : (
        <>
          {recusadas > 0 ? (
            <Aviso tone="danger">
              {recusadas} entrega(s) recusada(s) por assinatura. O{" "}
              <strong>secret do webhook</strong> daqui não confere com o do bot no
              Chatwoot — salve o secret de novo.
            </Aviso>
          ) : null}

          <ul className="divide-y divide-line rounded-lg border border-line">
            {entregas.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Badge tone={TOM[e.resultado ?? ""] ?? "accent"}>
                  {e.resultado ?? "recebido"}
                </Badge>
                <code className="font-mono text-xs">{e.eventType}</code>
                {e.detalhe ? (
                  <span className="min-w-0 truncate text-xs text-muted">
                    {e.detalhe}
                  </span>
                ) : null}
                <Meta className="ml-auto shrink-0">
                  {formatarData(e.createdAt)}
                </Meta>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
