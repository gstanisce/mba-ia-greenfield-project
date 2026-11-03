# phase-03-videos — Progress

**Status:** completed
**SIs:** 9/9 completed

### SI-03.1 — Infra: dependências, configuração e serviços do Docker Compose
- **Status:** completed
- **Tests:** 6 passing (`src/config/env.validation.integration-spec.ts`); `tsc --noEmit` exit 0; `npm run build` exit 0
- **Observations:**
  - Plano revisado manualmente e autorizado pelo usuário: o serviço `video-worker` saiu da SI-03.1 e foi para a SI-03.7 (ação 3, sub-item), porque o `command` dele depende do script criado na SI-03.7. O critério de aceite da SI-03.1 também foi ajustado.
  - Redis implementado como `valkey/valkey:8.1-alpine` (decisão do usuário), com healthcheck `valkey-cli ping`. A SI-03.9 ainda cita `redis-cli ping` na documentação; alinhar lá.
  - Dependências instaladas dentro do contêiner: npm gravou `bullmq ^6.5.4`, `@nestjs/bullmq ^12.0.0`, `@aws-sdk/client-s3 ^3.1161.0` e `@aws-sdk/s3-request-presigner ^3.1161.0`. Os intervalos do plano são pisos (`^6.5.1`, `^3.1160.0`) e as versões instaladas os satisfazem.
  - Aceite de infra verificado no WSL: `db`, `mailpit`, `redis` e `rustfs` `healthy`; `rustfs-init` com código 0; `ffprobe` e `ffmpeg` presentes na imagem da API após o rebuild do Dockerfile.
  - Fora de escopo: `MAIL_FROM` no `.env.example` continua sem aspas (já registrado).

### SI-03.2 — StorageModule: wrapper S3 com dois clientes
- **Status:** completed
- **Tests:** 7 passing (2 suites: `storage.module.spec.ts` e `storage.service.integration-spec.ts`); `tsc --noEmit` exit 0
- **Observations:**
  - Arquivos criados: `src/storage/storage.module.ts`, `storage.service.ts`, `storage.constants.ts`, `src/test/minio.ts` (nome do plano, mas o conteúdo fala com o RustFS), e os dois specs. `InvalidUploadPartsException` (400, `INVALID_UPLOAD_PARTS`) adicionada em `src/common/exceptions/domain.exception.ts`.
  - `storage.config.ts` passou a devolver `''` nos campos S3 ausentes, para o SDK aceitar a tipagem; a validação do Joi continua exigindo as chaves na subida.
  - O integration spec faz `PUT` nas URLs assinadas, que levam o host de `S3_PUBLIC_ENDPOINT`. Dentro do contêiner da API esse host precisa ser alcançável, então a execução de teste usa `S3_PUBLIC_ENDPOINT=http://rustfs:9000`. O `.env` continua com `http://localhost:9000` para o navegador. Isso está documentado no cabeçalho do spec.
  - Nome `src/test/minio.ts` mantido por causa do plano; renomear é decisão pendente.

