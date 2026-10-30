---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-30
scope_description: "Upload de vídeos (até 10GB, retomável), pré-cadastro como rascunho, armazenamento de objetos, fila e worker de processamento em segundo plano (extração de duração/metadados e thumbnail), URL única por vídeo, streaming e download."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — subprojeto principal. É dono do domínio `videos` (entidade, migration, endpoints que orquestram o upload, endpoints de leitura/stream/download), das integrações com storage e fila, do processo worker em segundo plano e dos novos serviços do Compose (object storage, broker da fila, worker). TD-01 a TD-12 tocam este subprojeto.
- `next-frontend/` — **nenhuma capability de UI nesta fase.** Nenhum bullet da Fase 03 descreve uma tela. As telas de upload, player e download chegam nas Fases 04/05. Mesmo assim, o FE fica sujeito aos TDs **Cross-layer** deste documento (TD-03 protocolo de upload, TD-09 identificador da URL, TD-10 entrega de stream/download). Eles fixam o contrato que o FE vai consumir mais tarde sob o modelo de BFF estrito (`next-frontend-config-base/TD-03`). Nenhum TD exclusivo de FE é aberto aqui.

> Âncoras em outros documentos (já decididas — NÃO reabrir):
> - **Config:** `@nestjs/config` + validação Joi + configs com namespace via `registerAs` (`phase-01-configuracao-base/TD-01..TD-04`). Os novos namespaces `storage`/`queue` e as novas variáveis de ambiente seguem esse padrão.
> - **Auth:** `JwtAuthGuard` customizado e registrado globalmente, com exceção via `@Public()` (`phase-02-auth/TD-02`). Hoje o `@Public()` pula a leitura do token por completo; não existe modo de "auth opcional".
> - **Validação / erros:** DTOs com class-validator (`phase-02-auth/TD-06`); `DomainException` + filtro global com `{ statusCode, error, message }` (`phase-02-auth/TD-07`).
> - **Rate limiting:** `@nestjs/throttler` (`phase-02-auth/TD-08`). Os endpoints de início de upload herdam essa proteção.
> - **Retry em colisão de unique:** `channels.service.ts` repete a operação ao receber o código PG `23505` (implementação de `phase-02-auth/TD-10`). O TD-09 reaproveita esse padrão.
> - **OpenAPI:** `@nestjs/swagger` + `openapi.json` exportado (`openapi-docs-nestjs/TD-01..TD-02`). Os novos endpoints são documentados por ele, e o FE os consome via `next-frontend-openapi-typing`.
> - **BFF estrito no FE:** o navegador nunca chama o NestJS diretamente (`next-frontend-config-base/TD-03`). Isso **não** proíbe tráfego navegador → object storage, que o diagrama C4 já prevê (`Frontend → Object Storage: Streams`).

---

## TD-01: Tecnologia de Fila de Mensagens

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama C4 deixa a "Message Queue" como TBD. O processamento de vídeo (ffprobe + thumbnail em arquivos de até 10GB) precisa rodar fora da requisição HTTP, sobreviver a reinícios da API e ser repetido em falhas transitórias. A escolha adiciona (ou não) um serviço de infraestrutura ao Compose e define a API de produtor/consumidor usada pela API e pelo worker.

**Options:**

### Option A: BullMQ + broker compatível com Redis (`@nestjs/bullmq`)
- Fila de jobs baseada em Redis, com integração oficial do Nest (`BullModule.forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`). Oferece retries com backoff exponencial, `jobId` customizado para deduplicação, jobs atrasados e concorrência por worker.
- **Pros:** Receita oficial do Nest, então a configuração do módulo é idiomática. Retry, backoff e deduplicação (`jobId`/`deduplication`) vêm prontos, e lançar erro no `process()` dispara um retry. Biblioteca madura, bem documentada, funciona com Redis 7 ou Valkey.
- **Cons:** Adiciona um serviço Redis/Valkey ao Compose e ao ambiente de testes. É mais um componente com estado para operar em produção. O Redis 8 tem licença dupla/AGPL, então uma imagem fixada do Redis 7.x ou do Valkey simplifica a questão de licença.

### Option B: pg-boss (fila sobre o PostgreSQL)
- Fila de jobs guardada num schema dedicado do PostgreSQL já existente. Usa polling com `SKIP LOCKED` e oferece retries (`retryLimit`, `retryBackoff`) e deduplicação por `singletonKey`.
- **Pros:** Nenhuma infraestrutura nova, porque o Postgres já está na stack. Dá para enfileirar o job na **mesma transação** que atualiza o status do vídeo (transactional outbox sem custo extra).
- **Cons:** Não há módulo oficial do Nest, então o provider e o ciclo de vida precisam ser escritos à mão. É baseado em polling, então a latência e a carga no banco são maiores que com Redis. Também se afasta do diagrama C4, que desenha a fila como um container separado.

### Option C: RabbitMQ (`amqplib` / transporte RMQ do `@nestjs/microservices`)
- Broker AMQP com filas duráveis. O retry é feito com dead-letter exchanges e filas com TTL.
- **Pros:** Broker de mensagens de verdade, com consumidores independentes de linguagem (útil se o worker um dia for reescrito em outra stack). Garantias de entrega fortes.
- **Cons:** Retry e backoff precisam ser montados com topologia DLX/TTL em vez de opções por job. Container mais pesado, e o transporte de microservices do Nest é voltado para RPC/eventos, não para processamento de jobs com tentativas. Mais peças móveis do que esta fase precisa.

