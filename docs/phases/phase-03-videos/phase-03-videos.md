---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-30T13:50:59+01:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-30T11:01:38+01:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-30T11:01:29+01:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-30T11:01:04+01:00"
  docs/project-plan.md: "2026-10-30T11:01:04+01:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB direto ao object storage (multipart retomável), com pré-cadastro do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano por fila e worker (extração de duração e metadados, geração de thumbnail), URL única por vídeo e reprodução via streaming e download.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços do Docker Compose

**Description:** Instala as libs de fila e storage, sobe MinIO, Redis/Valkey e o serviço do worker no Compose, e expõe as novas variáveis por configs namespaced validadas pelo Joi. É a fundação de infraestrutura de todos os SIs seguintes.

**Technical actions:**

1. Instalar `bullmq@^6.5.1`, `@nestjs/bullmq@^12.0.0`, `@aws-sdk/client-s3@^3.1160.0` e `@aws-sdk/s3-request-presigner@^3.1160.0` no `nestjs-project/` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`; versões em `library-refs.md`)
2. Atualizar `nestjs-project/Dockerfile.dev` — acrescentar `ffmpeg` ao `apt install` (inclui `ffprobe`), para a mesma imagem servir API e worker (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Atualizar `nestjs-project/compose.yaml`, sempre referenciando hosts pelo nome do serviço:
   - `minio`: última tag publicada de `minio/minio`, fixada; portas 9000/9001; volume nomeado; healthcheck.
   - `minio-init`: `minio/mc` fixado, roda uma vez; cria `S3_BUCKET` privado e aplica CORS com `PUT`/`GET`/`HEAD` e `ExposeHeaders: ["ETag"]` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`).
   - `redis`: Redis 7.x ou Valkey, imagem fixada; healthcheck (per `phase-03-videos/TD-01`).
   - `video-worker`: mesmo `build` da API, `command` = script do worker criado no SI-03.7, `depends_on` de `db`, `redis` e `minio-init` (per `phase-03-videos/TD-06`).
   - `nestjs-api`: passa a depender de `redis` e `minio-init`.
4. Acrescentar ao `src/config/env.validation.ts` e ao `.env.example`:
   - `S3_ENDPOINT` (`http://minio:9000`), `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`), `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (per `phase-03-videos/TD-04`);
   - `REDIS_HOST` (`redis`), `REDIS_PORT`;
   - `UPLOAD_MAX_BYTES` (default `10737418240`), `UPLOAD_PART_SIZE_BYTES` (default `67108864`), `UPLOAD_URL_TTL_SECONDS` (default `3600`) (per `phase-03-videos/TD-12`).
5. Criar `src/config/storage.config.ts`, `src/config/queue.config.ts` e `src/config/upload.config.ts` com `registerAs`, e registrá-los no `load` do `ConfigModule.forRoot` (convenção herdada da Fase 01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas chaves obrigatórias rejeitadas quando ausentes; defaults de `UPLOAD_*` aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `redis` e `video-worker`, e `docker compose ps` mostra `minio` e `redis` saudáveis
- Depois de `minio-init` terminar com código 0, o bucket `S3_BUCKET` existe e responde a um preflight CORS de `PUT` com `Access-Control-Expose-Headers` contendo `ETag`
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` saem com código 0
- Subir a API sem `S3_BUCKET` (ou sem qualquer outra chave obrigatória nova) falha no bootstrap com erro de validação do Joi que nomeia a chave
- Sem `UPLOAD_MAX_BYTES` no ambiente, a config resolve `10737418240`

---

### SI-03.2 — StorageModule: wrapper S3 com dois clientes

**Description:** Encapsula todo o acesso ao object storage num `StorageService` (multipart, presign, head, leitura por faixa, put e delete). É usado pela API e pelo worker, para que nenhum outro módulo fale com o SDK diretamente.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.constants.ts` com dois providers de `S3Client`, ambos com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'` (gotcha do `library-refs.md` → `@aws-sdk/client-s3`):
   - `S3_INTERNAL_CLIENT`, em `S3_ENDPOINT`, para as chamadas de dados;
   - `S3_PUBLIC_CLIENT`, em `S3_PUBLIC_ENDPOINT`, só para assinar URLs entregues ao navegador (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`).
2. Criar `src/storage/storage.service.ts` — métodos de multipart e de assinatura (per `phase-03-videos/TD-03`, `phase-03-videos/TD-07`):
   - `createMultipartUpload(key, contentType)`, `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)`;
   - `presignUploadParts(key, uploadId, partNumbers, expiresIn)`, assinado com o cliente **público**;
   - `presignGetObject(key, expiresIn)`, assinado com o cliente **interno**, para o worker.
   - Rejeições do `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`) viram `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`), criada em `src/common/exceptions/domain.exception.ts`.
3. Completar `StorageService` com `headObject(key)` → `{ contentLength, contentType }`, `getObjectStream(key, range?)` → `{ body: Readable, contentLength, contentRange?, contentType }`, `putObject(key, body, contentType)` e `deleteObject(key)` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-12`)
4. Criar `src/test/minio.ts`, no modelo de `src/test/mailpit.ts`: helpers para garantir o bucket e apagar o prefixo `videos/` entre testes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation (dois clientes injetáveis, `StorageService` exportado) | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration contra o MinIO real: multipart via `PUT` nas URLs assinadas, `listParts`, complete, `headObject`, leitura com `Range`, abort, `INVALID_UPLOAD_PARTS` com `ETag` errado, host das URLs = `S3_PUBLIC_ENDPOINT` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — libs, MinIO e `storage.config` precisam existir

**Acceptance criteria:**