### SI-03.3 — Entidade Video e migration CreateVideos
- **Status:** completed
- **Tests:** 4 passing (`src/videos/entities/video.entity.integration-spec.ts`); 2 passing (`src/database/migrations.integration-spec.ts`); full suite 157/157 across 26 suites with `S3_PUBLIC_ENDPOINT=http://rustfs:9000`; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors)
- **Observations:**
  - Migration `CreateVideos1793708525120` gerada pela CLI (`migration:generate`) depois de aplicar as duas migrations existentes num banco vazio; sem isso o diff incluiria as tabelas antigas.
  - `VideosModule` mínimo criado em `src/videos/videos.module.ts` (só `TypeOrmModule.forFeature([Video])`) e registrado no `AppModule`. Sem ele o `autoLoadEntities` não descobre `Video` e a API não sobe (`Channel#videos` não resolve). O plano só prevê o módulo completo na SI-03.6; ele deve ser expandido lá (imports de canais, storage e fila).
  - `Channel` ganhou `@OneToMany(() => Video)`; os 10 specs com `ALL_ENTITIES` passaram a incluir `Video`.
  - `migrations.integration-spec.ts`: inclui `CreateVideos`, a tabela `videos` e os dois enums; o revert agora desfaz `CreateVideos`. Os drops do `beforeAll` passaram a ser sequenciais, porque `DROP ... CASCADE` em paralelo sobre tabelas ligadas por FK causa deadlock.
  - `cleanAllTables` apaga `videos` antes de `channels`.
  - Lint: 2 warnings (`no-unsafe-argument`) já existentes, fora desta SI: `src/auth/auth.service.integration-spec.ts:473` e `src/storage/storage.service.integration-spec.ts:36` (SI-03.2). Não corrigidos aqui.
  - Execução de teste exige `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no container, como na SI-03.2.

### SI-03.4 — Gerador de slug e produtor da fila de processamento
- **Status:** completed
- **Tests:** 6 novos passando (`src/videos/slug.util.spec.ts`: 2; `src/video-processing/video-processing-queue.module.integration-spec.ts`: 1; `src/video-processing/video-processing.producer.integration-spec.ts`: 3); full suite 163/163 em 29 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors)
- **Observations:**
  - `@nestjs/bullmq` 12 e `bullmq` 6 são ESM puros (`"type": "module"`). O Jest em CJS não os carrega, então o `package.json` ganhou `transformIgnorePatterns` liberando `@nestjs/bullmq` e `@nestjs/bull-shared` para o ts-jest transpilar. A config do e2e (`test/jest-e2e.json`) vai precisar do mesmo ajuste quando um e2e importar a fila (SI-03.6).
  - `ioredis` adicionado como dependência (`^5.11.1`). É peer opcional do `bullmq` 6; sem ele a fila não abre conexão. O plano não listava esse pacote; deve ser coberto pela SI-03.1 ao revisar dependências.
  - O teste de módulo da fila ficou como `video-processing-queue.module.integration-spec.ts`, e não `.spec.ts` como o plano indica: ele abre conexão real com o Redis, e `CLAUDE.md` reserva `.spec.ts` para código sem I/O externo.
  - A documentação do context7 para `/nestjs/bull` mostra `redis:` no `forRootAsync`; isso é do pacote legado `@nestjs/bull`. Seguimos a API do `@nestjs/bullmq` instalado, com `connection: { host, port }`.
  - `jobId = videoId`: o BullMQ ignora um `add` com `jobId` já existente. Com `removeOnComplete: true`, a doc avisa que um job concluído sai da fila e um novo `enqueue` do mesmo `videoId` cria outro job. O worker da SI-03.7 precisa ser idempotente para um vídeo já `ready`.
  - `generateVideoSlug` usa rejection sampling com limite 248 (maior múltiplo de 62 abaixo de 256), sem viés de módulo.

### SI-03.5 — VideosService: iniciar, assinar, concluir e abortar o upload
- **Status:** completed
- **Tests:** 20 novos passando: `src/videos/videos.service.spec.ts` (14, unit), `src/videos/videos.service.integration-spec.ts` (4, RustFS + Redis + Postgres), `src/channels/channels.service.integration-spec.ts` (+2 `findByUserId`); full suite 183/183 em 31 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors)
- **Observations:**
  - `isPgUniqueViolationOnColumn` foi extraído de `channels.service.ts` para `src/common/database/pg-unique-violation.util.ts`, para o retry de slug do vídeo reutilizar a mesma detecção de `23505`. Comportamento do canal inalterado.
  - Duas exceções novas além do Error Catalog: `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404), para usuário sem canal no init; e `InvalidPartNumbersException` (`VALIDATION_ERROR`, 400), para `partNumber` fora de `1..partCount`, código que o plano fixa. Ambas são classes de domínio, como o restante.
  - `VideosModule` agora provê `VideosService` e `VideoProcessingProducer` e importa `ChannelsModule`, `StorageModule` e `VideoProcessingQueueModule`. Isso antecipa parte da SI-03.6, que previa esses imports; a SI-03.6 só precisa acrescentar o controller.
  - `completeUpload` faz `update` e depois `enqueue` sem transação. Se o `enqueue` falhar, o vídeo fica `processing` sem job. Risco registrado, não tratado nesta SI.
  - Em `failed` por tamanho divergente, `upload_id` também é zerado, já que o upload terminou com o `CompleteMultipartUpload`.
  - `abortUpload` remove a linha com `delete`; o plano não pede soft delete.
  - Lint: os mesmos 2 warnings antigos (`auth.service.integration-spec.ts:473`, `storage.service.integration-spec.ts:36`).