**Recommendation:** **Option A (BullMQ + broker compatível com Redis)**. É a única opção com integração oficial do Nest e com retry, backoff e deduplicação por job prontos, e o TD-08 depende disso. O container extra é barato no Compose, e o diagrama C4 já prevê um container separado para a fila. Fixar uma imagem do Redis 7.x ou do Valkey. A Option B é uma alternativa crível se manter a stack só com Postgres importar mais do que a configuração idiomática.

**Decision:** A (BullMQ + Redis/Valkey, `@nestjs/bullmq`)
**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: Backend de Object Storage e SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O diagrama C4 diz "S3 or MinIO". Vídeos (≤10GB) e thumbnails precisam ficar fora do container da API, acessíveis pela API e pelo worker, com suporte a multipart upload e leitura por faixa (TD-03, TD-10). **O MinIO Community Edition parou de publicar imagens Docker em out/2025, entrou em modo de manutenção em dez/2025 e teve o repositório arquivado em abr/2026.** Por isso, o servidor S3 local é uma escolha real, e não algo dado. A escolha do SDK atravessa componentes: é usado pela API, pelo worker e pelos helpers de teste.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `s3-request-presigner`) contra uma imagem fixada do MinIO
- O código fala a API S3 pura (`forcePathStyle: true`, `endpoint` customizado). Localmente roda a última tag publicada de `minio/minio`, fixada, mais um container de inicialização `minio/mc` que cria o bucket e as regras de CORS.
- **Pros:** Bate com o diagrama C4. Entre os servidores auto-hospedados, o MinIO é o que mais se aproxima do AWS S3 na semântica de multipart, URLs pré-assinadas, CORS e Range. O SDK é o canônico, então em produção dá para trocar para AWS S3 (ou qualquer serviço compatível com S3) só com variáveis de ambiente.
- **Cons:** A imagem está congelada: não recebe correções de segurança. Isso é aceitável para um container de dev/teste, mas não para auto-hospedar em produção. Uma troca futura afeta só o Compose.

### Option B: AWS SDK v3 contra um servidor compatível com S3 mantido ativamente (RustFS, SeaweedFS ou Garage)
- Mesmo SDK e mesmo código da Option A; só muda a imagem no Compose.
- **Pros:** Imagens mantidas ativamente. Mesma portabilidade de código da Option A.
- **Cons:** Conformidade com S3 menos testada justamente nos recursos que esta fase usa (multipart com partes pré-assinadas, CORS de bucket, Range). Cada um tem um jeito diferente de criar bucket e configurar CORS. O RustFS é jovem, e o Garage exige um passo de inicialização do layout do cluster.

### Option C: Cliente JS do `minio` (SDK do MinIO) contra o MinIO
- Biblioteca cliente própria do MinIO (`presignedPutObject`, `getPartialObject`).
- **Pros:** API um pouco mais simples para operações básicas.
- **Cons:** Prende o código ao SDK de um fornecedor arquivado. Pré-assinar partes individuais de multipart não é uma API de primeira classe. Migrar para o AWS S3 exigiria reescrever a camada de storage.

**Recommendation:** **Option A (AWS SDK v3 + imagem fixada do MinIO)**. Escrever contra a API S3 genérica torna a imagem do servidor um detalhe descartável do Compose. O MinIO fixado é o alvo de dev de menor risco para multipart, URLs pré-assinadas e CORS, e já aparece na arquitetura. Se a imagem congelada virar problema, migrar para a Option B é a troca de um serviço, sem impacto no código. Um único bucket privado; chaves dos objetos agrupadas por vídeo (`videos/{videoId}/…`).

**Decision:** A (AWS SDK v3 + imagem fixada do MinIO)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Protocolo de Upload de Arquivos Grandes (≤10GB, retomável)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Os "Pontos de Atenção" exigem que um upload de 10GB não trave o sistema e **possa ser retomado após falha de conexão**. O protocolo fixa o handshake dos dois lados: o backend expõe endpoints de init/parts/complete/abort (ou um servidor tus), e o futuro uploader do FE precisa implementar o cliente correspondente. Com o BFF estrito, qualquer opção que faça os bytes passarem pela API também os faz passar pelo BFF do Next.js: 10GB × 2 saltos.

**Options:**