- Um arquivo enviado em 2 partes por `PUT` nas URLs de `presignUploadParts` e concluído com os `ETag`s retornados vira um objeto cujo `headObject` informa o tamanho somado das partes
- As URLs de `presignUploadParts` usam o host de `S3_PUBLIC_ENDPOINT`, e as de `presignGetObject` usam o host de `S3_ENDPOINT`
- `listParts` depois do envio de só a parte 1 retorna exatamente `[{ partNumber: 1, … }]`
- `completeMultipartUpload` com um `ETag` divergente lança `INVALID_UPLOAD_PARTS`
- `getObjectStream(key, 'bytes=0-99')` devolve 100 bytes iguais aos 100 primeiros do arquivo enviado, com `contentRange` `bytes 0-99/<total>`
- Depois de `abortMultipartUpload`, `listParts` para o mesmo `uploadId` falha, ou seja, o upload não existe mais no storage

---

### SI-03.3 — Entidade Video e migration CreateVideos

**Description:** Cria a tabela `videos` conforme o Data Model, com os dois status independentes e o slug único. É a base de persistência do upload e do processamento.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com as colunas do `### Data Model → Video`:
   - enums TypeScript `VideoProcessingStatus` (`uploading`, `processing`, `ready`, `failed`) e `VideoPublicationStatus` (`draft`) (per `phase-03-videos/TD-05`);
   - transformer `bigint ↔ number` em `size_bytes`;
   - `@ManyToOne(() => Channel)` com `onDelete: 'CASCADE'` via `channel_id`.
2. Acrescentar em `src/channels/entities/channel.entity.ts` a relação inversa `@OneToMany(() => Video, (video) => video.channel)`
3. Gerar a migration `CreateVideos` com `npm run migration:generate` dentro do container: tipos enum `video_processing_status` e `video_publication_status`, FK com `ON DELETE CASCADE`, índice único em `slug` e índice em `channel_id` (convenção herdada: migrations via CLI, `synchronize: false`)
4. Incluir `videos` no `cleanAllTables` de `src/test/create-test-data-source.ts`, antes de `channels`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults `uploading`/`draft`, `slug` único, cascade ao apagar o canal, round-trip de `size_bytes` acima de 2^32 | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: `CreateVideos` aplica e reverte sem erro | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um vídeo informando só os campos obrigatórios persiste `processing_status = 'uploading'` e `publication_status = 'draft'`
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade (`23505`)
- Apagar o canal dono apaga os vídeos dele
- Um vídeo salvo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`
- `npm run migration:run` seguido de `npm run migration:revert` deixa o banco sem a tabela `videos` e sem os dois tipos enum

---

### SI-03.4 — Gerador de slug e produtor da fila de processamento

**Description:** Entrega o identificador público dos vídeos e o lado produtor da fila `video-processing`, com o contrato do job fixado num único lugar. A API e o worker compartilham esse contrato.

**Technical actions:**

1. Criar `src/videos/slug.util.ts` — `generateVideoSlug(): string` com 11 caracteres do alfabeto `[0-9A-Za-z]`, usando `crypto.randomBytes` com rejection sampling, sem viés de módulo (per `phase-03-videos/TD-09`)
2. Criar `src/video-processing/video-processing.constants.ts` com o contrato do `### Events/Messages → video-processing / process-video` (per `phase-03-videos/TD-08`):
   - `VIDEO_PROCESSING_QUEUE = 'video-processing'` e `PROCESS_VIDEO_JOB = 'process-video'`;
   - tipo `ProcessVideoJobData = { videoId: string }`;
   - `PROCESS_VIDEO_JOB_OPTIONS` = `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false`.
3. Criar `src/video-processing/video-processing-queue.module.ts` — `BullModule.forRootAsync` injetando `queueConfig.KEY` (`connection: { host, port }`) + `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; exporta o `BullModule` para que produtor e worker compartilhem a mesma fila (per `phase-03-videos/TD-01`)
4. Criar `src/video-processing/video-processing.producer.ts` — `VideoProcessingProducer.enqueue(videoId)` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)` → `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })` (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: tamanho 11, só `[0-9A-Za-z]`, sem repetição em 10 000 geradas | `src/videos/slug.util.spec.ts` |
| `VideoProcessingQueueModule` | Unit: compilation (fila resolvível via `getQueueToken`) | `src/video-processing/video-processing-queue.module.spec.ts` |
| `VideoProcessingProducer` | Integration com o Redis real: job com `jobId = videoId`, nome `process-video`, `attempts`/`backoff` esperados; enfileirar duas vezes gera um único job | `src/video-processing/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.1 — `@nestjs/bullmq`, Redis e `queue.config` precisam existir

**Acceptance criteria:**

- Todo slug gerado tem 11 caracteres de `[0-9A-Za-z]`
- `enqueue(videoId)` cria na fila `video-processing` um job `process-video` com `data = { videoId }`, `id = videoId`, `attempts = 3` e backoff exponencial de 5000 ms
- Chamar `enqueue` duas vezes seguidas para o mesmo `videoId` deixa um único job na fila

---

### SI-03.5 — VideosService: iniciar, assinar, concluir e abortar o upload

**Description:** Implementa as regras do fluxo de upload no service: rascunho criado ao iniciar, URLs por parte, conclusão com verificação de tamanho e enfileiramento, e abort. Cobre os erros do `### Error Catalog` desse fluxo.

**Technical actions:**

1. Criar em `src/common/exceptions/domain.exception.ts` as exceções do `### Error Catalog`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `UploadNotInProgressException` (`UPLOAD_NOT_IN_PROGRESS`, 409) e `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422). Acrescentar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` (o canal é dono do vídeo; o service de vídeos não consulta `channels` diretamente)
2. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`, todo o fluxo dentro do service:
   - resolve o canal do usuário;
   - gera `id` (`crypto.randomUUID()`) e `storage_key = videos/{id}/original`;
   - chama `storage.createMultipartUpload` e persiste o vídeo com `upload_id`, `title = fileName`, `processing_status = uploading` e `publication_status = draft` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`);
   - slug via `generateVideoSlug()` com até 5 tentativas em `23505`, no padrão de `channels.service.ts` (per `phase-03-videos/TD-09`);
   - se a persistência falhar de vez, chama `abortMultipartUpload`.
   - Retorna `{ slug, processingStatus, publicationStatus, partSizeBytes, partCount, maxBytes, urlTtlSeconds }` (`### API Contracts → POST /videos/uploads`).
