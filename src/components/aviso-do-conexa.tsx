"use client";

import { useState, useTransition } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { gerarEnderecoDoAvisoDoConexa } from "@/server/actions/notas-fiscais";
import { EntregasDoWebhook, type Entrega } from "@/components/entregas-do-webhook";
import { Aviso, Button, Card, Input } from "@/components/ui";
import { formatarData } from "@/lib/utils";

/**
 * O endereço que o Conexa chama quando uma cobrança é paga (ou gerada): a nota
 * sai na hora, e não até 35 minutos depois. Mesmo modelo do token do gatilho
 * HTTP: o token nasce aqui, aparece por inteiro UMA vez, e só o hash fica
 * guardado. O estado local some no reload, de propósito.
 */
export function AvisoDoConexa({
  urlBase,
  geradoEm,
  entregas,
  podeGerar,
}: {
  /** `https://host/api/webhooks/conexa` — falta só o token. */
  urlBase: string;
  geradoEm: string | null;
  entregas: Entrega[];
  podeGerar: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [ocupado, iniciar] = useTransition();

  const url = `${urlBase}/${token ?? "••••••••••••••••••••••••••••"}`;

  function copiar() {
    navigator.clipboard.writeText(url);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <Card className="space-y-3">
      <h3 className="font-medium">Aviso do Conexa (nota na hora do pagamento)</h3>
      <p className="text-sm text-muted">
        Cadastre este endereço no Conexa, nos avisos de <strong>cobrança paga</strong> e{" "}
        <strong>cobrança gerada</strong>, <strong>além</strong> dos que já apontam para o n8n. O aviso só diz{" "}
        <em>qual</em> cobrança: o valor, os itens e o cliente são relidos no Conexa. Sem ele, a nota sai pela
        conferência de 30 minutos, que continua funcionando como rede de segurança.
      </p>

      <div className="space-y-1">
        <span className="text-sm font-medium">Endereço do aviso</span>
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs" />
          <Button type="button" variant="secondary" disabled={!token} onClick={copiar}>
            {copiado ? <Check size={14} /> : <Copy size={14} />}
            {copiado ? "Copiado" : "Copiar"}
          </Button>
        </div>
        {token ? (
          <Aviso tone="danger">
            <strong>Copie agora.</strong> Esta é a única vez que o endereço aparece por inteiro — cole-o no Conexa
            antes de sair desta página. Gerar de novo troca o endereço, e o que já está cadastrado deixa de valer.
          </Aviso>
        ) : null}
      </div>

      {podeGerar ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={ocupado}
            onClick={() =>
              iniciar(async () => {
                const r = await gerarEnderecoDoAvisoDoConexa();
                setErro(r.erro ?? null);
                if (r.token) setToken(r.token);
              })
            }
          >
            <RefreshCw size={14} aria-hidden />
            {ocupado ? "Gerando…" : geradoEm ? "Gerar outro endereço" : "Gerar endereço"}
          </Button>
          {geradoEm ? (
            <span className="text-xs text-muted">Endereço gerado em {formatarData(new Date(geradoEm))}.</span>
          ) : (
            <span className="text-xs text-muted">Nenhum endereço gerado ainda.</span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">Só o papel Proprietário gera o endereço.</p>
      )}

      {erro ? <Aviso tone="danger">{erro}</Aviso> : null}

      <EntregasDoWebhook
        entregas={entregas}
        semMoldura
        textoVazio={<>Nenhum aviso chegou ainda. Depois de cadastrar o endereço no Conexa, o próximo pagamento aparece aqui.</>}
        textoSegredoQuebrado={<>O último aviso foi recusado: o endereço cadastrado no Conexa não confere com o atual. Gere outro e cadastre de novo.</>}
      />
    </Card>
  );
}
