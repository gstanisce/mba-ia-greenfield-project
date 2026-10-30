---
libs:
  "bullmq":
    version: "^6.5.1"
    context7_id: "/taskforcesh/bullmq/v6.3.11"
    fetched_at: "2026-10-30T10:57:35+01:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-30T10:57:35+01:00"
  "@aws-sdk/client-s3":
    version: "^3.1160.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-30T10:57:35+01:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1160.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-30T10:57:35+01:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-30T11:01:29+01:00"
---

# Library References — phase-03-videos

Excertos da documentação oficial (via Context7), focados no que os TDs da Fase 03 usam. Versões são as mais recentes no npm em 2026-10-30; nenhuma está instalada ainda no `nestjs-project/`.

**Compatibilidade verificada:** `@nestjs/bullmq@12.0.0` declara peer deps `@nestjs/common|core: ^10 || ^11 || ^12` e `bullmq: ^3 || ^4 || ^5 || ^6`, então é compatível com o NestJS 11 do projeto e com o `bullmq` 6. **Divergência a sinalizar:** o Context7 tem docs do `bullmq` até `v6.3.11`, e o npm já está em `6.5.1`. As APIs usadas abaixo (`attempts`, `backoff`, `jobId`, `close()`) são as mesmas da linha 6.x.

### bullmq

Usado por: `phase-03-videos/TD-01`, `TD-08`.

- **Retry com backoff exponencial (TD-08):** opções por job, `attempts: 3` + `backoff: { type: 'exponential', delay: 1000 }`, o que dá esperas de 1s, 2s e 4s. Também dá para defini-las uma vez como `defaultJobOptions` da fila.
  ```ts
  await queue.add('process', { videoId }, {
    jobId: videoId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
  ```
- **Deduplicação por `jobId` (TD-08):** um `jobId` customizado faz jobs "idênticos" serem tratados como duplicados e não entrarem na fila. **Ressalva:** com `removeOnComplete`/`removeOnFail`, um job removido deixa de contar como existente, e um novo job com o mesmo `jobId` pode ser adicionado. Isso é desejável para reprocessar, mas deve ser uma escolha consciente.
- **Conexão:** `connection: { host, port }` é repassado ao construtor do ioredis (padrão `localhost:6379`). No Compose, `host` é o nome do serviço (`redis`), nunca `localhost`.
- **Graceful shutdown (TD-06):** `await worker.close()` para de pegar jobs novos e espera os jobs em andamento terminarem. Não tem timeout próprio, então o processamento do FFmpeg precisa terminar ou falhar num tempo razoável.
- **Falha definitiva:** lançar erro dentro do processor dispara o retry conforme `attempts`/`backoff`. A última falha acontece quando `job.attemptsMade >= job.opts.attempts`, e é nesse ponto que o worker marca `processing_status = failed`.

### @nestjs/bullmq

Usado por: `phase-03-videos/TD-01`, `TD-06`, `TD-08`.

- **Configuração global:** `BullModule.forRootAsync({ useFactory, inject })` registra a conexão compartilhada (global). Seguindo a convenção herdada, injete a config namespaced (`queueConfig.KEY`) em vez do `ConfigService` genérico.
  ```ts
  BullModule.forRootAsync({
    inject: [queueConfig.KEY],
    useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
      connection: { host: cfg.host, port: cfg.port },
    }),
  });
  ```
- **Registro da fila:** `BullModule.registerQueue({ name, defaultJobOptions })` cria o provider da fila. O `onApplicationShutdown` do módulo fecha workers e fila.
- **Produtor:** `@InjectQueue(name) private readonly queue: Queue` no service da API.
- **Consumidor (só no worker, TD-06):** a classe `@Processor(name)` estende `WorkerHost` e implementa `async process(job)`; o valor retornado vira o `returnvalue` do job, e uma rejeição marca o job como falho (sujeito a retry). `@OnWorkerEvent('failed' | 'error' | …)` registra listeners. `this.worker` só existe a partir do `onApplicationBootstrap`.
- **Separação API × worker (TD-06):** só o módulo importado pelo `src/worker/main.ts` deve declarar o `@Processor`; a API importa apenas o `registerQueue` para produzir.
- **Testes:** `getQueueToken(name)` (de `@nestjs/bull-shared`) devolve o token DI `BullQueue_<name>`, usado para obter a fila real num teste de integração (`moduleRef.get<Queue>(getQueueToken('videos'))`).

### @aws-sdk/client-s3

Usado por: `phase-03-videos/TD-02`, `TD-03`, `TD-04`, `TD-07`, `TD-10`, `TD-12`.

- **Cliente para MinIO (TD-02/TD-04):** `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`. Com `forcePathStyle` o bucket vai no caminho (`host/bucket/key`). Pelo TD-04 A são dois clientes: um em `S3_ENDPOINT` (interno, chamadas de dados) e outro em `S3_PUBLIC_ENDPOINT` (só para assinar URLs).
- **⚠ Checksums padrão (gotcha para MinIO e URLs pré-assinadas):** a partir das versões recentes do v3, o padrão é `requestChecksumCalculation: 'WHEN_SUPPORTED'`. Com isso o SDK acrescenta `x-amz-sdk-checksum-algorithm`/`x-amz-checksum-crc32` em operações como `PutObject`/`UploadPart`. Isso quebra servidores S3-compatíveis e URLs pré-assinadas consumidas pelo navegador. Configure **os dois clientes** com:
  ```ts
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  ```
- **Multipart (TD-03):** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `ListPartsCommand({ Bucket, Key, UploadId })` para a retomada; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`. `PartNumber` vai de 1 a 10 000.
- **ETag exige CORS:** o navegador só lê o `ETag` de cada `PUT` se o bucket expuser o header (`ExposeHeaders: ["ETag"]`). Sem isso o complete não tem como montar `Parts`. Essa é a mensagem de erro clássica do próprio SDK ("Missing Bucket CORS configuration for ETag header?").
- **Tamanho real (TD-12):** `HeadObjectCommand({ Bucket, Key })` → `ContentLength` (bytes), `ContentType`, `ETag`, `AcceptRanges: 'bytes'`, sem baixar o corpo.
- **Leitura por faixa (TD-10):** `GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1023' })` → `Body` em stream (Node `Readable`), mais `ContentRange`, `ContentLength` e `ContentType` para montar a resposta `206`.
- **Thumbnail (TD-07):** `PutObjectCommand({ Bucket, Key: 'videos/{videoId}/thumbnail.jpg', Body, ContentType: 'image/jpeg' })`.

### @aws-sdk/s3-request-presigner

Usado por: `phase-03-videos/TD-03`, `TD-04`, `TD-07`.

- `getSignedUrl(client, command, { expiresIn })` assina qualquer comando S3; `expiresIn` padrão é **900s**. Use o TTL de `UPLOAD_URL_TTL_SECONDS` (TD-12).
- **Partes do multipart (TD-03):** `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })`. Assinar com o **cliente público** (TD-04) garante que o host da URL seja resolvível pelo navegador; a assinatura é offline e não abre conexão.
- **Leitura pelo worker (TD-07):** `getSignedUrl(internalClient, new GetObjectCommand({ Bucket, Key }), { expiresIn })` gera a URL que o `ffprobe`/`ffmpeg` consomem com Range. Aqui o host deve ser o **interno** (`minio:9000`), porque quem acessa é o container do worker.
- **Headers assinados:** para assinar headers `x-amz-*` (ex.: checksum), eles precisam ir em `unhoistableHeaders` e o cliente fica obrigado a enviá-los. Com `WHEN_REQUIRED` (acima), as URLs de parte não exigem headers extras do navegador.