3. Implementar `signUploadParts(userId, slug, partNumbers)` e `listUploadedParts(userId, slug)`:
   - carregam o vídeo pelo slug e checam se é do canal do usuário (outro dono → `VIDEO_NOT_FOUND`, per `phase-03-videos/TD-11`);
   - exigem `processing_status = uploading` (`UPLOAD_NOT_IN_PROGRESS`);
   - validam cada `partNumber` em `1..partCount` (fora disso → `VALIDATION_ERROR`);
   - delegam a `storage.presignUploadParts` com TTL de `UPLOAD_URL_TTL_SECONDS` e a `storage.listParts` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).
4. Implementar `completeUpload(userId, slug, parts)` — mesmas checagens de dono e de status, depois (per `phase-03-videos/TD-08`, `phase-03-videos/TD-12`):
   - chama `storage.completeMultipartUpload`, que pode lançar `INVALID_UPLOAD_PARTS`;
   - chama `storage.headObject`;
   - se `contentLength` for maior que `size_bytes`: `storage.deleteObject` + `processing_status = failed` com `processing_error`, e lança `UPLOAD_SIZE_MISMATCH`;
   - senão: grava `size_bytes = contentLength`, `upload_id = null`, `processing_status = processing` e chama `VideoProcessingProducer.enqueue(video.id)`.
5. Implementar `abortUpload(userId, slug)` — mesmas checagens de dono e de status, `storage.abortMultipartUpload` e remoção do registro do vídeo

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit (storage, producer e repositório mockados): outro dono → `VIDEO_NOT_FOUND`; status ≠ `uploading` → `UPLOAD_NOT_IN_PROGRESS`; tamanho maior → delete + `failed` + `UPLOAD_SIZE_MISMATCH`; retry de slug em `23505`; abort do multipart quando a persistência falha; `partNumber` fora de `1..partCount` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (Postgres, MinIO e Redis reais): init persiste rascunho com `upload_id`; complete leva a `processing` e deixa um job `process-video` com `id = videoId`; abort remove o registro e o multipart | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.3 (entidade `Video`), SI-03.4 (slug e produtor)

**Acceptance criteria:**

- `initiateUpload` de um arquivo de 150 MiB com `UPLOAD_PART_SIZE_BYTES` de 64 MiB persiste um vídeo `uploading`/`draft` no canal do usuário, com `upload_id` preenchido, e retorna `partCount = 3`
- `signUploadParts` para um vídeo de outro canal lança `VIDEO_NOT_FOUND`
- `signUploadParts`, `completeUpload` e `abortUpload` em um vídeo já `processing` lançam `UPLOAD_NOT_IN_PROGRESS`
- `completeUpload` com todas as partes enviadas deixa o vídeo `processing`, com `upload_id = null`, `size_bytes` igual ao tamanho real do objeto e um job `process-video` na fila
- `completeUpload` de um objeto maior que o tamanho declarado deixa o vídeo `failed`, apaga o objeto do bucket e lança `UPLOAD_SIZE_MISMATCH`, sem enfileirar job
- `abortUpload` remove o registro do vídeo e o multipart deixa de existir no storage

---

### SI-03.6 — VideosController: endpoints de upload

**Route:** POST /videos/uploads, POST /videos/:slug/upload/parts, GET /videos/:slug/upload/parts, POST /videos/:slug/upload/complete, DELETE /videos/:slug/upload
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (`POST /videos/uploads`); Owner (demais), conforme `### Authorization Matrix`

**Description:** Expõe o fluxo de upload por HTTP com DTOs validados, documentação OpenAPI e o módulo `VideosModule` registrado na API.

**Technical actions:**

1. Criar os DTOs em `src/videos/dto/` exatamente como no `### API Contracts` e no `#### Validation Rules — Upload` (class-validator, per `phase-02-auth/TD-06`):
   - `InitiateUploadDto` (`fileName`, `contentType` com `@IsIn` da allowlist, `sizeBytes` com `@Max` vindo de `UPLOAD_MAX_BYTES`);
   - `SignUploadPartsDto` (`partNumbers`, 1–100 únicos);
   - `CompleteUploadDto` com `CompletedPartDto[]` (`partNumber` 1..10000, `etag`);
   - DTOs de resposta.
2. Criar `src/videos/pipes/parse-video-slug.pipe.ts` — `ParseVideoSlugPipe` aceita só `^[0-9A-Za-z]{11}$`; qualquer outro valor lança `VIDEO_NOT_FOUND`
3. Criar `src/videos/videos.controller.ts` com prefixo `videos` e as 5 rotas:
   - `POST uploads` → 201;
   - `POST :slug/upload/parts` → 200;
   - `GET :slug/upload/parts` → 200;
   - `POST :slug/upload/complete` → `@HttpCode(202)`;
   - `DELETE :slug/upload` → `@HttpCode(204)`.
   - Usuário via `@CurrentUser()` (`sub`); nenhuma rota `@Public()` (per `phase-03-videos/TD-11`).
