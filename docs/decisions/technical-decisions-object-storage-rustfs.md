---
scope_type: ad-hoc
related_phases: [3]
status: pending
date: 2026-11-02
scope_description: "Substituição do servidor S3 local da Fase 03 (imagem do MinIO indisponível). Supersede de phase-03-videos/TD-02: mantém o AWS SDK v3, troca o servidor compatível com S3 e o serviço de init que cria bucket e CORS."
---

# Technical Decisions — Substituição do Object Storage Local (supersede de phase-03-videos/TD-02)

_Subprojects in scope:_

- `nestjs-project/` — único subprojeto com decisão aberta. O código do cliente S3 (AWS SDK v3 e a factory de dois clientes do `phase-03-videos/TD-04`) não muda. Mudam a imagem do servidor e o serviço de init no Compose.
- `next-frontend/` — nenhum TD de FE. O navegador continua falando com o storage por URLs pré-assinadas, então o CORS do bucket é a única ponta de FE afetada, e ela já é coberta pelo TD-01 abaixo.

---

## TD-01: Servidor S3 Local (substitui o MinIO do TD-02 da Fase 03)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Supersede de `phase-03-videos/TD-02` (Option A: AWS SDK v3 contra uma imagem fixada do MinIO). A imagem `minio/minio` não está mais disponível para pull: o repositório foi removido do Docker Hub e o quay.io está inacessível (informação fornecida pelo usuário, não reverificada nesta pesquisa). O TD-02 já tratava a troca de servidor como "troca de um serviço, sem impacto no código", então o SDK e a factory de clientes do TD-04 continuam valendo. O que muda: a imagem do servidor no Compose, o serviço de init que cria o bucket e aplica o CORS (hoje `minio/mc`), e as variáveis `S3_*` caso credenciais ou porta mudem. Restrição herdada, independente da opção: `requestChecksumCalculation: 'WHEN_SUPPORTED'` quebra servidores S3-compatíveis e URLs pré-assinadas, então os dois clientes precisam da configuração de checksum que `library-refs.md` já exige.

**Options:**

### Option A: RustFS 1.0.4 (`rustfs/rustfs:1.0.4`) + init com `amazon/aws-cli`
- Servidor S3 mantido ativamente. Init é um container `amazon/aws-cli` que roda `aws s3api create-bucket` e `aws s3api put-bucket-cors` com `--endpoint-url http://rustfs:9000`. A CLI oficial da AWS é neutra ao servidor, diferente do `minio/mc`.
- **Pros:** Tag `1.0.4` confirmada no Docker Hub (publicada há cerca de uma semana, com `latest` apontando para a mesma imagem). A matriz de compatibilidade marca como testados: presigned GET/PUT, range reads e condicionais, e multipart create/upload-part/complete/abort. Mesmo SDK e mesmo código da Option A do TD-02.
- **Cons:** Projeto jovem: a série 1.0.x tem versões preview anteriores à 1.0.4. A matriz de compatibilidade diz "casos selecionados" para CORS e não cita `PutBucketCors` pelo nome. A listagem de partes do multipart (`ListParts`, usada pelo `StorageService` da fase) está **excluída** do gate de compatibilidade. Precisa de fixação de tag e de teste de integração que valide essas duas lacunas.

### Option B: SeaweedFS (imagem oficial, nome e tag a confirmar)
- Servidor S3 de projeto maduro, com CORS configurável por bucket via `PutBucketCors` (aplicado pela AWS CLI apontada para o endpoint) e um default global por flag de inicialização. Suporta presigned URLs, com um campo de URL externa para que a assinatura use o host público (relevante para o `phase-03-videos/TD-04`).
- **Pros:** Maturidade; CORS documentado e testado no próprio projeto; URL externa resolve o caso de dois endpoints sem configuração extra.
- **Cons:** Topologia com mais componentes internos (master, volume, filer e gateway S3), o que aumenta o Compose. Não verifiquei nesta pesquisa a conformidade de `ListParts` nem de range reads. O CORS fica em cache por 5 minutos, o que atrapalha testes que alteram a configuração em sequência.

### Option C: Garage
- Servidor S3 voltado a self-hosting, com replicação própria.
- **Pros:** Projeto ativo e pensado para auto-hospedagem.
- **Cons:** Exige um passo de inicialização do layout do cluster antes de criar qualquer bucket, o que adiciona um serviço de init além do de CORS (já registrado no contexto do TD-02 original). Não pesquisei suporte a CORS, presigned URLs e multipart nesta pesquisa, então a avaliação fica incompleta.

**Recommendation:** **Option A (RustFS 1.0.4)**. É a substituição de serviço que o TD-02 previa, sem passo de cluster e com imagem fixável e disponível. O risco principal é a lacuna em `ListParts` e CORS, que a matriz de compatibilidade não cobre explicitamente. Por isso a escolha só deve ser aceita se o teste de integração do `StorageService` da fase (`phase-03-videos`, que usa `listParts`, CORS e range reads contra o servidor real) passar no servidor escolhido. Se falhar em `ListParts` ou em CORS, a alternativa é a Option B.

**Decision:** Option A

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Servidor S3 local (supersede de phase-03-videos/TD-02) | Option A (RustFS 1.0.4 + init com amazon/aws-cli) | Option A |
