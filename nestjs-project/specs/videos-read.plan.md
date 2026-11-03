---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-read.e2e-spec.ts
---

# Videos Read Endpoints Test Plan

## Application Overview

Leitura de vídeos pelo dono do canal: metadados (`GET /videos/:slug`), reprodução por faixa via proxy da API (`/stream`, com `206 Partial Content`), download como anexo (`/download`) e thumbnail (`/thumbnail`). Até a publicação, que chega na Fase 04, só o dono acessa. Qualquer outro usuário recebe `404 VIDEO_NOT_FOUND`. Stream, download e thumbnail exigem `processing_status = ready`.

## Test Scenarios

### 1. Vídeo pronto

**Setup:** `beforeEach` roda `cleanAllTables` e limpa o prefixo `videos/` do bucket. O módulo de teste é `Test.createTestingModule({ imports: [AppModule] })` com o `ValidationPipe` e os filtros globais reaplicados. São criados um usuário confirmado com canal e o login dele. O vídeo `ready` é preparado sem depender do worker em execução:
- gerar um MP4 com `src/test/video-fixtures.ts`;
- enviá-lo pelo fluxo `POST /videos/uploads` → `upload/parts` → `PUT` → `upload/complete`;
- processar o job uma vez chamando `VideoProcessingProcessor.process` diretamente, obtido de um módulo de teste do worker;
- conferir que o vídeo ficou `ready` com `thumbnail_key`.

#### 1.1. get-video-metadata

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug com o token do dono
    - expect: status 200
    - expect: body.processingStatus = "ready", body.publicationStatus = "draft"
    - expect: body.durationSeconds > 0, body.metadata.width e body.metadata.height preenchidos, body.hasThumbnail = true
    - expect: body.sizeBytes = tamanho do arquivo de fixture

#### 1.2. stream-partial-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug/stream com `Range: bytes=0-1023`
    - expect: status 206
    - expect: header `Content-Range` = `bytes 0-1023/<size_bytes>`, `Content-Length` = 1024, `Accept-Ranges` = `bytes`, `Content-Type` = `video/mp4`
    - expect: os bytes do corpo são iguais aos 1024 primeiros bytes da fixture

#### 1.3. stream-full-without-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug/stream sem header `Range`
    - expect: status 200, `Content-Length` = `size_bytes`, `Accept-Ranges` = `bytes`
    - expect: o corpo é idêntico à fixture

#### 1.4. stream-range-not-satisfiable

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug/stream com `Range: bytes=<size_bytes>-`
    - expect: status 416, body.error = "RANGE_NOT_SATISFIABLE"
    - expect: header `Content-Range` = `bytes */<size_bytes>`
  2. GET /videos/:slug/stream com `Range: bytes=0-10,20-30`
    - expect: status 416, body.error = "RANGE_NOT_SATISFIABLE"

#### 1.5. download-as-attachment

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug/download
    - expect: status 200, header `Content-Disposition` = `attachment; filename="<original_file_name>"`
  2. GET /videos/:slug/download com `Range: bytes=100-199`
    - expect: status 206, `Content-Range` = `bytes 100-199/<size_bytes>`, mantendo `Content-Disposition: attachment`

#### 1.6. thumbnail-is-jpeg

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug/thumbnail
    - expect: status 200, header `Content-Type` = `image/jpeg`
    - expect: o corpo começa com os bytes `FF D8`

### 2. Vídeo ainda não pronto

**Setup:** como no grupo 1, mas um vídeo fica em `processing` (upload concluído, sem processar o job) e outro é forçado a `failed` via repositório.

#### 2.1. not-ready-video-blocks-media

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. GET /videos/:slug/stream, /download e /thumbnail do vídeo em `processing`
    - expect: as 3 respostas têm status 409 e body.error = "VIDEO_NOT_READY"
  2. Repetir os 3 GETs para o vídeo `failed`
    - expect: as 3 respostas têm status 409 e body.error = "VIDEO_NOT_READY"
  3. GET /videos/:slug do vídeo `failed`
    - expect: status 200, body.processingStatus = "failed" e body.processingError não vazio

### 3. Isolamento entre donos

**Setup:** como no grupo 1, mais um segundo usuário confirmado com canal próprio e login próprio.

#### 3.1. other-user-gets-not-found-on-ready-video

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-30T13:21:00Z

**Steps:**
  1. Com o token do segundo usuário, chamar GET /videos/:slug, /stream, /download e /thumbnail do vídeo `ready` do primeiro usuário
    - expect: as 4 respostas têm status 404 e body.error = "VIDEO_NOT_FOUND"
  2. Chamar GET /videos/:slug sem `Authorization`
    - expect: status 401