### Option A: S3 Multipart Upload com URLs pré-assinadas por parte (direto ao storage)
- A API cria o vídeo em rascunho e chama `CreateMultipartUpload`. Ela entrega ao cliente URLs pré-assinadas de `UploadPart`, e o cliente faz `PUT` das partes **direto no storage**. Em seguida o cliente chama `complete` (ou `abort`) na API. Para retomar, o cliente pergunta à API quais partes já existem (`ListParts`) e envia só as que faltam.
- **Impacto no backend:** a API nunca toca nos bytes. Endpoints: init, sign-parts, list-parts, complete, abort.
- **Impacto no frontend:** `PUT` navegador → storage (não é navegador → NestJS, então o BFF estrito é respeitado; só o handshake JSON, que é pequeno, passa pelo BFF). Exige um endpoint público do storage (TD-04), CORS no bucket expondo `ETag` e um loop de fatiamento no cliente. O `@uppy/aws-s3` do Uppy faz isso pronto.
- **Pros:** Carga zero na API/BFF, qualquer que seja o tamanho do arquivo. Retomada nativa por parte. Partes em paralelo deixam o upload rápido. O mesmo código funciona no AWS S3.
- **Cons:** O storage precisa ser acessível pelo navegador. Mais endpoints e estados para modelar. Multiparts abandonados precisam de limpeza (regra de lifecycle; fora do escopo aqui).

### Option B: Protocolo tus via API (`@tus/server` + `@tus/s3-store`)
- Protocolo aberto de upload retomável. Um servidor tus montado no Nest recebe chunks via `PATCH` e os envia ao S3 por multipart.
- **Impacto no backend:** servidor tus montado no Express, cuidando de offsets e retomada. **Impacto no frontend:** `tus-js-client`/Uppy com tus. Os bytes vão navegador → BFF → API → storage.
- **Pros:** Retomada padronizada, com clientes maduros. O storage continua privado.
- **Cons:** Cada byte de um arquivo de 10GB passa **pelo BFF do Next e pela API**, o que contraria o requisito de "sem impacto na performance". Fazer proxy de tus pelos Route Handlers do Next traz limites de streaming e timeouts próprios.

### Option C: multipart/form-data em streaming pela API (`busboy` → `Upload` do `@aws-sdk/lib-storage`)
- Uma única requisição HTTP; a API repassa o stream ao S3 sem bufferizar.
- **Pros:** Cliente mais simples (um `fetch`/form). O storage continua privado.
- **Cons:** **Não é retomável**: uma conexão que cai aos 9GB recomeça do zero, o que viola os "Pontos de Atenção". Também prende conexões da API e do BFF durante toda a transferência.

**Recommendation:** **Option A (S3 multipart com URLs pré-assinadas por parte)**. É a única opção que atende os dois requisitos não funcionais: nenhum byte passa pela API ou pelo BFF, e a retomada é por parte. Ela respeita a regra do BFF estrito (só o handshake JSON passa pelo BFF) e bate com a aresta "Frontend → Object Storage" do C4. Os custos (endpoint público do storage, CORS) são tratados no TD-04.

**Decision:** A (S3 multipart com URLs pré-assinadas por parte, direto ao storage)

---

## TD-04: Endereçamento do Storage (interno vs exposto ao navegador)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Depende do **TD-03 Option A** (perde o sentido se o TD-03 escolher B ou C). URLs pré-assinadas embutem o host para o qual foram assinadas, e a assinatura cobre esse host. Dentro do Compose, a API e o worker precisam acessar o storage como `http://minio:9000` (regra Docker do CLAUDE.md raiz), mas o navegador não resolve `minio`. É um contrato entre componentes: schema Joi + `compose.yaml` + `.env.example` + factory do cliente de storage.

**Options:**

### Option A: Dois endpoints, dois clientes S3 (`S3_ENDPOINT` interno + `S3_PUBLIC_ENDPOINT` para assinatura)
- As chamadas de dados (Create/Complete multipart, Head, Get, Put do thumbnail) usam um cliente em `S3_ENDPOINT=http://minio:9000`. A pré-assinatura usa um segundo cliente configurado com `S3_PUBLIC_ENDPOINT` (por exemplo `http://localhost:9000` em dev, domínio da CDN/S3 em produção). Assinar é uma operação offline, então o cliente público nunca abre conexão de dentro do container.
- **Pros:** Respeita a regra de rede do Docker. Funciona igual em produção trocando uma variável de ambiente. Sem truques de rede.
- **Cons:** Duas instâncias de cliente para configurar; os testes precisam verificar que as URLs saem com o host público.

### Option B: Um único endpoint resolvível dos dois lados (alias de host)
- Usar o mesmo hostname nos dois casos, por exemplo adicionando `minio` ao arquivo hosts da máquina do desenvolvedor, ou apontando os containers para `host.docker.internal:9000`.
- **Pros:** Um cliente, uma variável de ambiente.
- **Cons:** Exige configuração na máquina host (arquivo hosts) ou quebra a regra de usar o nome do serviço do Compose (`host.docker.internal`). Frágil entre sistemas operacionais e no CI.

### Option C: Reverse proxy do storage sob a origem da aplicação (por exemplo `/storage/*` via um container de proxy)
- Um proxy (nginx/Caddy) expõe o storage num caminho de uma única origem pública. A pré-assinatura usa essa origem.
- **Pros:** Uma única origem pública, sem CORS no storage.
- **Cons:** Container e configuração novos. Um proxy com prefixo de caminho interfere nos caminhos canônicos do SigV4 se não for configurado com cuidado. Exagerado para esta fase.

**Recommendation:** **Option A (dois endpoints)**. É a única opção que mantém a regra de nomes de serviço do Compose sem configuração na máquina host, e vai para produção (host público de CDN/S3) com uma única variável de ambiente.

