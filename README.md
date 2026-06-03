# Chat-to-Dashboard

자연어로 분석 요청을 하면 LLM이 **대시보드 스펙(DashboardSpec)** 을 만들고, 앱이 Chart.js로 미리보기를 렌더링합니다. 발행한 리포트는 `/reports/{id}.html` 에 저장되며, 열 때마다 등록된 CRUD API로 PostgreSQL 데이터를 다시 불러옵니다.

## 데모
<img width="1280" height="720" alt="chat_to_dashboard" src="https://github.com/user-attachments/assets/72cd0408-e02c-4af3-99fc-b02e4d40a1f8" />


## 포함 기능

- Contoso BI 샘플 데이터(PostgreSQL)
- 테이블 스키마·관계 메타데이터 (`data/contoso-schema.json`)
- 목록/집계 CRUD API (`/api/{table}`)
- 채팅 기반 분석 계획 (`/api/analysis-chat`)
- 대시보드 스펙 생성 (`/api/generate-dashboard-spec`)
- 미리보기 렌더러 (`src/domain/dashboardRenderer.ts`)
- 발행 HTML (`public/reports/`, `public/published-dashboard.js`)

## 사전 준비

- Node.js 18+
- PostgreSQL (로컬 `localhost:5432` 등)
- OpenAI API 키 (선택, 없으면 일부 기능이 로컬 폴백으로 동작)
- Contoso 적재 시: R + `scripts/load_contoso_to_postgres.R` 에 필요한 R 패키지

## 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

프로젝트 루트에 `.env` 파일을 만듭니다.

```bash
# PostgreSQL
PGHOST=localhost
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres
PGPASSWORD=your_password
PGSCHEMA=public

# Contoso 적재 옵션
CONTOSO_SIZE=small
CONTOSO_OVERWRITE=true

# OpenAI
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_API_KEY` 는 브라우저에 노출되지 않습니다. `server/index.mjs` 만 읽습니다.

### 3. PostgreSQL 실행

DB가 꺼져 있으면 대시보드에서 `ECONNREFUSED 127.0.0.1:5432` 가 납니다. PostgreSQL을 먼저 켠 뒤 아래를 실행하세요.

```bash
# 포트 확인 (macOS)
nc -z 127.0.0.1 5432 && echo "PostgreSQL port is open"
```

Postgres.app, Homebrew(`brew services start postgresql`), Docker 등 본인 환경에 맞게 시작하면 됩니다.

### 4. 샘플 데이터 적재

```bash
set -a
source .env
set +a

Rscript scripts/load_contoso_to_postgres.R
```

R 패키지는 프로젝트 로컬 `.r-lib` 에 설치되므로 `sudo` 가 필요 없습니다.

### 5. 개발 서버 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:5173` (기본 포트) 로 접속합니다. 터미널에 `PostgreSQL connected` 가 보이면 DB 연결이 정상입니다.

## npm 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | Node 서버 + Vite 개발 모드 |
| `npm run build` | TypeScript 빌드 + Vite 프로덕션 빌드 |
| `npm start` | 프로덕션 모드 서버 (`NODE_ENV=production`) |
| `npm run typecheck` | TypeScript 검사만 실행 |

## 사용 흐름

1. 채팅으로 분석 목표·차트·필터를 설명합니다.
2. **Generate draft** 로 `DashboardSpec` 미리보기를 만듭니다.
3. 만족하면 **Publish** 로 `public/reports/rpt_*.html` 을 발행합니다.
4. 사이드바 **Published pages** 에서 편집·열기가 가능합니다.

발행 페이지는 저장 시점의 차트 레이아웃만 HTML에 두고, **숫자 데이터는 열 때마다 API** 로 다시 가져옵니다.

## 프롬프트 파일

`server/index.mjs` 가 시작 시 `prompts/` 를 읽습니다.

| 파일 | 용도 |
|------|------|
| `prompts/analysis-chat.system.md` | 채팅 단계 분석·요구사항 정리 |
| `prompts/dashboard-spec-generator.system.md` | DashboardSpec JSON 생성 |
| `prompts/report-generator.system.md` | 리포트 초안 생성 |

## DashboardSpec 구조

LLM은 차트 코드 대신 JSON 스펙을 출력합니다.

- `data/contoso-schema.json` — LLM·서버가 참조하는 스키마 원본
- `data/dashboard-spec.schema.json` — 스펙 JSON 스키마
- `src/domain/dashboardSpec.ts` — TypeScript 타입
- `src/domain/dashboardRenderer.ts` — 미리보기 렌더러
- `public/published-dashboard.js` — 발행 페이지 렌더러

차트 라이브러리(Chart.js)는 렌더러 뒤에 두고, LLM은 **데이터 소스·변환·위젯** 만 고릅니다.

## 데이터 추가·관리

### A. Contoso 샘플 데이터 다시 넣기 (가장 흔한 경우)

이미 제공된 8개 테이블을 PostgreSQL에 채웁니다.

| 테이블 | 설명 |
|--------|------|
| `calendar` | 날짜 차원 |
| `customer` | 고객 |
| `product` | 상품 |
| `store` | 매장 |
| `fx` | 환율 |
| `orders` | 주문 헤더 |
| `orderrows` | 주문 라인 |
| `sales` | 매출 팩트(분석 시 가장 많이 사용) |

**데이터 양 조절** (`.env` 또는 실행 전 환경 변수):

