# API do Conexa (v2) — referência extraída

Gerado de `docs/API v2 Conexa.postman_collection.json` (coleção Postman, 1,8 MB).
Este arquivo é a **fonte de consulta** ao escrever a integração — o JSON original é
ilegível para revisão, e o que importa dele está tudo aqui.

## Autenticação e base

- Base: `https://<subdominio>.conexa.app/index.php/api/v2`
- `POST /auth` com `{username, password}` devolve `accessToken` (JWT).
- Todas as demais chamadas: `Authorization: Bearer <accessToken>`.
- O JWT **expira** (`expiresIn` em segundos) — o cliente precisa renovar sozinho.

## Índice

- [Auth](#auth)
- [Sale](#sale)
- [Customer](#customer)
- [Person](#person)
- [Plan](#plan)
- [Contract](#contract)
- [Recurring Sale](#recurring-sale)
- [Product](#product)
- [Invoicing Method](#invoicing-method)
- [Receiving Method](#receiving-method)
- [Payment Method](#payment-method)
- [Charge](#charge)
- [Credit Card](#credit-card)
- [Bill](#bill)
- [Bill Category](#bill-category)
- [Bill Subcategory](#bill-subcategory)
- [Supplier](#supplier)
- [Extra Field](#extra-field)
- [Cost Center](#cost-center)
- [Account](#account)
- [Company](#company)
- [Service Category](#service-category)
- [Conexa Coworking › Booking](#conexa-coworking-booking)
- [Conexa Coworking › Check-in](#conexa-coworking-check-in)
- [Conexa Coworking › Check-out](#conexa-coworking-check-out)
- [Potential Customer (Em Desenvolvimento)](#potential-customer-em-desenvolvimento-)


## Auth

### `POST /auth`

**Corpo de exemplo:**

```json
{
    "username": "admin",
    "password": "lorem.ipsun0"
}
```

### Body:

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| username | string | Login de acesso ao sistema Conexa | Sim |
| password | string | Senha de acesso ao sistema Conexa | Sim |

### Response:

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| user | object | Objeto do usuário logado | Sim |
| user.id | integer | ID do usuário logado | Sim |
| user.type | string | Tipo de usuário, podendo ser: **admin** ou **employee** | Sim |
| user.name | string | Nome do usuário | Sim |
| tokenType | string | "Bearer" | Sim |
| accessToken | string | JWT | Sim |
| expiresIn | integer | Tempo de expiração do JWT em segundos | Sim |

O JWT deve ser armazenado em um cookie seguro ou local storage para evitar o seu roubo por meio de ataques de cross-site scripting (XSS), por exemplo.


## Sale

### `POST /sale`

**Corpo de exemplo:**

```json
{
    "customerId": 450,
    "requesterId": 458,
    "productId": 2521,
    "sellerId": 534,
    "quantity": 1,
    "amount": 80.99,
    "referenceDate": "2024-09-24T17:24:00-03:00",
    "notes": "Solicitação pelo WhatsApp"
}
```

Criação de uma venda avulsa no sistema Conexa.

### Body:

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| customerId | integer | ID do cliente da venda | Sim |
| requesterId | integer | ID do solicitante da venda | Depende da configuração do sistema |
| sellerId | integer | ID do vendedor (usuário) que cadastrou a venda | Não (deve ser enviado em requisições que a autenticação é realizada pelo API Token) |
| productId | integer | ID do produto | Sim |
| quantity | integer | Quantidade de itens do produto. Deve ser um valor maior que zero | Sim |
| amount | decimal | Valor personalizado para a venda, tanto para aplicar desconto quanto para um valor diferente do preço do produto | Não (caso não informado, será calculado com base no preço unitário do produto) |
| referenceDate | string | Data de referência da venda. Formato W3C (**Y-m-d\\TH:i:sP**) | Não (caso não informado, será preenchido com a data atual) |
| notes | string | Observações da venda | Não |

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da venda criada |


### `GET /sale/:id`

Recuperação dos principais dados de uma venda, independente de ser avulsa ou recorrente.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| status | string | Status da venda, podendo ser: **paid**, **billed**, **cancelled**, **notBilled**, **deductedFromQuota**, **billedCancelled**, **billedNegociated** ou **partiallyPaid** |
| saleId | integer | ID da venda |
| contractId | integer | ID do contrato quando a venda é originada de contrato |
| recurringSaleId | integer | ID da venda recorrente quando a venda é originada de venda recorrente |
| ~~productId~~ | ~~integer~~ | ~~ID do produto~~ (Deprecated) |
| product | object | Objeto do produto |
| product.id | integer | ID do produto |
| product.name | string | Nome do produto |
| product.description | string / null | Descrição do produto |
| product.companyId | integer | ID da unidade do produto |
| customerId | integer | ID do cliente |
| requesterId | integer / null | ID do solicitante da venda |
| sellerId | integer | ID do vendedor (usuário) |
| quantity | integer | Quantidade de itens do produto na venda |
| referenceDate | string | Data de referência da venda. Formato W3C (**Y-m-d\\TH:i:sP**) |
| amount | decimal | Valor final da venda |
| originalAmount | decimal | Valor original da venda |
| discountValue | decimal | Valor de desconto da venda |
| notes | string | Observações da venda |
| createdAt | string / null | Data de criação da venda. Formato W3C (**Y-m-d\\TH:i:sP**) |
| updatedAt | string | Data de modificação da venda. Formato W3C (**Y-m-d\\TH:i:sP**) |


### `PATCH /sale/:id`

**Corpo de exemplo:**

```json
{
    "requesterId": 458,
    "sellerId": 531,
    "quantity": 2,
    "amount": 500.99,
    "referenceDate": "2023-04-15T13:24:00-03:00",
    "notes": "Café morno"
}
```

Edição de uma ou n informações de uma venda avulsa no sistema Conexa.

### Body:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| requesterId | integer | ID do solicitante da venda |
| sellerId | integer | ID do vendedor (usuário). Deve ser enviado em requisições que a autenticação é realizada pelo API Token |
| quantity | integer | Quantidade de itens do produto. Deve ser um valor inteiro maior que zero |
| amount | decimal | Valor da venda |
| referenceDate | string | Data de referência da venda. Formato W3C (**Y-m-d\\TH:i:sP**) |
| notes | string | Observações da venda |

### Response:

Mesmo conteúdo retornado em [GET /sale/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#fed8e8fa-3e9e-4830-9228-0a6752a95a7d).


### `DELETE /sale/:id`

Exclusão de uma venda avulsa no Conexa não faturada.


### `GET /sales`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 189616,187524 | não |
| `productId` | 4174 | não |
| `customerId[]` | 450,216 | não |
| `companyId[]` | 3 | não |
| `contractId` | 1452 | não |
| `recurringSaleId` | 1454 | não |
| `sellerId[]` | 534,533 | não |
| `dateFrom` | 2025-12-25 | não |
| `dateTo` | 2024-01-01 | não |
| `status` | notBilled | não |
| `createdAtFrom` | 2024-04-01T12:00:00-03:00 | não |
| `createdAtTo` | 2024-05-01T12:00:00-03:00 | não |
| `limit` | 20 | sim |
| `offset` | 0 | não |

Listagem paginada de vendas, independente de ser avulsa ou recorrente.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula. Consultar exemplo: [(200) Success filted by multiples IDs](https://web.postman.co/workspace/c51b51f1-5fd1-43b8-82e6-972f5bfb78d4/example/25182821-2ec87e6e-caa0-4fc9-b034-e844c36b023d)

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro** **`limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**. 
  

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de vendas contendo o mesmo modelo de dados presente em [GET /sale/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#fed8e8fa-3e9e-4830-9228-0a6752a95a7d) | \- |
| pagination | object | Paginação | \- |
| pagination.limit | integer | Quantidades de itens retornados | \- |
| pagination.offset | integer | Posição inicial da busca | \- |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | \- |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Customer

### `POST /customer`

**Corpo de exemplo:**

```json
{
    "companyId": 3,
    "name": "Julius Cris",
    "tradeName": "Fake ABC",
    "pronunciation": null,
    "fieldOfActivity": "Indústria",
    "notes": "Uma empresa que produz droides de batalha, incluindo os Droidekas",
    "cellNumber": "11988997766",
    "tagsId": [
        1,
        2
    ],
    "website": "fakeabc.app",
    "hasLoginAccess": false,
    "automaticallyIssueNfse": "notIssue",
    "notesNfse": "Teste observações na NFSe",
    "taxDeductions": {
        "iss": true,
        "ir": true,
        "pis": true,
        "inss": false,
        "csll": true,
        "cofins": true
    },
    "legalPerson": {
        "cnpj": "99.557.155/0001-90",
        "foundationDate": "2020-06-12",
        "stateInscription": "4569",
        "municipalInscription": "145263"
    },
    // "naturalPerson": {
    //     "cpf": "516.079.209-05",
    //     "rg": "30.340.779-7",
    //     "birthDate": "1977-05-01",
    //     "issuingAuthority": "SSP BA",
    //     "profession": "Developer",
    //     "maritalStatus": "single"
    // },
    // "foreign": {
    //     "document": "7700225VH (Passaporte)",
    //     "birthDate": "1977-05-01",
    //     "profession": "Developer"
    // },
    "address": {
        "zipCode":"13058-111", 
        "state":  "SP",
        "city": "Campinas",
        "street": "Rua Alziro Arten",
        "number": "443",
        "neighborhood": "Conjunto Habitacional Parque da Floresta",
        "additionalDetails": "Sala 4, Térreo"
    },
    "phones": ["(75) 2222-5455", "(75) 3885-3344"],
    "emailsMessage" : ["admin@fakeabc.com", "crm@fakeabc.com"],
    "emailsFinancialMessages": ["financeiro@fakeabc.com", "financeiro.fakeabc@gmail.com"],
    "extraFields": [
        {
            "id": 101,
            "value": "4qw79dsaoiqw"
        }
    ]
… (truncado)
```

Criação de um cliente no sistema Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não são necessários! 
  

### Body:

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| companyId | integer | ID da unidade | Sim | Todos |
| name | string | Nome do cliente | Sim | Todos |
| tradeName | string / null | Nome fantasia | Não | Todos |
| pronunciation | string / null | Pronúncia | Não | Todos |
| fieldOfActivity | string / null | Ramo de atividade | Não | Todos |
| notes | string / null | Observações | Não | Todos |
| cellNumber | string / null | Celular | Não | Todos |
| website | string / null | Site | Não | Todos |
| hasLoginAccess | boolean | Tem acesso a área do cliente | Não | Todos |
| login | string / null | Login da área do cliente | Apenas se o campo **hasLoginAccess** for **true** | Todos |
| password | string / null | Senha da área do cliente | Apenas se o campo **hasLoginAccess** for **true** | Todos |
| automaticallyIssueNfse | string / null | Emitir NFS-e automaticamente. A opção deve ser uma das seguintes: **whenGeneratingBilling**, **afterPaymentBilling**, **notIssue** | Não | Todos |
| notesNfse | string / null | Observações da NFS-e | Não | Todos |
| taxDeductions | object | Retenção de Imposto Municipal e Federal | Não | Todos |
| taxDeductions.iss | boolean | Retém ISS (Imposto Municipal) | Não | \- |
| taxDeductions.ir | boolean | Retém IR (Imposto Federal) | Não | \- |
| taxDeductions.pis | boolean | Retém PIS (Imposto Federal) | Não | \- |
| taxDeductions.inss | boolean | Retém INSS (Imposto Federal) | Não | \- |
| taxDeductions.csll | boolean | Retém CSLL (Imposto Federal) | Não | \- |
| taxDeductions.cofins | boolean | Retém COFINS (Imposto Federal) | Não | \- |
| naturalPerson | object | Objeto com os dados referentes a um cliente **Pessoa Física** | Não | Todos |
| naturalPerson.cpf | string / null | CPF | Não | \- |
| naturalPerson.rg | string / null | RG | Não | \- |
| naturalPerson.birthDate | date | Data de aniversário. Formato: **yyyy-MM-dd** | Não | \- |
| naturalPerson.issuingAuthority | string / null | Órgão expedidor | Não | \- |
| naturalPerson.profession | string / null | Profissão | Não | \- |
| naturalPerson.maritalStatus | string / null | O estado civil do cliente, sendo: "**married**", "**single**", "**divorced**", "**widowed**" ou "**not informed**" | Não | \- |
| legalPerson | object | Objeto com os dados referentes a um cliente **Pessoa Jurídica** | Não | Todos |
| legalPerson.cnpj | string / null | CNPJ | Não | \- |
| legalPerson.foundationDate | date | Data de fundação. Formato: **yyyy-MM-dd** | Não | \- |
| legalPerson.stateInscription | string / null | Inscrição estadual | Não | \- |
| legalPerson.municipalInscription | string / null | Inscrição municipal | Não | \- |
| foreign | object | Objeto com os dados de estrangeiro | Não | Todos |
| foreign.document | string / null | Número do documento de identificação estrangeiro | Não | \- |
| foreign.birthDate | date | Data de aniversário. Formato: **yyyy-MM-dd** | Não | \- |
| foreign.profession | string / null | Profissão | Não | \- |
| address | object | Objeto com o endereço do cliente | Não | Todos |
| address.zipCode | string / null | CEP | Não | \- |
| address.country | string / null | País de origem (apenas se for **estrangeiro**) | Não | \- |
| address.state | string / null | Sigla do estado (UF) | Não | \- |
| address.city | string / null | Cidade | Não | \- |
| address.street | string / null | Logradouro | Não | \- |
| address.number | string / null | Número | Não | \- |
| address.neighborhood | string / null | Bairro | Não | \- |
| address.additionalDetails | string / null | Complemento | Não | \- |
| phones | string\[\] | Array com os telefones de contato. Os telefones devem ter 10 ou 11 números. | Não | Todos |
| emailsMessage | string\[\] | Array com os e-mails para envio de recados | Não | Todos |
| emailsFinancialMessages | string\[\] | Array com os e-mails para envio de avisos financeiros | Não | Todos |
| tagsId | integer\[\] | Array com os IDs das Tags para associar ao cliente | Não | Todos |
| extraFields | array of objects | Array de objetos de Campos Extras | Não | Todos |
| extraFields[].id | integer | ID do Campo Extra | Sim | Todos |
| extraFields[].value | string | Valor para o Campo Extra | Não | Todos |
| isNetworkingProfileVisible | boolean | Exibir perfil do cliente na área de Networking da área do cliente | Não | Conexa Coworking |
| isBlockedBookingCustomerArea | boolean | Não permite que o cliente cadastre novas reservas pela área do cliente, caso hasLoginAccess seja true | Não | Conexa Coworking |
| isAllowedBookingOutsideBusinessHours | boolean | Permite reservar fora do horário de funcionamento padrão, caso hasLoginAccess seja true | Não | Conexa Coworking |
| internetPlan | string / null | Nome do plano de internet (Disponível apenas com o módulo Mikrotik ativo) | Não | Conexa Coworking |
| businessPresentation | string / null | Breve apresentação sobre o cliente | Não | Conexa Coworking |
| offeredServicesProducts | string / null | Serviços e produtos oferecidos | Não | Conexa Coworking |
| receptionOrientations | string / null | Orientações para atendimento | Não | Conexa Coworking |
| mailingOrientations | string / null | Orientações para correspondência | Não | Conexa Coworking |
| mailingAddress | object | Objeto com o endereço para correspondências | Não | Conexa Coworking |
| mailingAddress.zipCode | string / null | CEP | Não | \- |
| mailingAddress.state | string / null | Sigla do estado (UF) | Não | \- |
| mailingAddress.city | string / null | Cidade | Não | \- |
| mailingAddress.street | string / null | Logradouro | Não | \- |
| mailingAddress.number | string / null | Número | Não | \- |
| mailingAddress.neighborhood | string / null | Bairro | Não | \- |
| mailingAddress.additionalDetails | string / null | Complemento | Não | \- |
| mailingAddress.landmark | string / null | Ponto de referência | Não | \- |
| extensionNumbers | string\[\] | Array com os ramais | Não | Conexa Coworking |
| defaultDueDay | integer | Dia de vencimento padrão do cliente | Não |  |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do cliente criado |


### `GET /customer/:id`

Recuperação dos dados dos clientes. Abaixo exibimos uma tabela do que será retornado dado o tipo de versão do software Conexa.

### Response:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| customerId | integer | ID do cliente | Todos |
| companyId | integer | ID da unidade | Todos |
| name | string | Nome do cliente | Todos |
| tradeName | string | Nome fantasia | Todos |
| firstName | string | Primeiro nome do cliente | Todos |
| pronunciation | string | Pronúncia | Todos |
| fieldOfActivity | string | Ramo de atividade | Todos |
| notes | string | Observações | Todos |
| cellNumber | string | Celular | Todos |
| website | string | Site | Todos |
| hasLoginAccess | boolean | Tem acesso a área do cliente | Todos |
| login | string | Login da área do cliente | Todos |
| automaticallyIssueNfse | string | Configuração automática da emissão de NFS-e. Podendo ser: **whenGeneratingBilling**, **afterPaymentBilling**, **notIssue** | Todos |
| notesNfse | string | Observações da NFS-e | Todos |
| taxDeductions | object | Retenção de Imposto Municipal e Federal | Todos |
| taxDeductions.iss | boolean | Flag se retém ISS (Imposto Municipal) | \- |
| taxDeductions.ir | boolean | Flag se retém IR (Imposto Federal) | \- |
| taxDeductions.pis | boolean | Flag se retém PIS (Imposto Federal) | \- |
| taxDeductions.inss | boolean | Flag se retém INSS (Imposto Federal) | \- |
| taxDeductions.csll | boolean | Flag se retém CSLL (Imposto Federal) | \- |
| taxDeductions.cofins | boolean | Flag se retém COFINS (Imposto Federal) | \- |
| isJuridicalPerson | boolean | Flag se é uma pessoa jurídica | Todos |
| isForeign | boolean | Flag se pessoa estrangeira | Todos |
| naturalPerson | object | Objeto com os dados referentes a um cliente **Pessoa Física** | Todos |
| naturalPerson.cpf | string | CPF | \- |
| naturalPerson.rg | string | RG | \- |
| naturalPerson.birthDate | date | Data de aniversário. Formato: **yyyy-MM-dd** | \- |
| naturalPerson.issuingAuthority | string | Órgão expedidor | \- |
| naturalPerson.maritalStatus | string | O estado civil do cliente, podendo ser: "**married**", "**single**", "**divorced**", "**widowed**" ou "**not informed**" | \- |
| naturalPerson.profession | string | Profissão | \- |
| legalPerson | object | Objeto com os dados referentes a um cliente **Pessoa Jurídica** | Todos |
| legalPerson.cnpj | string | CNPJ | \- |
| legalPerson.foundationDate | date | Data de fundação. Formato: **yyyy-MM-dd** | \- |
| legalPerson.stateInscription | string | Inscrição estadual | \- |
| legalPerson.municipalInscription | string | Inscrição municipal | \- |
| foreign | object | Objeto com os dados de estrangeiro | Todos |
| foreign.document | string | Número do documento de identificação estrangeiro | \- |
| foreign.birthDate | date | Data de aniversário. Formato: **yyyy-MM-dd** | \- |
| foreign.profession | string | Profissão | \- |
| address | object | Objeto com o endereço do cliente | Todos |
| address.zipCode | string | CEP | \- |
| address.country | string | País de origem (apenas se for **estrangeiro**) | \- |
| address.state | object | Informações do estado | \- |
| address.state.id | integer | ID do estado | \- |
| address.state.name | string | Nome do estado | \- |
| address.state.abbreviation | string | UF do estado | \- |
| address.city | string | Cidade | \- |
| address.street | string | Logradouro | \- |
| address.number | string | Número | \- |
| address.neighborhood | string | Bairro | \- |
| address.additionalDetails | string | Complemento | \- |
| phones | string\[\] | Array com os telefones de contato | Todos |
| emailsMessage | string\[\] | Array com os e-mails para envio de recados | Todos |
| emailsFinancialMessages | string\[\] | Array com os e-mails para envio de avisos financeiros | Todos |
| tagsId | integer\[\] | Array com os IDs das Tags associadas | Todos |
| isBlocked | boolean | Está bloqueado ou não | Todos |
| isActive | boolean | Está ativa ou não | Todos |
| extraFields | array of objects | Array de objetos com os campos extras do cliente | Todos |
| extraFields.id | integer | ID do campo extra | \- |
| extraFields.name | string | Nome do campo extra | \- |
| extraFields.value | string | Valor do campo extra | \- |
| createdAt | string | Data de cadastro. Formato W3C: (**Y-m-d\\TH:i:sP**) | Todos |
| isNetworkingProfileVisible | boolean | Exibe perfil do cliente na área de Networking da área do cliente? | Conexa Coworking |
| isBlockedBookingCustomerArea | boolean | Não permite que o cliente cadastre novas reservas pela área do cliente, caso hasLoginAccess seja true? | Conexa Coworking |
| isAllowedBookingOutsideBusinessHours | boolean | Permite reservar fora do horário de funcionamento padrão, caso hasLoginAccess seja true? | Conexa Coworking |
| internetPlan | string | Nome do plano de internet (Disponível apenas com o módulo Mikrotik ativo) | Conexa Coworking |
| businessPresentation | string | Breve apresentação sobre o cliente | Conexa Coworking |
| offeredServicesProducts | string | Serviços e produtos oferecidos | Conexa Coworking |
| receptionOrientations | string | Orientações para atendimento | Conexa Coworking |
| mailingOrientations | string | Orientações para correspondência | Conexa Coworking |
| mailingAddress | object | Objeto com o endereço para correspondências | Conexa Coworking |
| mailingAddress.zipCode | string | CEP | \- |
| mailingAddress.state | object | Informações do estado | \- |
| mailingAddress.state.id | integer | ID do estado | \- |
| mailingAddress.state.name | string | Nome do estado | \- |
| mailingAddress.state.abbreviation | string | UF do estado | \- |
| mailingAddress.city | string | Cidade | \- |
| mailingAddress.street | string | Logradouro | \- |
| mailingAddress.number | string | Número | \- |
| mailingAddress.neighborhood | string | Bairro | \- |
| mailingAddress.additionalDetails | string | Complemento | \- |
| mailingAddress.landmark | string | Ponto de referência | \- |
| extensionNumbers | string\[\] | Array com os ramais (depende de configuração) | Conexa Coworking |
| dedicatedPhones | array of objects | Array de objetos com os telefones exclusivos (depende de configuração) | Conexa Coworking |
| dedicatedPhones.id | integer | ID do telefone exclusivo vinculado | \- |
| dedicatedPhones.phone | string | Telefone exclusivo vinculado | \- |
| mailboxes | string\[\] | Array com as caixas postais (depende de configuração) | Conexa Coworking |


### `PATCH /customer/:id`

**Corpo de exemplo:**

```json
{
    "companyId": 3,
    "name": "Empresa Fake ABC Ltda",
    "tradeName": "Fake ABC",
    "pronunciation": null,
    "fieldOfActivity": "Indústria",
    "notes": "Uma empresa que produz droides de batalha, incluindo os Droidekas",
    "cellNumber": "11988997766",
    "phones": ["(11) 2222-2222", "(75) 4444-5555"],
    "website": "fakeabc.app",
    "hasLoginAccess": true,
    "login": "clienteteste",
    "password": "abc123456#$",
    "automaticallyIssueNfse": "notIssue",
    "notesNfse": "Teste observações na NFSe",
    "taxDeductions": {
        "iss": true
        // "ir": true,
        // "pis": true,
        // "inss": false,
        // "csll": true,
        // "cofins": true
    },
    "naturalPerson": {
        "cpf": "516.079.209-05",
        "rg": "30.340.779-7",
        "birthDate": "1977-05-01",
        "issuingAuthority": "SSP BA",
        "profession": "Full Stack Developer",
        "maritalStatus": "single"
    },
   /*"legalPerson": {
        "cnpj": "99.557.155/0001-90",
        "foundationDate": "1980-01-02",
        "stateInscription": "4569",
        "municipalInscription": "145263"
    },*/
    /*"foreign": {
        "document": "7700225VH (Passaporte)",
        "birthDate": "1977-05-01",
        "profession": "Full Stack Developer"
    },*/
    "address": {
        "zipCode":"13058-111", 
        //"country": "United States",
        "state":  "SP",
        "city": "São Paulo",
        "street": "Rua ABC",
        "number": "432",
        "neighborhood": "Conjunto Habitacional Parque da Floresta 4",
        "additionalDetails": "Sala 4, Térreo 1"
    },
    "emailsMessage" : ["testfghje@gmail.com", "testoiuygfe5@gmail.com"],
    "emailsFinancialMessages": ["financeiro@fakeabc.com", "financeiro.fakeabc@gmail.com"],
    "tagsId": [1],
    "extraFiel
… (truncado)
```

Edição de uma ou n informações de um cliente no sistema Conexa.

### Body:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| companyId | integer | Id da unidade | Todos |
| name | string | Nome do cliente | Todos |
| tradeName | string | Nome fantasia | Todos |
| pronunciation | string | Pronúncia | Todos |
| fieldOfActivity | string | Ramo de atividade | Todos |
| notes | string | Observações | Todos |
| cellNumber | string | Celular | Todos |
| phones | string\[\] | Array com os telefones de contato. Os telefones devem ter 10 ou 11 números. | Todos |
| website | string | Site | Todos |
| hasLoginAccess | boolean | Tem acesso a área do cliente | Todos |
| login | string | Login da área do cliente | Todos |
| password | string | Senha da área do cliente | Todos |
| automaticallyIssueNfse | string | Emitir NFS-e automaticamente (depende de configuração). A opção deve ser uma das seguintes: **whenGeneratingBilling**, **afterPaymentBilling**, **notIssue** | Todos |
| notesNfse | string | Observações da NFS-e (depende de configuração) | Todos |
| taxDeductions | object | Retenção de Imposto Municipal e Federal | Todos |
| taxDeductions.iss | boolean | Retém ISS (Imposto Municipal) | \- |
| taxDeductions.ir | boolean | Retém IR (Imposto Federal) | \- |
| taxDeductions.pis | boolean | Retém PIS (Imposto Federal) | \- |
| taxDeductions.inss | boolean | Retém INSS (Imposto Federal) | \- |
| taxDeductions.csll | boolean | Retém CSLL (Imposto Federal) | \- |
| taxDeductions.cofins | boolean | Retém COFINS (Imposto Federal) | \- |
| naturalPerson | object | Objeto com os dados referentes a um cliente **Pessoa Física** | Todos |
| naturalPerson.cpf | string | CPF | \- |
| naturalPerson.rg | string | RG | \- |
| naturalPerson.birthDate | date | Data de aniversário. Formato: **yyyy-MM-dd** | \- |
| naturalPerson.issuingAuthority | string | Órgão expedidor | \- |
| naturalPerson.profession | string | Profissão | \- |
| naturalPerson.maritalStatus | string | O estado civil do cliente, sendo: "**married**", "**single**", "**divorced**", "**widowed**" ou "**not informed**" | \- |
| legalPerson | object | Objeto com os dados referentes a um cliente **Pessoa Jurídica** | Todos |
| legalPerson.cnpj | string | CNPJ | \- |
| legalPerson.foundationDate | date | Data de fundação. Formato: **yyyy-MM-dd** | \- |
| legalPerson.stateInscription | string | Inscrição estadual | \- |
| legalPerson.municipalInscription | string | Inscrição municipal | \- |
| foreign | object | Objeto com os dados de estrangeiro | Todos |
| foreign.document | string | Número do documento de identificação estrangeiro | \- |
| foreign.birthDate | date | Data de aniversário. Formato: **yyyy-MM-dd** | \- |
| foreign.profession | string | Profissão | \- |
| address | object | Objeto com o endereço do cliente | Todos |
| address.zipCode | string | CEP | \- |
| address.country | string | País de origem (apenas se for **estrangeiro**) | \- |
| address.state | string | Sigla do estado (UF) | \- |
| address.city | string | Cidade | \- |
| address.street | string | Logradouro | \- |
| address.number | string | Número | \- |
| address.neighborhood | string | Bairro | \- |
| address.additionalDetails | string | Complemento | \- |
| emailsMessage | string\[\] | Array com os e-mails para envio de recados | Todos |
| emailsFinancialMessages | string\[\] | Array com os e-mails para envio de avisos financeiros | Todos |
| tagsId | integer\[\] | Array com os IDs das Tags para associar ao cliente | Todos |
| extraFields | array of objects | Array de objetos de Campos Extras | Não | Todos |
| extraFields[].id | integer | ID do Campo Extra | Sim | Todos |
| extraFields[].value | string | Valor para o Campo Extra | Não | Todos |
| isNetworkingProfileVisible | boolean | Exibir perfil do cliente na área de Networking da área do cliente | Conexa Coworking |
| isBlockedBookingCustomerArea | boolean | Não permite que o cliente cadastre novas reservas pela área do cliente, caso hasLoginAccess seja true | Conexa Coworking |
| isAllowedBookingOutsideBusinessHours | boolean | Permite reservar fora do horário de funcionamento padrão, caso hasLoginAccess seja true | Conexa Coworking |
| internetPlan | string | Nome do plano de internet (Disponível apenas com o módulo Mikrotik ativo) | Conexa Coworking |
| businessPresentation | string | Breve apresentação sobre o cliente | Conexa Coworking |
| offeredServicesProducts | string | Serviços e produtos oferecidos | Conexa Coworking |
| receptionOrientations | string | Orientações para atendimento | Conexa Coworking |
| mailingOrientations | string | Orientações para correspondência | Conexa Coworking |
| mailingAddress | object | Objeto com o endereço para correspondências | Conexa Coworking |
| mailingAddress.zipCode | string | CEP | \- |
| mailingAddress.state | string | Sigla do estado (UF) | \- |
| mailingAddress.city | string | Cidade | \- |
| mailingAddress.street | string | Logradouro | \- |
| mailingAddress.number | string | Número | \- |
| mailingAddress.neighborhood | string | Bairro | \- |
| mailingAddress.additionalDetails | string | Complemento | \- |
| mailingAddress.landmark | string | Ponto de referência | \- |
| extensionNumbers | string\[\] | Array com os ramais | Conexa Coworking |
| defaultDueDay | integer | Dia de vencimento padrão do cliente |  |

### Response:

Mesmo modelo de dados retornado em [GET /customer/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#8ccf00c9-767b-4517-b085-a3e5a784431e)


### `DELETE /customer/:id`

Exclusão de um cliente no Conexa, quando não há registros (vendas, cobranças e etc) vinculada ao cliente.


### `GET /customers`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 102,103 | não |
| `companyId[]` | 5 | não |
| `name` | Theo | não |
| `tradeName` | Neto | não |
| `cpf` | 111.111.111-11 | não |
| `cnpj` | 11.111.111/0001-11 | não |
| `isActive` | 0 | não |
| `tagId[]` | 3 | não |
| `createdAtFrom` | 2024-04-01T12:00:00-03:00 | não |
| `createdAtTo` | 2024-05-01T12:00:00-03:00 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de clientes.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula. Consultar exemplo: [(200) Success - Conexa Recorrência](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#8c44d03d-037d-476d-82a9-b78f272b5db5).

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de clientes contendo o mesmo modelo de dados presente em [GET /customer/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#8ccf00c9-767b-4517-b085-a3e5a784431e) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Person

### `POST /person`

**Corpo de exemplo:**

```json
{
    "customerId": 31,
    "name": "John Doe Sete",
    "nationality": "brasileiro",
    "placeOfBirth": "Feira de Santana",
    "maritalStatus": "married",
    "isForeign": false,
    /*"foreignData": {
        "zipCode": "30058",
        "country": "United States",
        "city": "Panola",
        "state": "Georgia",
        "street": "Lakeland",
        "number": "93",
        "neighborhood": "Park Drive",
        "additionalDetails": "",
        "document": "22225555522"
    },*/
    "isCompanyPartner": true,
    "isGuarantor": true,
    "cpf": "245.679.031-61",
    "rg": "33.892.656-2",
    "issuingAuthority": "SSP-BA",
    "birthDate": "1994-05-01",
    "cellNumber": "(95) 98126-1744",
    "phones": [
        "(61) 3746-3590",
        "(61) 3746-3590"
    ],
    "emails": [
        "teste@gmail.com",
        "teste2@gmail.com"
    ],
    "sex": "M",
    "jobTitle": "",
    "profession": "",
    "resume": "",
    "notes": "",
    "address": {
        "zipCode": "44380000",
        "state": "BA",
        "city": "Cruz das Almas",
        "street": "Rua Silvestre Mendes",
        "number": "935",
        "neighborhood": "Centro",
        "additionalDetails": "Apt. 02"
    },
    "hasLoginAccess": true,
    "login": "johndoesete",
    "password": "!5CqTBdeM[&x91zb2",
    "permissions": [
        "finance",
        "orders",
        "rooms",
        "sharedSpaces",
        "assistance",
        "correspondences",
        "printing"
    ],
    "accessId": "",
    "canReceiveMail": true,
    "color": "",
    // "printFeeId": "",
    "extensionNumbers": [],
    "urlLinkedin": "www.linkedin.com.br",
    "urlInstagram": "www.instagram.com.br",
    "urlFacebook": "www.facebook.com.br",
    "urlTwitter": "www.twitter.com.br",
    // "devices": [
    //     {
    //         
… (truncado)
```

Criação de uma pessoa, associada a um cliente, no sistema Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não são necessários! 
  

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| customerId | integer | ID do cliente ao qual a pessoa será associada | Sim | Todos |
| name | string | Nome da pessoa | Sim | Todos |
| nationality | string | Define a nacionalidade da pessoa | Não | Todos |
| placeOfBirth | string | Define a naturalidade da pessoa | Não | Todos |
| maritalStatus | string | Define o estado civil da pessoa. Seu valor deve estar entre os seguintes: '**married', 'single', 'divorced', 'widowed', 'not informed'** | Não | Todos |
| isForeign | boolean | Define se a pessoa é estrangeira | Não | Todos |
| foreignData | object | Objeto contendo os dados estrangeiros da pessoa, serão considerados se **isForeign** for **true** | Não | Todos |
| foreignData.zipCode | string | Código postal estrangeiro da pessoa | Não | \- |
| foreignData.contry | string | País da pessoa estrangeira | Não | \- |
| foreignData.city | string | Cidade da pessoa estrangeira | Não | \- |
| foreignData.state | string | Estado ou Unidade Administrativa da pessoa estrangeira | Não | \- |
| foreignData.street | string | Rua da pessoa estrangeira | Não | \- |
| foreignData.number | string | Número da residência estrangeira da pessoa | Não | \- |
| foreignData.neighborhood | string | Bairro da pessoa estrangeira | Não | \- |
| foreignData.additionalDetails | string | Complementos para o endereço estrangeiro da pessoa | Não | \- |
| foreignData.document | string | Número de documento estrangeiro de identificação da pessoa | Não | \- |
| isCompanyPartner | boolean | Sinaliza se a pessoa pode assinar documentos em nome do cliente a qual é associada | Não | Todos |
| isGuarantor | boolean | Sinaliza se a pessoa é fiadora do cliente a qual está associada | Não | Todos |
| cpf | string | Número de CPF da pessoa, será considerado se **isForeign** for **false** | Não | Todos |
| rg | string | Número de RG da pessoa, será considerado se **isForeign** for **false** | Não | Todos |
| issuinAutohrity | string | Órgão expedidor do documento de RG da pessoa, será considerado se **isForeign** for **false** | Não | Todos |
| birthDate | string | Data de nascimento da pessoa. Formato: **yyyy-MM-dd** | Não | Todos |
| cellNumber | string | Número de celular da pessoa, deve possuir 10 ou 11 dígitos | Não | Todos |
| phones | string\[\] | Array contendo os números de telefone da pessoa. Deve possuir 11 dígitos e números estrangeiros deve inicia com o símbolo +. | Não | Todos |
| emails | string\[\] | Array contendo os emails da pessoa. | Não | Todos |
| sex | string | Indica o sexo da pessoa, deve ser uma das seguintes iniciais: **'M'** => **'Masculine'**, **'F'** => **'Feminine'**, **'U'** => **'Not informed'**, um valor diferente dos informados será identificado como **Not** **informed** | Não | Todos |
| jobTitle | string | Nome do cargo da pessoa | Não | Todos |
| profession | string | Profissão da pessoa | Não | Todos |
| resume | string | Breve currículo da pessoa | Não | Todos |
| notes | string | Observações da pessoa | Não | Todos |
| address | object | Objeto contendo os dados de endereço da pessoa. Válido para pessoas não estrangeiras | Não | Todos |
| address.zipCode | string | CEP da pessoa | Não | \- |
| address.state | string | Sigla do estado em que a pessoa reside | Não | \- |
| address.city | string | Nome da cidade em que a pessoa reside | Não | \- |
| address.street | string | Nome da rua em que a pessoa reside | Não | \- |
| address.number | integer | Número da residênica da pessoa | Não | \- |
| address.neighborhood | string | Bairro em que a pessoa reside | Não | \- |
| address.additionalDetails | string | Complemento do endereço da pessoa | Não | \- |
| hasLoginAccess | boolean | Indica se a pessoa terá acesso à **Área do Clliente** | Não | Conexa Coworking |
| login | string | Define o login da pessoa caso esta tenha acesso à **Área do Cliente.** O login deve conter: Somente **letras**, **números**, **@ . - +** ou **_** | Sim, se **hasLoginAccess** for **true** | Conexa Coworking |
| password | string | Define a senha da pessoa caso esta tenha acesso. Deve conter pelo menos 6 caracteres, compostos por letras e números | Sim, se **hasLoginAccess** for **true** | Conexa Coworking |
| permissions | string\[\] | Array contendo as permissões que a pessoa terá no sistema. Os valores válidos são: **'finance'**, **'orders'**, **'rooms'**, **'sharedSpaces'**, **'assistance'**, **'correspondences'** e **'printing'** | Não | Conexa Coworking |
| accessId | string | Identificador da pessoa (id, nº do cartão e etc) no dispositivo de controle de acesso (catracas, biometria, etc) | Não | Conexa Coworking |
| canReceiveMail | boolean | Sinaliza se a pessoa pode receber correspondências para o cliente ao qual é associada | Não | Conexa Coworking |
| color | string | Código de cor hexadecimal que será associado ao perfil da pessoa | Não | Conexa Coworking |
| printFeeId | string | Valor utilizado unicamente para identificar o cliente durante a importação do arquivo com as tarifações de impressão. Só pode ser cadastrado por usuários do tipo **admin** | Não | Conexa Coworking |
| extensionNumbers | string\[\] | Array contendo os números de ramal ou extensões da pessoa | Não | Conexa Coworking |
| urlLinkedin | string | Endereço perfil da pessoa no **LinkedIn** | Não | Conexa Coworking |
| urlInstagram | string | Endereço do perfil da pessoa no **Instagram** | Não | Conexa Coworking |
| urlFacebook | string | Endereço do perfil da pessoa no **Facebook** | Não | Conexa Coworking |
| urlTwitter | string | Endereço do perfil da pessoa no **Twitter** | Não | Conexa Coworking |
| devices | array of objects | Array contendo os objetos que representam os dispositivos da pessoa que serão cadastrados | Não | Conexa Coworking |
| devices\[\].nickname | string | Apelido do dispositivo | Sim. Cada dispositivo deve possuir um apelido para ser cadastrado | \- |
| devices\[\].macAddress | string | Endereço de mac do dispositivo | Sim. Cada dispositivo precisa fornecer seu endereço de mac para ser cadastrado | \- |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da pessoa criada |


### `GET /person/:id`

Recuperação dos dados de uma pessoa.

> ⚠ Alguns campos podem não estar presentes a depender de módulos opcionais ou tipo de sistema contratado. 
  

#### Response

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| personId | integer | ID da pessoa | Todos |
| address | object | Objeto contendo os dados de endereço da pessoa | Todos |
| address.zipCode | string | Código postal da pessoa | \- |
| address.city | string | Cidade da pessoa | \- |
| address.state | object | Objeto contendo os dados da UF da pessoa | \- |
| address.state.id | integer | Id do estado da pessoa | \- |
| address.state.name | string | Nome do estado da pessoa | \- |
| address.state.abbreviation | string | Sigla do estado da pessoa | \- |
| address.street | string | Rua da pessoa | \- |
| address.number | string | Número residencial da pessoa | \- |
| address.neighborhood | string | Bairro da pessoa | \- |
| address.additionalDetails | string | Complemento adicionado ao endereço da pessoa | \- |
| isForeign | boolean | Indica se a pessoal é estrangeira ou não | Todos |
| name | string | Nome da pessoa | Todos |
| rg | string | Número de RG da pessoa | Todos |
| issuingAutority | string | Órgão responsável pela emissão do RG (Ex.: SSP) | Todos |
| cpf | string | Número de CPF da pessoa | Todos |
| birthDate | string | Data de nascimento da pessoa no formato: **yyyy-mm-dd** | Todos |
| maritalStatus | string | Estado civil da pessoa. O estado civil pode ser representado por: **"single"**, **"married"**, **"divorced"**, **"widowed"** e **"not informed"** | Todos |
| sex | string | Sexo da pessoa. O sexo pode ser representado por: I => **Não Informado**, M => **Masculino** e F => **Feminino** | Todos |
| nationality | string | Nacionalidade da pessoa | Todos |
| placeOfBirth | string | Naturalidade da pessoa | Todos |
| notes | string | Observações relacionadas à pessoa | Todos |
| isCompanyPertner | boolean | Indica se a pessoa assina ou não pela empresa que está associada | Todos |
| isGuarantor | boolean | Indica se a pessoa é fiadora da empresa | Todos |
| profession | string | Profissão da pessoa | Todos |
| cellNumber | string | Número de celular da pessoa | Todos |
| phones | Array | Contém os números de telefone da pessoa | Todos |
| emails | Array | Contém os endereços de email da pessoa | Todos |
| jobTitle | string | Cargo da pessoa | Todos |
| photo | string | URL para a foto da pessoa | Todos |
| resume | string | Breve descrição curricular da pessoa | Todos |
| isIndividualCustomer | boolean | Indica se o cliente é pessoa física | Todos |
| hasLoginAccess | boolean | Indica se a pessoa tem acesso à área do cliente | Todos |
| isActive | boolean | Indica se a pessoa está ativa | Todos |
| customerId | integer | ID do cliente ao qual a pessoa está associada | Todos |
| companyId | integer | ID da unidade a qual a pessoa está associada | Todos |
| canReceiveMail | boolean | Indica se a pessoa pode receber correspondências em nome da empresa | Conexa Coworking |
| urlLinkedin | string | URL para o perfil do LinkedIn da pessoa | Conexa Coworking |
| urlInstagram | string | URL para o perfil do Instagram da pessoa | Conexa Coworking |
| urlFacebook | string | URL para o perfil do Facebook da pessoa | Conexa Coworking |
| urlTwitter | string | URL para o perfil do Twitter da pessoa | Conexa Coworking |
| printFeeId | string | Valor utilizado para identificar o cliente durante a importação de arquivos de tarifação de impressão (depende te configuração do sistema) | Conexa Coworking |
| accessId | string | Valor utilizado para verificar o acesso da pessoa em dispositivos de controle de acesso (depende te configuração do sistema) | Conexa Coworking |
| useFacialRecognitionPhoto | boolean | Se a foto da pessoa deve ser utilizada em dispositivos de reconhecimento facial (depende te configuração do sistema) | Conexa Coworking |


### `PATCH /person/:id`

**Corpo de exemplo:**

```json
{
    "name": "Kevin Enrico Doe Sete",
    "nationality": "brasileiro",
    "placeOfBirth": "Feira de Santana",
    "maritalStatus": "single",
    "isForeign": false,
    /*"foreignData": {
        "zipCode": "30058",
        "country": "United States",
        "city": "Panola",
        "state": "Georgia",
        "street": "Lakeland",
        "number": "93",
        "neighborhood": "Park Drive",
        "additionalDetails": "",
        "document": "22225555522"
    },*/
    "isCompanyPartner": false,
    "isGuarantor": false,
    "cpf": "519.058.165-96",
    "rg": "42.453.520-8",
    "issuingAuthority": "SSP-BA",
    "birthDate": "1967-03-17",
    "cellNumber": "(95) 98111-1111",
    "phones": [
        "(69) 3772-4710"
    ],
    "emails": [
        "kevin@gmail.google.com"
    ],
    "sex": "M",
    "jobTitle": "Funcionário",
    "profession": "Vendedor",
    "resume": "",
    "notes": "",
    "address": {
        "zipCode": "76873186",
        "state": "RO",
        "city": "Ariquemes",
        "street": "Rua Jandaias Mendes",
        "number": "935",
        "neighborhood": "Setor 02",
        "additionalDetails": "Apt. 02"
    },
    "hasLoginAccess": true,
    "login": "kevindoesete",
    "password": "!5CqTBdeM[&x91zb2",
    "permissions": [
        "finance",
        "orders",
        "rooms",
        "sharedSpaces",
        "assistance",
        "correspondences",
        "printing"
    ],
    "accessId": "",
    "canReceiveMail": true,
    "color": "",
    "printFeeId": "",
    "extensionNumbers": [],
    "urlLinkedin": "www.linkedin.com.br",
    "urlInstagram": "www.instagram.com.br",
    "urlFacebook": "www.facebook.com.br",
    "urlTwitter": "www.twitter.com.br",
    "useFacialRecognitionPhoto": false,
    "devices": [
        {
            "nickname": "iPh
… (truncado)
```

Edição de uma ou n informações de uma pessoa no sistema Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não são necessários! 
  

### Body:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| name | string | Nome da pessoa | Todos |
| nationality | string | Define a nacionalidade da pessoa | Todos |
| placeOfBirth | string | Define a naturalidade da pessoa | Todos |
| maritalStatus | string | Define o estado civil da pessoa. Seu valor deve estar entre os seguintes: '**married', 'single', 'divorced', 'widowed', 'not informed'** | Todos |
| isForeign | boolean | Define se a pessoa é estrangeira | Todos |
| foreignData | object | Objeto contendo os dados estrangeiros da pessoa, serão considerados se **isForeign** for **true** | Todos |
| foreignData.zipCode | string | Código postal estrangeiro da pessoa | \- |
| foreignData.contry | string | País da pessoa estrangeira | \- |
| foreignData.city | string | Cidade da pessoa estrangeira | \- |
| foreignData.state | string | Estado ou Unidade Administrativa da pessoa estrangeira | \- |
| foreignData.street | string | Rua da pessoa estrangeira | \- |
| foreignData.number | string | Número da residência estrangeira da pessoa | \- |
| foreignData.neighborhood | string | Bairro da pessoa estrangeira | \- |
| foreignData.additionalDetails | string | Complementos para o endereço estrangeiro da pessoa | \- |
| foreignData.document | string | Número de documento estrangeiro de identificação da pessoa | \- |
| isCompanyPartner | boolean | Sinaliza se a pessoa pode assinar documentos em nome do cliente a qual é associada | Todos |
| isGuarantor | boolean | Sinaliza se a pessoa é fiadora do cliente a qual está associada | Todos |
| cpf | string | Número de CPF da pessoa, será considerado se **isForeign** for **false** | Todos |
| rg | string | Número de RG da pessoa, será considerado se **isForeign** for **false** | Todos |
| issuinAutohrity | string | Órgão expedidor do documento de RG da pessoa, será considerado se **isForeign** for **false** | Todos |
| birthDate | string | Data de nascimento da pessoa. Formato: **yyyy-MM-dd** | Todos |
| cellNumber | string | Número de celular da pessoa, deve possuir 10 ou 11 dígitos | Todos |
| phones | string\[\] | Array contendo os números de telefone da pessoa. Deve possuir 11 dígitos e números estrangeiros deve inicia com o símbolo +. | Todos |
| emails | string\[\] | Array contendo os emails da pessoa. | Todos |
| sex | string | Indica o sexo da pessoa, deve ser uma das seguintes iniciais: **'M'** => **'Masculine'**, **'F'** => **'Feminine'**, **'U'** => **'Not informed'**, um valor diferente dos informados será identificado como **Not** **informed** | Todos |
| jobTitle | string | Nome do cargo da pessoa | Todos |
| profession | string | Profissão da pessoa | Todos |
| resume | string | Breve currículo da pessoa | Todos |
| notes | string | Observações da pessoa | Todos |
| address | object | Objeto contendo os dados de endereço da pessoa. Válido para pessoas não estrangeiras | Todos |
| address.zipCode | string | CEP da pessoa | \- |
| address.state | string | Sigla do estado em que a pessoa reside | \- |
| address.city | string | Nome da cidade em que a pessoa reside | \- |
| address.street | string | Nome da rua em que a pessoa reside | \- |
| address.number | integer | Número da residênica da pessoa | \- |
| address.neighborhood | string | Bairro em que a pessoa reside | \- |
| address.additionalDetails | string | Complemento do endereço da pessoa | \- |
| hasLoginAccess | boolean | Indica se a pessoa terá acesso à **Área do Clliente** | Conexa Coworking |
| login | string | Define o login da pessoa caso esta tenha acesso à **Área do Cliente.** O login deve conter: Somente **letras**, **números**, **@ . - +** ou **_** | Conexa Coworking |
| password | string | Define a senha da pessoa caso esta tenha acesso. Deve conter pelo menos 6 caracteres, compostos por letras e números | Conexa Coworking |
| permissions | string\[\] | Array contendo as permissões que a pessoa terá no sistema. Os valores válidos são: **'finance'**, **'orders'**, **'rooms'**, **'sharedSpaces'**, **'assistance'**, **'correspondences'** e **'printing'** | Conexa Coworking |
| accessId | string | Identificador da pessoa (id, nº do cartão e etc) no dispositivo de controle de acesso (catracas, biometria, etc) | Conexa Coworking |
| canReceiveMail | boolean | Sinaliza se a pessoa pode receber correspondências para o cliente ao qual é associada | Conexa Coworking |
| color | string | Código de cor hexadecimal que será associado ao perfil da pessoa | Conexa Coworking |
| printFeeId | string | Valor utilizado unicamente para identificar o cliente durante a importação do arquivo com as tarifações de impressão. Só pode ser cadastrado por usuários do tipo **admin** | Conexa Coworking |
| extensionNumbers | string\[\] | Array contendo os números de ramal ou extensões da pessoa | Conexa Coworking |
| urlLinkedin | string | Endereço perfil da pessoa no **LinkedIn** | Conexa Coworking |
| urlInstagram | string | Endereço do perfil da pessoa no **Instagram** | Conexa Coworking |
| urlFacebook | string | Endereço do perfil da pessoa no **Facebook** | Conexa Coworking |
| urlTwitter | string | Endereço do perfil da pessoa no **Twitter** | Conexa Coworking |
| useFacialRecognitionPhoto | boolean | Define se a imagem da pessoa deve ser utilizada para o reconhecimento facial. Depende de configurações e equipamento específico | Conexa Coworking |
| devices | array of objects | Array contendo os objetos que representam os dispositivos da pessoa que serão cadastrados | Conexa Coworking |
| devices\[\].nickname | string | Apelido do dispositivo | \- |
| devices\[\].macAddress | string | Endereço de mac do dispositivo | \- |

#### Response

Mesmo modelo de dados retornado em [GET /person/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#73281413-c592-4a38-8b3a-90d11adebe6f)


### `DELETE /person/:id`

Exclusão de uma pessoa (associada a um cliente) no sistema Conexa.

É necessário que a pessoa não tenha vínculo com vendas, impressões e/ou correspondências para que a exclusão seja realizada!


### `GET /persons`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 512,508,347 | não |
| `companyId[]` | 8 | não |
| `customerId[]` | 450,216 | não |
| `name` | Tomás Miguel | não |
| `active` | 1 | não |
| `rg` | 439535864 | não |
| `cpf` | 93726775315 | não |
| `limit` | 20 | sim |
| `offset` | 0 | não |

**Corpo de exemplo:**

```json
{
    "username": "admin",
    "password": "lorem.ipsun0"
}
```

Listagem paginada de pessoas.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula. Consultar exemplo: [(200) Success - Conexa Recorrência/Contabilidade](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#d108b2b9-2efa-4264-9e56-1ac65acb627c).

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de pessoas contendo o mesmo modelo de dados presente em [GET /person/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#73281413-c592-4a38-8b3a-90d11adebe6f) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Plan

### `POST /plan`

**Corpo de exemplo:**

```json
{
    "companyId": 3,
    "name": "Gold Global",
    "serviceCategoryId": 1,
    "costCenterId": 1,
    "description": "<p>Gold Global.</p>\n<p>Contrate j&aacute;!</p>",
    "paymentPeriodicities": [
        {
            "periodicity": "monthly",
            "amount": 99.99
        }
    ],
    "membershipFee": 9.99,
    "refundValue": 5.25,
    "fidelityMonths": 12,
    "productQuotas": [
        {
            "quantity": 2,
            "productId": 2521
        }
    ],
    "nfseDescription": "Lorem ipsum dolor",
    "receiptDescription": "Lorem ipsum dolor sit amet",
    "discountOnRooms": 25,
    "discountOnWorkstation": 50,
    "isSmsEnabled": true,
    "serviceCorrespondenceQuotas": {
        "limited": true,
        "messagesLimit": 10,
        "priceAdditionalMessage": 1.50
    },
    "bookingModels": [
        {
            "id": 9,
            "stations": 1
        }
    ],
     "privateSpaceIds": [
        2128
    ],
    "hourQuotas": [
        {
            "hours": 4,
            "periodicity": "monthly",
            "groupId": 8
        },
        {
            "hours": 2,
            "periodicity": "monthly",
            "spaceId": 	4145
        }
    ]
}
```

Criação de um plano, utilizado no cadastro de contrato, no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| companyId | integer | ID da unidade | Sim | Todos |
| name | string | Nome do plano (**deve ser único**) | Sim | Todos |
| serviceCategoryId | integer | ID da categoria de serviço | Sim | Todos |
| costCenterId | integer | ID do centro custo | Sim | Todos |
| description | string | Descrição do plano | Não | Todos |
| paymentPeriodicities | array of objects | Opções de periodicidade de pagamento | Não | Todos |
| paymentPeriodicities\[\].periodicity | string | Periodicidade de pagamento, podendo ser: **monthly**, **bimonthly**, **quarterly**, **semester** ou **yearly** | Sim, se existir um objeto de paymentPeriodicities | \- |
| paymentPeriodicities\[\].amount | decimal | Valor do plano em determinada periodicidade | Sim, se existir um objeto de paymentPeriodicities | \- |
| membershipFee | decimal | Taxa de adesão | Não | Todos |
| refundValue | decimal | Valor de deposito retornavel | Não | Todos |
| fidelityMonths | integer | Meses de fidelidade | Não | Todos |
| productQuotas | array of objects | Cotas de serviços/itens (produtos) que vão estar associadas ao plano | Não | Todos |
| productQuotas\[\].productId | integer | ID do serviço/item | Sim, se um objeto dentro de productQuotas for definido | \- |
| productQuotas\[\].quantity | integer | Quantidade de cotas | Sim, se um objeto dentro de productQuotas for definido | \- |
| nfseDescription | string | Descrição da nota fiscal | Não | Todos |
| descriptionReceipt | string | Descrição do recibo (depende de configuração) | Não | Conexa Coworking |
| discountOnRooms | decimal | Valor em percentual de desconto em salas | Não | Conexa Coworking |
| discountOnWorkstation | decimal | Valor em percentual de desconto em ambientes compartilhados | Não | Conexa Coworking |
| isSmsEnabled | boolean | Flag para verificar se envia SMS. Padrão: `false` | Não | Conexa Coworking |
| serviceCorrespondenceQuotas | object | Configura as cotas de atendimentos e correspondências (depende de configuração) | Não | Conexa Coworking |
| serviceCorrespondenceQuotas.limited | boolean | Define se a quantidade de atendimentos e correspondências é ou não limitada | Não | \- |
| serviceCorrespondenceQuotas.messagesLimit | integer | Define o limite de atendimentos e correspondências. Definir como 0 para não adicionar cotas ao contrato | Sim, se serviceCorrespondenceQuotas.limited for `true` | \- |
| serviceCorrespondenceQuotas.priceAdditionalMessage | decimal | Define o valor a ser pago caso o limite de atendimentos e correspondências seja ultrapassado | Sim, se serviceCorrespondenceQuotas.limited for `true` | \- |
| bookingModels | array of objects | Lista de Modelos de Reserva (Estações de Trabalho do Ambiente Compartilhado) | Não | Conexa Coworking |
| bookingModels\[\].id | integer | ID do Modelo de reserva | Sim, se um objeto dentro de bookingModels for definido | \- |
| bookingModels\[\].stations | integer | Quantidade de estações | Sim, se um objeto dentro de bookingModels for definido | \- |
| privateSpaceIds | array | IDs de espaços privativos que o plano contempla | Não | Conexa Coworking |
| hourQuotas | array of objects | Pacotes de horas | Não | Conexa Coworking |
| hourQuotas\[\].hours | integer | Quantidade de horas da cota | Sim, se existir um objeto de hourQuotas | \- |
| hourQuotas\[\].periodicity | string | Frequência de disponibilidade de cota, podendo ser: **daily**, **weekly** ou **monthly** | Sim, se existir um objeto de hourQuotas | \- |
| hourQuotas\[\].spaceId | integer | ID do espaço | Sim, se existir um objeto de hourQuotas e groupId for vazio | \- |
| hourQuotas\[\].groupId | integer | ID do grupo | Sim, se existir um objeto de hourQuotas e spaceId for vazio | \- |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do plano criado |


### `GET /plan/:id`

Recuperação dos dados de um Plano no Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não serão retornados! 
  

### Response:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| planId | integer | ID do plano | Todos |
| isActive | boolean | Status de ativo | Todos |
| isCustom | boolean | Flag se o plano foi criado de forma personalizada (através do cadastro de um contrato) | Todos |
| companyId | integer | ID da unidade | Todos |
| name | string | Nome do plano | Todos |
| description | string | Descrição do plano | Todos |
| serviceCategoryId | integer | ID da categoria de serviço | Todos |
| costCenterId | integer | ID do centro de custo | Todos |
| refundValue | decimal | Valor do depósito retornável | Todos |
| membershipFee | decimal | Taxa de adesão | Todos |
| fidelityMonths | integer | Quantidade de meses da fidelidade | Todos |
| nfseDescription | string | Descrição da NFS-e (depende de configuração) | Todos |
| paymentPeriodicities | object | Objeto com os valores de periodicidade. O objeto só terá as periodicidades presente no plano | Todos |
| paymentPeriodicities.monthly | decimal | Valor mensal | \- |
| paymentPeriodicities.bimonthly | decimal | Valor bimestral | \- |
| paymentPeriodicities.quarterly | decimal | Valor trimestral | \- |
| paymentPeriodicities.semester | decimal | Valor semestral | \- |
| paymentPeriodicities.yearly | decimal | Valor anual | \- |
| productQuotas | array of objects | Lista de Cotas de Serviços/Itens | Todos |
| productQuotas\[\].id | integer | ID da cota de serviços/itens | \- |
| productQuotas\[\].productId | integer | ID do serviço/item | \- |
| productQuotas\[\].quota | integer | Quantidade de cotas para o serviço/item | \- |
| createdAt | string | Data de criação. Formato: W3C (**Y-m-d\\TH:i:sP**) | Todos |
| updatedAt | string | Data de atualização. Formato: W3C (**Y-m-d\\TH:i:sP**) | Todos |
| receiptDescription | string | Descrição que aparecerá no recibo de locação (dependente de configuração) | Conexa Coworking |
| isSmsEnabled | boolean | Flag de envio de SMS | Conexa Coworking |
| privateSpaceIds | array of integer | Lista de IDs de espaços privativos | Conexa Coworking |
| discountOnRooms | decimal | Percentual de desconto em sala de reunião | Conexa Coworking |
| discountOnWorkstation | decimal | Percentual de desconto em ambiente compartilhado | Conexa Coworking |
| receiptDescription | string | Descrição da Fatura/Recibo (depende de configuração) | Conexa Coworking |
| serviceCorrespondenceQuotas | object | Cotas de atendimento e correspondência (depende de configuração) | Conexa Coworking |
| serviceCorrespondenceQuotas.limited | boolean | Flag se a quantidade de atendimentos e correspondências são limitadas | \- |
| serviceCorrespondenceQuotas.messagesLimit | integer | Limite de atendimentos e correspondências | \- |
| serviceCorrespondenceQuotas.priceAdditionalMessage | decimal | Valor a ser pago caso o limite de atendimentos e correspondências seja ultrapassado | \- |
| bookingModels | array of objects | Lista de Modelos de Reserva (Estações de Trabalho do Ambiente Compartilhado) | Conexa Coworking |
| bookingModels\[\].id | integer | ID do modelo de reserva | \- |
| bookingModels\[\].name | string | Nome do modelo de reserva | \- |
| bookingModels\[\].shareSpaceId | integer | ID do ambinete compartilhado da reserva | \- |
| bookingModels\[\].frequency | string | Frequência da reserva. Podendo ser: **weekly** ou **monthly** | \- |
| bookingModels\[\].isActive | boolean | Flag se o modelo de reserva está ativo | \- |
| bookingModels\[\].startHour | string | Horário de início da reserva. Formato: **hh:mm** | \- |
| bookingModels\[\].endHour | string | Horário de término da reserva. Formato: **hh:mm** | \- |
| bookingModels\[\].resume | string | Resumo, em linguagem natural, do modelo de reserva | \- |
| bookingModels\[\].daysOfWeek | array of string | Lista de dias da semana do modelo de reserva | \- |
| bookingModels\[\].monthlyType | string | Informação se a reserva é em um dia ou data específica caso a frequência seja **monthly**. Podendo ser: **day** ou **date** | \- |
| bookingModels\[\].createdAt | string | Data de criação do modelo de reserva. Formato: W3C (**Y-m-d\\TH:i:sP**) | \- |
| bookingModels\[\].updatedAt | string | Data de atualização do modelo de reserva. Formato: W3C (**Y-m-d\\TH:i:sP**) | \- |
| hourQuotas | array of objects | Lista de Cotas de Horas em Salas de Reunião, Ambientes Compartilhados ou Grupos de Salas | Conexa Coworking |
| hourQuotas\[\].id | integer | ID do pacote de horas definida na cota de horas | \- |
| hourQuotas\[\].name | string | Nome do pacote de horas definida na cota de horas | \- |
| hourQuotas\[\].spaceId | integer | Espaço de trabalho definido na cota de horas | \- |
| hourQuotas\[\].groupId | integer | Grupo de Salas definida na cota de horas | \- |
| hourQuotas\[\].quantity | integer | Quantidade de horas definida na cota de horas | \- |
| hourQuotas\[\].validityType | string | Período de validade da cota. Podendo ser: **Daily**, **Weekly** ou **Monthly** | \- |
| hourQuotas\[\].createdAt | string | Data de criação. Formato: W3C (**Y-m-d\\TH:i:sP**) | \- |
| hourQuotas\[\].updatedAt | string | Data de atualização. Formato: W3C (**Y-m-d\\TH:i:sP**) | \- |


### `PATCH /plan/:id`

**Corpo de exemplo:**

```json
{
    "companyId": 3,
    "name": "4AllDevs Global",
    "serviceCategoryId": 1,
    "costCenterId": 1,
    "description": "<p>4AllDevs Global.</p>\n<p>Contrate j&aacute;!</p>",
    "paymentPeriodicities": [
        {
            "periodicity": "monthly",
            "amount": 99.99
        }
    ],
    "membershipFee": 9.99,
    "refundValue": 5.25,
    "fidelityMonths": 12,
    "productQuotas": [
        {
            "quantity": 2,
            "productId": 2521
        }
    ],
    // "dueDay": 5,
    "nfseDescription": "Lorem ipsum dolor",
    "receiptDescription": "Lorem ipsum dolor sit amet",
    "discountOnRooms": 25,
    "discountOnWorkstation": 50,
    "isSmsEnabled": true,
    "serviceCorrespondenceQuotas": {
        "limited": false,
        "messagesLimit": 10,
        "priceAdditionalMessage": 1.50
    },
    "bookingModels": [
        {
            "id": 9,
            "stations": 1
        }
    ],
     "privateSpaceIds": [
        2128
    ],
    "hourQuotas": [
        {
            "hours": 4,
            "periodicity": "monthly",
            "groupId": 8
        },
        {
            "hours": 2,
            "periodicity": "monthly",
            "spaceId": 	4145
        }
    ]
}
```

Atualiza um plano, utilizado no cadastro de contrato, no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| companyId | integer | ID da unidade | Não | Todos |
| name | string | Nome do plano (**deve ser único**) | Não | Todos |
| serviceCategoryId | integer | ID da categoria de serviço | Não | Todos |
| costCenterId | integer | ID do centro custo | Não | Todos |
| description | string | Descrição do plano | Não | Todos |
| paymentPeriodicities | array of objects | Opções de periodicidade de pagamento | Não | Todos |
| paymentPeriodicities\[\].periodicity | string | Periodicidade de pagamento, podendo ser: **monthly**, **bimonthly**, **quarterly**, **semester** ou **yearly** | Sim, se existir um objeto de paymentPeriodicities | \- |
| paymentPeriodicities\[\].amount | decimal | Valor do plano para a periodicidade | Sim, se existir um objeto de paymentPeriodicities | \- |
| membershipFee | decimal | Taxa de adesão | Não | Todos |
| refundValue | decimal | Valor de depósito retornável | Não | Todos |
| fidelityMonths | integer | Quantidade de meses de fidelidade | Não | Todos |
| productQuotas | array of objects | Lista de cotas de serviços/itens (produtos) vinculadas ao plano | Não | Todos |
| productQuotas\[\].productId | integer | ID do serviço/item | Sim, se um objeto dentro de productQuotas for definido | \- |
| productQuotas\[\].quantity | integer | Quantidade de cotas | Sim, se um objeto dentro de productQuotas for definido | \- |
| dueDay | integer | Dia do vencimento do plano "Cliente Avulso" | Não | Todos |
| nfseDescription | string | Descrição da nota fiscal | Não | Todos |
| receiptDescription | string | Descrição do recibo (depende de configuração) | Não | Conexa Coworking |
| discountOnRooms | decimal | Valor em percentual de desconto para reserva em salas | Não | Conexa Coworking |
| discountOnWorkstation | decimal | Valor em percentual de desconto para reserva em ambientes compartilhados | Não | Conexa Coworking |
| isSmsEnabled | boolean | Flag de envio de SMS | Não | Conexa Coworking |
| serviceCorrespondenceQuotas | object | Configura as cotas de atendimentos e correspondências (depende de configuração) | Não | Conexa Coworking |
| serviceCorrespondenceQuotas.limited | boolean | Define se a quantidade de atendimentos e correspondências é ou não limitada | Não | \- |
| serviceCorrespondenceQuotas.messagesLimit | integer | Define o limite de atendimentos e correspondências. Definir como 0 para não adicionar cotas ao contrato | Sim, se serviceCorrespondenceQuotas.limited for `true` | \- |
| serviceCorrespondenceQuotas.priceAdditionalMessage | decimal | Define o valor adicional por atendimentos e correspondências, caso seja ultrapassado | Sim, se serviceCorrespondenceQuotas.limited for `true` | \- |
| bookingModels | array of objects | Lista de modelos de reserva (Estações de Trabalho do Ambiente Compartilhado) | Não | Conexa Coworking |
| bookingModels\[\].id | integer | ID do modelo de reserva | Sim, se um objeto dentro de bookingModels for definido | \- |
| bookingModels\[\].stations | integer | Quantidade de estações | Sim, se um objeto dentro de bookingModels for definido | \- |
| privateSpaceIds | array | Lista de IDs de espaços privativos associados ao plano | Não | Conexa Coworking |
| hourQuotas | array of objects | Lista de cotas de horas para uso de salas ou ambientes compartilhados | Não | Conexa Coworking |
| hourQuotas\[\].hours | integer | Quantidade de horas inclusas | Sim, se existir um objeto de hourQuotas | \- |
| hourQuotas\[\].periodicity | string | Frequência de disponibilidade de cota, podendo ser: **daily**, **weekly** ou **monthly** | Sim, se existir um objeto de hourQuotas | \- |
| hourQuotas\[\].spaceId | integer | ID do espaço | Sim, se existir um objeto de hourQuotas e groupId for vazio | \- |
| hourQuotas\[\].groupId | integer | ID do grupo | Sim, se existir um objeto de hourQuotas e spaceId for vazio | \- |


#### Response

Mesmo modelo de dados retornado em [GET /plan/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#4580c54b-81ec-4a20-9d46-16584fd3f0a6)


### `DELETE /plan/:id`

Exclusão de um plano no Conexa.


### `GET /plans`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 465 | não |
| `companyId[]` | 3 | não |
| `name` | Plano Alpha | não |
| `isActive` | 1 | não |
| `isOnlineContractingEnabled` | 1 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Planos.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Planos contendo o mesmo modelo de dados presente em [GET /plan/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#4580c54b-81ec-4a20-9d46-16584fd3f0a6) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Contract

### `POST /contract`

**Corpo de exemplo:**

```json
{
    "planId": 12,
    "customerId": 42,
    "paymentFrequency": "monthly",
    "startDate": "2024-10-01",
    "endDate": "2025-09-30",
    "dueDay": 11,
    "fidelityDate": "2024-07-01",
    "amount": 1500,
    "discountValue": 100,
    "sellerId": 531,
    "contractSummary": "Contrato de locação de espaço",
    "notes": "O cliente realizou o pagamento antecipadamente",
    "membershipFee": 59.99,
    "generateSales": "firstOccurrence",
    "prorataType": "startOfMonth",
    "nfseDescription": "Lorem ipsun dolor",
    "refund": {
        "amount": 59.99,
        "dateLimit": "2024-04-30",
        "isToGenerateRefundBillet": false
    },
    "complementaryServices": [
        {
            "productOrServiceId": 2113,
            "quantity":3,
            "amount": 200,
            "notes": "Lorem ipsun dolor 1"
        },
        {
            "productOrServiceId": 2521,
            "quantity": 2,
            "amount": 250,
            "notes": "Lorem ipsun dolor 2"
        }
    ],
    "discountOnRooms": 5,
    "discountOnWorkstation": 10,
    "privateSpaceId": 2590,
    "isSmsEnabled": true,
    "calculateProrataHourPackage": true,
    "serviceCorrespondenceQuotas": {
        "limited": true,
        "messagesLimit": 61,
        "priceAdditionalMessage": 101
    },
    "extraFields": [
        {
            "id": 1,
            "value": "Valor do campo extra 1"
        },
        {
            "id": 2,
            "value": "Valor do campo extra 2"
        }
    ]
}
```

Cadastro de um contrato para um Cliente no sistema Conexa.

#### Body:

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| planId | integer | ID do plano | Sim | Todos |
| customerId | integer | ID do cliente | Sim | Todos |
| paymentFrequency | integer | Periodicidade do pagamendo do contrato conforme o plano, podendo ser: **monthly**, **bimonthly**, **quarterly**, **semester** e **yearly** | Sim | Todos |
| startDate | string | Data de início. Formato: **yyyy-MM-dd** | Sim | Todos |
| endDate | string | Data de encerramento. Formato: **yyyy-MM-dd** | Não | Todos |
| firstDueDate | string | Determina a data de vencimento da primeira parcela. Formato **yyyy-mm-dd** | Sim (caso o cliente utilize faturamento automático) | Todos |
| dueDay | integer | Dia de vencimento do contrato | Sim (caso seja o primeiro contrato do cliente, ou caso o cliente utilize faturamento automático) | Todos |
| fidelityDate | string | Data de fidelidade. Formato: **yyyy-MM-dd** | Não | Todos |
| amount | decimal | Valor do contrato¹ | Não | Todos |
| discountValue | decimal | Valor do desconto aplicado ao valor do contrato (em reais) | Não (0 por padrão) | Todos |
| sellerId | integer | ID do vendedor (usuário) | Não (deve ser enviado em requisições que a autenticação é realizada pelo API Token) | Todos |
| contractSummary | string | Descrição resumida do contrato | Não | Todos |
| notes | string | Observações | Não | Todos |
| membershipFee | decimal | Taxa de adesão do contrato | Não | Todos |
| generateSales | string | Define a partir de quando deve gerar as vendas, podendo ser: **firstOccurrence**, **currentOccurrence, nextOccurrence** ou **firstOccurrenceSettleRetroactive** | Não (**firstOccurrence** por padrão) | Todos |
| expenseSettlement | object | Configura informações necessárias para quitar as cobranças retroativas, caso generateSales for **firstOccurrenceSettleRetroactive**. | Somente se generateSales for **firstOccurrenceSettleRetroactive** | Todos |
| expenseSettlement.receivingMethodId | integer | ID do meio de recebimento a ser utilizado para quitar as vendas retroativas | Somente se generateSales for **firstOccurrenceSettleRetroactive** | Todos |
| expenseSettlement.accountId | integer | ID da conta bancária a ser utilizada para quitar as vendas retroativas | Somente se generateSales for **firstOccurrenceSettleRetroactive** | Todos |
| prorataType | string | Define a forma como a prorata dese ser cálculada. Podendo ser: **startOfMonth**, **notCalculate** ou **perDueDate** (está última depende da configuração do sistema) | Não (configuração do sistema por padrão) | Todos |
| nfseDescription | string | Descrição utilizada na NFSe | Não | Todos |
| refund | object / null | Configura os dados do depósito retornável. Informe **null** para não gerar, mesmo que esteja configurado no plano | Não | Todos |
| refund.amount | decimal | Valor do depósito retornável | Não | \- |
| refund.dateLimit | string | Data de vencimento do depósito retornável | Sim, se refund.amount for preenchido com um valor diferente de zero | \- |
| refund.isToGenerateRefundBillet | boolean | Define se deve ser gerado um boleto do depósito retornável | Sim, se refund.amount for preenchido com um valor diferente de zero | \- |
| complementaryServices | array of objects | Define os serviços complementares que serão adicionados ao contrato | Não | Todos |
| complementaryServices\[\].productOrServiceId | integer | Id do produto ou serviço | Sim | \- |
| complementaryServices\[\].quantity | integer | Quantidade do produto ou serviço | Sim | \- |
| complementaryServices\[\].amount | decimal | Valor final do serviço | Não. Informe caso queira um valor personalizado | \- |
| complementaryServices\[\].notes | string | Observações | Não | \- |
| extraFields | array of objects / null | Lista de campos extras do contrato. Enviar **null** ou omitir para não alterar. Os campos extras devem ser do tipo **contract** | Não | Todos |
| extraFields\[\].id | integer | ID do campo extra | Sim | \- |
| extraFields\[\].value | string | Valor do campo extra | Sim | \- |
| discountOnRooms | decimal | Desconto (%) aplicado às reservas de salas realizadas pelo contratante | Não | Conexa Coworking |
| discountOnWorkstation | decimal | Desconto (%) aplicado às reservas de ambientes compartilhados realizadas pelo contratante | Não | Conexa Coworking |
| privateSpaceId | integer | ID do Escritório Privativo vinculado ao Contrato | Não | Conexa Coworking |
| isSmsEnabled | boolean | Indica se o envio de recados via SMS está habilitado no contrato | Não | Conexa Coworking |
| calculateProrataHourPackage | boolean | Define se deve ser realizado o cálculo do prorata nos pacotes de horas | Não (false por padrão) | Conexa Coworking |
| serviceCorrespondeceQuotas | object | Configura as cotas de Atendimento e Correpondência | Não | Conexa Coworking |
| serviceCorrespondeceQuotas.limited | boolean | Define se a quantidade de atendimentos ou correspondências é ou não limitada | Não | \- |
| serviceCorrespondeceQuotas.messagesLimit | integer | Define o limite de atendimentos ou correspondências. Definir como 0 para não adicionar cotas ao contrato | Sim, se serviceCorrespondeceQuotas.limited for _true_ | \- |
| serviceCorrespondeceQuotas.priceAdditionalMessage | decimal | Define o valor a ser pago por atendimentos ou correspondências caso o limite seja ultrapassado | Sim, se serviceCorrespondeceQuotas.limited for _true_ | \- |

¹ Se o campo `complementaryServices` for utilizado, o valor final do contrato será a soma do campo `amount` com os campos `complementaryServices[].amount` de cada objeto. Na requisição de exemplo **(201) Success - Cadastro de contrato com serviços complementares** de [POST /contract](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#7e89ac4d-27b6-4717-8c8d-43b2ce865bbb), temos: R$ 1.500,00 (valor do contrato) + R$ 200,00 (produto/serviço complementar 1) + R$ 250,00 (produto/serviço complementar 2), totalizando: R$ 1.950,00 sendo este o valor final do contrato!

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do contrato criado |


### `PATCH /contract/end/:id`

**Corpo de exemplo:**

```json
{
    "date":"2024-05-01",
    "reasonId": 2,
    "unlinkCustomer": true
}
```

Encerra um contrato ativo ou atualiza a data de encerramento de um contrato no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| date | string | Data de encerramento do contrato. Formato: **yyyy-MM-dd** | Sim |
| reasonId | integer | ID relacionado ao motivo do encerramento¹ | Não |
| unlinkCustomer | boolean | Desvincula o cliente de **DDRs**, **Caixas Postais**, **Ramais** e **Vendas Recorrentes²**. Para que o cliente possa ser desvinculado, a data informada deve ser anterior ou igual a atual e o cliente não deve possuir demais contratos ativos. | Não |

¹ Os IDs dos Motivos de Encerramento podem ser encontrados, dentro do sistema Conexa, em: **Listagem de Contratos > Outros Cadastros > Motivo de Encerramento de Contrato**.

**² Todas as Vendas Recorrentes do cliente, mesmo sem vínculo com o contrato, serão encerradas para a data atual e suas vendas não faturadas serão canceladas.**


### `PATCH /contract/:id`

**Corpo de exemplo:**

```json
{
    "startDate": "2023-02-12",
    "dueDay" : 3,
    "fidelityDate": "2024-06-02",
    "contractSummary": "Contrato de Plus Horizon AA",
    "amount": 5000.50,
    "discountValue": 1000,
    "notes": "O cliente tem condição especial nas cotas",
    "lastAdjustmentDate": "2024-01-04",
    "sellerId": 532,
    "productQuotas": [
        {
            "quantity": 10,
            "productId": 2521
        },
        {
            "quantity": 2,
            "productId": 2154
        }
    ],
    "complementaryServices": [
        {
            "productOrServiceId": 2113,
            "quantity":3,
            "amount": 280,
            "notes": "Lorem ipsun dolor 1"
        }
    ],
    /*"plan": {
        "serviceCategoryId": 9,
        "costCenterId": 1,
        "nfseDescription": "Descrição Nfse 3"
    },*/
    "discountOnRooms": 10,
    "discountOnWorkstation": 5,
    "privateSpaceId": 2151,
    "isSmsEnabled": true,
    "serviceCorrespondenceQuotas": {
        "limited": true,
        "messagesLimit": 10,
        "priceAdditionalMessage": 5.99
    },
    "extraFields": [
        {
            "id": 1,
            "value": "Valor do campo extra 1"
        },
        {
            "id": 2,
            "value": "Valor do campo extra 2"
        }
    ]
}
```

Edição de um contrato no sistema Conexa.

#### Body:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| startDate | date | Data de início do contrato | Todos |
| dueDay | integer | Dia de vencimento (caso só exista um contrato ativo no cliente) | Todos |
| fidelityDate | date | Data de fidelidade | Todos |
| contractSummary | string | Descrição resumida do contrato | Todos |
| amount | decimal | Valor do contrato | Todos |
| discountValue | decimal | Desconto de contrato | Todos |
| notes | string | Observações | Todos |
| lastAdjustmentDate | date | Último reajuste do contrato | Todos |
| sellerId | integer | ID do vendedor (usuário). Deve ser enviado em requisições que a autenticação é realizada pelo API Token | Todos |
| productQuotas | array of objects | Lista de cotas de serviços/itens | Todos |
| productQuotas\[\].quantity | integer | Quantidade de cotas | \- |
| productQuotas\[\].productId | integer | ID do serviço/item | \- |
| complementaryServices | array of objects | Define os serviços complementares que serão adicionados ao contrato | Todos |
| complementaryServices\[\].productOrServiceId | integer | Id do produto ou serviço | \- |
| complementaryServices\[\].quantity | integer | Quantidade do produto ou serviço | \- |
| complementaryServices\[\].amount | decimal | Valor final do serviço | \- |
| complementaryServices\[\].notes | string | Observações | \- |
| extraFields | array of objects / null | Lista de campos extras do contrato. Enviar **null** ou omitir para não alterar. Enviar **[]** para remover todos. Os campos extras devem ser do tipo **contract** | Não | Todos |
| extraFields\[\].id | integer | ID do campo extra | Sim | \- |
| extraFields\[\].value | string | Valor do campo extra | Sim | \- |
| plan | object | Plano (apenas para planos personalizados) | Todos |
| plan.serviceCategoryId | integer | ID da categoria de serviço | \- |
| plan.costCenterId | integer | ID do centro de custo | \- |
| plan.nfseDescription | string | Descrição do serviço na NFS-e | \- |
| discountOnRooms | decimal | Descontos em salas | Conexa Coworking |
| discountOnWorkstation | decimal | Descontos em ambientes compartilhados | Conexa Coworking |
| privateSpaceId | integer | ID de um espaço privativo que será vinculado ao contrato | Conexa Coworking |
| isSmsEnabled | boolean | Habilitar envios de atendimento e correspondência por SMS | Conexa Coworking |
| serviceCorrespondenceQuotas | object | Cotas de atendimento e correspondência | Conexa Coworking |
| serviceCorrespondenceQuotas.limited | boolean | Define se a quantidade de atendimentos ou correspondências é ou não limitada | \- |
| serviceCorrespondenceQuotas.messagesLimit | integer | Define o limite de atendimentos ou correspondências. Definir como 0 para não adicionar cotas ao contrato | \- |
| serviceCorrespondenceQuotas.priceAdditionalMessage | decimal | Define o valor a ser pago por atendimentos ou correspondências caso o limite seja ultrapassado | \- |

#### Response:

Mesmo modelo de dados retornado em [GET /contract/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#9bcf8e00-e5e4-4d23-88db-6a15281e9bce)


### `GET /contract/:id`

Recupera as informações de um Contrato a partir do ID.

#### Response

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| id | integer | ID do Contrato | Todos |
| sellerId | integer | ID do vendedor (usuário) | Todos |
| customerId | integer | ID do Cliente | Todos |
| planId | integer | ID do Plano | Todos |
| costCenterId | integer | ID do Centro de Custo | Todos |
| paymentFrequency | integer | Periodicidade do pagamendo do Contrato, podendo ser: **Monthly**, **Bimonthly**, **Quarterly**, **Semester**, **Yearly** | Todos |
| contractSummary | string | Descrição Resumida do Contrato | Todos |
| startDate | string | Data de Início | Todos |
| endDate | string | Data de Encerramento | Todos |
| endReasonId | integer | ID do Motivo de Cancelamento | Todos |
| hadProrata | boolean | Indicador se houve ou não prorata | Todos |
| isActive | boolean | Está ativo ou não | Todos |
| salesQuantity | string | Quantidade de vendas geradas | Todos |
| amount | decimal | Valor final do Contrato | Todos |
| refundAmount | decimal | Valor do depósito retornável | Todos |
| notes | string | Observações | Todos |
| dateSalesGeneration | string | Data de início de geração das vendas | Todos |
| createdAt | string | Data de criação do contrato | Todos |
| updatedAt | string | Data da última modificação do contrato | Todos |
| dueDay | integer | Dia de vencimento do contrato | Todos |
| fidelityDate | string | Data de fidelidade | Todos |
| lastContractualReadjustment | object | Objeto contendo informações do último reajust | Todos |
| lastContractualReadjustment.index | string | Ídice informado no momento do reajust | \- |
| lastContractualReadjustment.date | string | Data no formato **yyyy-mm-dd** em que o reajuste foi realizado | \- |
| lastContractualReadjustment.percentage | decimal | Porcentagem de reajuste aplicado | \- |
| complementaryServices | array of objects | Serviços complementares do contrato | Todos |
| complementaryServices\[\].productOrServiceId | integer | Id do produto ou serviço | \- |
| complementaryServices\[\].startDate | string | Data de início do serviço | \- |
| complementaryServices\[\].endDate | string | Data de encerramento do serviço | \- |
| complementaryServices\[\].isActive | boolean | Serviço ativo ou não | \- |
| complementaryServices\[\].quantity | integer | Quantidade do produto ou serviço | \- |
| complementaryServices\[\].amount | decimal | Valor final do serviço | \- |
| complementaryServices\[\].notes | string | Observações | \- |
| productQuotas | array of objects | Cotas de produtos (**Serviços/Itens**) que não serão cobrados caso o cliente consuma | Todos |
| productQuotas\[\].quantity | integer | Quantidade de Serviços/Itens | \- |
| productQuotas\[\].productId | integer | ID do Serviço/Item | \- |
| extraFields | array of objects / null | Lista de campos extras do contrato. Enviar **null** ou omitir para não alterar. Os campos extras devem ser do tipo **contract** | Não | Todos |
| extraFields\[\].id | integer | ID do campo extra | Sim | \- |
| extraFields\[\].value | string | Valor do campo extra | Sim | \- |
| discountOnRooms | decimal | Desconto aplicado às reservas de Salas realizadas para o contratante (valor percentual) | Conexa Coworking |
| discountOnWorkstation | decimal | Desconto aplicado às reservas de Ambientes Compartilhados realizadas para o contratante (valor percentual) | Conexa Coworking |
| isSmsEnabled | boolean | Indica se o envio de recados por SMS está ativado | Conexa Coworking |
| privateSpaceId | integer | ID do Escritório Privativo ou Sala Privativa vinculada ao contrato | Conexa Coworking |
| bookingModels | array of objects | Cotas em faixa de dias e horário pré-definidos (apenas para estações de trabalho) em um plano. | Conexa Coworking |
| bookingModels\[\].personId | integer | ID da pessoa vinculada à cota em faixa de dias e horário pré-definido. Se ausente, a cota fica livre pra qualquer pessoa | \- |
| bookingModels\[\].hourPlanId | integer | ID do plano de horas. se isCustom for false, apenas IDs de Planos de Horas vinculados ao Plano selecionado | \- |
| hourPlanQuota | array of objects | Lista de pacotes de horas relacionados ao contrato | Conexa Coworking |
| hourPlanQuota\[\].quantity | integer | Quantidade de horas contratadas | \- |
| hourPlanQuota\[\].spaceId | integer | ID da Sala ou Ambiente Compartilhado ao qual está vinculada a cota (`null` se existir `groupId`) | \- |
| hourPlanQuota\[\].groupId | integer | ID da grupo ao qual está vinculada a cota (`null` se existir `spaceId`) | \- |
| serviceCorrespondenceQuotas | object | Cotas de Atendimento e Correpondência | Conexa Coworking |
| serviceCorrespondenceQuotas.limited | boolean | Quantidade de atendimentos é ou não limitada | \- |
| serviceCorrespondenceQuotas.limit | integer | Limite de Correspondências ou Atendimentos | \- |
| serviceCorrespondenceQuotas.aditionalValue | decimal | Valor a ser pago caso o limite de Correspondências e Atendimentos seja ultrapassado. | \- |


### `DELETE /contract/:id`

Exclusão de um contrato no Conexa.

## Error Response

### _422 Unable to process_

Abaixo apresentamos alguns erros que podem ser retornados ao tentar excluir um contrato no Conexa.

| **Code** | **Message** |
| --- | --- |
| CONTRACT_RECURRING_SALE_40 | It is not possible to delete this contract as it already has invoiced sales. If desired, you can still terminate the contract for a specific date. |
| CONTRACT_RECURRING_SALE_41 | It is not possible to delete this contract as the customer has already paid the refundable deposit. Charge ID: {chargeId} |
| CONTRACT_RECURRING_SALE_42 | Error when deleting the refundable deposit invoice. |
| CONTRACT_RECURRING_SALE_43 | Error when canceling the invoice in the integrator bank. |
| CONTRACT_RECURRING_SALE_44 | Error when deleting recurring reservations linked. |
| CONTRACT_RECURRING_SALE_45 | Error when removing links for due date changes. |
| ... | ... |


### `GET /contracts`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 80,81,91 | não |
| `companyId[]` | 3 | não |
| `customerId[]` | 516, 489 | não |
| `planId[]` | 15 | não |
| `sellerId[]` | 1 | não |
| `startDateFrom` | 2024-01-05 | não |
| `startDateTo` | 2024-01-10 | não |
| `endDateFrom` | 2024-03-01 | não |
| `endDateTo` | 2024-03-09 | não |
| `lastReadjustmentDateFrom` | 2024-02-04 | não |
| `lastReadjustmentDateTo` | 2024-02-08 | não |
| `isActive` | 1 | não |
| `frequency` | monthly | não |
| `tagId[]` | 2 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Contratos.

Os itens definidos como array podem ter múltiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Contratos contendo o mesmo modelo de dados presente em [GET /contract/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#9bcf8e00-e5e4-4d23-88db-6a15281e9bce) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


### `POST /contract/:id/signature/request`

**Corpo de exemplo:**

```json
{
    "contractTemplateId": 1,
    "contractNumber": "",
    "companySigners": [
      {
        "deliveryValue": "lorem@ipsum.dolor",
        "deliveryMethod": "email",
        "role": "sign"
      },
      {
        "deliveryValue": "citius.dolor@ipsun.lorem",
        "deliveryMethod": "email",
        "role": "acknowledge"
      }
    ],
    "customerSigners": [
      {
        "deliveryMethod": "email",
        "deliveryValue": "customer@email.com",
        "role": "sign",
        "name": "Natália Kamilly Assis"
      },
      {
        "deliveryMethod": "whatsapp",
        "deliveryValue": "5511911223344",
        "role": "sign",
        "name": "Sérgio Kauê Leonardo Peixoto"
      }
    ],
    "requirePhoto": false,
    "requirePhotoWithSelfie": false,
    "requireDigitalCertificate": false,
    "requireInPersonSignature": false
}
```

Solicitação de envio do Contrato para Assinatura Eletrônica através da integração feita pela D4Sign dentro do sistema Conexa.

#### Body:

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| contractTemplateId | integer | ID do modelo de contrato a ser utilizado para gerar o PDF | Sim |
| contractNumber | string\/null | Número do contrato (id) para ser substituído no parametro do modelo | Não |
| companySigners | array of objects | Dados do signatário da empresa (sócio) | Sim |
| companySigners[].deliveryValue | string | Valor de entrega conforme o método escolhido (e-mail ou número de celular do sócio) | Sim |
| companySigners[].deliveryMethod | string | Método de envio da solicitação de assinatura para o sócio. Valores aceitos: **email**, **whatsapp** | Sim |
| companySigners[].role | string | Papel/função do signatário da empresa no contrato | Sim |
| customerSigners | array of objects | Dados do signatário do cliente | Sim |
| customerSigners[].deliveryMethod | string | Método de envio da solicitação de assinatura para o cliente. Valores aceitos: **email**, **whatsapp** | Sim |
| customerSigners[].deliveryValue | string | Valor de entrega conforme o método escolhido (e-mail ou número de celular do cliente) | Sim |
| customerSigners[].role | string | Papel/função do signatário do cliente no contrato | Sim |
| customerSigners[].name | string | Nome do signatário do cliente no contrato | Sim |
| requirePhoto | boolean\/null | Exige foto do documento do signatário para autenticação | Não |
| requirePhotoWithSelfie | boolean\/null| Exige foto do documento com selfie para autenticação | Não |
| requireDigitalCertificate | boolean\/null | Exige certificado digital ICP-Brasil para assinatura | Não |
| requireInPersonSignature | boolean\/null | Exige assinatura presencial | Não |


### Códigos de Erro (422 - Unable to process)

| **Error Code** | **Message** |
| --- | --- |
| SIGNATURE_01 | Digital signature integration is invalid or not configured for the company. |
| SIGNATURE_02 | Sending through WhatsApp is not activated for this account. |
| SIGNATURE_03 | This account does not have limit to send documents in this safe. |
| SIGNATURE_04 | The limit of sign solitacions has been reached in this account. |
| SIGNATURE_05 | Company signer partner not found. Verify the delivery value provided: {deliveryValue} |
| SIGNATURE_06 | The signature request could not be sent. Please try again later. |
| SIGNATURE_07 | The integration does not have access to the selected safe. |
| SIGNATURE_08 | Signer not found in your D4Sign account. |
| SIGNATURE_09 | It is not possible to sign an inactive contract. |


## Recurring Sale

### `POST /recurringSale`

**Corpo de exemplo:**

```json
{
    "customerId": 450,
    // "type": "package",
    // "referenceId": 73,
    "type": "product",
    "referenceId": 2109,
    "requesterId": 458,
    "sellerId": 13,
    "isRepeat": false,
    "occurrenceQuantity": 2,
    "frequency": "monthly",
    "startDate": "2024-03-15",
    "lastAdjustmentDate": "2023-03-15",
    "quantity": 1,
    "amount": 75.99,
    "notes": "Solicitação via WhatsApp"
    // "isDiscountPreviousReservations": false,
    // "isCalculateProRata": false
}
```

Criação de uma **Venda Recorrente**, cujo produto pode ser **Serviço/Item** ou **Pacote de Horas** (apenas Conexa Coworking) no sistema Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não são necessários! 
  

#### Body

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| customerId | integer | ID do cliente | Sim | Todos |
| type | string | **'product'** para venda de Serviço/Item.  <br>**'package'** para venda de Pacotes de Horas. | Sim | Todos |
| referenceId | integer | ID do Serviço/Item ou do Pacote de Horas | Sim | Todos |
| requesterId | integer | ID do solicitante | Depende da configuração do sistema | Todos |
| sellerId | integer | ID do vendedor (usuário) | Não (deve ser enviado em requisições que a autenticação é realizada pelo API Token) | Todos |
| frequency | string | Frequência da Venda Recorrente, podendo ser: **'daily'**, **'weekly'**, **'monthly'**, **'bimonthly'**, **'quarterly'**, **'semester'**, **'yearly'** | Sim | Todos |
| isRepeat | boolean | Repetir a venda conforme a periodicidade (`frequency`) | Não | Todos |
| occurrenceQuantity | integer | Quantidade de ocorrências | Sim, se `isRepeat` for `false` | Todos |
| startDate | string | Data de início | Sim | Todos |
| lastAdjustmentDate | string | Data do último reajuste | Não | Todos |
| quantity | integer | Quantidade (não disponível para o tipo **'package'**) | Apenas para Serviço/Item | Todos |
| amount | decimal | Valor da venda recorrente | Sim | Todos |
| notes | string | Observações | Não | Todos |
| isDiscountPreviousReservations | boolean | Aplicar desconto do Pacote de Horas em reservas anteriores | Apenas para Pacote de Horas | Conexa Coworking |
| isCalculateProRata | boolean | Calcular Pro Rata proporcional ao mês de início da venda recorrente | Apenas para Pacote de Horas | Conexa Coworking |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da venda recorrente criada |


### `GET /recurringSale/:id`

Recuperação das informações de uma Venda Recorrente, a partir do ID, no sistema Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não serão retornados! 
  

#### Response

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| recurringSaleId | integer | ID da venda recorrente | Todos |
| sellerId | integer | ID do vendedor (usuário) | Todos |
| customerId | integer | ID do cliente | Todos |
| requesterId | integer | Id do solicitante (pessoa) | Todos |
| productId | integer | ID do Serviço/Item (`null` se existir um `packageId`) | Todos |
| packageId | integer | ID do Pacote de Horas (`null` se existir um `productId`) | Conexa Coworking |
| occurrenceQuantity | integer | Quantidade de ocorrências | Todos |
| frequency | string | Frequência da venda recorrente, podendo ser: **daily**, **weekly**, **monthly**, **bimonthly**, **quarterly**, **semester** ou **yearly** | Todos |
| startDate | string | Data de início (primeira ocorrência) | Todos |
| endDate | string | Data de encerramento (última ocorrência) | Todos |
| quantity | integer | Quantidade do produto | Todos |
| ~~quantityProduct~~ | ~~integer~~ | ~~Quantidade do produto~~ | ~~Todos~~ |
| amount | decimal | Valor da venda recorrente | Todos |
| notes | string | Observações | Todos |
| lastAdjustmentDate | string | Data do último reajuste | Todos |
| recurringSaleContractId | integer | Id do contrato que gerou a venda recorrente | Todos |
| generatedQuantity | integer | Quantidade de vendas gerada | Todos |
| isActive | boolean | Está ativa ou não | Todos |
| isCalculateProRata | boolean | Calcula pró rata | Conexa Coworking |
| createdAt | string | Data de criação | Todos |
| modifiedAt | string | Data da última edição | Todos |


### `PATCH /recurringSale/end/:id`

**Corpo de exemplo:**

```json
{
    "date":"2024-10-31"
}
```

Encerra uma venda recorrente ativa ou atualiza a data de encerramento de uma venda recorrente no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| date | string | Data de encerramento do contrato. Formato: **yyyy-MM-dd** | Sim |


### `PATCH /recurringSale/:id`

**Corpo de exemplo:**

```json
{
    "requesterId": 3,
    "amount": 190.00,
    "quantity": 2,
    "lastAdjustmentDate": "2023-03-15",
    "notes": "via API"
}
```

Edição de campos de uma **Venda Recorrente** no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| requesterId | integer | ID do solicitante |
| amount | decimal | Valor da venda recorrente |
| quantity | integer | Quantidade |
| lastAdjustmentDate | string | Data do último reajuste |
| notes | string | Observações |

#### Response

Mesmo modelo de dados retornado em [GET /recurringSale/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#5f271810-0d9d-4dcc-a4d1-60c18e211e47)


### `DELETE /recurringSale/:id`

Exclusão de uma venda recorrente no Conexa.

## Error Response

### _422 Unable to process_

Abaixo apresentamos alguns erros que podem ser retornados ao tentar excluir uma Venda Recorrente no Conexa.

| **Code** | **Message** | **Conexa's Product** |
| --- | --- | --- |
| RECURRING_SALE_02 | The id {id} does not correspond to a recurring sale. | Todos |
| RECURRING_SALE_08 | It is not possible to delete a recurring sale linked to a contract. | Todos |
| RECURRING_SALE_09 | It is not possible to delete a recurring sale that has invoiced sales. | Todos |
| RECURRING_SALE_10 | It is not possible to delete a recurring sale that has usages in bookings. | Conexa Coworking |
| ... | ... | ... |


### `GET /recurringSales`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 45,48,1275 | não |
| `companyId[]` | 3 | não |
| `customerId[]` | 23, 623 | não |
| `productId[]` | 2145, 2154 | não |
| `packageId[]` | 9,5 | não |
| `sellerId[]` | 534 | não |
| `startDateFrom` | 2022-01-01 | não |
| `startDateTo` | 2023-12-12 | não |
| `endDateFrom` | 2018-01-01 | não |
| `endDateTo` | 2023-12-31 | não |
| `lastAdjustmentDateFrom` | 2022-01-01 | não |
| `lastAdjustmentDateTo` | 2024-12-31 | não |
| `isActive` | 0 | não |
| `frequency` | weekly | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Vendas Recorrentes.

Os itens definidos como array podem ter múltiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Venda Recorrente contendo o mesmo modelo de dados presente em [GET /recurringSale/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#5f271810-0d9d-4dcc-a4d1-60c18e211e47) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Product

### `POST /product`

**Corpo de exemplo:**

```json
{
    "name": "Serviço de Motoboy",
    "description": "Serviço de entrega de correspondências",
    "price": 10.9,
    "companyId": 3,
    "serviceCategoryId": 1,
    "costCenterId": 7,
    "isCustomerConsumable": false,
    "notificationsEmails": ["lorem.ipsun@dolor.cirius", "ipsun@dolor.cirius"],
    "nfseDescription": null,
    "receiptDescription": null
}
```

Criação de um Item/Serviço no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| name | string | Nome | Sim |
| price | decimal | Valor | Sim |
| companyId | integer | ID da unidade | Sim |
| serviceCategoryId | integer | ID da categoria de serviço | Sim |
| costCenterId | integer | ID do centro de custo | Sim |
| description | string | Descrição detalhada | Não |
| isCustomerConsumable | boolean | Define se o produto pode ser consumido pela Área do Cliente | Não |
| notificationsEmails | array of string | Lista de e-mails para notificação de venda | Não |
| nfseDescription | string | Descrição para NFSe. Depende de configuração, módulo ou versão do sistema | Não |
| receiptDescription | string | Descrição para recibo. Depende de configuração, módulo ou versão do sistema | Não |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do item/serviço criado |


### `GET /product/:id`

Recuperação dos dados de Itens/Serviços (produtos). Abaixo exibimos uma tabela do que será retornado dado o tipo de versão do software Conexa.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não serão retornados! 
  

### Response:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| productId | integer | ID do produto | Todos |
| companyId | integer | ID da unidade | Todos |
| categoryId | integer | ID da categoria de serviço | Todos |
| costCenterId | integer | ID do centro de custo | Todos |
| name | string | Nome do Serviço/Item | Todos |
| description | string | Descrição do Serviço/Item | Todos |
| price | decimal | Preço | Todos |
| active | boolean | Ativo | Todos |
| isCustomerConsumable | boolean | Consumível na Área do Cliente | Todos |
| notificationsEmails | array/null | E-mail de notificação quando uma venda desse produto é realizada | Todos |
| createdAt | string | Data de criação. Formato: W3C (**Y-m-d\\TH:i:sP**) | Todos |
| updatedAt | string | Data de atualização. Formato: W3C (**Y-m-d\\TH:i:sP**) | Todos |
| nfseDescription | string | Descrição que aparecerá na nota fiscal | Todos (dependente de módulo opcional) |
| receiptDescription | string | Descrição que aparecerá no recibo de locação | Conexa Coworking (dependente de configuração) |


### `GET /products`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 2493,2521 | não |
| `companyId[]` | 3 | não |
| `name` | Café | não |
| `price` | 0 | não |
| `isActive` | 1 | não |
| `isCustomerConsumable` | 0 | não |
| `createdAtFrom` | 2024-04-01T12:00:00-03:00 | não |
| `createdAtTo` | 2025-04-01T12:00:00-03:00 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Serviços/Itens.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Serviços/Itens contendo o mesmo modelo de dados presente em [GET /product/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#1c0ceb76-9206-439f-90e3-6367611f6bd5) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


### `PATCH /product/:id`

**Corpo de exemplo:**

```json
{
    "name": "Capsula de Café",
    "price": 4.99,
    "companyId": 4,
    "serviceCategoryId": 5,
    "costCenterId": 7,
    "active": true,
    "description": "Serviço de Copa",
    "isCustomerConsumable": true,
    "notificationsEmails": ["lorem.ipsun@dolor.cirius", "ipsun@dolor.cirius"],
    "nfseDescription": "Serviços de Copa/Cozinha",
    "receiptDescription": null
}
```

Edição de campos de um **Item/Serviço** no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| name | string | Nome |
| price | decimal | Valor |
| companyId | integer | ID da unidade |
| serviceCategoryId | integer | ID da categoria de serviço |
| costCenterId | integer | ID do centro de custo |
| active | boolean | Define se o produto está ativo ou não |
| description | string | Descrição detalhada |
| isCustomerConsumable | boolean | Define se o produto pode ser consumido pela Área do Cliente |
| notificationsEmails | array of string | Lista de e-mails para notificação de venda |
| nfseDescription | string | Descrição para NFSe. Depende de configuração, módulo ou versão do sistema |
| receiptDescription | string | Descrição para recibo. Depende de configuração, módulo ou versão do sistema |

#### Response

Mesmo modelo de dados retornado em [GET /product/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#1c0ceb76-9206-439f-90e3-6367611f6bd5)


### `DELETE /product/:id`

Exclusão de um serviço/item no Conexa.

> Obs.: É necessário que o serviço/item esteja desativado para poder ser excluído!


## Invoicing Method

### `GET /invoicingMethod/:id`

Recuperação dos dados de um Meio de Faturamento na Conexa.

### Response:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| invoicingMethodId | integer | ID do meio de faturamento | Todos |
| companyId | integer | ID da unidade | Todos |
| name | string | Nome do meio de faturamento | Todos |
| type | string | Tipo do meio de faturamento, podendo ser: **others** ou **billet** | Todos |
| isActive | boolean | Flag se o meio de faturamento está ativo | Todos |


### `GET /invoicingMethods`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1,2,3 | não |
| `companyId[]` | 3 | não |
| `isActive` | 1 | não |
| `type` | others | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Meios de Faturamento.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Meios de Faturamento contendo o mesmo modelo de dados presente em [GET /invoicingMethod/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#e5251ee1-e594-435e-927c-540548370278) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Receiving Method

### `GET /receivingMethod/:id`

Recuperação dos dados do Meio de Recebimento.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| receivingMethodId | integer | ID do meio de recebimento |
| name | string | Nome do meio de recebimento |
| maxInstallments | integer | Número máximo de parcelas |
| creditDays | integer | Tempo para crédito em dias |
| isInstallmentFee | boolean | Se a tarifa é parcelada |
| transactionFee | decimal | Tarifa por transação |
| transactionRate | decimal | Taxa percentual sobre o valor da transação |
| accountId | integer | ID da conta atribuída |
| costCenterId | integer | ID do centro de custo da despesa |
| billCategoryId | integer | ID da categoria da despesa |
| billSubcategoryId | integer | ID da subcategoria da despesa |
| paymentMethodId | integer | ID do meio de pagamento |
| supplierId | integer | ID do fornecedor |
| isActive | boolean | Se o meio de recebimento está ativo |
| createdAt | string | Data de criação do meio de recebimento. Padrão ISO 8601 (Y-m-dTH:i:sP) |
| updatedAt | string/null | Data de criação do meio de recebimento. Padrão ISO 8601 (Y-m-dTH:i:sP) |


### `GET /receivingMethods`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 10,68,69 | não |
| `accountId[]` | 15 | não |
| `costCenterId[]` | 11 | não |
| `paymentMethodId[]` | 2 | não |
| `name` | pix | não |
| `maxInstallments` | 6 | não |
| `creditDays` | 0 | não |
| `isInstallmentFee` | 1 | não |
| `transactionFee` | 2.99 | não |
| `transactionRate` | 0.5 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Meios de Recebimento.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Meios de Recebimento contendo o mesmo modelo de dados presente em [GET /receivingMethod/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#ef28c6b7-9e92-415a-8232-03a18aa4d069) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Payment Method

### `GET /paymentMethod/:id`

Recuperação dos dados do Meio de Recebimento.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| paymentMethodId | integer | ID do meio de pagamento |
| name | string | Nome do meio de pagamento |
| maxInstallments | integer | Número máximo de parcelas |
| accountId | integer/null | ID da conta atribuída ao meio de pagamento |
| isActive | boolean | Indica se o meio de pagamento está ativo |
| createdAt | string | Data-hora de criação. Padrão ISO 8601 (Y-m-d\\TH:i:sP) |
| updatedAt | string/null | Data-hora da última atualização. Padrão ISO 8601 (Y-m-d\\TH:i:sP) |


### `GET /paymentMethods`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1,2,3 | não |
| `accountId[]` | 28 | não |
| `name` | pix | não |
| `maxInstallments` | 12 | não |
| `isActive` | 1 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Meios de Pagamento.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Meios de Pagamento contendo o mesmo modelo de dados presente em [GET /paymentMethod/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#e6ea65ab-e8f2-4d48-a481-f3dcf1d15112) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Charge

### `POST /charge`

**Corpo de exemplo:**

```json
{
    "salesIds": [188087, 188088],
    "invoicingMethodId": 2,
    "dueDate": "2024-12-01",
    "notes": "Lorem ipsum eget morbi"
}
```

Criação de uma cobrança avulsa no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| salesIds | array of integer | IDs das Vendas a serem faturadas. Informe apenas vendas pertencentes a um único cliente. | Sim |
| invoicingMethodId | integer | ID do Meio de Faturamento a ser utilizado | Não, meio de faturamento do cliente por padrão |
| dueDate | string | Data de vencimento da cobrança. Formato: **yyyy-MM-dd** | Não, data atual por padrão |
| notes | string | Observações da cobrança | Não |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da cobrança criada |


### `GET /charge/:id`

Recuperação da cobrança dado o seu ID. Abaixo exibimos uma tabela dos possíveis valores que será retornado nos campos.

> ⚠ Fique atento ao produto do seu sistema. Há campos que não serão retornados! 
  

### Response:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| chargeId | integer | ID da cobrança | Todos |
| companyId | integer | ID da unidade | Todos |
| customerId | integer | ID do cliente | Todos |
| accountId | integer | ID da conta | Todos |
| receivingMethod | string/null | Nome do meio de recebimento configurado | Todos |
| type | string | Tipo. Podendo ser: **loose**, **contractual**, **returnableDeposit**, **contractualPlan** ou **contractualServices** | Todos |
| status | string | Status. Podendo ser: **unpaid**, **paid**, **negotiated**, **generatedByNegotiation**, **cancelled**, **denied**, **thirdPartyCompany**, **protested**, **juridical** ou **excluded** | Todos |
| origin | string | Origem do faturamento. Podendo ser: **default**, **onlineHiring** ou **invoicing** | Todos |
| amount | decimal | Valor | Todos |
| currentAmount | deciaml | Valor atual considerando juros e multa | Todos |
| rawAmount | decimal | Valor bruto | Todos |
| paidAmount | decimal | Valor pago | Todos |
| installmentNumber | integer | Número da parcela (caso a cobrança seja parcelada) | Todos |
| totalInstallmentsAmount | integer | Total da quantidade de parcelas (caso a cobrança seja parcelada) | Todos |
| fatherChargeId | integer | Id da cobrança pai | Todos |
| originalChargeId | integer | Id da cobrança original | Todos |
| dueDate | string | Data de vencimento. Formato: **yyyy-MM-dd** | Todos |
| paymentDate | string | Data de quitação. Formato: **yyyy-MM-dd** | Todos |
| competenceDate | string | Data de competência. Formato: **yyyy-MM-dd** | Todos |
| customerViews | integer | Número visualizações da cobrança pelo cliente | Todos |
| hasISSRetention | boolean | Identificação se o cliente retém ISS | Todos |
| ISSAmount | decimal | Valor correspondente da retenção de ISS do cliente | Todos |
| notes | string | Observações | Todos |
| taxInvoiceNumber | integer/null | Número da Nota Fiscal de Serviço emitada (caso exista) | Todos |
| chargeUrl | string | URL da fatura | Todos |
| billetDigitableLine | string | Linha digitável do boleto (caso a cobrança foi faturada por um boleto) | Todos |
| billetUrl | string | URL do PDF do boleto | Todos |
| salesIds | array | Ids das vendas faturadas | Todos |
| createdAt | string | Data de emissão. Formato W3C (**Y-m-d\\TH:i:sP**) | Todos |
| updatedAt | string | Data da última atualização. Formato W3C (**Y-m-d\\TH:i:sP**) | Todos |
| discountAmount | decimal | Valor de desconto na cobrança | Todos |
| paymentDiscountAmount | decimal | Valor de desconto na quitação | Todos |
| conditionalDiscount | string | Resumo do desconto condicional configurado | Todos |
| conditionalDiscountFixedAmount | decimal | Valor fixado do desconto condicional | Todos |
| conditionalDiscountPercentage | decimal | Porcentagem do desconto condicional | Todos |
| conditionalDiscountType | string | Tipo de desconto condicional. Podendo ser: **fixed** ou **percentage** | Todos |
| conditionalDiscountDate | string | Data limite para o desconto condicional. Formato: **yyyy-MM-dd** | Todos |
| cancelDate | string | Data de cancelamento da cobrança. Formato: **yyyy-MM-dd** | Todos |
| receiptAmount | decimal | Valor da Fatura/Recibo | Conexa Coworking |
| rawReceiptAmount | decimal | Valor bruto da Fatura/Recibo | Conexa Coworking |
| receiptDescription | string | Descrição adicional a Fatura/Recibo | Conexa Coworking |
| receiptCode | string | Código da Fatura/Recibo | Conexa Coworking |

- Caso deseje obter o valor de desconto concedida à cobrança, basta subtrair o valor bruto (`rawAmount`) pelo valor da cobrança (`amount`);
    
- Caso deseje obter o valor de desconto concedido na quitação da cobrança, basta subtrair o valor pago (`paidAmount`) pelo valor da cobrança (`amount`) ou pelo valor atual da cobrança (`currentAmount`) se existir juros e multa.


### `GET /charges`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 300461,300456 | não |
| `companyId[]` | 3,5 | não |
| `customerId[]` | 450,216 | não |
| `status` | unpaid | não |
| `dueDateFrom` | 2024-01-11 | não |
| `dueDateTo` | 2024-05-31 | não |
| `competenceDateFrom` | 2024-05-27 | não |
| `competenceDateTo` | 2024-05-27 | não |
| `paymentDateFrom` | 2024-05-01 | não |
| `paymentDateTo` | 2024-05-27 | não |
| `tagId[]` | 3 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Cobranças.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Cobranças contendo o mesmo modelo de dados presente em [GET /charge/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#33af73f3-8af8-4749-a217-dc735495f966) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


### `PATCH /charge/settle/:id`

**Corpo de exemplo:**

```json
{
    "settlementDate": "2024-11-28",
    "receivingMethod": {
        "id": 53,
        "installmentsQuantity": 3
    },
    "accountId": 1,
    "paidAmount": 40,
    "sendEmail": false
}
```

Quitação manual de uma cobrança no sistema Conexa.

|  | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| settlementDate | string | Data de quitação da Cobrança. Formato: **yyyy-MM-dd** | Sim |
| receivingMethod | object | Objeto contendo os detalhes relacionados ao Meio de Recebimento da quitação | Sim |
| receivingMethod.id | integer | ID do Meio de Recebimento | Sim |
| receivingMethod.installmentsQuantity | integer | Quantidade de parcelas da quitação | Sim |
| accountId | integer | ID da Conta de recebimento vinculada a Cobrança | Sim |
| paidAmount | decimal | Valor pago | Não, valor da cobrança (sem juros) por padrão |
| sendEmail | boolean | Se deve ser enviado um email de confirmação de quitação ao cliente | Não, falso por padrão |


### `GET /charge/pix/:id`

Retorna o Pix gerado no Conexa para o ID da cobrança informado.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| copyPasteCode | string | Código "copia e cola" do Pix para pagamento |
| qrCode | string | Imagem em base64 do QR Code para pagamento |

> A validade do Pix corresponde ao dia de vencimento da cobrança, até às 23:59:59. Caso o endpoint seja consultado após essa data, o sistema atualizará automaticamente o Pix — em conjunto com a plataforma integradora — e retornará uma nova versão, com os valores atualizados (incluindo eventuais juros e multa) e validade estendida até o final do dia atual (23:59:59). Dessa forma, é recomendado que a aplicação consumidora sempre consulte a API antes de exibir, garantindo que os dados do Pix estejam sempre atualizados.


## Credit Card

### `POST /creditCard`

**Corpo de exemplo:**

```json
{
    "customerId": 450,
    "number": "3481 273342 18775",
    "name": "Luke Skywalker",
    "expirationDate": "04/25",
    "cvc": "4692",
    "brand": null,
    "default": true,
    "enableRecurring": true
}
```

Cadastro do cartão de crédito do cliente no sistema Conexa, através da Cielo.

**Obs.: os dados importantes do cartão (número e CVC) ficam armazenados somente na Cielo de forma criptografada.**

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| customerId | integer | ID do cliente | Sim |
| number | string | Número do cartão de crédito | Sim |
| expirationDate | string | Data de expiração do cartão. Formato: **MM/yy** | Sim |
| cvc | string | Card Verification Code ou Card Verification Value (CVV) | Sim |
| name | string | Nome impresso no cartão | Sim |
| brand | string/null | Nome da bandeira do cartão | Não |
| default | boolean/null | Flag indicadora do cartão principal de pagamento do cliente \[1\] | Não |
| enableRecurring | boolean/null | Flag indicadora de recorrência automática ativa \[2\] | Não |

\[1\] Se for informado `true` em um novo cadastro do mesmo cliente, esse novo cartão passará a ser o padrão.  
\[2\] Se for informado `false` em um novo cadastro do mesmo cliente, a recorrência automática será desativada para o cliente.

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do cartão regsitrado |


## Bill

### `POST /bill`

**Corpo de exemplo:**

```json
{
    "companyId": 3,
    "dueDate": "2024-10-01",
    "amount": 15.99,
    "costCenters": [
        {
            "id": 1,
            "percentage": 100
        }
    ],
    "subcategoryId": 1,
    "supplierId": 1,
    "description": "Lorem ipsum dolor sit amet, consectetuer adipiscing elit.",
    "accountId": 15,
    "documentDate": "2024-09-15",
    "competenceDate": "2024-10-01",
    "documentNumber": "155687841324849214",
    "digitableLine": "00000.00000 00000.000000 00000.000000 0 00000000000000",
    "cac": {
        "isIncluded": true,
        "percentage": 30
    }
}
```

Criação de uma despesa avulsa no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** | **Conexa's Product** |
| --- | --- | --- | --- | --- |
| companyId | integer | ID da unidade | Sim | Todos |
| subcategoryId | integer | ID da subcategoria da despesa | Sim | Todos |
| accountId | integer | ID da conta a qual a despesa será associada | Sim | Todos |
| dueDate | string | Data de vencimento da despesa. Formato: **yyyy-MM-dd** | Sim | Todos |
| amount | decimal | Valor da despesa | Sim | Todos |
| costCenters | array of objects | Centros de custo vinculados a despesa. Atualmente, é permitido o preenchimento de apenas um objeto. | Sim | Todos |
| costCenters\[\].id | integer | ID do centro de custo | Sim | \- |
| costCenters\[\].percentage | decimal | Percentual do centro de custo relativo à despesa | Sim | \- |
| cac | object | Detalhes da inclusão da despesa no CAC. Atualmente, é permitido o preenchimento de apenas um objeto. | Sim | Todos |
| cac.isIncluded | boolean | Sinaliza se a despesa será inclusa no CAC | Sim | \- |
| cac.percentage | decimal | Percentual a ser considerado no CAC relativo ao valor da despesa | Sim (caso a despesa seja inclusa no CAC) | \- |
| supplierId | integer | ID do fornecedor que a despesa será associada | Não | Todos |
| description | string | Descrição da despesa | Não | Todos |
| documentDate | string | Data de emissão do documento. Formato: **yyyy-MM-dd** | Não | Todos |
| competenceDate | string | Data de competência do documento (utilizada no relatório DRE). Formato: **yyyy-MM-dd** | Não | Todos |
| documentNumber | string | Número do documento | Não | Todos |
| digitableLine | string | Linha digitável do boleto | Não | Todos |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da despesa criada |


### `GET /bill/:id`

Recuperação dos dados de Despesa. Abaixo exibimos uma tabela do que será retornado dado o tipo de versão do software Conexa.

### Response:

| **Index** | **Type** | **Description** | **Conexa's Product** |
| --- | --- | --- | --- |
| billId | integer | ID da despesa | Todos |
| parentBillId | integer | ID da despesa pai (caso de quitação parcial) | Todos |
| originalBillId | integer | ID da despesa original (caso de quitação parcial) | Todos |
| chargeId | integer | ID da cobrança que gerou a despesa | Todos |
| amount | decimal | Valor da despesa | Todos |
| paidAmount | decimal | Valor da despesa quitada | Todos |
| dueDate | string | Data de vencimento. Formato: **Y-m-d** | Todos |
| competenceDate | string | Data de competência. Formato: **Y-m-d** | Todos |
| paymentDate | string | Data da quitação. Formato: **Y-m-d** | Todos |
| documentDate | string | Data da emissão. Formato: **Y-m-d** | Todos |
| status | string | Status, podendo ser: **unpaid**, **cancelled**, **paid**, **received** ou **scheduled** | Todos |
| type | string | Tipo da despesa, podendo ser: **fixed** ou **loose** | Todos |
| description | string | Descrição da despesa | Todos |
| digitableLine | string | Linha digital do boleto da despesa | Todos |
| documentNumber | string | Número do documento da despesa | Todos |
| installmentId | integer | ID da parcela (caso seja uma despesa parcelada) | Todos |
| installmentNumber | integer | Número da parcela (caso seja uma despesa parcelada) | Todos |
| cac | object | Objeto referente ao CAC | Todos |
| cac.isIncluded | boolean | Flag se a despesa foi incluída no CAC | \- |
| cac.percentage | decimal | Valor cheio da porcentagem | \- |
| isReconciled | boolean | Flag se a despesa está conciliada | Todos |
| recurrentBillId | integer | ID da despesa fixa ou recorrente | Todos |
| paymentMethodId | integer | ID do meio de pagamento | Todos |
| companyId | integer | ID da unidade | Todos |
| supplierId | integer | ID do fornecedor | Todos |
| accountId | integer | ID da conta | Todos |
| categoryId | integer | ID da categoria | Todos |
| subcategoryId | integer | ID da subcategoria | Todos |
| costCenters | array of objects | lorem_ipsun_dolor | Todos |
| costCenters\[\].id | integer | ID do centro de custo | \- |
| costCenters\[\].percentage | decimal | Valor cheio da porcentagem | \- |
| createdAt | string | Data de cadastro. Formato: W3C (**Y-m-d\\TH:i:sP**) | Todos |
| updatedAt | string | Data da última modificação. Formato: W3C (**Y-m-d\\TH:i:sP**) | Todos |


### `GET /bills`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1220,1221,1222 | não |
| `companyId[]` | 3 | não |
| `supplierId` | null | não |
| `categoryId` | 2 | não |
| `subcategoryId` | 50,24 | não |
| `status` | paid | não |
| `dueDateFrom` | 2024-10-01 | não |
| `dueDateTo` | 2024-10-31 | não |
| `issueDateFrom` | 2024-08-31 | não |
| `issueDateTo` | 2024-08-31 | não |
| `competenceDateFrom` | 2024-09-01 | não |
| `competenceDateTo` | 2024-09-30 | não |
| `paymentDateFrom` | 2024-07-20 | não |
| `paymentDateTo` | 2024-07-30 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Despesas.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Despesas contendo o mesmo modelo de dados presente em [GET /bill/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#b3697b86-2d7c-4b01-bd7d-6cfe82e51c0d) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Bill Category

### `GET /billCategory/:id`

Recuperação dos dados da Categoria da Despesa.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| billCategoryId | integer | ID da categoria de despesa |
| name | string | Nome da categoria de despesa |
| isActive | boolean | Indica se a categoria de despesa está ativa |
| subcategories | array of objects | Array de objetos com as subcategorias da |
| subcategories\[\].id | integer | ID da subcategoria |
| subcategories\[\].name | string | Nome da subcategoria |


### `GET /billCategories`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1,2,3 | não |
| `name` | IMPOSTO E TAXAS | não |
| `isActive` | 1 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Categorias de Despesa.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Categorias de Despesa contendo o mesmo modelo de dados presente em [GET /billCategory/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#fbcfc3c6-a280-4ab3-9af4-be139e44ee12) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Bill Subcategory

### `GET /billSubcategory/:id`

Recuperação dos dados da Subcategoria da Despesa.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| billSubcategoryId | integer | ID da subcategoria de despesa |
| name | string | Nome da subcategoria de despesa |
| billCategoryId | integer | ID da categoria de despesa vinculada |
| dreCategory | string/null | Categoria do DRE¹ |
| accountingCode | integer/null | Código para o software contábil. Retorna o código sintético configurado ou o código individual da subcategoria |
| isActive | boolean | Indica se está ativo |

¹ Demonstrativo de Resultados do Exercício (DRE) vinculada à subcategoria, tendo os possíveis valores: **"Não exibir no DRE"**, **"Custo dos Serviços Prestados"**, **"Custo das Vendas de Produtos"**, **"Impostos Sobre Vendas"**, **"Despesas Administrativas"**, **"Despesas Comerciais"**, **"Despesas Financeiras"**, **"Despesas Operacionais"**, **"Empréstimos e Dívidas"**, **"Investimentos em Imobilizado"**, **"Outras Despesas Não Operacionais"**.


### `GET /billSubcategories`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 3,4 | não |
| `name` |    Retirada Pró-labore | não |
| `billCategoryId[]` | 1,2 | não |
| `dreCategory` | Não exibir no DRE | não |
| `isActive` | 1 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Subcategorias de Despesa.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Subcategorias de Despesa contendo o mesmo modelo de dados presente em [GET /billSubcategory/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#8e49f22b-fc21-4843-b0e3-118b6475391d) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Supplier

### `POST /supplier`

**Corpo de exemplo:**

```json
{
    "name": "Fake Company ABC",
    "fieldOfActivity": "Indústria",
    "notes": "Uma empresa que produz droides de batalha, incluindo os Droidekas",
    "cellNumber": "11988997766",
    "website": "fakeabc.app",
    "naturalPerson": {
        "cpf": "516.079.209-05",
        "rg": "30.340.779-7",
        "issuingAuthority": "SSP BA"
    },
    "legalPerson": {
        "legalName": "Fake Company ABC Ltda",
        "cnpj": "99.557.155/0001-90",
        "stateInscription": "4569",
        "municipalInscription": "145263"
    },
    "address": {
        "zipCode":"13058-111", 
        "state":  "SP",
        "city": "Campinas",
        "street": "Rua Alziro Arten",
        "number": "443",
        "neighborhood": "Conjunto Habitacional Parque da Floresta",
        "additionalDetails": "Sala 4, Térreo"
    },
    "phones": ["(75) 2222-5455", "(75) 3885-3355"],
    "emails" : ["admin@fakeabc.com", "crm@fakeabc.com"],
    "contactPersonNames": ["Maria", "José", "João"]
}
```

Criação de um fornecedor no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| name | string | Nome ou nome fantasia | Sim |
| fieldOfActivity | string | Ramo de atividade | Não |
| notes | string | Observações | Não |
| cellNumber | string | Celular | Não |
| website | string | Site | Não |
| naturalPerson | object | Dados referentes a pessoa física | Não |
| naturalPerson.cpf | string | CPF | Não |
| naturalPerson.rg | string | RG | Não |
| naturalPerson.issuingAuthority | string | Órgão expedidor | Não |
| legalPerson | object | Dados referentes a pessoa jurídica | Não |
| legalPerson.legalName | string | Razão social | Não |
| legalPerson.cnpj | string | CNPJ | Não |
| legalPerson.stateInscription | string | Inscrição estadual | Não |
| legalPerson.municipalInscription | string | Inscrição municipal | Não |
| address | object | Endereço do fornecedor | Não |
| address.zipCode | string | CEP | Não |
| address.state | string | Sigla do estado (UF) | Não |
| address.city | string | Cidade | Não |
| address.street | string | Logradouro | Não |
| address.number | string | Número | Não |
| address.neighborhood | string | Bairro | Não |
| address.additionalDetails | string | Complemento | Não |
| phones | array of string | Lista com os telefones de contato | Não |
| emails | array of string | Lista com e-mails de contato | Não |
| contactPersonNames | array of string | Lista de pessoas de contato | Não |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do fornecedor criado |


### `GET /supplier/:id`

Recuperação dos dados de Fornecedor.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| supplierId | integer | ID do fornecedor |
| name | string | Nome ou nome fantasia |
| fieldOfActivity | string/null | Ramo de atividade |
| notes | string/null | Observações |
| cellNumber | string/null | Número de celular |
| website | string/null | Website |
| type | string/null | Tipo do fornecedor, podendo ser: **legalPerson** (pessoa jurídica) ou **naturalPerson** (pessoa física) |
| naturalPerson | object/null | Informações da pessoa física (se aplicável) |
| naturalPerson.cpf | string/null | CPF |
| naturalPerson.rg | string/null | RG |
| naturalPerson.issuingAuthority | string/null | Órgão expedidor |
| legalPerson | object/null | Informações da pessoa jurídica (se aplicável) |
| legalPerson.legalName | string/null | Razão social |
| legalPerson.cnpj | string/null | CNPJ |
| legalPerson.stateInscription | string/null | Inscrição estadual |
| legalPerson.municipalInscription | string/null | Inscrição municipal |
| address | object | Endereço |
| address.zipCode | string/null | CEP |
| address.city | string/null | Cidade |
| address.state | string/null | Estado |
| address.street | string/null | Rua |
| address.number | string/null | Número |
| address.neighborhood | string/null | Bairro |
| address.additionalDetails | string/null | Complemento |
| phones | array/null | Lista de números de telefone |
| emails | array/null | Lista de endereços de e-mail |
| contactPersonNames | array/null | Lista de nomes de pessoas de contato |
| origin | string | Origem do cadastro |
| isActive | boolean | Se o fornecedor está ativo |
| createdAt | string | Data de criação do fornecedor. Padrão ISO 8601 (Y-m-dTH:i:sP) |
| updatedAt | string/null | Data de atualização do fornecedor. Padrão ISO 8601 (Y-m-dTH:i:sP) |


### `GET /suppliers`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1,7 | não |
| `name` | Conexa | não |
| `legalName` | Webfeira | não |
| `cnpj` | 17992846000158 | não |
| `cpf` | 994.735.490-32 | não |
| `email` | lorem.ipsun@dolor.cirius | não |
| `isActive` | 1 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Fornecedores.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Fornecedores contendo o mesmo modelo de dados presente em [GET /supplier/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#f33aeefb-ca28-45ac-820b-2f9ef3d6c8e7) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Extra Field

### `POST /extraField`

**Corpo de exemplo:**

```json
{
    "name": "Filiação",
    "type": "customer",
    "showCustomerService": false
}
```

Criação de um Campo Extra no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| name | string | Nome do campo extra (máx. 255 caracteres) | Sim |
| type | string | Tipo do campo extra. Valores aceitos: `customer`, `plan`, `contract`. Padrão: `customer` | Sim |
| showCustomerService | boolean | Exibir campo nas informações de atendimento. Permitido apenas quando `type` for `customer` | Não |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do campo extra criado |


### `GET /extraField/:id`

Recuperação dos dados de um Campo Extra.

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do campo extra |
| name | string | Nome do campo extra |
| type | string | Tipo do campo extra: `customer`, `plan` ou `contract` |
| showCustomerService | boolean | Indica se o campo é exibido nas informações de atendimento |
| createdAt | string | Data de criação. Formato: W3C (**Y-m-d\\TH:i:sP**) |
| updatedAt | string/null | Data de atualização. Formato: W3C (**Y-m-d\\TH:i:sP**) |


### `GET /extraFields`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1,7 | não |
| `name` | TIpo | não |
| `type` | contract | não |
| `showCustomerService` | 1 | não |
| `limit` | 10 | não |
| `offset` | 0 | não |

Listagem paginada de Campos Extras.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro** **`limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**. 
  

#### Response

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Campos Extra com o mesmo modelo de dados de `GET /extraField/:id` | \- |
| pagination | object | Informações de paginação | \- |
| pagination.limit | integer | Quantidade de itens retornados | \- |
| pagination.offset | integer | Deslocamento utilizado | \- |
| pagination.hasNext | boolean | Indica se há mais itens além dos retornados | \- |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


### `PATCH /extraField/:id`

**Corpo de exemplo:**

```json
{
    "name": "Filiação do cliente",
    "type": "contract",
    "showCustomerService": true
}
```

Atualização parcial de um Campo Extra no sistema Conexa.

  > Apenas os campos enviados no body serão atualizados. Campos ausentes mantêm o valor atual.
  > O campo `showCustomerService` só pode ser enviado quando o `type` for `customer`.

#### Body

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| name | string | Nome do campo extra (máx. 255 caracteres) | Não |
| type | string | Tipo do campo extra. Valores aceitos: `customer`, `plan`, `contract` | Não |
| showCustomerService | boolean | Exibir campo nas informações de atendimento. Permitido apenas quando `type` for `customer` | Não |

#### Response

Retorna os dados atualizados do campo extra, com o mesmo modelo de dados de `GET /extraField/:id`.


### `DELETE /extraField/:id`

Exclusão de um Campo Extra no sistema Conexa.

> ⚠ A exclusão é permanente. Todos os valores desse campo extra vinculados a clientes, planos ou contratos serão removidos junto.

#### Response

Retorna `204 No Content` em caso de sucesso.


## Cost Center

### `GET /costCenter/:id`

Recuperação dos dados do Centro de Custo.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| costCenterId | integer | ID do centro de custo |
| name | string | Nome |
| createdAt | string | Data-hora de criação. Padrão ISO 8601 (Y-m-d\\TH:i:sP) |
| updatedAt | string/null | Data-hora da última atualização. Padrão ISO 8601 (Y-m-d\\TH:i:sP) |


### `GET /costCenters`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 1,2,3,4 | não |
| `name` | CC Cielo | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Centros de Custo.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Centros de Custo contendo o mesmo modelo de dados presente em [GET /costCenter/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#31a4a637-c3e8-40c7-884c-d5b68e6abc88) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Account

### `GET /account/:id`

Recuperação dos dados de Conta Bancária.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da conta |
| companyId | integer | ID da empresa proprietária da conta |
| name | string | Nome da conta |
| movementBlockUntil | string/null | Data até quando a movimentação está bloqueada. Formato: **YYYY-MM-DD** |
| automaticBankReconciliation | boolean | Indica se possui conciliação bancária automática |
| accountingCode | integer/null | Código contábil para integração com software contábil |
| isActive | boolean | Status ativo/inativo da conta |
| syncedAt | string/null | Data-hora da última sincronização. Padrão ISO 8601 (Y-m-dTH:i:sP) |
| createdAt | string | Data-hora de criação. Padrão ISO 8601 (Y-m-dTH:i:sP) |
| updatedAt | string/null | Data-hora da última atualização. Padrão ISO 8601 (Y-m-dTH:i:sP) |


### `GET /accounts`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 3,7,22 | não |
| `companyId[]` | 4 | não |
| `name` | Caixa | não |
| `isActive` | 0 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Contas.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Contas contendo o mesmo modelo de dados presente em [GET /account/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#8aa6b53f-f82a-4955-bbe4-164e20845464) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Company

### `GET /company/:id`

Recuperação dos dados de uma Unidade no sistema Conexa.

### Response:

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| tradeName | string | Nome fantasia |
| legalName | string | Razão social |
| cnpj | string | CNPJ (somente números) |
| address | object | Objeto de endereço |
| address.zipCode | string | Código de Endereçamento Postal (CEP) |
| address.street | string | Logradouro |
| address.number | string | Número |
| address.neighborhood | string | Bairro |
| address.additionalDetails | string | Complemento do endereço |
| address.city | string | Nome da cidade |
| address.state | object | Objeto do estado |
| address.state.id | string | ID do estado |
| address.state.name | string | Nome do estado |
| address.state.abbreviation | string | Sigla do estado |
| phone | string | Número de telefone |
| notificationEmails | array of string | Lista de e-mails para notificações |
| backupEmails | array of string | Lista de e-mails de backup |
| timeZone | string | Fuso horário (ex.: "America/Sao_Paulo") |
| notes | string | Observações sobre a unidade |
| active | boolean | Indica se a unidade está ativa |
| createdAt | string | Data e hora de cadastro. Formato: W3C (**Y-m-d\\TH:i:sP**) |
| updatedAt | string | Data e hora da última modificação. Formato: W3C (**Y-m-d\\TH:i:sP**) |


### `GET /companies`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 3,4 | não |
| `tradeName` | Modelo | não |
| `legalName` | Modelo Ltda | não |
| `cnpj` | 17.992.846/0001-58 | não |
| `city` | Feira de Santana | não |
| `active` | 1 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Unidades.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Unidades contendo o mesmo modelo de dados presente em [GET /company/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#36bc9f4d-4494-4d04-a93c-b43012bb3448) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Service Category

### `GET /serviceCategory/:id`

Recuperação dos dados de Categoria de Serviço.

### Response:

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| serviceCategoryId | int | ID do registro | Sim |
| name | string | Nome da categoria | Sim |
| companies | array of objects | Unidades às quais a categoria pertence | Sim |
| companies\[\].id | int | ID da unidade | Sim |
| companies\[\].name | string/null | Nome fantasia (preferencialmente) ou razão social da unidade | Sim |
| description | string/null | Descrição da categoria | Sim |
| municipalIbsPercentage | decimal | Porcentagem do IBS municipal (Novo Imposto da reforma tributária) | Sim |
| stateIbsPercentage | decimal | Porcentagem do IBS Estadual (Novo Imposto da reforma tributária) | Sim |
| cbsPercentage | decimal | Porcentagem do CBS (Novo Imposto da reforma tributária) | Sim |
| cnaeCode | string/null | Código CNAE - Classificação Nacional de Atividades Econômicas | Sim |
| nbsCode | string/null | Código NBS - Nomenclatura Brasileira de Serviços | Sim |
| municipalServiceCode | string/null | Código de Serviço do Município | Sim |
| municipalTaxCode | string/null | Código de Tributação do Município | Sim |
| operationIndicatorCode | string/null | Código do Indicador de Operação (CIndOp) | Sim |
| taxClassificationCode | string/null | Código de Classificação Tributária (cClassTrib) | Sim |
| taxSituationCode | string/null | Código de Situação tributária (CST) - Geralmente composto pelos 3 primeiros dígitos do cClassTrib | Sim |
| isActive | bool | Indica se a categoria está ativa ou não | Sim |
| municipalBenefitCode | string/null | Código de Benefício Municipal do Portal Nacional | Se o município utiliza a NFSe Nacional |
| commissionPercentage | decimal | Porcentagem de comissão | Se o módulo de Comissão estiver ativado |
| nfsePercentage | decimal | Porcentagem da Nota Fiscal | Depende de configuração do sistema |
| receiptPercentage | decimal | Porcentagem do Recibo | Depende de configuração do sistema |
| taxDeductions | object | Alíquotas de Impostos | Depende de configuração do sistema |
| taxDeductions.iss | decimal | Alíquota ISS | \- |
| taxDeductions.inss | decimal | Alíquota INSS | \- |
| taxDeductions.pis | decimal | Alíquota PIS | \- |
| taxDeductions.cofins | decimal | Alíquota COFINS | \- |
| taxDeductions.ir | decimal | Alíquota IR | \- |
| taxDeductions.csll | decimal | Alíquota CSLL | \- |
| taxDeductions.irp | decimal | Alíquota IR (empresa pública) | \- |
| taxDeductions.minValueDarf | decimal | Valor Mínimo do DARF | \- |


### `GET /serviceCategories`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 14,15 | não |
| `companyId[]` | 3,4 | não |
| `name` | CS1 | não |
| `city` | rio de janeiro | não |
| `cnaeCode` | 6110803 | não |
| `municipalServiceCode` | 071002 | não |
| `municipalTaxCode` | 03.03 | não |
| `nbsCode` | 118032900 | não |
| `description` | serviços de locação | não |
| `isActive` | 12 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Categorias de Serviço.

Os itens definidos como array podem ter multiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Categorias de Serviço contendo o mesmo modelo de dados presente em [GET /serviceCategory/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#296e68aa-98e6-46bf-a56f-6e1a83db0b9f) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Conexa Coworking › Booking

### `POST /room/booking`

**Corpo de exemplo:**

```json
{
    "customerId": 450,
    "personId": 458,
    "roomId": 	4140,
    "date": "2025-12-25",
    "startTime": "08:00",
    "finalTime": "16:00",
    "notes": "Atualização observações",
    "sendCustomerEmail": true,
    "sendRequesterEmail": true,
    "visitors": [
        {
            "name": "Convidado Fake",
            "email": "convidadofake1@gmail.com"
        }
    ]
}
```

Cadastro de uma **Reseva de Sala de Reunião** no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| customerId | integer | ID do cliente |
| personId | integer | ID do solicitante |
| roomId | integer | ID da sala de reunião |
| date | string | Data da reserva. Formato: **yyyy-MM-dd** |
| startTime | string | Hora de início da reserva. Formato **HH:mm** |
| finalTime | string | Hora de término da reserva. Formato **HH:mm** |
| notes | string | Observações |
| sendCustomerEmail | boolean | Flag para envio do e-mail de atualização da reserva para o cliente |
| sendRequesterEmail | boolean | Flag para envio do e-mail de atualização da reserva para o solicitante |
| visitors | array of objects | Lista de convidados da reserva |
| visitors[].name | string | Nome do convidado |
| visitors[].email | string | E-mail do convidado |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID da reserva |


### `GET /room/booking/:id`

Recuperação dos dados de uma Reserva de Sala na Conexa.

### Response

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| bookingId | integer | ID único da reserva | Sim |
| saleId | integer | ID da venda associada | Sim |
| place | object | Objeto contendo informações do local/sala | Sim |
| place.id | integer | ID da sala | Sim |
| place.name | string | Nome da sala | Sim |
| customerId | integer | ID do cliente responsável pela reserva | Sim |
| personId | integer/null | ID da pessoa responsável pela reserva | Sim |
| idRecurringBooking | integer/null | ID da reserva recorrente (se aplicável) | Sim |
| status | string | Status da reserva, podendo ser: **'notBilled'**, **'billed'**, **'billedCancelled'**, **'partiallyPaid'**, **'paid'**, **'cancelled'**, **'deductedFromQuota'** | Sim |
| notes | string/null | Observações/anotações da reserva | Sim |
| createdAt | string | Data e hora de criação da reserva (ISO 8601) | Sim |
| updatedAt | string | Data e hora da última atualização (ISO 8601) | Sim |
| completed | boolean | Indica se a reserva foi concluída | Sim |
| canceled | boolean | Indica se a reserva foi cancelada | Sim |
| cancellationReason | string/null | Motivo do cancelamento (se aplicável) | Sim |
| deviceAccessReleased | boolean | Indica se o acesso por dispositivo foi liberado | Sim |
| isOnlinePayment | boolean | Indica se o pagamento foi realizado online | Sim |
| isBilled | boolean | Indica se a reserva foi faturada | Sim |
| startTime | string | Data e hora de início da reserva (ISO 8601) | Sim |
| finalTime | string | Data e hora de término da reserva (ISO 8601) | Sim |
| visitorPassword | string/null | Senha para visitante (se aplicável) | Sim |
| internetPassword | string/null | Senha para acesso à internet (se aplicável) | Sim |
| settings | object | Objeto com configurações específicas da sala | Não\* |
| settings.temperature | decimal/null | Temperatura configurada para o ambiente (em °C) | Sim |
| settings.roomPassword | string/null | Senha de acesso físico à sala | Sim |
| visitors | array of objects | Lista de objetos dos visitantes da reserva | Sim |
| visitor\[\].id | integer | Identificador único do visitante | Sim |
| visitors\[\].name | string | Nome do visitante | Sim |
| visitors\[\].email | string | E-mail do visitante | Sim |

\* O campo `settings` só é retornado para domínios habilitados no sistema.


### `PATCH /room/booking/:id`

**Corpo de exemplo:**

```json
{
    "personId": 458,
    "roomId": 	4140,
    "date": "2025-12-22",
    "startTime": "08:00",
    "finalTime": "16:00",
    "notes": "Atualização observações",
    "sendCustomerEmail": true,
    "sendRequesterEmail": true,
    "sendVisitorsEmail": true,
    "visitors": [
        {
            "name": "Convidado Fake",
            "email": "convidadofake1@gmail.com"
        }
    ]
}
```

Edição de campos de uma **Reseva de Sala de Reunião** no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| personId | integer | ID do solicitante |
| roomId | integer | ID da sala de reunião |
| date | string | Data da reserva. Formato: **yyyy-MM-dd** |
| startTime | string | Hora de início da reserva. Formato **HH:mm** |
| finalTime | string | Hora de término da reserva. Formato **HH:mm** |
| notes | string | Observações |
| sendCustomerEmail | boolean | Flag para envio do e-mail de atualização da reserva para o cliente |
| sendRequesterEmail | boolean | Flag para envio do e-mail de atualização da reserva para o solicitante |
| sendVisitorsEmail | boolean | Flag para envio do e-mail de atualização da reserva para o convidado |
| visitors | array of objects | Lista de convidados da reserva |
| visitors[].name | string | Nome do convidado |
| visitors[].email | string | E-mail do convidado |

#### Response

Mesmo modelo de dados retornado em [GET /room/booking/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#d87c6ea5-6ebe-4661-9248-cf59b69dd343)


### `PATCH /room/booking/:id/cancel`

Cancela uma Reserva de Sala na Conexa.

### Body

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| cancelSale | boolean | Indicativo se deseja cancelar a reserva e a venda associada. Default: **true** | Não |
| sendEmailCustomer | boolean | Indicativo se deve enviar um e-mail para o cliente. Default: **true** | Não |
| sendEmailRequester | boolean | Indicativo se deve enviar um e-mail para o solicitante. Default: **true** | Não |
| sendEmailVisitors | boolean | Indicativo se deve enviar um e-mail para o convidado. Default: **true** | Não |

#### Response

Mesmo modelo de dados retornado em [GET /room/booking/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#d87c6ea5-6ebe-4661-9248-cf59b69dd343)


### `GET /room/bookings`

**Query:**

| Parâmetro | Exemplo | Obrigatório |
| --- | --- | --- |
| `id[]` | 143063, 142600 | não |
| `companyId[]` | 4,5 | não |
| `customerId[]` | 450,216 | não |
| `roomId[]` | 4140, 4141 | não |
| `isActive` | 0 | não |
| `status` | notBilled | não |
| `bookingDateTimeFrom` | 2025-11-28T00:00:00-03:00 | não |
| `bookingDateTimeTo` | 2025-11-28T23:59:59-03:00 | não |
| `createdAtFrom` | 2025-11-27T08:00:00-03:00 | não |
| `createdAtTo` | 2025-11-28T12:00:00-03:00 | não |
| `limit` | 10 | sim |
| `offset` | 0 | não |

Listagem paginada de Reservas de Sala.

Os itens definidos como array podem ter múltiplos valores atribuídos separados por vírgula.

> **ATENÇÃO:** Para utilizar a nova paginação, é **obrigatório informar o parâmetro `limit`**. Caso não seja informado, a API continuará utilizando o modelo anterior - que será descontinuada em **01 de agosto de 2026**.

### Response:

| **Index** | **Type** | **Description** | **Warn** |
| --- | --- | --- | --- |
| data | array | Lista de Reservas de Sala contendo o mesmo modelo de dados presente em [GET /room/booking/:id](https://documenter.getpostman.com/view/25182821/2s93RZMpcB#d87c6ea5-6ebe-4661-9248-cf59b69dd343) | - |
| pagination | object | Paginação | - |
| pagination.limit | integer | Quantidades de itens retornados | - |
| pagination.offset | integer | Posição inicial da busca | - |
| pagination.hasNext | boolean | Indica se existem mais registros para a próxima página | - |
| pagination.itemPerPage | integer | Quantidades de itens retornados | Deprecated |
| pagination.currentPage | integer | Página atual da requisição | Deprecated |
| pagination.totalPages | integer | Total de páginas existentes | Deprecated |
| pagination.totalItems | integer | Total de itens existêntes (incluindo os listados e não listados na requisição) | Deprecated |


## Conexa Coworking › Check-in

### `POST /checkin`

**Corpo de exemplo:**

```json
{
    "personId": 458,
    "workspaceId": 2582,
    "notes": "Check-in via integração",
    "datetime": "2024-04-23T08:01:00-03:00",
    "checkoutDatetime": "2024-04-23T13:39:48-03:00"
}
```

> ⚠️ Disponível apenas para Conexa Coworking 
  

Registro de Check-In (data e hora atuais) através do ID da pessoa (`personId`) e do ID do espaço de trabalho (`workSpaceId`) no sistema Conexa.

ℹ️ É permitido realizar um Check-In retroativo, porém é necessário informar horário de Check-Out!

#### Body

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| personId | integer | ID da pessoa | Sim |
| workspaceId | integer | ID do espaço de trabalho | Sim |
| notes | string | Observações | Não |
| datetime | string | Data e hora do check-in. Formato: W3C (**Y-m-d\\TH:i:sP**) | Não |
| checkoutDatetime | string | Data e hora do check-out, sendo no mesmo dia que o check-in. Formato: W3C (**Y-m-d\\TH:i:sP**) | Sim, quando `datetime` é informado |


## Conexa Coworking › Check-out

### `POST /checkout`

**Corpo de exemplo:**

```json
{
    "personId": 458,
    "workspaceId": 2582,
    "notes": "Check-out via integração",
    "datetime": "2024-04-25T19:00:00-03:00"
}
```

Registro de Check-Out através do ID da pessoa (`personId`), ID do espaço de trabalho (`workSpaceId`) e da data e hora (`datetime`) no sistema Conexa. Caso não seja informado o `datetime`, será utilizado data e hora atuais.

ℹ️ É permitido realizar um Check-Out pendente, informando a data e horário de Check-Out no parâmetro `datetime`!

#### Body

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| personId | integer | ID da pessoa | Sim |
| workspaceId | integer | ID do espaço de trabalho | Sim |
| datetime | string | Data e hora do check-out. Formato: W3C (**Y-m-d\\TH:i:sP**) | Não |
| notes | string | Observações | Não |


### `POST /room/booking/:id/checkout`

**Corpo de exemplo:**

```json
{
  "sendEmail": true
}
```

Registro de Check-Out de Sala através do ID da reserva (`bookingId`) no sistema Conexa.

#### Body

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| sendEmail | boolean | Flag que envia o checkout por email ao cliente e solicitante (caso exista na reserva) | Não |


## Potential Customer (Em Desenvolvimento)

### `POST /potentialCustomer`

**Corpo de exemplo:**

```json
{
    "companyId": 3,
    "partnerId": 1,
    "contactNames": "João Caio Igor da Silva Neto",
    "name": "Lorem Ipsun Company Ltda",
    "phones": [
        "(75) 2222-3333",
        "75 3885-3344",
        "75988776655"
    ],
    "emails": [
        "lorem.ipsun@company.example.ltda",
        "joao.caio.igor@company.com"
    ],
    "responsibleUserId": 1,
    "statusId": 4,
    "contactMethodId": 2,
    "fieldOfActivityId": 36,
    "interestServicesIds": [
        1,
        2,
        3
    ],
    "website": "https://www.exemplo.com.br",
    "notes": "Cliente interessado em nossos serviços",
    "receiveInformativeEmails": true
}
```

Cadastro de Cliente Potencial (Negociações) do CRM no sistema Conexa.

| **Index** | **Type** | **Description** | **Required** |
| --- | --- | --- | --- |
| companyId | integer | ID da unidade | Sim |
| partnerId | integer | ID do parceiro/origem | Sim |
| contactNames | string | Nome para contato | Sim |
| name | string | Nome da empresa do cliente potencial (máx. 255 caracteres) | Não |
| fieldOfActivityId | integer | ID do ramo de atividade | Não |
| responsibleUserId | integer | ID do usuário (funcionário) responsável | Não |
| phones | array of string | Lista de telefones de contato | Não |
| emails | array of string | Lista de e-mails de contato | Não |
| statusId | integer | ID do status do cliente potencial | Não |
| contactMethodId | integer | ID da forma de contato | Não |
| interestServicesIds | array of integer | Lista de IDs dos serviços de interesse | Não |
| website | string | Site da unidade (máx. 255 caracteres) | Não |
| notes | string | Observações sobre o cliente potencial | Não |
| receiveInformativeEmails | boolean | Flag para receber e-mails informativos | Não |

#### Response

| **Index** | **Type** | **Description** |
| --- | --- | --- |
| id | integer | ID do Cliente Potencial |
