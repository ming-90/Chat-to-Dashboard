# Contoso Schema

LLM에는 `data/contoso-schema.json`을 source of truth로 넣는 것을 권장합니다. 이 문서는 사람이 빠르게 검토하기 위한 요약입니다.

## 사용 권장

- 기본 매출/마진/상품/고객/매장/시계열 분석은 `sales`를 먼저 사용합니다.
- 주문 헤더와 라인아이템을 분리해서 봐야 하면 `orders` + `orderrows`를 사용합니다.
- 월별/분기별/요일별 분석은 날짜 컬럼을 `calendar.date`에 연결합니다.
- 상품 분석은 `product`, 고객 분석은 `customer`, 매장 분석은 `store`를 조인합니다.
- LLM이 직접 SQL을 만들기보다는 등록된 read/list API를 선택합니다.
- 월별/연별 추이는 가능하면 `/api/sales?groupBy=month&grain=month&metrics=sum:net_revenue&limit=200`처럼 API 집계를 사용합니다.
- 상품/고객/매장 조인이 필요한 분석만 raw row를 가져온 뒤 프론트에서 병합/집계합니다.

## 관계

- `sales.order_key` -> `orders.order_key`
- `sales.customer_key` -> `customer.customer_key`
- `sales.product_key` -> `product.product_key`
- `sales.store_key` -> `store.store_key`
- `sales.order_date` -> `calendar.date`
- `orders.customer_key` -> `customer.customer_key`
- `orders.store_key` -> `store.store_key`
- `orders.order_date` -> `calendar.date`
- `orderrows.order_key` -> `orders.order_key`
- `orderrows.product_key` -> `product.product_key`
- `fx.from_currency` -> `orders.currency_code`

## Tables

### `calendar`

Date dimension for time-based grouping and filtering.

Columns:

- `date` date
- `date_key` number
- `year` number
- `year_quarter` string
- `year_quarter_number` number
- `quarter` string
- `year_month` string
- `year_month_short` string
- `year_month_number` number
- `month` string
- `month_short` string
- `month_number` number
- `day_of_week` string
- `day_of_week_short` string
- `day_of_week_number` number
- `working_day` number
- `working_day_number` number

### `customer`

Customer dimension with demographics and location.

Columns:

- `customer_key` number
- `geo_area_key` number
- `start_date` date
- `end_date` date
- `continent` string
- `gender` string
- `title` string
- `given_name` string
- `middle_initial` string
- `surname` string
- `street_address` string
- `city` string
- `state` string
- `state_full` string
- `zip_code` string
- `country` string
- `country_full` string
- `birthday` date
- `age` number
- `occupation` string
- `company` string
- `vehicle` string
- `latitude` number
- `longitude` number

### `fx`

Foreign exchange rates by date and currency pair.

Columns:

- `date` date
- `from_currency` string
- `to_currency` string
- `exchange` number

### `orderrows`

Order line items with product, quantity, price, and cost.

Columns:

- `order_key` number
- `line_number` number
- `product_key` number
- `quantity` number
- `unit_price` number
- `net_price` number
- `unit_cost` number

### `orders`

Order headers with customer, store, date, delivery date, and currency.

Columns:

- `order_key` number
- `customer_key` number
- `store_key` number
- `order_date` date
- `delivery_date` date
- `currency_code` string

### `product`

Product dimension with brand, category, price, cost, and physical attributes.

Columns:

- `product_key` number
- `product_code` string
- `product_name` string
- `manufacturer` string
- `brand` string
- `color` string
- `weight_unit` string
- `weight` number
- `cost` number
- `price` number
- `category_key` number
- `category_name` string
- `sub_category_key` number
- `sub_category_name` string

### `sales`

Denormalized sales fact table with order, customer, store, product, date, currency, revenue, discount, cost, and margin fields.

Columns:

- `order_key` number
- `line_number` number
- `order_date` date
- `delivery_date` date
- `customer_key` number
- `store_key` number
- `product_key` number
- `quantity` number
- `unit_price` number
- `net_price` number
- `unit_cost` number
- `currency_code` string
- `exchange_rate` number
- `gross_revenue` number
- `net_revenue` number
- `unit_discount` number
- `discounts` number
- `cogs` number
- `gross_margin` number
- `unit_margin` number

### `store`

Store dimension with geography, status, size, and open/close dates.

Columns:

- `store_key` number
- `store_code` number
- `geo_area_key` number
- `country_code` string
- `country_name` string
- `state` string
- `open_date` date
- `close_date` date
- `description` string
- `square_meters` number
- `status` string