**Decision:** A (Dois endpoints: `S3_ENDPOINT` interno + `S3_PUBLIC_ENDPOINT` para assinatura)

---

## TD-05: Modelo de Status do Vídeo (estado de processamento vs estado de publicação)

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** O registro do vídeo é criado quando o upload **começa** (capability literal), então o modelo precisa representar "enviando", "processando", "pronto" e "falhou". A Fase 04 introduz um fluxo separado de **rascunho → publicado** e a visibilidade pública/unlisted. Se a Fase 03 codificar "rascunho" como estado de processamento, a Fase 04 vai ter de migrar ou sobrecarregar a coluna. O enum de status é compartilhado pela API, pelo worker, pela migration e (via OpenAPI) pelo FE.

**Options:**

### Option A: Um único enum `status` cobrindo tudo (`draft` → `processing` → `ready` | `failed`, depois `published`)
- Uma coluna; "draft" significa "upload iniciado", e a Fase 04 acrescenta `published`.
- **Pros:** Uma coluna, consulta mais simples hoje.
- **Cons:** Mistura dois ciclos de vida independentes: um vídeo processado está `ready` e ainda é rascunho até ser publicado. A Fase 04 então precisa de migration ou de valores combinados (`ready_draft`, `ready_published`, …), e teria de redefinir o significado de `draft`.

### Option B: Duas colunas independentes: `processing_status` + `publication_status`
- `processing_status`: `uploading` → `processing` → `ready` | `failed` (de responsabilidade da API e do worker nesta fase). `publication_status`: criado como `draft` agora, e a Fase 04 acrescenta a transição para `published` e a visibilidade.
- **Pros:** A capability literal ("rascunho") é atendida por `publication_status = draft` desde o primeiro insert. A Fase 04 acrescenta transições sem migrar a semântica da Fase 03. O worker só escreve em `processing_status`.
- **Cons:** Duas colunas para manter consistentes (por exemplo, a Fase 04 precisa impedir a publicação se o vídeo não estiver `ready`). Um pouco mais de schema hoje.

**Recommendation:** **Option B (duas colunas independentes)**. Processamento e publicação são ciclos de vida independentes, controlados por atores e fases diferentes. Separá-los agora evita redefinir `draft` na Fase 04. Falhas guardam a mensagem em `processing_error`.

**Decision:** B (Duas colunas: `processing_status` + `publication_status`)

---

## TD-06: Topologia do Processo Worker

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama C4 desenha o "Video Worker (FFmpeg)" como um container separado. FFmpeg num arquivo de vários GB consome muita CPU e IO; rodá-lo no processo da API competiria com o tráfego HTTP, o que contraria o requisito de "sem impacto na performance". A topologia define os serviços do Compose, a imagem Docker e a organização do código.

**Options:**

### Option A: Processo separado, mesmo codebase (`src/worker/main.ts` com `NestFactory.createApplicationContext`)
- Um segundo entrypoint no `nestjs-project` que sobe um application context do Nest sem servidor HTTP e importa só o que o worker precisa (banco, storage, consumidor da fila). Roda como serviço `video-worker` no Compose, a partir da mesma imagem, com o FFmpeg instalado.
- **Pros:** Bate com o C4. Isola a carga de CPU da API. Reaproveita entidades, config, módulo de storage e helpers de teste sem pacote compartilhado. Escala de forma independente (`replicas`).
- **Cons:** Dois entrypoints num mesmo projeto; a organização dos módulos precisa garantir que a API não registre o processor (só o worker importa o módulo consumidor).

### Option B: Consumidor dentro do processo da API
- `@Processor` registrado no `AppModule` da API.
- **Pros:** Nenhum serviço novo; setup de dev mais simples.
- **Cons:** Os processos filhos do FFmpeg e o IO competem com o atendimento das requisições, o que contraria diretamente o requisito não funcional e a separação de containers do C4. Escalar a API passa a significar escalar os workers.

### Option C: Subprojeto separado (`video-worker/` na raiz do repositório)
- Pacote independente com seu próprio `package.json`, possivelmente nem sendo Nest.
- **Pros:** Isolamento total; poderia usar outra stack.
- **Cons:** Duplica o código de entidades/config/storage ou obriga a criar pacotes compartilhados no monorepo (uma mudança de ferramental no repositório inteiro). Muito mais pesado do que esta fase justifica.

**Recommendation:** **Option A (processo separado, mesmo codebase)**. Ela entrega o isolamento de container do C4 e a escala independente sem a duplicação de código ou o ferramental de monorepo que a Option C exigiria.

**Decision:** A (Processo separado, mesmo codebase, serviço `video-worker` no Compose)

---

## TD-07: Ferramentas de Análise de Mídia e Thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa extrair a duração e os metadados das streams e capturar um frame como thumbnail de um arquivo de até 10GB guardado no object storage. São duas escolhas acopladas: **como o FFmpeg é invocado** e **como o worker lê o arquivo de entrada**. Baixar 10GB para o disco local a cada job tem custo real de disco e de tempo.

**Options:**

