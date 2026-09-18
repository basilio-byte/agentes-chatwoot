import { BellRing } from "lucide-react";
import { Recolhivel } from "@/components/recolhivel";
import { Aviso, Badge, Meta, Tabela } from "@/components/ui";
import { AlertaDeSaldoForm, TesteDoAlerta } from "@/components/consumo/alerta-de-saldo";
import type { AlertaLido } from "@/server/alerta-de-saldo/alerta";
import {
  dolar,
  formatarTelefone,
  INTERVALO_ENTRE_AVISOS_MS,
} from "@/server/alerta-de-saldo/regras";
import type { Entrega } from "@/server/alerta-de-saldo/conversa";
import { formatarData } from "@/lib/utils";

const ROTULO_DO_TIPO = { BAIXO: "Saldo baixo", ZERADO: "Saldo zerado", TESTE: "Teste" } as const;

type AvisoEnviado = {
  id: string;
  tipo: keyof typeof ROTULO_DO_TIPO;
  saldoUsd: number | null;
  entregas: unknown;
  entregues: number;
  falhas: number;
  criadoEm: Date;
};

/**
 * Alerta de saldo por WhatsApp, logo abaixo do saldo em Consumo. Só chega aqui
 * quem é Administrador para cima — a página decide, porque os telefones são de
 * pessoas e a tela é aberta à equipe inteira.
 *
 * Numa linha que abre (`Recolhivel`), como as integrações: fechado, diz se está
 * ligado e para quantas pessoas, que é a pergunta de quem passa por aqui para
 * ver o saldo.
 */
export function BlocoDoAlerta({ alerta, avisos }: { alerta: AlertaLido; avisos: AvisoEnviado[] }) {
  const pessoas = alerta.destinatarios.length;
  const resumo = alerta.ligado
    ? [
        `${pessoas} ${pessoas === 1 ? "pessoa" : "pessoas"}`,
        `abaixo de ${dolar(alerta.limiteUsd)}`,
        alerta.avisadoEm ? `último aviso em ${formatarData(alerta.avisadoEm)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "ninguém é avisado quando o saldo cai";

  return (
    <Recolhivel
      titulo="Alerta de saldo por WhatsApp"
      icone={<BellRing size={15} aria-hidden />}
      estado={
        alerta.ligado ? <Badge tone="success">ligado</Badge> : <Badge>desligado</Badge>
      }
      resumo={resumo}
    >
      <p className="text-[13px] leading-relaxed text-muted">
        Quando o saldo fica abaixo do limite, o sistema manda uma mensagem pela
        caixa do Chatwoot escolhida, a qualquer hora. Repete a cada 24 h
        enquanto continuar abaixo, avisa de novo na hora se zerar, e para quando
        alguém recarrega. O saldo é conferido a cada 10 minutos, e uma leitura
        que falha nunca vira alerta.
      </p>

      <Situacao alerta={alerta} />

      <AlertaDeSaldoForm
        ligado={alerta.ligado}
        limiteUsd={String(alerta.limiteUsd).replace(".", ",")}
        caixaId={String(alerta.caixaId)}
        destinatarios={alerta.destinatarios.map((d) => ({
          nome: d.nome,
          telefone: formatarTelefone(d.telefone),
        }))}
      />

      <div className="border-t border-line pt-4">
        <TesteDoAlerta podeTestar={pessoas > 0} />
      </div>

      {avisos.length > 0 ? <Historico avisos={avisos} /> : null}
    </Recolhivel>
  );
}

function Situacao({ alerta }: { alerta: AlertaLido }) {
  if (!alerta.ligado) return null;

  if (alerta.ultimaFalha) {
    return (
      <Aviso tone="warning">
        A última conferência
        {alerta.conferidoEm ? ` (${formatarData(alerta.conferidoEm)})` : ""} não
        chegou ao fim: {alerta.ultimaFalha}
      </Aviso>
    );
  }

  if (alerta.abaixoDesde) {
    const proximo = alerta.avisadoEm
      ? new Date(alerta.avisadoEm.getTime() + INTERVALO_ENTRE_AVISOS_MS)
      : null;
    return (
      <Aviso tone="warning">
        Saldo abaixo do limite desde {formatarData(alerta.abaixoDesde)}.
        {alerta.avisadoEm
          ? ` Último aviso em ${formatarData(alerta.avisadoEm)}; o próximo sai a partir de ${formatarData(proximo!)}, se o saldo continuar abaixo.`
          : ""}
      </Aviso>
    );
  }

  return (
    <Meta className="block">
      {alerta.conferidoEm
        ? `Conferido em ${formatarData(alerta.conferidoEm)}: saldo acima do limite.`
        : "Ainda não conferido. O worker confere a cada 10 minutos."}
    </Meta>
  );
}

function Historico({ avisos }: { avisos: AvisoEnviado[] }) {
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-[13px] font-medium">Últimos envios</p>
      <Tabela
        cabecalho={
          <>
            <th scope="col">Quando</th>
            <th scope="col">Tipo</th>
            <th scope="col" className="text-right">
              Saldo
            </th>
            <th scope="col">Resultado</th>
          </>
        }
      >
        {avisos.map((aviso) => {
          const entregas = Array.isArray(aviso.entregas) ? (aviso.entregas as Entrega[]) : [];
          const falharam = entregas.filter((e) => !e.ok);
          return (
            <tr key={aviso.id}>
              <td className="whitespace-nowrap">
                <Meta>{formatarData(aviso.criadoEm)}</Meta>
              </td>
              <td>
                <Badge tone={aviso.tipo === "TESTE" ? "neutral" : aviso.tipo === "ZERADO" ? "danger" : "warning"}>
                  {ROTULO_DO_TIPO[aviso.tipo]}
                </Badge>
              </td>
              <td className="text-right text-xs tabular-nums">
                {aviso.saldoUsd == null ? "—" : dolar(aviso.saldoUsd)}
              </td>
              <td className="text-xs">
                {aviso.entregues} de {aviso.entregues + aviso.falhas} entregues ao
                Chatwoot
                {falharam.length > 0 ? (
                  <Meta className="block">
                    {falharam.map((e) => `${e.nome}: ${e.detalhe}`).join(" · ")}
                  </Meta>
                ) : null}
              </td>
            </tr>
          );
        })}
      </Tabela>
    </div>
  );
}
