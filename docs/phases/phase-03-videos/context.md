---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-30T11:01:04.369442100+01:00"
  docs/decisions/technical-decisions-videos.md: "2026-11-03T08:50:41.967635000+01:00"
  docs/decisions/technical-decisions-object-storage-rustfs.md: "2026-11-03T09:01:24.505714100+01:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-30T11:01:04.327003400+01:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-30T11:01:04.347518500+01:00"
  docs/phases/phase-02-auth/context.md: "2026-10-30T11:01:04.362044900+01:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-30T11:01:04.352532900+01:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-30T11:01:04.164344100+01:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Não especificado em `docs/project-plan.md`._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _Não nomeados explicitamente em `docs/project-plan.md`; o escopo técnico é o `nestjs-project` (ver TDs). Nenhum TD de frontend nesta fase._
**Deferred subprojects:** _None._
**Sequencing notes:** > Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — "Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha."
- **Phase 04:** Gerenciamento de Vídeos e Canal — "Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública."

## Decisions Index

_(from decisions-reader — one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| videos/TD-01 | phase | Backend | Tecnologia de Fila de Mensagens | decided | A | bullmq, @nestjs/bullmq |
| videos/TD-02 | phase | Backend | Backend de Object Storage e SDK | superseded-by object-storage-rustfs/TD-01 | — | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| videos/TD-03 | phase | Cross-layer | Protocolo de Upload de Arquivos Grandes (≤10GB, retomável) | decided | A | — |
| videos/TD-04 | phase | Backend | Endereçamento do Storage (interno vs exposto ao navegador) | decided | A | — |
| videos/TD-05 | phase | Backend | Modelo de Status do Vídeo (processamento vs publicação) | decided | B | — |
| videos/TD-06 | phase | Backend | Topologia do Processo Worker | decided | A | — |
| videos/TD-07 | phase | Backend | Ferramentas de Análise de Mídia e Thumbnail | decided | A | — |
| videos/TD-08 | phase | Backend | Gatilho do Processamento, Contrato do Job e Retry | decided | A | — |
| videos/TD-09 | phase | Cross-layer | Identificador Público Único do Vídeo (slug da URL) | decided | A | — |
| videos/TD-10 | phase | Cross-layer | Entrega do Streaming e do Download | decided | A | — |
| videos/TD-11 | phase | Backend | Política de Acesso a Vídeos Antes da Publicação | decided | A | — |
| videos/TD-12 | phase | Cross-layer | Limites de Upload e Política de Validação da Entrada | decided | A | — |
| object-storage-rustfs/TD-01 | ad-hoc | Backend | Servidor S3 Local (substitui o MinIO do TD-02 da Fase 03) | decided | A | — |

_Source files:_

- videos — `docs/decisions/technical-decisions-videos.md` (scope_type: phase, related_phases: [3])
- object-storage-rustfs — `docs/decisions/technical-decisions-object-storage-rustfs.md` (scope_type: ad-hoc, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | videos/TD-04, object-storage-rustfs/TD-01 _(videos/TD-02 superseded por object-storage-rustfs/TD-01)_ |
| Serviço de processamento em segundo plano (filas) | videos/TD-01, videos/TD-06 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | videos/TD-03, videos/TD-12 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | videos/TD-05, videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | videos/TD-07, videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | videos/TD-09 |
| Reprodução via streaming (sem necessidade de download completo) | videos/TD-10, videos/TD-11 |
| Download do vídeo pelo usuário | videos/TD-10, videos/TD-11 |

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader; superseded videos/TD-02 omitted)_

### videos/TD-01

**Recommendation:** **Option A (BullMQ + broker compatível com Redis)**. É a única opção com integração oficial do Nest e com retry, backoff e deduplicação por job prontos, e o TD-08 depende disso. O container extra é barato no Compose, e o diagrama C4 já prevê um container separado para a fila. Fixar uma imagem do Redis 7.x ou do Valkey. A Option B é uma alternativa crível se manter a stack só com Postgres importar mais do que a configuração idiomática.
**Libraries:** bullmq, @nestjs/bullmq

### videos/TD-03

**Recommendation:** **Option A (S3 multipart com URLs pré-assinadas por parte)**. É a única opção que atende os dois requisitos não funcionais: nenhum byte passa pela API ou pelo BFF, e a retomada é por parte. Ela respeita a regra do BFF estrito (só o handshake JSON passa pelo BFF) e bate com a aresta "Frontend → Object Storage" do C4. Os custos (endpoint público do storage, CORS) são tratados no TD-04.
**Libraries:** —

### videos/TD-04

**Recommendation:** **Option A (dois endpoints)**. É a única opção que mantém a regra de nomes de serviço do Compose sem configuração na máquina host, e vai para produção (host público de CDN/S3) com uma única variável de ambiente.
**Libraries:** —

### videos/TD-05

**Recommendation:** **Option B (duas colunas independentes)**. Processamento e publicação são ciclos de vida independentes, controlados por atores e fases diferentes. Separá-los agora evita redefinir `draft` na Fase 04. Falhas guardam a mensagem em `processing_error`.
**Libraries:** —

### videos/TD-06

**Recommendation:** **Option A (processo separado, mesmo codebase)**. Ela entrega o isolamento de container do C4 e a escala independente sem a duplicação de código ou o ferramental de monorepo que a Option C exigiria.
**Libraries:** —

### videos/TD-07

**Recommendation:** **Option A (binários do sistema via `spawn`, lendo por URL pré-assinada)**. Evita um wrapper descontinuado e evita copiar 10GB por job, já que o ffprobe e o seek de um único frame só precisam de algumas leituras com Range. O FFmpeg vai na imagem compartilhada pela API e pelo worker (TD-06).
**Libraries:** —

### videos/TD-08

**Recommendation:** **Option A (a API enfileira no `complete`, `jobId = videoId`, 3 tentativas com backoff exponencial, `failed` só depois da última tentativa)**. Com o TD-03 A, a API já está no caminho crítico da conclusão, então este é o gatilho correto mais simples. A janela de queda fica registrada como tarefa de follow-up.
**Libraries:** —

### videos/TD-09

**Recommendation:** **Option A (slug aleatório base62 de 11 caracteres)**. É curto e impossível de adivinhar, o que a visibilidade unlisted da Fase 04 precisa. Reaproveita o padrão de retry em `23505` já existente e não adiciona dependência.
**Libraries:** —

### videos/TD-10

**Recommendation:** **Option A (proxy pela API com Range/206)**, como já preferido pelo usuário na preparação da fase. Mantém a autorização por requisição (necessária para os rascunhos no TD-11 e para os vídeos unlisted da Fase 04), e o storage continua privado para leitura. O custo de banda é aceitável na escala deste projeto, e uma CDN ou a migração para a Option B podem vir depois sem mudar o formato da URL pública.
**Libraries:** —

### videos/TD-11

**Recommendation:** **Option A (só o dono até a publicação)**. Nunca expõe rascunhos e mantém o contrato do guard inalterado. O entregável "streaming funcionando" é atendido pelo dono. A auth opcional pertence às regras de visibilidade da Fase 04.
**Libraries:** —

### videos/TD-12

**Recommendation:** **Option A**. Cada limite é aplicado no ponto em que é mais barato (declarado no init, tamanho real no complete, conteúdo real no worker), e o ffprobe continua sendo a única autoridade sobre "isto é um vídeo". Tamanho de parte, tamanho máximo e expiração das URLs vêm do env e são devolvidos na resposta do init, para que o cliente nunca os fixe no código.
**Libraries:** —

### object-storage-rustfs/TD-01

**Recommendation:** **Option A (RustFS 1.0.4)**. É a substituição de serviço que o TD-02 previa, sem passo de cluster e com imagem fixável e disponível. O risco principal é a lacuna em `ListParts` e CORS, que a matriz de compatibilidade não cobre explicitamente. Por isso a escolha só deve ser aceita se o teste de integração do `StorageService` da fase (`phase-03-videos`, que usa `listParts`, CORS e range reads contra o servidor real) passar no servidor escolhido. Se falhar em `ListParts` ou em CORS, a alternativa é a Option B.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — phases-reader, plus the decided TDs of the correlator-confirmed doc openapi-docs-nestjs)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