### Option A: Binários `ffmpeg`/`ffprobe` do sistema na imagem + `child_process.spawn`, lendo a entrada por uma URL HTTP pré-assinada
- `ffprobe -print_format json -show_format -show_streams <url>` e `ffmpeg -ss <t> -i <url> -frames:v 1 …`. O próprio FFmpeg faz requisições HTTP com Range, então só os bytes necessários (cabeçalhos, `moov`, um GOP) são lidos.
- **Pros:** Nenhuma dependência de wrapper. Saída JSON tipável do ffprobe. Nenhuma cópia local do arquivo de 10GB. A versão do binário é controlada pela imagem (`apt install ffmpeg`).
- **Cons:** Montagem dos argumentos e leitura do stderr feitas à mão. Arquivos com o índice no fim (`moov` no final) custam algumas idas e voltas extras com Range, mas ainda assim não um download completo.

### Option B: Wrapper `fluent-ffmpeg`
- API fluente em JS sobre os mesmos binários.
- **Pros:** Métodos de conveniência (`ffprobe()`, `screenshots()`).
- **Cons:** **Descontinuado e sem manutenção** (aviso no README e no npm). Acrescenta uma dependência morta para o que são duas linhas de comando.

### Option C: Binários do sistema + download do original para um volume temporário antes
- Igual à Option A, mas `GetObject` → arquivo local → FFmpeg roda sobre o arquivo.
- **Pros:** Semântica mais simples do FFmpeg (arquivo local com seek).
- **Cons:** Até 10GB de disco por job simultâneo, mais o tempo da transferência completa antes de começar qualquer trabalho, só para ler cabeçalhos e um frame.

**Recommendation:** **Option A (binários do sistema via `spawn`, lendo por URL pré-assinada)**. Evita um wrapper descontinuado e evita copiar 10GB por job, já que o ffprobe e o seek de um único frame só precisam de algumas leituras com Range. O FFmpeg vai na imagem compartilhada pela API e pelo worker (TD-06).

**Decision:** A (ffmpeg/ffprobe do sistema via `spawn`, entrada por URL pré-assinada)

---

## TD-08: Gatilho do Processamento, Contrato do Job e Política de Retry

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Algo precisa detectar que o upload terminou e enfileirar o processamento. O payload do job, o nome da fila, a chave de idempotência e a política de retry/falha formam o contrato entre a API (produtora), o worker (consumidor) e o status no banco (TD-05). Depende do TD-01 (fila) e do TD-03 (protocolo de upload).

**Options:**

### Option A: A API enfileira na chamada `complete` do cliente
- O endpoint `complete` da API já precisa chamar `CompleteMultipartUpload` (TD-03 A). Logo em seguida, ele define `processing_status = processing` e enfileira `{ videoId }` com `jobId = videoId`, `attempts: 3` e backoff exponencial. O worker só marca `failed` + `processing_error` depois da última tentativa. Os jobs são idempotentes (rodar de novo sobrescreve os metadados e o thumbnail).
- **Pros:** Nenhuma infraestrutura extra. Ordem determinística: o objeto já está completo quando o job passa a existir. `jobId = videoId` deduplica cliques duplos e repetições do `complete`.
- **Cons:** Se a API cair entre a atualização no banco e o enfileiramento, o vídeo fica em `processing` sem job (uma janela pequena; uma varredura pode corrigir isso depois, fora do escopo).

### Option B: Notificação de evento do bucket (MinIO/S3 → webhook/fila)
- O storage emite `s3:ObjectCreated:CompleteMultipartUpload` para um webhook ou direto para uma fila; um listener enfileira o job.
- **Pros:** Disparado pela fonte da verdade: nenhum job se perde mesmo que o cliente nunca chame `complete`.
- **Cons:** Com o TD-03 A, o cliente **precisa** chamar a API para concluir o multipart de qualquer forma, então isso não acrescenta nada. Exige configuração de notificação específica de cada fornecedor (diferente no MinIO e no AWS), mais um endpoint de webhook para proteger.

### Option C: Transactional outbox (se TD-01 = pg-boss) / varredura por polling
- Enfileirar dentro da mesma transação do banco (pg-boss), ou um cron que pega registros em `processing` sem job.
- **Pros:** Elimina a janela de queda da Option A.
- **Cons:** Só é natural com o TD-01 B. Com BullMQ, acrescenta uma varredura agendada e uma tabela de outbox, o que é mais maquinário do que uma janela pequena justifica nesta fase.

**Recommendation:** **Option A (a API enfileira no `complete`, `jobId = videoId`, 3 tentativas com backoff exponencial, `failed` só depois da última tentativa)**. Com o TD-03 A, a API já está no caminho crítico da conclusão, então este é o gatilho correto mais simples. A janela de queda fica registrada como tarefa de follow-up.

**Decision:** A (Enfileirar no `complete`, `jobId = videoId`, 3 tentativas com backoff exponencial)

---

## TD-09: Identificador Público Único do Vídeo (slug da URL)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Os "Pontos de Atenção" pedem uma URL **curta** que nunca conflite. O identificador aparece nas rotas da API (`/videos/:id/...`), nas rotas do FE da futura página de exibição (`/watch/:id`), em links compartilhados e no banco como coluna única. Esse formato é fixado uma vez e consumido pelos dois subprojetos via OpenAPI.

