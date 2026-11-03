# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (Valkey 8.1):** `docker compose exec redis valkey-cli ping` — expect `PONG`
- **RustFS (S3):** `docker compose exec rustfs curl --fail http://localhost:9000/health` — expect exit 0
- **Bucket init:** `docker compose ps -a rustfs-init` — expect `Exited (0)`; it creates the bucket and the CORS rules once and then stops
- **Video Worker:** `docker compose logs video-worker` — expect the BullMQ worker started and no crash loop; it has no healthcheck of its own

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — Video Worker (same image as the API), consumes the `video-processing` queue; no port
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Valkey 8.1 (Redis-compatible), port `6379`, BullMQ backend
- `rustfs` — RustFS 1.0.4 (S3-compatible), API port `9000`, console port `9001`
- `rustfs-init` — one-shot: creates the bucket and CORS rules, then exits with 0
- `mailpit` — SMTP sink, SMTP port `1025`, web UI port `8025`

`docker compose up -d` starts the whole stack, including `video-worker`. To start only the infrastructure, list the services: `docker compose up -d db redis rustfs rustfs-init mailpit`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `transformIgnorePatterns: ["node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]` — `@nestjs/bullmq` 12 and `bullmq` 6 are ESM-only; without this entry Jest cannot load them, and any suite that imports the queue (or boots `AppModule`) fails to parse. Keep it in both `package.json` and `test/jest-e2e.json`.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Storage, Queue and Video Worker

**Two S3 endpoints, on purpose:**

- `S3_ENDPOINT` (`http://rustfs:9000`) — the API and the worker reach storage over the Compose network. Use the service name, never `localhost`.
- `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`) — the host the **browser** reaches. Presigned `UploadPart` URLs carry this host, so the browser PUTs parts directly to storage. This is the one deliberate `localhost` in the stack, because it is a browser-facing address.
- Consequence for tests: the presigned PUT is issued from inside the `nestjs-api` container, so every run that uploads parts must override the public endpoint. Keep `.env` on `localhost`.

**Variables:** `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_CORS_ALLOWED_ORIGINS` (used by `rustfs-init`), `REDIS_HOST=redis`, `REDIS_PORT=6379`, `UPLOAD_MAX_BYTES` (default 10 GiB), `UPLOAD_PART_SIZE_BYTES` (default 64 MiB), `UPLOAD_URL_TTL_SECONDS` (default 3600).

**Entrypoints:**

- `src/main.ts` boots the API. It imports `dotenv/config` as its first import on purpose: the upload DTO reads `UPLOAD_MAX_BYTES` when its module loads, before `ConfigModule` runs. Do not move that import.
- `src/worker/main.ts` boots the worker as an application context (no HTTP). `enableShutdownHooks()` is on, so `docker compose stop video-worker` waits for in-flight jobs before the process exits.
- `VideoProcessingProcessor` is provided only by `WorkerModule`. `AppModule` must never import the worker, or the API would start consuming the queue.

**Worker commands:**

```bash
docker compose logs -f video-worker                    # follow the worker
docker compose stop video-worker                       # waits for in-flight jobs
docker compose exec nestjs-api npm run openapi:export  # regenerate openapi.json
```

The `video-worker` service runs `npm run start:worker:dev` (watch mode, compiled from `src/worker/main.ts`). For the compiled build, `npm run build` followed by `npm run start:worker` runs `dist/worker/main.js`.

**Video tests need the real services.** The video integration and e2e suites (`src/videos`, `src/video-processing`, `src/media`, `src/worker`, `test/videos-*`) run against RustFS, Redis, Postgres and the FFmpeg binaries. All of them are in the stack; `Dockerfile.dev` installs `ffmpeg` and `ffprobe`. Run them with the public-endpoint override:

```bash
docker compose exec -e S3_PUBLIC_ENDPOINT=http://rustfs:9000 nestjs-api npm test -- --runInBand
docker compose exec -e S3_PUBLIC_ENDPOINT=http://rustfs:9000 nestjs-api npm run test:e2e -- --runInBand
```

**Stop the worker before running the video suites.** A running `video-worker` consumes the `video-processing` queue on the same Redis the tests use. It takes jobs the tests enqueue, and tests that clear the queue then fail with `Missing key for job`, or count a job that was already processed. Run `docker compose stop video-worker` first and `docker compose start video-worker` afterwards.

Test media is generated at runtime by `src/test/video-fixtures.ts` with `ffmpeg`, so no binary fixture is committed.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