### SI-03.6 — VideosController: endpoints de upload
- **Status:** completed
- **Tests:** 10 e2e novos passando (`test/videos-upload.e2e-spec.ts`, cenários 1.1–3.2 do `specs/videos-upload.plan.md`); 7 unit/integration novos (`src/videos/pipes/parse-video-slug.pipe.spec.ts`: 5; `src/videos/videos.module.integration-spec.ts`: 1; `VideosService.signUploadParts` expiresAt: 1); full unit/integration 190/190 em 33 suites; full e2e 62/62 em 4 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors); `openapi.json` regenerado com as 4 rotas de caminho (5 operações)
- **Observations:**
  - DTOs de request seguem `nestjs-dtos.md`: sem `@ApiProperty` manual, descrições por JSDoc, exceto `contentType` que usa `enum` explícito (o plugin não infere enum de `@IsIn`). DTOs de resposta têm `@ApiProperty` em todos os campos.
  - `signUploadParts` agora devolve `{ parts: [{ partNumber, url }], expiresAt }` (antes devolvia um mapa de URLs). A mudança é no service da SI-03.5; os specs unit e integração daquela SI foram atualizados. Motivo: o TTL é configuração e `expiresAt` fica no service, não no controller.
  - `sizeBytes` tem `@Max` com `UPLOAD_MAX_BYTES`, lido quando o módulo do DTO carrega. Isso exige o `.env` já no `process.env`: a API não tem `env_file` no compose, e o `ConfigModule` só carrega o `.env` ao avaliar o `AppModule`. Correção aplicada na SI-03.7: `import 'dotenv/config'` como primeiro import de `src/main.ts`. Os e2e já tinham o `dotenv/config` no `setupFiles` do jest.
  - Constante `DEFAULT_UPLOAD_MAX_BYTES` exportada de `upload.config.ts` para o DTO reusar o default, sem duplicar o literal.
  - `ParseVideoSlugPipe` lança `VIDEO_NOT_FOUND` para slug malformado, então rotas com slug inválido respondem 404, como o plano pede.
  - `test/jest-e2e.json` ganhou o mesmo `transformIgnorePatterns` do `package.json` (`@nestjs/bullmq` é ESM). Sem isso o e2e não carrega o `AppModule`.
  - O teste de compilação do `VideosModule` foi nomeado `*.integration-spec.ts` (plano: `*.spec.ts`), porque abre Postgres e Redis, mesma regra da SI-03.4.
  - Lint: 2 warnings antigos (`auth.service.integration-spec.ts:473`, `storage.service.integration-spec.ts:36`), fora desta SI.

### SI-03.7 — Worker: processo separado e processamento do vídeo
- **Status:** completed
- **Tests:** 13 novos passando: `src/media/media-probe.service.integration-spec.ts` (3, FFmpeg real), `src/video-processing/video-processing.processor.spec.ts` (4, unit), `src/video-processing/video-processing.processor.integration-spec.ts` (4, FFmpeg + RustFS + Postgres), `src/worker/worker.module.integration-spec.ts` (2); full unit/integration 203/203 em 37 suites; full e2e 62/62 em 4 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors)
- **Observations:**
  - **Não verificado (acceptance de runtime):** subir o serviço `video-worker` no compose e checar que um vídeo válido chega a `ready` pela fila, e que `docker compose stop video-worker` espera o job. Os testes cobrem o processor contra FFmpeg, Postgres e RustFS reais, mas não o processo do worker em execução no compose. Fica para verificação manual ou para a SI-03.9.
  - `VideoProcessingProcessor` instanciado via DI sem `VideoProcessingQueueModule` nos testes de integração: nenhum Worker do BullMQ conecta ao Redis nesse suite.
  - `WorkerModule` compila com um Worker real do BullMQ (ele consome `video-processing`). Como cada suite fecha o módulo no `afterAll`, a fila fica sem consumidor entre suites.
  - Sucesso grava com `save()` na entidade carregada, não com `update()`: o `update()` tipado do TypeORM rejeita o `metadata` JSON nulável. Falha segue com `update()`, que só mexe em status e erro.
  - `video` ausente ou já `ready` no job retorna sem erro (idempotência do re-enqueue).
  - `buildTypeOrmOptions` extraído para `src/database/typeorm-options.ts`, usado pela API e pelo worker, para as duas conexões ficarem iguais.
  - `import 'dotenv/config'` como primeiro import de `src/main.ts`, correção da SI-03.6 (ver a nota dela).
  - `start:worker:dev` usa `nest start --watch --entryFile worker/main`; `start:worker` roda `dist/worker/main`.
  - Lint: 2 warnings antigos (`auth.service.integration-spec.ts:473`, `storage.service.integration-spec.ts:36`), fora desta SI.