**Options:**

### Option A: Slug aleatório base62 de 11 caracteres (`crypto.randomBytes`), `UNIQUE` + retry em `23505`
- Cerca de 65 bits de entropia (mesmo comprimento do YouTube). Gerado no service; uma colisão dispara um retry, reaproveitando o padrão do `channels.service.ts`. A PK UUID interna nunca é exposta.
- **Pros:** Curto e impossível de adivinhar (resistente a enumeração, o que importa para os vídeos unlisted da Fase 04). Nenhuma dependência nova. Padrão de retry já testado no codebase.
- **Cons:** Precisa do loop de retry (a colisão é astronomicamente rara, mas é tratada).

### Option B: Expor a chave primária UUID
- `/videos/3f2c…-…`.
- **Pros:** Zero código extra; unicidade garantida.
- **Cons:** 36 caracteres: não é a "URL curta" pedida no plano. Acopla a URL pública à chave interna.

### Option C: Inteiro sequencial codificado com Sqids/Hashids
- Codifica uma coluna auto-incremento numa string curta e reversível.
- **Pros:** Muito curto, sem colisões por construção.
- **Cons:** Reversível e sequencial por baixo, então dá para enumerar se o alfabeto vazar, o que é ruim para vídeos unlisted. Também adiciona uma dependência e uma segunda coluna de ID.

**Recommendation:** **Option A (slug aleatório base62 de 11 caracteres)**. É curto e impossível de adivinhar, o que a visibilidade unlisted da Fase 04 precisa. Reaproveita o padrão de retry em `23505` já existente e não adiciona dependência.

**Decision:** A (Slug aleatório base62 de 11 caracteres + retry em `23505`)

---

## TD-10: Entrega do Streaming e do Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A reprodução precisa começar sem o arquivo completo (HTTP Range), e o usuário precisa conseguir baixar o original. O caminho de entrega define os endpoints e códigos de status da API e para qual URL vão apontar o `<video src>` e o link de download do futuro FE. Com o BFF estrito, um stream que passa pela API também passa pelo BFF (navegador → Next → Nest → storage).

**Options:**

### Option A: A API faz proxy do storage com suporte a Range (`206 Partial Content`)
- `GET /videos/:slug/stream` repassa o `Range` do cliente ao `GetObject` e devolve o corpo em stream com `206`, `Content-Range` e `Accept-Ranges`. `GET /videos/:slug/download` faz o mesmo com `Content-Disposition: attachment`.
- **Impacto no backend:** a API transporta os bytes do vídeo (em stream, sem bufferizar); a autorização é verificada em toda requisição. **Impacto no frontend:** o BFF precisa de um Route Handler de passagem que repasse o `Range` e devolva o corpo em stream (Fase 05); o `<video>` aponta para uma URL da mesma origem.
- **Pros:** Controle total da autorização a cada requisição (TD-11). O storage continua privado para leitura. URLs estáveis e cacheáveis.
- **Cons:** A banda da reprodução passa pela API (e pelo BFF), então assistir vídeos consome capacidade da API. Uma CDN na frente resolve isso mais tarde.

### Option B: A API devolve ou redireciona para uma URL pré-assinada de `GetObject` de curta duração
- `GET /videos/:slug/stream` → `302` para uma URL pré-assinada (ou JSON com a URL). O navegador faz as requisições com Range direto no storage. O download usa uma pré-assinatura com `ResponseContentDisposition=attachment`.
- **Impacto no backend:** endpoints pequenos, sem transferência de bytes. **Impacto no frontend:** o `<video>` segue o redirect até o host do storage (exige o endpoint público e o CORS do TD-04); sessões longas precisam renovar a URL depois que ela expira.
- **Pros:** Carga zero de reprodução na API e no BFF; usa o tratamento nativo de Range do storage.
- **Cons:** A autorização só é verificada na emissão da URL; quem tiver a URL pode usá-la até ela expirar. Fazer seek depois da expiração quebra a reprodução, a menos que o player busque a URL de novo.

### Option C: Streaming adaptativo HLS/DASH (transcodificação em segmentos)
- O worker transcodifica em várias resoluções e segmentos; o player usa um manifesto `.m3u8`.
- **Pros:** Padrão da indústria; bitrate adaptativo.
- **Cons:** Exige transcodificação, o que vai muito além de "extração de duração e metadados", multiplica o storage e exige uma biblioteca de player. Fora do escopo desta fase.

**Recommendation:** **Option A (proxy pela API com Range/206)**, como já preferido pelo usuário na preparação da fase. Mantém a autorização por requisição (necessária para os rascunhos no TD-11 e para os vídeos unlisted da Fase 04), e o storage continua privado para leitura. O custo de banda é aceitável na escala deste projeto, e uma CDN ou a migração para a Option B podem vir depois sem mudar o formato da URL pública.

**Decision:** A (Proxy pela API com Range → 206; `attachment` no download)

---

## TD-11: Política de Acesso a Vídeos Antes da Publicação

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Usuários anônimos podem assistir livremente, mas nesta fase todo vídeo é um **rascunho** (TD-05): a publicação só chega na Fase 04. Expor rascunhos publicamente agora criaria um vazamento que a Fase 04 teria de fechar. O decorator `@Public()` atual pula a leitura do token por completo, então um endpoint "público para publicados, só o dono para rascunhos" exige um modo de auth opcional. Os endpoints de upload (init/sign/complete/abort) são exclusivos do dono em todas as opções.

