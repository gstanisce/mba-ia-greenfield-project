---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# Videos Upload Endpoints Test Plan

## Application Overview

Fluxo HTTP de upload de vídeos de até 10GB. O dono autenticado inicia o upload, e a API cria o vídeo como rascunho (`uploading`/`draft`) e o multipart no MinIO. Em seguida pede URLs pré-assinadas por parte, envia as partes direto ao storage com `PUT`, lista as partes já recebidas (retomada) e conclui, o que leva o vídeo a `processing` e enfileira o job `process-video`. Também pode abortar. Todas as rotas exigem JWT. As rotas `/videos/:slug/**` são exclusivas do dono, e para qualquer outro usuário respondem `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. POST /videos/uploads — iniciar upload

**Setup:** `beforeEach` roda `cleanAllTables` (inclui `videos`) e limpa o prefixo `videos/` do bucket via `src/test/minio.ts`. O módulo de teste é `Test.createTestingModule({ imports: [AppModule] })` com o `ValidationPipe` e os filtros globais de `main.ts` reaplicados. É criado um usuário confirmado com canal, e o login dele fornece o access token.

#### 1.1. initiate-upload-creates-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. POST /videos/uploads com `Authorization: Bearer <token>` e body `{ fileName: "clip.mp4", contentType: "video/mp4", sizeBytes: 1048576 }`
    - expect: status 201
    - expect: body.slug casa `^[0-9A-Za-z]{11}$`
    - expect: body.processingStatus = "uploading", body.publicationStatus = "draft", body.partCount = 1
    - expect: body.partSizeBytes, body.maxBytes e body.urlTtlSeconds são inteiros positivos
    - expect: a tabela `videos` tem 1 linha com esse `slug`, `channel_id` do usuário e `upload_id` não nulo

#### 1.2. initiate-upload-rejects-invalid-input

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. POST /videos/uploads com `contentType: "image/png"` e os demais campos válidos
    - expect: status 400, body.error = "VALIDATION_ERROR"
  2. POST /videos/uploads com `sizeBytes` = `UPLOAD_MAX_BYTES + 1`
    - expect: status 400, body.error = "VALIDATION_ERROR"
  3. Consultar a tabela `videos`
    - expect: nenhuma linha criada

#### 1.3. initiate-upload-requires-auth

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. POST /videos/uploads com body válido e sem header `Authorization`
    - expect: status 401

### 2. Partes, conclusão e abort

**Setup:** como no grupo 1, mais um upload iniciado via POST /videos/uploads (`sizeBytes` igual ao tamanho de um buffer de teste de 1 MiB), guardando o `slug`.

#### 2.1. sign-parts-returns-usable-url

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. POST /videos/:slug/upload/parts com `{ partNumbers: [1] }`
    - expect: status 200
    - expect: body.parts tem 1 item com `partNumber: 1` e `url` absoluta; body.expiresAt é ISO-8601 no futuro
  2. `PUT` do buffer de 1 MiB direto na `url` (fetch para o MinIO, sem passar pela API)
    - expect: status 200 e header `ETag` presente
  3. GET /videos/:slug/upload/parts
    - expect: status 200, body.parts = `[{ partNumber: 1, etag: <ETag do passo 2>, sizeBytes: 1048576 }]`

#### 2.2. complete-upload-starts-processing

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. Enviar a parte 1 como no cenário 2.1 e guardar o `ETag`
  2. POST /videos/:slug/upload/complete com `{ parts: [{ partNumber: 1, etag: <ETag> }] }`
    - expect: status 202, body = `{ slug, processingStatus: "processing" }`
    - expect: no banco, o vídeo tem `processing_status = 'processing'`, `upload_id` nulo e `size_bytes = 1048576`
    - expect: a fila `video-processing` tem um job `process-video` com `id` = id do vídeo e `data.videoId` = id do vídeo

#### 2.3. complete-upload-rejects-wrong-etag

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. Enviar a parte 1 como no cenário 2.1
  2. POST /videos/:slug/upload/complete com `{ parts: [{ partNumber: 1, etag: "\"0000\"" }] }`
    - expect: status 400, body.error = "INVALID_UPLOAD_PARTS"
    - expect: o vídeo continua `processing_status = 'uploading'` e nenhum job foi enfileirado

#### 2.4. abort-upload-removes-draft

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. DELETE /videos/:slug/upload
    - expect: status 204
  2. GET /videos/:slug/upload/parts
    - expect: status 404, body.error = "VIDEO_NOT_FOUND"
    - expect: a tabela `videos` não tem mais esse `slug`

#### 2.5. upload-not-in-progress-after-complete

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. Concluir o upload como no cenário 2.2
  2. POST /videos/:slug/upload/parts com `{ partNumbers: [1] }`
    - expect: status 409, body.error = "UPLOAD_NOT_IN_PROGRESS"
  3. DELETE /videos/:slug/upload
    - expect: status 409, body.error = "UPLOAD_NOT_IN_PROGRESS"

### 3. Isolamento entre donos e slugs inválidos

**Setup:** como no grupo 2, mais um segundo usuário confirmado com canal próprio e login próprio.

#### 3.1. other-user-gets-not-found

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. Com o token do segundo usuário, chamar POST /videos/:slug/upload/parts, GET /videos/:slug/upload/parts, POST /videos/:slug/upload/complete e DELETE /videos/:slug/upload usando o slug do primeiro usuário
    - expect: as 4 respostas têm status 404 e body.error = "VIDEO_NOT_FOUND"
    - expect: o vídeo do primeiro usuário continua `uploading` e com `upload_id`

#### 3.2. malformed-slug-gets-not-found

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/abc/upload/parts com o token do dono
    - expect: status 404, body.error = "VIDEO_NOT_FOUND"
  2. GET /videos/AAAAAAAAAA!/upload/parts (11 caracteres, um deles fora do base62)
    - expect: status 404, body.error = "VIDEO_NOT_FOUND"
