import { resolverCampo, type Entrada } from "./campos";
import type { ClickUpCampoPersonalizado } from "./tipos";
import { limparEndereco, valorDeLocalizacao, type Coordenadas } from "./localizacao";

/**
 * Converte, antes de `prepararCampos`, os campos de LOCALIZAÇÃO que o agente
 * mandou como texto ("Rua X, 100, Bairro, Cidade - UF, CEP") no valor que a API
 * quer. Os demais campos passam intactos.
 *
 * ⚠ Geocodificação que falha NUNCA aborta o lote — ao contrário de um campo de
 * outro tipo com valor ruim. O campo sai da lista e vira `aviso`, a task é criada
 * sem ele, e o que ele deixa de cobrir (a regra da Base) aparece em
 * `contrato.faltam`. Perder a venda inteira por causa de um pino seria o
 * defeito que o campo existe para evitar.
 */

export type Geocodificador = (endereco: string) => Promise<Coordenadas | null>;

export type AvisoDeLocalizacao = { campo: string; motivo: string };

export async function resolverLocalizacoes(
  entradas: Entrada[],
  campos: ClickUpCampoPersonalizado[],
  geocodificar: Geocodificador,
): Promise<{ entradas: Entrada[]; avisos: AvisoDeLocalizacao[] }> {
  const saida: Entrada[] = [];
  const avisos: AvisoDeLocalizacao[] = [];

  for (const entrada of entradas) {
    const achado = resolverCampo(entrada.campo, campos);
    const ehLocalizacao = achado.tipo === "achado" && achado.campo.type === "location";

    // Só o que é texto num campo de localização precisa de conversão. Valor já
    // convertido passa (e `converterValor` o confere); o resto não é conosco.
    if (!ehLocalizacao || typeof entrada.valor !== "string") {
      saida.push(entrada);
      continue;
    }

    const endereco = limparEndereco(entrada.valor);
    const nome = achado.tipo === "achado" ? achado.campo.name : entrada.campo;

    if (!endereco) {
      avisos.push({ campo: nome, motivo: "veio vazio — o campo ficou em branco." });
      continue;
    }

    const coordenadas = await geocodificar(endereco);
    if (!coordenadas) {
      avisos.push({
        campo: nome,
        motivo:
          "não consegui localizar o endereço no mapa (confira se tem rua, número, bairro, cidade e CEP). O campo ficou em branco e a equipe o preenche na tela do ClickUp.",
      });
      continue;
    }

    saida.push({ campo: entrada.campo, valor: valorDeLocalizacao(endereco, coordenadas) });
  }

  return { entradas: saida, avisos };
}