**Options:**

### Option A: Leitura só pelo dono na Fase 03; o acesso público chega com a publicação na Fase 04
- Os endpoints de leitura/stream/download/thumbnail exigem JWT e verificam se o usuário é dono do canal. A Fase 04 acrescenta a auth opcional: anônimos podem acessar quando `publication_status = published` (ou unlisted, com o slug).
- **Pros:** Nenhum rascunho fica acessível publicamente. A Fase 03 não precisa mexer no guard. A transição na Fase 04 é puramente aditiva.
- **Cons:** O streaming anônimo não pode ser demonstrado na Fase 03 (só o streaming pelo dono).

### Option B: Guard com auth opcional agora: público para vídeos `ready`, só o dono nos demais casos
- Estender o guard para que rotas `@Public()` ainda anexem `request.user` quando houver um token válido. Anônimos podem ler qualquer vídeo `ready` pelo slug.
- **Pros:** Demonstra o streaming anônimo já nesta fase.
- **Cons:** Publica rascunhos pelo slug (segurança por obscuridade) até a Fase 04 chegar. Muda o contrato do guard global numa fase que não precisa disso.

**Recommendation:** **Option A (só o dono até a publicação)**. Nunca expõe rascunhos e mantém o contrato do guard inalterado. O entregável "streaming funcionando" é atendido pelo dono. A auth opcional pertence às regras de visibilidade da Fase 04.

**Decision:** A (Só o dono até a publicação na Fase 04)

---

## TD-12: Limites de Upload e Política de Validação da Entrada

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Com o upload direto ao storage (TD-03 A), a API nunca vê os bytes, então o limite de 10GB e a verificação de que "isto é de fato um vídeo" precisam ser feitos no handshake e depois da conclusão. Os limites formam um contrato entre as camadas: o cliente precisa fatiar no mesmo tamanho de parte e respeitar o mesmo tamanho máximo e os mesmos tipos aceitos, e a API valida os mesmos valores na config Joi e nos DTOs.

**Options:**

### Option A: Metadados declarados no init + `HeadObject` no complete + ffprobe como árbitro final
- O DTO de init exige `sizeBytes ≤ 10 GiB` e um MIME `video/*` de uma allowlist. A API calcula a quantidade de partes a partir de um tamanho de parte fixo (por exemplo 64 MiB, dentro dos limites do S3 de 5 MiB a 5 GiB por parte e 10 000 partes) e assina as URLs com expiração curta. No `complete`, verifica `HeadObject.ContentLength ≤` o tamanho declarado; a falha do ffprobe no worker marca o vídeo como `failed` (não é vídeo).
- **Pros:** Verificações baratas em cada etapa, sem a API tocar nos bytes. Uma mentira sobre o tamanho é pega na conclusão, e um vídeo falso é pego no processamento. Tamanho de parte e tamanho máximo são valores de config (env) repassados ao cliente na resposta do init.
- **Cons:** Um cliente malicioso ainda consegue enviar até o tamanho declarado antes da rejeição, então o storage é consumido até a limpeza.

### Option B: Option A + verificação de magic bytes no `complete` (`GetObject` com Range do primeiro KB)
- Antes de enfileirar, a API lê os primeiros bytes e confere a assinatura do container (MP4/`ftyp`, WebM/EBML, …).
- **Pros:** Rejeita na hora, com um 4xx claro, arquivos que obviamente não são vídeo.
- **Cons:** Duplica o que o ffprobe já decide com autoridade segundos depois, e exige manter uma tabela de assinaturas.

### Option C: Validar só no worker
- Nenhuma verificação de tamanho ou tipo no init/complete; o ffprobe decide.
- **Pros:** Menos código.
- **Cons:** O contrato de 10GB não é aplicado em lugar nenhum; qualquer tamanho entra no storage.

**Recommendation:** **Option A**. Cada limite é aplicado no ponto em que é mais barato (declarado no init, tamanho real no complete, conteúdo real no worker), e o ffprobe continua sendo a única autoridade sobre "isto é um vídeo". Tamanho de parte, tamanho máximo e expiração das URLs vêm do env e são devolvidos na resposta do init, para que o cliente nunca os fixe no código.