4. Criar `src/videos/videos.module.ts` (importa `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `VideoProcessingQueueModule`; provê `VideosService` e `VideoProcessingProducer`) e registrá-lo no `AppModule` **sem** importar o processor do worker (per `phase-03-videos/TD-06`)
5. Documentar as 5 rotas com `@ApiTags`, `@ApiOperation`, `@ApiBearerAuth`, `@ApiParam`, `@ApiBody` e `@ApiResponse` por status, incluindo o envelope de erro (per `openapi-docs-nestjs/TD-01`, revisão de 2026-05-12), e regenerar `nestjs-project/openapi.json` com `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation (DI de storage, fila, canais e repositório) | `src/videos/videos.module.spec.ts` |
| `ParseVideoSlugPipe` | Unit: aceita 11 caracteres base62; rejeita tamanho errado, caracteres fora do alfabeto e vazio com `VIDEO_NOT_FOUND` | `src/videos/pipes/parse-video-slug.pipe.spec.ts` |

**Dependencies:** SI-03.5 — o controller delega ao `VideosService`

**Acceptance criteria:**

- `POST /videos/uploads` com `{ fileName: "clip.mp4", contentType: "video/mp4", sizeBytes: 1048576 }` e JWT válido retorna `201` com `slug` de 11 caracteres, `processingStatus: "uploading"`, `publicationStatus: "draft"` e `partCount: 1`
- `POST /videos/uploads` com `contentType: "image/png"` ou `sizeBytes` acima de `UPLOAD_MAX_BYTES` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos/uploads` sem `Authorization` retorna `401`
- `POST /videos/:slug/upload/parts` com `{ partNumbers: [1] }` retorna `200` com uma URL cujo `PUT` direto no storage responde `200` e expõe `ETag`
- `POST /videos/:slug/upload/complete` com as partes enviadas retorna `202` com `processingStatus: "processing"`
- `POST /videos/:slug/upload/complete` com um `etag` errado retorna `400` com `error: "INVALID_UPLOAD_PARTS"`
- `DELETE /videos/:slug/upload` do dono retorna `204`, e um `GET /videos/:slug/upload/parts` seguinte retorna `404` com `VIDEO_NOT_FOUND`
- Qualquer rota `/videos/:slug/**` chamada por outro usuário autenticado, ou com slug malformado, retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `nestjs-project/openapi.json` passa a listar as 5 rotas, com os schemas de request/response e as respostas de erro documentadas

---

### SI-03.7 — Worker: processo separado e processamento do vídeo

**Description:** Cria o processo `video-worker`, que consome `video-processing`, extrai duração e metadados com `ffprobe`, gera o thumbnail com `ffmpeg` e leva o vídeo a `ready` ou, depois da última tentativa, a `failed`.

**Technical actions:**

1. Criar `src/media/media-probe.service.ts` — `MediaProbeService`, usando `child_process.spawn` sem wrapper (per `phase-03-videos/TD-07`):
   - `probe(url)` roda `ffprobe -v error -print_format json -show_format -show_streams <url>` e devolve `{ durationSeconds, metadata: { formatName, bitRate, width, height, videoCodec, audioCodec, frameRate } }`;
   - `extractThumbnail(url, atSeconds)` roda `ffmpeg -ss <atSeconds> -i <url> -frames:v 1 -f image2 -c:v mjpeg pipe:1` e devolve um `Buffer` JPEG;
   - ambos têm timeout e lançam erro com o stderr quando o código de saída é diferente de 0.
2. Criar `src/video-processing/video-processing.processor.ts` — `VideoProcessingProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)`, estende `WorkerHost`). `process(job)` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-08`):
   - carrega o vídeo e ignora se já estiver `ready` (idempotência);
   - gera `presignGetObject(storage_key)` com o cliente interno;
   - roda `probe`, depois `extractThumbnail` em ~10% da duração;
   - grava `videos/{id}/thumbnail.jpg` com `putObject` e salva `ready`, `duration_seconds`, `metadata`, `thumbnail_key` e `processed_at`.
   - Em erro: se `job.attemptsMade + 1 >= job.opts.attempts`, grava `failed` + `processing_error`; em todos os casos relança o erro para o BullMQ.
3. Criar `src/worker/worker.module.ts` (config, TypeORM, `StorageModule`, `VideoProcessingQueueModule`, `MediaProbeService`, `VideoProcessingProcessor`) e `src/worker/main.ts`:
   - `main.ts` usa `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`, para que o `worker.close()` espere os jobs em andamento;
   - acrescentar ao `package.json` os scripts `start:worker` (`node dist/worker/main`) e `start:worker:dev` (watch), este último usado pelo serviço `video-worker` do Compose (per `phase-03-videos/TD-06`).
4. Criar `src/test/video-fixtures.ts` — gera vídeos de teste com `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=25` (MP4 válido) e um arquivo não-vídeo, ambos em diretório temporário

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration com o FFmpeg real: fixture de 2s → `durationSeconds` ≈ 2, `width = 320`, `height = 240`; thumbnail começa com os bytes JPEG `FF D8`; arquivo não-vídeo lança erro | `src/media/media-probe.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit: última tentativa → `failed` + `processing_error` + relança; tentativa não final → relança sem gravar `failed`; vídeo já `ready` → não chama `probe` | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration (Postgres, MinIO e FFmpeg reais): fixture válida → `ready` com `duration_seconds`, `metadata` e thumbnail no bucket; arquivo inválido na última tentativa → `failed` | `src/video-processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation; o `AppModule` da API não registra `VideoProcessingProcessor` | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.3 (entidade `Video`), SI-03.4 (contrato da fila)

**Acceptance criteria:**

- Com o serviço `video-worker` rodando, um vídeo válido que entra na fila chega a `processing_status = 'ready'`, com `duration_seconds` > 0, `metadata.width`/`metadata.height` preenchidos, `thumbnail_key = videos/{id}/thumbnail.jpg` e `processed_at` não nulo
- O objeto `videos/{id}/thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`
- Um arquivo que não é vídeo é tentado 3 vezes e termina `processing_status = 'failed'`, com `processing_error` não vazio; antes da terceira tentativa o status continua `processing`
- Reenfileirar um vídeo já `ready` não altera `duration_seconds`, `metadata` nem `thumbnail_key`
- O worker processa o vídeo sem baixar o original para o disco local: nenhum arquivo do tamanho do original é criado no container durante o job
- `docker compose stop video-worker` durante um job espera o job terminar ou falhar antes de o processo sair

---

### SI-03.8 — VideosController: metadados, streaming, download e thumbnail

**Route:** GET /videos/:slug, GET /videos/:slug/stream, GET /videos/:slug/download, GET /videos/:slug/thumbnail
**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`
**Authorization:** Owner, conforme `### Authorization Matrix`

**Description:** Expõe a leitura do vídeo pelo dono: metadados, reprodução por faixa (`206`), download como anexo e thumbnail. A API faz proxy do storage, sem redirecionar para URL pré-assinada.

**Technical actions:**

1. Criar em `src/common/exceptions/domain.exception.ts` `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) e `RangeNotSatisfiableException` (`RANGE_NOT_SATISFIABLE`, 416). Garantir que o filtro global devolva `Content-Range: bytes */<total>` nesse 416, passando o tamanho pela exceção. Acrescentar ao `VideosService`:
   - `getOwnedVideo(userId, slug)` — só checa dono, para os metadados;
   - `getReadyVideo(userId, slug)` — exige `ready` e lança `VIDEO_NOT_READY` (per `phase-03-videos/TD-11`).
2. Criar `src/videos/range.util.ts` — `parseRange(header, totalBytes)`:
   - `undefined` quando não há header;
   - `{ start, end }` para `bytes=a-b`, `bytes=a-` e `bytes=-n`, com `end` limitado a `total-1`;
   - `RANGE_NOT_SATISFIABLE` para formato inválido, múltiplas faixas ou `start ≥ total`.
3. Acrescentar ao `VideosController`, com o mesmo `ParseVideoSlugPipe` (per `phase-03-videos/TD-10`):
   - `GET :slug` → resposta do `### API Contracts → GET /videos/:slug`;
   - `GET :slug/stream` e `GET :slug/download` → `storage.getObjectStream(storage_key, range)` devolvido com `StreamableFile`;
     - status `206` + `Content-Range` com Range, `200` sem;
     - sempre `Accept-Ranges: bytes`, `Content-Type` e `Content-Length`;
     - download acrescenta `Content-Disposition: attachment; filename="<original_file_name>"`.
   - `GET :slug/thumbnail` → stream de `thumbnail_key` com `image/jpeg`.
4. Documentar as 4 rotas com decoradores explícitos do `@nestjs/swagger` (`@ApiProduces`, respostas `200`/`206`/`404`/`409`/`416`) e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseRange` | Unit: `bytes=0-99`, `bytes=100-`, `bytes=-50`, `end` acima do total, múltiplas faixas, `start ≥ total`, formato inválido | `src/videos/range.util.spec.ts` |
| `VideosService` (leitura) | Unit: `getReadyVideo` lança `VIDEO_NOT_READY` para `uploading`/`processing`/`failed`; outro dono → `VIDEO_NOT_FOUND` | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.6 (controller e módulo), SI-03.7 (vídeos chegam a `ready` com thumbnail)

**Acceptance criteria:**

- `GET /videos/:slug` do dono retorna `200` com `processingStatus`, `publicationStatus: "draft"`, `durationSeconds`, `metadata` e `hasThumbnail` coerentes com o estado do vídeo
- `GET /videos/:slug/stream` com `Range: bytes=0-1023` num vídeo `ready` retorna `206`, `Content-Range: bytes 0-1023/<size_bytes>`, `Content-Length: 1024`, `Accept-Ranges: bytes` e os 1024 primeiros bytes do original
- `GET /videos/:slug/stream` sem `Range` retorna `200` com `Content-Length` igual a `size_bytes`
- `GET /videos/:slug/stream` com `Range: bytes=<size_bytes>-` retorna `416` com `error: "RANGE_NOT_SATISFIABLE"` e `Content-Range: bytes */<size_bytes>`
- `GET /videos/:slug/download` retorna `Content-Disposition: attachment; filename="<original_file_name>"` e aceita `Range` com `206`
- `GET /videos/:slug/thumbnail` de um vídeo `ready` retorna `200` com `Content-Type: image/jpeg`
- `stream`, `download` e `thumbnail` de um vídeo `processing` ou `failed` retornam `409` com `error: "VIDEO_NOT_READY"`
- Outro usuário autenticado recebe `404` com `VIDEO_NOT_FOUND` nas 4 rotas, inclusive para vídeos `ready`
- O streaming de um vídeo grande não faz a memória da API crescer na proporção do arquivo (o corpo é repassado em stream)

---

### SI-03.9 — Documentação da arquitetura e do ambiente

**Description:** Atualiza o `CLAUDE.md` raiz, o do `nestjs-project/` e o diagrama C4 com o que a fase introduziu (fila, worker, storage, variáveis e como testar), para que as próximas fases herdem esse contexto.

**Technical actions:**

1. Atualizar `CLAUDE.md` (raiz) — a Message Queue deixa de ser "TBD" e passa a ser BullMQ sobre Redis/Valkey; a Repository Structure e a Architecture citam o worker como segundo entrypoint do `nestjs-project/` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`)
2. Atualizar `docs/diagrams/software-arch.mermaid`:
   - a Message Queue passa a "BullMQ / Redis";
   - a aresta `frontend → storage` passa a "Uploads parts (pre-signed)";
   - a leitura de vídeo passa a ser `frontend → api` (streaming proxied, per `phase-03-videos/TD-03`, `phase-03-videos/TD-10`).