_(from phases-reader — compact list; latest prior phases (01, 02); phase 02's own convention list is tagged from phase 01)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- DB connection params come from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| "Telas de frontend" | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth | `next-frontend/` not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma, so the link destination remains a 404 until a later phase delivers the screen. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | Umbrella bullet deferred: the confirmação and reset-password destination screens are both deferred per the rows above; the 3 ship-this-phase telas (signup, login, forgot-password) are covered by their own verbs. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

_(from testing-guide-nestjs-project — Feature Implementation Checklist, §3; subproject in scope: `nestjs-project`. No frontend subproject in scope for this phase.)_

| Artifact created | Required tests | Guide |
|---|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` | `artifacts/entities.md` |
| Service with branching + DB (ex.: pré-cadastro, complete, retry) | Unit: branch logic (mock repo) + Integration: DB contract | `artifacts/services.md` |
| Service with side-effect dep (storage S3, fila BullMQ) | Integration: contra o servidor real (RustFS, Redis/Valkey) | `artifacts/services.md` |
| Module with configured imports (`storage.config`, `queue.config`, `BullModule.registerQueue()`) | Unit: compilation test | `artifacts/modules.md` |
| Controller (upload, stream, download, slug) | E2E only — do NOT write unit tests | `artifacts/controllers.md` |
| DTO (init/complete do upload) | E2E: one validation wiring test per endpoint | `artifacts/dtos.md` |
| Guard (acesso ao dono antes da publicação) | E2E + Unit if complex internal logic | `artifacts/guards.md` |
| Exception Filter (erros de upload/processamento) | Unit + E2E | `artifacts/filters.md` |
