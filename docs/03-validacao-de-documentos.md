# Validação de documentos: o que dá para checar, onde, e com que garantia

> Pesquisado e conferido na fonte em **10/09/2026**. Site de governo muda de
> endereço e de regra sem aviso: reconfira o link antes de montar processo em
> cima dele.

## Leia isto primeiro: são quatro perguntas diferentes

Quase toda confusão sobre "validar documento" vem de tratar como uma só quatro
perguntas que têm respostas, custos e garantias diferentes:

1. **O número é bem formado?** Dígito verificador. Offline, grátis, instantâneo.
   Pega erro de digitação e número inventado ao acaso. **Não prova que o número
   existe.**
2. **O número existe e está regular na base oficial?** Consulta ao governo.
3. **O documento é autêntico, não foi forjado nem alterado?** Assinatura digital
   ou QR code seguro.
4. **O documento é de quem mandou?** Nenhuma das três acima responde isso. Só
   biometria contra base oficial, e é paga.

## Resumo

| Documento | O que confere | Onde | Grátis | O que exige | O agente usa sozinho? |
|---|---|---|---|---|---|
| CPF | número bem formado | o próprio sistema | ✅ | nada | ✅ |
| CPF | situação cadastral | Receita Federal | ✅ | data de nascimento e captcha | ❌ |
| CNPJ | número bem formado **e** base pública | o próprio sistema (BrasilAPI) | ✅ | nada | ✅ |
| CNPJ | comprovante de situação | Receita Federal | ✅ | captcha | ❌ |
| CNH | número de registro bem formado | o próprio sistema | ✅ | nada | ✅ |
| CNH | dados e validade | gov.br / Senatran | ✅ | login gov.br e código de segurança | ❌ |
| CNH-e em PDF | **autenticidade do arquivo** | VALIDAR, do ITI | ✅ | o PDF original | ❌ só pela web |
| CNH-e | QR code | app Vio | ✅ | celular com câmera | ❌ |
| CIN | QR code e validade | app Vio | ✅ | conta gov.br, no modo completo | ❌ |
| RG antigo | — | **não existe base nacional** | — | — | — |
| Qualquer | **é de quem mandou** (biometria) | Datavalid, do Serpro | ❌ pago | contrato | ✅ tem API |

---

## O que o sistema já faz

Provedor `DOCUMENTOS`, sem credencial. As três ferramentas estão em
`src/server/documentos/`.

- **`documento_conferir_cpf`**: confere o dígito verificador. Diz se o CPF é bem
  formado, e só isso.
- **`documento_conferir_cnh`**: confere o dígito do número de registro. O
  algoritmo tem variantes circulando, então quando o dígito não fecha a
  ferramenta manda **conferir à mão** em vez de declarar o documento falso.
- **`documento_conferir_cnpj`**: confere o dígito e, se estiver bem formado,
  consulta a base pública da Receita pela BrasilAPI e traz razão social,
  situação cadastral e município.
  - BrasilAPI: <https://brasilapi.com.br/>
  - Endpoint usado: `https://brasilapi.com.br/api/cnpj/v1/{cnpj}`
  - ⚠ É projeto comunitário, sem compromisso de disponibilidade. Por isso
    timeout e erro de servidor viram `indeterminado`, e **só `404` autoriza dizer
    que o CNPJ não existe**.

---

## CPF

### Situação cadastral: Receita Federal

- **Link:** <https://servicos.receita.fazenda.gov.br/servicos/cpf/consultasituacao/consultapublica.asp>
- **Pede:** CPF e data de nascimento, com captcha.
- **Devolve:** a situação cadastral: regular, pendente, suspensa, cancelada, nula
  ou titular falecido. Nas palavras da própria página, o comprovante *"limita-se
  tão somente a comprovar a situação cadastral no CPF"*.
- **Custo:** grátis, sem login.
- **API:** não há API oficial.
- ⚠ Existem serviços de terceiros que resolvem o captcha para automatizar a
  consulta. É área cinzenta de termo de uso: **não integrar**.

---

## CNPJ

### Comprovante de inscrição e situação cadastral: Receita Federal

- **Link:** <https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp>
- **Pede:** CNPJ, com captcha.
- **Devolve:** razão social, endereço e situação cadastral. Dá para salvar como PDF.
- **Custo:** grátis.
- **Na prática:** para o agente, a BrasilAPI já cobre isso sem captcha (ver
  acima). O site da Receita serve para uma pessoa emitir o comprovante oficial.

---

## CNH: pelo número

### Validar CNH: gov.br / Portal de Serviços Senatran