3. Atualizar `nestjs-project/CLAUDE.md`:
   - serviços `minio`, `minio-init`, `redis` e `video-worker`, com as verificações de prontidão (`redis-cli ping`, healthcheck do MinIO);
   - variáveis `S3_*`, `REDIS_*` e `UPLOAD_*`, incluindo a regra `S3_ENDPOINT` interno × `S3_PUBLIC_ENDPOINT`;
   - como subir e ver os logs do worker;
   - que os testes de integração e e2e de vídeo exigem MinIO, Redis e FFmpeg reais.

**Tests:** _(empty — documentação; verificada pelos critérios de aceite)_

**Dependencies:** SI-03.7 (worker), SI-03.8 (endpoints de leitura)

**Acceptance criteria:**

- O `CLAUDE.md` raiz não menciona mais a Message Queue como "TBD" e descreve o worker
- `docs/diagrams/software-arch.mermaid` renderiza sem erro e mostra a fila como BullMQ/Redis
- Seguindo só o `nestjs-project/CLAUDE.md`, um desenvolvedor sobe o ambiente completo (incluindo `minio`, `redis` e `video-worker`), confirma a prontidão de cada serviço e roda as suítes de teste

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Identificador interno; nunca exposto na URL (per `phase-03-videos/TD-09`) |
| slug | varchar(11) | unique, not null | Identificador público base62 de 11 caracteres, gerado com `crypto.randomBytes`; colisão → retry em `23505` (per `phase-03-videos/TD-09`) |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Canal dono do vídeo |
| title | varchar(255) | not null | Inicialmente o `fileName` declarado no init; editável na Fase 04 |
| original_file_name | varchar(255) | not null | Nome do arquivo declarado pelo cliente no init |
| content_type | varchar(100) | not null | MIME declarado no init (allowlist `video/*`, per `phase-03-videos/TD-12`) |
| size_bytes | bigint | not null | Tamanho declarado no init; sobrescrito pelo `ContentLength` real do `HeadObject` no complete (per `phase-03-videos/TD-12`). Transformer `bigint ↔ number` na entidade |
| processing_status | enum `video_processing_status` (`uploading`, `processing`, `ready`, `failed`) | not null, default `uploading` | Ciclo de processamento, escrito pela API (`uploading` → `processing`) e pelo worker (`ready` / `failed`) (per `phase-03-videos/TD-05`) |
| publication_status | enum `video_publication_status` (`draft`) | not null, default `draft` | Ciclo de publicação; nasce `draft` (rascunho ao iniciar o upload). A Fase 04 acrescenta `published` e a visibilidade (per `phase-03-videos/TD-05`) |
| storage_key | varchar(255) | not null | Chave do original no bucket: `videos/{id}/original` (per `phase-03-videos/TD-02`) |
| upload_id | varchar(255) | nullable | `UploadId` do multipart em andamento; zerado no complete e no abort (per `phase-03-videos/TD-03`) |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, preenchido pelo worker (per `phase-03-videos/TD-07`) |
| duration_seconds | numeric(10,3) | nullable | Extraído pelo `ffprobe` (per `phase-03-videos/TD-07`) |
| metadata | jsonb | nullable | Subconjunto do `ffprobe`: `formatName`, `bitRate`, `width`, `height`, `videoCodec`, `audioCodec`, `frameRate` |
| processing_error | text | nullable | Mensagem da última falha, gravada só após a tentativa final (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`) |
| processed_at | timestamptz | nullable | Momento em que o vídeo ficou `ready` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many)
**Indexes:** `(slug)` — unique; `(channel_id)`

**Object storage layout** (bucket único e privado `S3_BUCKET`, per `phase-03-videos/TD-02`):

| Key | Escrito por | Conteúdo |
|-----|-------------|----------|
| `videos/{videoId}/original` | Navegador, via URLs pré-assinadas de `UploadPart` (per `phase-03-videos/TD-03`) | Arquivo original, intacto |
| `videos/{videoId}/thumbnail.jpg` | Worker, via `PutObject` (per `phase-03-videos/TD-07`) | Frame JPEG extraído em ~10% da duração |

### API Contracts

Todos os endpoints exigem `Authorization: Bearer <accessToken>` (guard global de `phase-02-auth/TD-02`); nenhum é `@Public()` nesta fase (per `phase-03-videos/TD-11`). Erros seguem o envelope `{ statusCode, error, message }` de `phase-02-auth/TD-07`. Todos são documentados com decoradores explícitos do `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`, revisão de 2026-05-12) e o `openapi.json` é reexportado (per `openapi-docs-nestjs/TD-02`).

#### POST /videos/uploads (SI-03.6)

Inicia o upload: cria o vídeo como rascunho (`processing_status = uploading`, `publication_status = draft`) e o multipart no storage (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <accessToken>

**Request body:**
- fileName: string, required — 1 a 255 caracteres
- contentType: string, required — um de `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` (per `phase-03-videos/TD-12`)
- sizeBytes: integer, required — 1 a `UPLOAD_MAX_BYTES` (10 GiB por padrão, per `phase-03-videos/TD-12`)

**Response 201:**
- slug: string — identificador público de 11 caracteres
- processingStatus: `"uploading"`
- publicationStatus: `"draft"`
- partSizeBytes: integer — `UPLOAD_PART_SIZE_BYTES`
- partCount: integer — `ceil(sizeBytes / partSizeBytes)`
- maxBytes: integer — `UPLOAD_MAX_BYTES`
- urlTtlSeconds: integer — `UPLOAD_URL_TTL_SECONDS`

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido, `contentType` fora da allowlist ou `sizeBytes` acima do máximo
- 401 Unauthorized: token ausente ou inválido

---

#### POST /videos/:slug/upload/parts (SI-03.6)

Gera URLs pré-assinadas de `UploadPart`, assinadas com o cliente público (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <accessToken>

**Request body:**
- partNumbers: integer[], required — 1 a 100 itens, únicos, cada um entre 1 e `partCount`

**Response 200:**
- parts: array of `{ partNumber: integer, url: string }` — `PUT` direto ao storage; o navegador lê o header `ETag` de cada resposta
- expiresAt: string (ISO-8601) — `now + UPLOAD_URL_TTL_SECONDS`

**Error responses:**
- 400 VALIDATION_ERROR: `partNumbers` vazio, duplicado ou fora de `1..partCount`
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` diferente de `uploading`

---

#### GET /videos/:slug/upload/parts (SI-03.6)

Lista as partes já recebidas pelo storage, para retomar o upload (`ListParts`, per `phase-03-videos/TD-03`).

**Request headers:**
- Authorization: Bearer <accessToken>

**Response 200:**
- parts: array of `{ partNumber: integer, etag: string, sizeBytes: integer }`, ordenado por `partNumber`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` diferente de `uploading`

---

#### POST /videos/:slug/upload/complete (SI-03.6)

Conclui o multipart, confere o tamanho real e enfileira o processamento (per `phase-03-videos/TD-08`, `phase-03-videos/TD-12`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <accessToken>

**Request body:**
- parts: array, required — 1 a 10 000 itens de `{ partNumber: integer (1..10000), etag: string }`, sem `partNumber` repetido

**Response 202:**
- slug: string
- processingStatus: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido
- 400 INVALID_UPLOAD_PARTS: o storage rejeitou a lista de partes (parte ausente, `ETag` divergente ou ordem inválida)
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` diferente de `uploading`
- 422 UPLOAD_SIZE_MISMATCH: `HeadObject.ContentLength` maior que o `sizeBytes` declarado; o objeto é apagado e o vídeo vai para `failed`

---

#### DELETE /videos/:slug/upload (SI-03.6)

Aborta o upload em andamento (`AbortMultipartUpload`) e remove o rascunho.

**Request headers:**
- Authorization: Bearer <accessToken>

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` diferente de `uploading`

---

#### GET /videos/:slug (SI-03.8)

**Request headers:**
- Authorization: Bearer <accessToken>

**Response 200:**
- slug: string
- title: string
- originalFileName: string
- contentType: string
- sizeBytes: integer
- processingStatus: `"uploading" | "processing" | "ready" | "failed"`
- publicationStatus: `"draft"`
- durationSeconds: number | null
- metadata: object | null — `{ formatName, bitRate, width, height, videoCodec, audioCodec, frameRate }`
- hasThumbnail: boolean
- processingError: string | null
- createdAt: string (ISO-8601)
- processedAt: string (ISO-8601) | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal

---

#### GET /videos/:slug/stream (SI-03.8)

A API repassa o `Range` ao `GetObject` e devolve o corpo em stream, sem bufferizar (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer <accessToken>
- Range: `bytes=<start>-<end>`, optional — uma única faixa

**Response 206 (com `Range`):** corpo binário com `Content-Type` = `content_type` do vídeo, `Content-Range: bytes <start>-<end>/<total>`, `Content-Length` da faixa, `Accept-Ranges: bytes`

**Response 200 (sem `Range`):** corpo binário completo, `Content-Length`, `Accept-Ranges: bytes`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 VIDEO_NOT_READY: `processing_status` diferente de `ready`
- 416 RANGE_NOT_SATISFIABLE: faixa malformada, múltiplas faixas ou início além do tamanho; responde `Content-Range: bytes */<total>`

---

#### GET /videos/:slug/download (SI-03.8)

Mesmo comportamento de `/stream`, acrescido de `Content-Disposition: attachment; filename="<original_file_name>"` (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer <accessToken>
- Range: `bytes=<start>-<end>`, optional — permite retomar o download

**Response 200 / 206:** como em `/stream`, com `Content-Disposition: attachment`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 VIDEO_NOT_READY: `processing_status` diferente de `ready`
- 416 RANGE_NOT_SATISFIABLE: faixa inválida

---

#### GET /videos/:slug/thumbnail (SI-03.8)

**Request headers:**
- Authorization: Bearer <accessToken>

**Response 200:** corpo `image/jpeg` lido de `thumbnail_key`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 VIDEO_NOT_READY: `processing_status` diferente de `ready`

---

#### Validation Rules — Upload

- `fileName`: required, string, 1–255 caracteres
- `contentType`: required, um de `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- `sizeBytes`: required, inteiro, `1 ≤ sizeBytes ≤ UPLOAD_MAX_BYTES`
- `partNumbers`: required, array de inteiros únicos, 1–100 itens, cada um em `1..partCount` (o limite superior é verificado no service, pois depende do vídeo)
- `parts`: required, array de 1–10 000 itens; `partNumber` inteiro em `1..10000` e único; `etag` string não vazia
- `:slug`: 11 caracteres `[0-9A-Za-z]`; slug com outro formato responde 404 `VIDEO_NOT_FOUND`

### Authorization Matrix

Leitura, stream, download e thumbnail são exclusivos do dono do canal até a publicação, que chega na Fase 04 (per `phase-03-videos/TD-11`). "Owner" = o `sub` do JWT é o `user_id` do canal dono do vídeo. Acesso de outro usuário responde 404 `VIDEO_NOT_FOUND`, sem revelar que o slug existe.

| Endpoint | Public | Authenticated | Owner | Notes |
|----------|--------|---------------|-------|-------|
| POST /videos/uploads | | ✓ | | Cria o vídeo no canal do usuário autenticado |
| POST /videos/:slug/upload/parts | | | ✓ | |
| GET /videos/:slug/upload/parts | | | ✓ | |
| POST /videos/:slug/upload/complete | | | ✓ | |
| DELETE /videos/:slug/upload | | | ✓ | |
| GET /videos/:slug | | | ✓ | Fase 04 abre para `published`/unlisted via auth opcional |
| GET /videos/:slug/stream | | | ✓ | Idem |
| GET /videos/:slug/download | | | ✓ | Idem |
| GET /videos/:slug/thumbnail | | | ✓ | Idem |
| `PUT` nas URLs pré-assinadas (storage) | assinatura | | | Autorizado pela assinatura SigV4 emitida para o dono; expira em `UPLOAD_URL_TTL_SECONDS` |

### Error Catalog

Envelope herdado de `phase-02-auth/TD-07`: `{ statusCode, error, message }`. Cada código abaixo vira uma subclasse de `DomainException` em `src/common/exceptions/domain.exception.ts`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Slug inexistente, malformado ou de outro canal, em qualquer endpoint `/videos/:slug/**` |
| UPLOAD_NOT_IN_PROGRESS | 409 | Upload is not in progress | sign-parts, list-parts, complete ou abort com `processing_status` diferente de `uploading` |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid or incomplete | `CompleteMultipartUpload` rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size exceeds the declared size | `HeadObject.ContentLength` maior que o `size_bytes` declarado no init |
| VIDEO_NOT_READY | 409 | Video is not ready | stream, download ou thumbnail com `processing_status` diferente de `ready` |
| RANGE_NOT_SATISFIABLE | 416 | Requested range not satisfiable | `Range` malformado, com múltiplas faixas ou com início ≥ tamanho do objeto |

Falhas de processamento não são erros HTTP: o worker grava a mensagem em `processing_error` e marca `processing_status = failed` após a última tentativa (per `phase-03-videos/TD-08`). O vídeo fica legível via `GET /videos/:slug`.

### Events/Messages

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Queue:** `video-processing` (BullMQ sobre Redis/Valkey, per `phase-03-videos/TD-01`)
**Job name:** `process-video`
**Job options:** `jobId = videoId` (deduplicação), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false` (per `phase-03-videos/TD-08`)
**Producer:** `VideoProcessingProducer`, chamado por `VideosService.completeUpload` depois de `CompleteMultipartUpload` + `HeadObject` + `processing_status = processing` (per `phase-03-videos/TD-08`)
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')`, estende `WorkerHost`), registrado só no processo worker `src/worker/main.ts` (per `phase-03-videos/TD-06`)
**Trigger:** conclusão bem-sucedida de `POST /videos/:slug/upload/complete`
**Processing:** `ffprobe` (duração + metadados) e `ffmpeg -ss <~10% da duração> -frames:v 1` (thumbnail), ambos via `child_process.spawn` lendo o original por URL pré-assinada do cliente **interno** (per `phase-03-videos/TD-07`, `phase-03-videos/TD-04`). Sucesso → `ready`, `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`. Erro → lançado para o BullMQ repetir; na última tentativa (`job.attemptsMade >= job.opts.attempts`) → `failed` + `processing_error`.
**Delivery semantics:** at-least-once; o processamento é idempotente (rodar de novo sobrescreve metadados e thumbnail; vídeo já `ready` é ignorado) (per `phase-03-videos/TD-08`)

