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
  // Só avisa se a recusa ainda vale: uma entrega aceita depois dela significa
  // que o secret já foi corrigido. Sem isto, o alarme ficava vermelho para
  // sempre por causa de um erro resolvido meia hora antes.
  const ultimaRecusa = entregas.findIndex((e) => e.resultado === "rejeitado");
  const aceitaDepois =
    ultimaRecusa >= 0 &&
    entregas
      .slice(0, ultimaRecusa)
      .some((e) => e.resultado === "agendado" || e.resultado === "ignorado");
  const secretQuebrado = ultimaRecusa >= 0 && !aceitaDepois;

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
          {secretQuebrado ? (
            <Aviso tone="danger">
              A última entrega foi recusada por assinatura. O{" "}
              <strong>secret do webhook</strong> daqui não confere com o do bot no
              Chatwoot — salve o secret de novo.
            </Aviso>
          ) : null}

          {/* Rola em vez de crescer: dez linhas cabem, o resto fica a um
              arrastar de distância sem empurrar o resto da página. */}
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
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

          <Meta>
            Últimas {entregas.length} entregas. O histórico é podado
            automaticamente — o que interessa aqui é o passado recente.
          </Meta>
        </>
      )}
    </Card>
  );
}