- **Link:** <https://www.gov.br/pt-br/servicos/validar-cnh>
- **Pede:** login gov.br (nível bronze, prata ou ouro), CPF, número de registro e
  **código de segurança** da CNH.
- **Devolve:** CPF do condutor, número de registro, número do formulário da CNH,
  código de segurança, nome, categoria e validade.
- **Custo:** grátis.
- **API:** não há. Para volume maior, a página orienta entidades públicas e
  privadas a pedir autorização e contratar serviço específico.
- ⚠ A página pede para informar *"seu CPF"*. Não ficou claro se um terceiro
  consegue validar a CNH de **outra pessoa** pelo formulário.

### Consultar os dados da própria habilitação

- **Link:** <https://www.gov.br/pt-br/servicos/consultar-online-dados-de-sua-habilitacao-de-transito>
- Serviço do titular: é a pessoa consultando a própria CNH, não a empresa
  conferindo a de alguém.

---

## CNH-e (digital): autenticidade do arquivo

A CNH-e em PDF sai **assinada com certificado digital ICP-Brasil**. O próprio
arquivo diz isso no rodapé: *"Documento assinado com certificado digital em
conformidade com a Medida Provisória nº 2200-2/2001"*.

Conferir essa assinatura é **mais forte que conferir o número**: prova que o
arquivo saiu do governo e que ninguém mexeu nele depois.

### VALIDAR: ITI (Instituto Nacional de Tecnologia da Informação)

- **Página do serviço:** <https://www.gov.br/pt-br/servicos/realizar-validacao-de-assinaturas-eletronicas-validar>
- **Site:** <https://validar.iti.gov.br/>
- **Guia do desenvolvedor:** <https://validar.iti.gov.br/guia-desenvolvedor.html>
- **Dúvidas:** <https://validar.iti.gov.br/duvidas.html>
- **Cartilha de uso (PDF):** <https://validar.iti.gov.br/Docs/cartilha-de-uso.pdf>
- **Confere:** se o arquivo foi assinado com certificado válido, íntegro e não
  revogado, e a cadeia até a Autoridade Certificadora Raiz da ICP-Brasil. Vale
  também para assinaturas feitas pela plataforma gov.br.
- **Aceita:** upload do PDF, arquivo por URL ou leitura de QR code.
- **Custo:** grátis, para qualquer pessoa.
- **API:** o guia do desenvolvedor **não descreve API de validação**. Ele trata
  apenas de parâmetros para sistemas que **geram** documentos assinados.
- ⚠ **Só funciona com o PDF original.** Foto ou print da carteira perde a
  assinatura. Se o cliente mandar imagem, não há o que validar aqui.
- ⚠ **A frase do rodapé é só texto.** Um PDF falso pode conter exatamente a mesma
  frase. O agente lê essa linha, e **nunca** pode concluir "assinado, portanto
  autêntico" por causa dela. Quem confirma a assinatura é o VALIDAR.

### QR code da CNH-e: app Vio (Serpro / Senatran)

- **Página do serviço:** <https://www.gov.br/pt-br/servicos/utilizar-aplicativo-vio-app-vio>
- **Android:** <https://play.google.com/store/apps/details?id=br.gov.serpro.lince>
- **Tutorial de leitura do QR code (Senatran):** <https://portalservicos.senatran.serpro.gov.br/static/carteiradigital/tutoriais/html/demo_25.html>
- **Confere:** a autenticidade do Safe QR Code e **mostra os dados originais** do
  documento, para comparar com o que foi apresentado. O app só lê os QR codes do
  próprio Vio.
- **Funciona offline.**
- **Custo:** grátis.
- **API:** a página oficial não menciona API, SDK nem leitura a partir de
  imagem. As instruções falam em apontar a câmera.

---

## RG e CIN (Carteira de Identidade Nacional)

### RG antigo

**Não existe base nacional.** Cada estado emite num formato próprio, e não há o
que consultar.

### CIN: QR code e validade

A CIN usa o **CPF como número**, então documento novo cai no caso do CPF para a
checagem de número. Para autenticidade, ela tem QR code.

- **Página do serviço:** <https://www.gov.br/pt-br/servicos/verificar-validade-de-qr-code-da-carteira-de-identidade-nacional>
- **Anúncio do app (ITI):** <https://www.gov.br/iti/pt-br/assuntos/noticias/indice-de-noticias/lancamento-do-aplicativo-de-validacao-da-carteira-de-identidade-nacional-cin>
- **App:** Vio, para Android e iOS.
- **Dois modos, com garantias diferentes:**
  - **Leitura parcial, offline:** confirma que o QR code foi emitido pelo
    Ministério da Justiça e mostra CPF e data de nascimento. ⚠ **Não confirma que
    o documento está válido.**
  - **Leitura completa, online:** confirma a validade e mostra os dados da CIN
    para comparar. Exige internet e conta gov.br.