---

## Dependency Map

```
SI-03.1 (root — infra: libs, Compose, configs)
├── SI-03.2 — StorageService precisa das libs AWS, do MinIO e do storage.config
├── SI-03.4 — produtor precisa do @nestjs/bullmq, do Redis e do queue.config
SI-03.3 (root — entidade + migration)

SI-03.2 + SI-03.3 + SI-03.4
├── SI-03.5 — VideosService (fluxo de upload)
│   └── SI-03.6 — VideosController (endpoints de upload)
└── SI-03.7 — worker (processamento)

SI-03.6 + SI-03.7
└── SI-03.8 — endpoints de leitura (precisam do controller e de vídeos ready)
    └── SI-03.9 — documentação (junto com SI-03.7)
```

Ordem linear de implementação: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (paralelos) → SI-03.5 → SI-03.6 e SI-03.7 (paralelos) → SI-03.8 → SI-03.9

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços do Docker Compose
- [ ] SI-03.2 — StorageModule: wrapper S3 com dois clientes
- [ ] SI-03.3 — Entidade Video e migration CreateVideos
- [ ] SI-03.4 — Gerador de slug e produtor da fila de processamento
- [ ] SI-03.5 — VideosService: iniciar, assinar, concluir e abortar o upload
- [ ] SI-03.6 — VideosController: endpoints de upload
- [ ] SI-03.7 — Worker: processo separado e processamento do vídeo
- [ ] SI-03.8 — VideosController: metadados, streaming, download e thumbnail
- [ ] SI-03.9 — Documentação da arquitetura e do ambiente

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
