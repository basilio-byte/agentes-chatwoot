import Link from "next/link";
import { Wallet } from "lucide-react";
import { Aviso, Card, TituloDeBloco } from "@/components/ui";
import {
  classificarSaldo,
  diasDeSaldo,
  SALDO_MINIMO_USD,
  type LeituraDeSaldo,
} from "@/server/consumo/saldo";
import { cn, formatarData, formatarNumero, formatarUsd } from "@/lib/utils";

/** Onde se compra crédito. A tela diz o caminho, senão o aviso não resolve nada. */
const PAGINA_DE_CREDITOS = "https://openrouter.ai/settings/credits";

/**
 * Saldo da conta da OpenRouter, na tela de Consumo.
 *
 * Fica **acima** da barra de filtros porque não é recortado por ela: o saldo é
 * o estado da conta agora, não uma apuração do período escolhido. Embaixo da
 * barra, a tela estaria prometendo que o número responde ao filtro.
 */
export function SaldoDaConta({
  leitura,
  gastoDiarioUsd,
  diasDaMedia,
  falhas,
  limiteUsd = SALDO_MINIMO_USD,
  alertaLigado = false,
}: {
  leitura: LeituraDeSaldo;
  gastoDiarioUsd: number;
  diasDaMedia: number;
  falhas: { quantidade: number; ultima: Date | null };
  /**
   * O limite do alerta por WhatsApp. A cor do número e o aviso da tela seguem
   * o MESMO limite: a tela dizer "baixo" num valor em que ninguém foi avisado,
   * ou o contrário, seriam duas réguas para a mesma pergunta.
   */
  limiteUsd?: number;
  alertaLigado?: boolean;
}) {
  return (
    <Card className="space-y-3">
      <TituloDeBloco
        icone={<Wallet size={15} aria-hidden />}
        descricao="É o que paga todas as chamadas dos agentes. Não depende do período escolhido abaixo — é a conta agora."
      >
        Saldo na OpenRouter
      </TituloDeBloco>

      <Leitura
        leitura={leitura}
        gastoDiarioUsd={gastoDiarioUsd}
        diasDaMedia={diasDaMedia}
        limiteUsd={limiteUsd}
      />

      {/* Para a equipe inteira: SE alguém é avisado, nunca QUEM — os telefones
          só aparecem no bloco do alerta, que é de Administrador. */}
      <p className="text-xs text-muted">
        {alertaLigado
          ? `Alerta por WhatsApp ligado: avisa quando o saldo fica abaixo de ${formatarUsd(limiteUsd)}.`
          : "Alerta por WhatsApp desligado: ninguém é avisado quando o saldo cai."}
      </p>

      {falhas.quantidade > 0 ? (
        <Aviso tone="danger">
          <strong>
            {formatarNumero(falhas.quantidade)}{" "}
            {falhas.quantidade === 1 ? "execução falhou" : "execuções falharam"}{" "}
            por falta de crédito
          </strong>{" "}
          nas últimas 24 horas
          {falhas.ultima ? `, a última em ${formatarData(falhas.ultima)}` : ""}.
          Cada uma é alguém que ficou sem resposta.{" "}
          <Link href="/execucoes?status=ERROR" className="underline">
            Ver em Execuções
          </Link>
          .
        </Aviso>
      ) : null}
    </Card>
  );
}

function Leitura({
  leitura,
  gastoDiarioUsd,
  diasDaMedia,
  limiteUsd,
}: {
  leitura: LeituraDeSaldo;
  gastoDiarioUsd: number;
  diasDaMedia: number;
  limiteUsd: number;
}) {
  if (leitura.estado === "sem_chave") {
    return (
      <Aviso tone="danger">
        Sem <code>OPENROUTER_API_KEY</code> configurada: nenhum agente consegue
        rodar, e não há a quem perguntar o saldo. A variável é definida no
        Easypanel.
      </Aviso>
    );
  }

  if (leitura.estado === "indisponivel") {
    return (
      <Aviso tone="warning">
        A OpenRouter respondeu, mas não dá para saber o saldo: {leitura.motivo}
      </Aviso>
    );
  }

  if (leitura.estado === "erro") {
    return (
      <Aviso tone="neutral">
        Não consegui ler o saldo agora ({leitura.motivo}). Quem falhou foi a
        leitura, não a conta — isto <strong>não</strong> quer dizer que o saldo
        acabou. Tento de novo quando esta tela for aberta de novo.
      </Aviso>
    );
  }

  const situacao = classificarSaldo(leitura.saldoUsd, limiteUsd);
  const dias = diasDeSaldo(leitura.saldoUsd, gastoDiarioUsd);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "text-[30px] font-semibold leading-9 tracking-tight",
            situacao === "esgotado" && "text-danger",
            situacao === "baixo" && "text-warning",
          )}
        >
          {formatarUsd(leitura.saldoUsd)}
        </span>
        <span className="text-xs text-muted">
          {/* Os dois números não são a mesma coisa, e a tela precisa dizer qual
              está mostrando: o teto de uma chave pode ser bem menor que o saldo
              da conta. */}
          {leitura.origem === "conta"
            ? "saldo da conta"
            : "restante do teto desta chave"}{" "}
          · lido em {formatarData(leitura.lidoEm)}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        {dias == null
          ? `Sem gasto medido nos últimos ${diasDaMedia} dias — não dá para estimar quanto dura.`
          : `No ritmo dos últimos ${diasDaMedia} dias (${formatarUsd(
              gastoDiarioUsd,
            )} por dia), dura ${duracao(dias)}.`}
        {leitura.usadoUsd != null
          ? ` Já foram gastos ${formatarUsd(leitura.usadoUsd)} desde o começo da conta.`
          : ""}
      </p>

      {situacao !== "ok" ? (
        <Aviso tone={situacao === "esgotado" ? "danger" : "warning"}>
          {situacao === "esgotado" ? (
            <>
              <strong>Sem saldo.</strong> Os agentes não conseguem responder
              ninguém até alguém repor o crédito.
            </>
          ) : (
            <>
              <strong>
                Saldo abaixo de {formatarUsd(limiteUsd)}.
              </strong>{" "}
              Quando acabar, toda conversa fica sem resposta — o cliente recebe
              um aviso de instabilidade e a conversa espera uma pessoa.
            </>
          )}{" "}
          <a
            href={PAGINA_DE_CREDITOS}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Repor crédito na OpenRouter
          </a>
          .
        </Aviso>
      ) : null}
    </div>
  );
}

/** Arredonda para baixo: prometer o dia que talvez não exista é o erro caro. */
function duracao(dias: number): string {
  if (dias < 1) return "menos de um dia";
  const inteiro = Math.floor(dias);
  return inteiro === 1 ? "cerca de 1 dia" : `cerca de ${inteiro} dias`;
}