**Decision:** A (Declarado no init + `HeadObject` no complete + ffprobe)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Tecnologia de fila de mensagens | **A** (BullMQ + Redis/Valkey, `@nestjs/bullmq`) | **A** |
| TD-02 | Backend | Backend de object storage e SDK | **A** (AWS SDK v3 + imagem fixada do MinIO) | **A** |
| TD-03 | Cross-layer | Protocolo de upload de arquivos grandes | **A** (S3 multipart, URLs pré-assinadas por parte, direto ao storage) | **A** |
| TD-04 | Backend | Endereçamento do storage | **A** (`S3_ENDPOINT` interno + `S3_PUBLIC_ENDPOINT` para assinatura) | **A** |
| TD-05 | Backend | Modelo de status do vídeo | **B** (`processing_status` + `publication_status`) | **B** |
| TD-06 | Backend | Topologia do processo worker | **A** (processo separado, mesmo codebase, serviço próprio no Compose) | **A** |
| TD-07 | Backend | Ferramentas de análise de mídia e thumbnail | **A** (ffmpeg/ffprobe do sistema via `spawn`, entrada por URL pré-assinada) | **A** |
| TD-08 | Backend | Gatilho do processamento, contrato do job e retry | **A** (enfileirar no `complete`, `jobId = videoId`, 3× backoff exponencial) | **A** |
| TD-09 | Cross-layer | Identificador público único do vídeo | **A** (slug aleatório base62 de 11 caracteres + retry em `23505`) | **A** |
| TD-10 | Cross-layer | Entrega do streaming e do download | **A** (proxy pela API com Range → 206; `attachment` no download) | **A** |
| TD-11 | Backend | Política de acesso antes da publicação | **A** (só o dono até a publicação na Fase 04) | **A** |
| TD-12 | Cross-layer | Limites de upload e validação da entrada | **A** (declarado no init + `HeadObject` no complete + ffprobe) | **A** |

---

## Notas para o pipeline

- **Dependências entre TDs:**
  - O TD-04 só existe se TD-03 = A.
  - O TD-08 A pressupõe TD-03 = A (a API está no caminho da conclusão) e TD-01 = A. Com TD-01 = B (pg-boss), o TD-08 C (enfileiramento transacional) passa a ser a escolha natural.
  - O TD-12 A pressupõe TD-03 = A.
  - O TD-11 pressupõe TD-05 = B (existência de `publication_status`).
  - O TD-07 A depende do TD-06 A (FFmpeg na imagem compartilhada).
- **Repasses para a Fase 04 (não decididos aqui):** transição de publicação e regras de visibilidade sobre `publication_status` (TD-05 B), e modo de auth opcional no guard para leituras públicas/unlisted (TD-11 A).
- **Repasse para a Fase 05:** o Route Handler de passagem do BFF para `/stream` precisa repassar o `Range` e devolver o corpo em stream (impacto no frontend do TD-10 A).
- **Tarefas de follow-up, fora do escopo (registrar separadamente):**
  - limpeza de multipart uploads abandonados e de rascunhos parados em `uploading` (regra de lifecycle ou job agendado);
  - varredura para a janela de queda da API entre a atualização do status e o enfileiramento (TD-08 A);
  - CDN na frente do stream/download (TD-10 A);
  - substituição da imagem congelada do MinIO (TD-02).
- **Novas variáveis de ambiente canônicas (contrato entre Joi + `compose.yaml` + `.env.example`), caso as recomendações sejam aceitas:**
  - storage: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`;
  - fila: `REDIS_HOST`, `REDIS_PORT`;
  - limites de upload: `UPLOAD_MAX_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_URL_TTL_SECONDS`.
  - Todos os hosts usam nomes de serviço do Compose.
- **Testes:** as suítes de integração e e2e seguem o padrão já estabelecido de serviços reais do Compose (como `db` e `mailpit`). MinIO, Redis e FFmpeg rodam de verdade, e nenhuma infraestrutura é mockada. Vídeos de fixture são gerados com `ffmpeg -f lavfi testsrc`. É uma convenção herdada, não um TD em aberto.

Fontes consultadas na pesquisa:

- [Referência da API do `@nestjs/bullmq` (BullModule, WorkerHost)](https://github.com/nestjs/bull) (via context7): `forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`; erros lançados no `process()` disparam retries.
- [Documentação do BullMQ: retry de jobs com falha, deduplicação, job IDs](https://docs.bullmq.io/) (via context7): `attempts` + `backoff` exponencial, deduplicação por `jobId` customizado, ressalva do `removeOnComplete`.
- [AWS SDK for JavaScript v3: cliente S3 e `s3-request-presigner`](https://github.com/aws/aws-sdk-js-v3) (via context7): `endpoint` customizado + `forcePathStyle` para MinIO, `getSignedUrl` sobre comandos S3 (expiração padrão de 900s).
- [MinIO CE in 2026: Retired Upstream, Source-Only](https://glukhov.org/data-infrastructure/object-storage/minio-dead/), [MinIO Is in Maintenance Mode](https://blog.elest.io/minio-is-in-maintenance-mode-your-guide-to-s3-compatible-storage-alternatives/), [MinIO archived — self-hosted S3 alternatives](https://pinggy.io/blog/minio_archived_self_hosted_s3_alternatives/): publicação de imagens encerrada em out/2025, modo de manutenção em dez/2025, repositório arquivado em abr/2026 (fontes secundárias; datas conferidas entre elas).
- [fluent-ffmpeg no npm (aviso de descontinuação)](https://npmjs.com/package/fluent-ffmpeg): descontinuado e sem manutenção.
- No repositório: `docs/project-plan.md` (Fase 03 + Pontos de Atenção), `docs/diagrams/software-arch.mermaid`, `nestjs-project/src/auth/guards/jwt-auth.guard.ts`, `nestjs-project/src/channels/channels.service.ts`, `next-frontend/CLAUDE.md` (BFF estrito).