```bash
CONTOSO_SIZE=small    # small | medium | large | mega
CONTOSO_OVERWRITE=true   # true: 기존 테이블 덮어쓰기
```

다시 적재:

```bash
set -a && source .env && set +a
Rscript scripts/load_contoso_to_postgres.R
```

`scripts/load_contoso_to_postgres.R` 의 `tables` 벡터에 새 Contoso 테이블 이름을 추가한 뒤, `contoso-schema.json` 도 함께 맞춰야 API·LLM이 인식합니다.

### B. PostgreSQL에 직접 테이블을 넣는 경우 (자체 데이터)

1. **PostgreSQL에 테이블 생성·데이터 INSERT**
   `psql`, DBeaver, `COPY`, ETL 도구 등으로 `PGSCHEMA`(기본 `public`) 아래에 테이블을 만듭니다.

2. **`data/contoso-schema.json` 에 등록**
   - `tables[]` 에 `name`, `description`, `primaryKey`, `columns[]` 추가
   - 다른 테이블과 조인할 거면 `relationships[]` 에 `from` / `to` 추가
   - `apiCatalog.endpoints` 에 `{ "table": "my_table", "operation": "list", "method": "GET", "path": "/api/my_table" }` 추가

3. **채팅에서 사용**
   예: `my_table을 sales와 customer_key로 조인해서 월별 집계 보여줘`
   LLM은 스키마 JSON만 보고 `/api/...` 경로와 필터·집계를 스펙에 넣습니다.

> **주의:** 스키마에 없는 테이블은 `/api/{table}` 이 `404 Unknown API table` 을 반환합니다. DB에만 있고 JSON에 없으면 대시보드에서 쓸 수 없습니다.

### C. 대시보드에 “데이터 소스”만 추가하는 경우 (채팅)

이미 PostgreSQL·스키마에 등록된 테이블을 **새 위젯·조인** 으로 쓰고 싶을 때는 DB를 다시 넣을 필요 없습니다.

- `sales 테이블 추가해서 월별 매출 라인 차트 넣어줘`
- `customer 국가별 고객 수 막대 차트도 포함해줘`

이때 LLM은 `DashboardSpec.dataSources[]` / `transforms[]` / `widgets[]` 를 수정합니다. **물리적 데이터 적재(B)** 와 **시각화 구성(C)** 을 구분하면 됩니다.

### D. 스키마 문서 (사람용 요약)

- LLM·서버 원본: `data/contoso-schema.json`
- 사람이 읽기 좋은 요약: `docs/contoso-schema.md`

새 테이블·컬럼을 추가했으면 JSON을 먼저 고치고, 필요하면 `docs/contoso-schema.md` 도 갱신하세요.

## CRUD API 필터

목록 API는 쿼리 파라미터로 필터합니다. 예약 파라미터: `sort`, `page`, `pageSize`, `limit`, `groupBy`, `grain`, `metrics`.

| 종류 | 예시 |
|------|------|
| 동등 | `GET /api/sales?currency=USD` |
| 비교 | `GET /api/sales?order_date__gte=2020-01-01&order_date__lte=2020-12-31` |
| 다중 값 | `GET /api/product?category_name__in=Electronics,Computers` |
| 범위 | `GET /api/sales?order_date__between=2020-01-01,2020-12-31` |
| LIKE | `GET /api/product?product_name__like=%phone%` |
| NULL | `GET /api/customer?email__isnull=true` |

`DashboardSpec.dataSources[].filters` 도 같은 연산자를 쓰며, 렌더러가 쿼리 스트링으로 변환합니다.

## CRUD API 집계 (서버 측)

월별 추이 등은 DB에서 먼저 묶는 것이 좋습니다.

```text
GET /api/sales?groupBy=month&grain=month&metrics=sum:net_revenue,sum:gross_revenue&order_date__gte=2020-01-01&limit=200
```

| 파라미터 | 설명 |
|----------|------|
| `groupBy` | 쉼표로 구분 (`month`, `year`, `country`, …) |
| `grain` | `day`, `week`, `month`, `quarter`, `year` |
| `metrics` | `sum:field`, `avg:field`, `count`, `count_distinct:field` 등 |

국가별 고객 수 예:

```text
GET /api/customer?groupBy=country&metrics=count&limit=50
```

카테고리별 매출 추세 (`category_name` 은 `product` 테이블 컬럼이며, API가 `sales`↔`product` 조인을 자동 처리):

```text
GET /api/sales?groupBy=month,category_name&grain=month&metrics=sum:net_revenue&limit=500
```

대시보드 위젯 예: `x: month`, `y: sum_net_revenue`, `series: category_name`

응답 형식은 `{ data, meta }` 이며, 집계 시 `meta.aggregated` 가 `true` 입니다.

**총 고객 수 KPI** 는 국가 8행 개수가 아니라 `count` 컬럼 합(또는 `aggregate: sum`, `id: count`)을 쓰세요.


## 프로젝트 구조 (요약)

```text
server/index.mjs          # API, OpenAI, PostgreSQL, 발행
src/main.ts               # 채팅·미리보기·발행 UI
src/domain/               # DashboardSpec, 렌더러, API 클라이언트
data/contoso-schema.json  # 테이블·관계·API 카탈로그
prompts/                  # LLM 시스템 프롬프트
public/reports/           # 발행된 HTML
scripts/                  # Contoso → PostgreSQL 적재
```

## 라이선스

Private MVP — 필요 시 저장소 설정에 맞게 조정하세요.