- **Custo:** grátis.

---

## Identidade de verdade (pago): Datavalid, do Serpro

É o único caminho **oficial e programático** para a quarta pergunta: o documento
é de quem mandou?

- **Página do serviço:** <https://www.gov.br/pt-br/servicos/obter-solucao-digital-para-validacao-de-identidade-datavalid>
- **Documentação da API:** <https://apicenter.estaleiro.serpro.gov.br/documentacao/datavalid/en/>
- **Novidades:** <https://campanhas.serpro.gov.br/datavalid/novidades/>
- **Confere:** dados cadastrais direto nas bases oficiais e **biometria** facial e
  digital contra a base da CNH, com índice de similaridade.
- **Custo:** por validação, sem mensalidade, com desconto progressivo por volume.
  A tabela de preços fica na Loja Serpro.

---

## O que isso significa para a Seahub

1. **Hoje, sem código.** O agente confere o dígito de CPF e CNH e consulta o CNPJ
   na base pública. Quando o cliente mandar a **CNH-e como PDF**, uma pessoa sobe
   o arquivo no VALIDAR e confere em meio minuto: é a checagem mais forte que
   existe de graça. Para QR code de CNH-e ou CIN, o app Vio.
2. **Automático e gratuito.** O sistema pode validar a assinatura ICP-Brasil do
   PDF por conta própria, porque a cadeia de certificados é pública no ITI. É
   trabalho de engenharia de verdade: checar revogação e validade de longo prazo
   não é trivial. **Não foi medido.**
3. **Antifraude de verdade.** Datavalid, pago por consulta.

## O que o agente nunca pode concluir

- **"CPF válido"** a partir do dígito verificador. O certo é "bem formado".
- **"Documento autêntico"** a partir da frase de assinatura no rodapé do PDF.
- **"Não existe"** a partir de falha de consulta (timeout, erro de servidor). Só
  `404` autoriza.
- **"É do cliente"** a partir de qualquer uma das checagens acima.

A palavra nos registros é **"conferido"**, nunca "validado" nem "autenticado".

---

## Todos os links

| Serviço | Link |
|---|---|
| CPF: situação cadastral (Receita) | <https://servicos.receita.fazenda.gov.br/servicos/cpf/consultasituacao/consultapublica.asp> |
| CNPJ: comprovante de situação (Receita) | <https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp> |
| CNPJ: BrasilAPI (usada pelo sistema) | <https://brasilapi.com.br/> |
| CNH: validar (gov.br / Senatran) | <https://www.gov.br/pt-br/servicos/validar-cnh> |
| CNH: consultar a própria habilitação | <https://www.gov.br/pt-br/servicos/consultar-online-dados-de-sua-habilitacao-de-transito> |
| Assinatura digital: VALIDAR (serviço) | <https://www.gov.br/pt-br/servicos/realizar-validacao-de-assinaturas-eletronicas-validar> |
| Assinatura digital: VALIDAR (site) | <https://validar.iti.gov.br/> |
| Assinatura digital: dúvidas (VALIDAR) | <https://validar.iti.gov.br/duvidas.html> |
| Assinatura digital: guia do desenvolvedor | <https://validar.iti.gov.br/guia-desenvolvedor.html> |
| Assinatura digital: cartilha de uso (PDF) | <https://validar.iti.gov.br/Docs/cartilha-de-uso.pdf> |
| QR code: app Vio (serviço) | <https://www.gov.br/pt-br/servicos/utilizar-aplicativo-vio-app-vio> |
| QR code: app Vio (Android) | <https://play.google.com/store/apps/details?id=br.gov.serpro.lince> |
| CNH-e: leitura do QR code (Senatran) | <https://portalservicos.senatran.serpro.gov.br/static/carteiradigital/tutoriais/html/demo_25.html> |
| CIN: verificar QR code | <https://www.gov.br/pt-br/servicos/verificar-validade-de-qr-code-da-carteira-de-identidade-nacional> |
| CIN: anúncio do app (ITI) | <https://www.gov.br/iti/pt-br/assuntos/noticias/indice-de-noticias/lancamento-do-aplicativo-de-validacao-da-carteira-de-identidade-nacional-cin> |
| Datavalid: serviço | <https://www.gov.br/pt-br/servicos/obter-solucao-digital-para-validacao-de-identidade-datavalid> |
| Datavalid: documentação da API | <https://apicenter.estaleiro.serpro.gov.br/documentacao/datavalid/en/> |
| Datavalid: novidades | <https://campanhas.serpro.gov.br/datavalid/novidades/> |