### SI-03.8 — VideosController: metadados, streaming, download e thumbnail
- **Status:** completed
- **Tests:** 9 e2e novos passando (`test/videos-read.e2e-spec.ts`, cenários 1.1–3.1 do `specs/videos-read.plan.md`); `src/videos/range.util.spec.ts` (novo, 10 casos) e `src/videos/videos.service.spec.ts` (+6 leitura); full unit/integration 223/223 em 38 suites; full e2e 71/71 em 5 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors); `openapi.json` regenerado com as 8 rotas de `/videos`
- **Observations:**
  - `parseRange` aceita uma faixa só (`a-b`, `a-`, `-n`) e devolve 416 para múltiplas faixas, formato inválido e início ≥ total. `-0` também é 416.
  - O 416 carrega `Content-Range: bytes */<total>` pela própria exceção: `DomainException` ganhou `responseHeaders` opcional, e o `DomainExceptionFilter` aplica esses cabeçalhos antes do JSON.
  - `stream`/`download` usam `@Res({ passthrough: true })` para definir status 206 e `Content-Range`, e devolvem `StreamableFile` sem bufferizar. O e2e confirmou o 206 com esse fluxo.
  - Orquestração no service (`getReadyVideo`, `openOriginal`, `openThumbnail`); o controller só traduz para HTTP (status, cabeçalhos e `StreamableFile`).
  - `Content-Disposition` com aspas escapadas em `http-headers.util.ts`; nomes com caracteres não-ASCII ficam sem `filename*`, o que o plano não pede.
  - `GET /videos/:slug` mapeia a entidade com `toVideoDetails`; `durationSeconds` sai de `numeric` (string no banco) como número.
  - O e2e prepara o vídeo chamando o processor direto, sem worker em execução: a fila não é consumida pelo teste.
  - Ponto não verificado: streaming de arquivo grande sem crescer a memória da API (AC da SI). Os testes usam fixture de 2 s; não há medição de memória.
  - Lint: 2 warnings antigos (`auth.service.integration-spec.ts:473`, `storage.service.integration-spec.ts:36`), fora desta SI.

### SI-03.9 — Documentação da arquitetura e do ambiente
- **Status:** completed
- **Tests:** documentação (sem teste novo). Verificação: full unit/integration 225/225 em 39 suites; full e2e 71/71 em 5 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors)
- **Observations:**
  - Documentação atualizada: `CLAUDE.md` raiz (Message Queue deixa de ser TBD; worker como segundo entrypoint; storage RustFS), `docs/diagrams/software-arch.mermaid` (fila BullMQ/Redis; `frontend → storage` como "Uploads parts (pre-signed)"; leitura via `frontend → api` com streaming proxied), e `nestjs-project/CLAUDE.md` (serviços, prontidão de cada serviço, variáveis `S3_*`/`REDIS_*`/`UPLOAD_*`, regra `S3_ENDPOINT` interno × `S3_PUBLIC_ENDPOINT`, comandos do worker, testes de vídeo).
  - Prontidão verificada na cópia WSL com o stack completo, seguindo os comandos escritos na doc: `valkey-cli ping` → `PONG`; health do RustFS exit 0; `rustfs-init` `Exited (0)`; `pg_isready` aceitando conexões.
  - **Defeito achado na verificação e corrigido:** o `WorkerModule` registrava só `Video` no `forFeature`. O worker em loop de erro (`Entity metadata for Video#channel was not found`). Corrigido registrando `Video`, `Channel` e `User` (a relação `Video → Channel → User` precisa dos três no metadata).
  - **Teste que não pegava o defeito:** o spec de integração do worker importava `AppModule`, que registra todas as entidades no processo do Jest, e escondia o erro. O spec agora importa só o `WorkerModule`. A fronteira da API foi para `src/worker/worker.module.spec.ts` (unit, nome do plano).
  - **Limitação do teste de regressão:** sem a correção, o spec de integração trava (o TypeORM fica em retry e a `beforeAll` não termina) em vez de falhar com mensagem. Ele detecta o defeito, mas por timeout. Ainda não foi transformado em falha rápida.
  - **Suítes de vídeo exigem o worker parado.** O `video-worker` consome a fila `video-processing` do mesmo Redis usado pelos testes: pega jobs que os testes enfileiram e faz o `obliterate` falhar com `Missing key for job`. Com o worker de pé, a asserção de job único falhou (0 em vez de 1). Documentado no `nestjs-project/CLAUDE.md`. Isolar a fila de teste (outro DB do Redis ou prefixo de fila) fica como tarefa separada.
  - Não verificado: o Mermaid não foi renderizado (sem mermaid-cli no ambiente); a sintaxe foi só revisada. O `docker compose stop video-worker` esperando o job em voo continua sem verificação em runtime (já registrado na SI-03.7).
  - Lint: 2 warnings antigos (`auth.service.integration-spec.ts:473`, `storage.service.integration-spec.ts:36`), fora desta SI.
