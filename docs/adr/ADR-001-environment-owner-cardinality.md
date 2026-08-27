# ADR-001: Environment owner và cardinality cho MVP

| Trường         | Giá trị                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trạng thái     | Accepted                                                                                                                                                                                                               |
| Ngày           | 2026-08-28                                                                                                                                                                                                             |
| Decision owner | Product + Architecture                                                                                                                                                                                                 |
| Issue          | [#53](https://github.com/majinbaka/Flexi/issues/53)                                                                                                                                                                    |
| Blocking       | [#85](https://github.com/majinbaka/Flexi/issues/85), [#209](https://github.com/majinbaka/Flexi/issues/209), [#144](https://github.com/majinbaka/Flexi/issues/144), [#73](https://github.com/majinbaka/Flexi/issues/73) |
| Spec liên quan | `apps/frontend/src/docs/specifications/environment-release-management.mdx`, `platform-roadmap.mdx`, `platform-decisions-risks.mdx`, `application-management.mdx`, `core-system-configuration.mdx`                      |

## Context

### Repo đang là gì (đã đối chiếu code, không lấy từ planning doc)

- **Không có khái niệm Environment ở bất kỳ tầng nào.** `schema.prisma` không
  có model `Environment`; `grep` toàn bộ `apps/backend/src` không có
  `environmentId`, `environmentCode`, hay bất kỳ biến thể nào. Thứ duy nhất tên
  "environment" trong code là `NODE_ENV` ở `config/env.validation.ts` — biến
  môi trường của **process**, không phải môi trường của tenant.
- **Không có khái niệm Application.** Không có model `Application`,
  `AppMember`, `AppResource` hay `AppRelease`; không có `applicationId`/`appId`
  ở đâu cả. `application-management.mdx` tự ghi nhận điều này ở mục hiện trạng
  của nó.
- **Đúng một scope lưu trữ, và nó gắn với tenant.** Dữ liệu runtime nằm ở
  schema Postgres `tenant_<tenantId>`. `resolveTenantSchema(tenantId)` là choke
  point duy nhất sinh ra tên schema đó và nhận **đúng một** tham số. Không có
  chỗ nào trong chữ ký của nó để một chiều thứ hai chen vào.
- **Config hôm nay là một namespace phẳng trên mỗi tenant.** `TenantSeedService`
  tạo bảng `system_settings` trong schema tenant với `key` **UNIQUE đứng một
  mình** (`t.text('key').notNullable().unique()`). Đây là điểm quan trọng: bảng
  này không có chỗ cho chiều environment, và thêm chiều đó về sau là drop một
  unique constraint đang có, không phải thêm một cột trống.
- `GET /api/settings` vẫn là stub trả `{ status: 'not-implemented' }`.
  Configuration Engine thật (catalog + override + resolver) chưa tồn tại —
  nó là #48/#85/#209.
- `TenantSettings` (Prisma, control plane) là bảng riêng cho các cờ identity
  của tenant (self-registration, domain whitelist, default role, approval). Nó
  cũng chỉ có `tenantId @unique`, không có chiều nào khác.

Nói cách khác: hôm nay platform có **một** scope duy nhất, nó là tenant, và nó
chưa được đặt tên. ADR này không xoá một mô hình đang chạy — nó đặt tên cho cái
đang có và nói cái tên đó sẽ nở ra theo hướng nào.

### Spec đang nói gì, và mâu thuẫn ở đâu

Hai spec mô tả hai chủ sở hữu khác nhau cho cùng một khái niệm:

- `environment-release-management.mdx` mục 5 định nghĩa
  `Environment: id, tenant_id, name (DEV/STG/PROD), ...` — **tenant-owned**, và
  mục 9 còn viết sẵn tên schema `tenant_tenantA_dev` / `tenant_tenantA_prod`.
  Mục 3 liệt kê "Hỗ trợ 2 môi trường: Development và Production" là MVP.
- `application-management.mdx` viết ngược lại: "Cấu hình được scope bằng
  `(app_id, environment_code)`; MVP luôn dùng `environment_code = default`" —
  **app-owned**, cardinality 1.

Đây không phải khác biệt về từ ngữ. Nó quyết định biến môi trường của một app
có bị app khác trong cùng tenant nhìn thấy hay không, promotion là đơn vị gì,
và precedence của Configuration Engine có mấy tầng.

### Vì sao phải chốt bây giờ

Roadmap cấm bắt đầu multi-environment persistence trước khi ownership/topology
được chốt, nên trên giấy ADR này chỉ chặn Epic 11 (V1-B). Trên thực tế nó chặn
sớm hơn nhiều: **#209 đang làm ở MVP-A và đã cố ý làm resolver 2 tầng**
(`tenant override active → catalog default → CONFIG_KEY_NOT_FOUND`) với ghi chú
"nếu ADR-001 chốt environment là scope thứ ba thì precedence phải mở rộng".

Chi phí của việc chốt muộn không phải là chờ đợi, mà là một lần đổi precedence
**trên dữ liệu override đã có thật** cộng với migration catalog. Chốt trước khi
#209 merge thì chi phí đó bằng không.

## Options đã cân nhắc

### A. Tenant-owned environment

`Environment` treo dưới `Tenant`; mọi app trong tenant dùng chung tập
DEV/STG/PROD; config và secret bind theo `(tenant_id, environment_id)`. Đây là
mô hình mà `environment-release-management.mdx` đang viết.

- **Được**: chia sẻ config/secret giữa các app trong cùng tenant là chuyện tự
  nhiên — một connection string DB, một SMTP credential, khai báo một lần. Ánh
  xạ thẳng sang topology "một schema cho mỗi (tenant, environment)".
- **Mất**: environment trở thành một trục **trực giao** với app, cắt ngang mọi
  app trong tenant. Promotion mất tính độc lập: "promote app A lên PROD" phải
  trả lời câu hỏi app B đang ở trạng thái nào trong cùng environment đó, vì
  chúng chia sẻ scope. Export/import một Application (FAPS) không còn khép kín
  — nó tham chiếu tới các environment không thuộc về nó. Và nó mâu thuẫn trực
  tiếp với `(app_id, environment_code)` đã viết ở `application-management.mdx`,
  nên chọn A là phải sửa spec đó chứ không phải sửa spec kia.

### B. App-owned default scope (chọn)

`Environment` treo dưới `Application`. MVP có **đúng một** environment cho mỗi
app, `environment_code = 'default'`, tạo ngầm cùng app, không xoá được, không
có UI quản lý.

- **Được**: không phải migrate dữ liệu hiện có — hôm nay chưa có hàng
  environment nào để migrate, và scope duy nhất đang chạy trở thành default một
  cách trực tiếp. Application là đơn vị khép kín: export, dependency lock,
  release, quota đều đã được đặc tả theo app. Precedence của Configuration
  Engine giữ nguyên 2 tầng, nên #85/#209 mở khoá ngay mà không đổi resolver.
  Đường lên multi-environment là **thêm hàng**, không phải đổi hình dạng, miễn
  là cột `environment_code` có mặt từ migration đầu tiên (xem mục 3).
- **Mất**: không chia sẻ được config/secret giữa các app trong cùng tenant. Hai
  app cùng dùng một Postgres ngoài là hai lần khai báo, hai lần rotate. Với
  tenant có nhiều app, đây là chi phí vận hành thật và nó **không** được giải
  quyết ở MVP.

### C. DEV + PROD ngay từ MVP

Dựng hai environment thật từ đầu, kèm promotion tối thiểu.

- **Được**: safety thật — maker không sửa trực tiếp trên dữ liệu người dùng
  cuối; không phải migrate về sau.
- **Mất**: nhân đôi bề mặt persistence trước khi có một release/rollback
  deterministic nào, đúng thứ mà nguyên tắc sequencing số 5 của roadmap cấm. Nó
  còn kéo theo ADR-002 (database topology) — hiện vẫn Open — vì hai environment
  phải nằm ở đâu đó, và câu trả lời "cùng schema" thì vô nghĩa còn "khác schema"
  thì buộc `resolveTenantSchema()` đổi chữ ký ngay bây giờ. Cộng thêm diff,
  approval, secret binding riêng: đây là Epic 11 kéo ngược vào MVP.

## Decision

Chọn **option B — app-owned default scope**.

### 1. Ownership: Tenant → Application → Environment

`Environment` là entity con của `Application`, không phải của `Tenant`. Chuỗi
sở hữu là `Tenant → Application → Environment`, và nó là chuỗi **duy nhất**:
không có environment nào tồn tại ngoài một application, và không có environment
nào được nhiều application dùng chung.

- Aggregate root cho promotion/release là **Application**. Environment là biên
  giới trong lòng app đó.
- `tenant_id` của một environment được suy ra qua application. Nếu
  implementation chọn denormalize `tenant_id` xuống hàng environment để đánh
  index, đó là chuyện lưu trữ — nó **không** trở thành nguồn của quyền. Nguồn
  của `tenantId` vẫn chỉ là `JwtAuthGuard` qua CLS, không đổi.
- `environment-release-management.mdx` mục 5 được sửa theo: `Environment` mang
  `application_id`, không mang `tenant_id`.

Hệ quả phải nói thẳng: **config và secret không chia sẻ được giữa các app trong
cùng một tenant.** Hai app cùng gọi một hệ thống ngoài là hai lần khai báo
credential và hai lần rotate. Đây là chi phí đã chấp nhận, không phải thiếu sót
cần vá ở MVP; xem "Điều kiện xét lại" cho ngưỡng mở lại.

### 2. Cardinality MVP: đúng một, và nó ngầm

Mỗi Application có **đúng một** environment ở MVP:

- `code = 'default'`, tạo cùng lúc với application, trong cùng transaction.
- Không có API tạo/xoá environment, không có UI quản lý environment ở MVP.
  `GET` để đọc là được; mọi mutation lên bản thân environment thì không.
- Không có `type` DEV/STG/PROD ở MVP. Cột `type` nếu có thì mang một giá trị
  duy nhất và **không** được dùng để phân nhánh logic — một cột enum một giá
  trị mà code đã `if` lên nó là một cột sẽ được dùng sai ngay khi có giá trị
  thứ hai.
- Hằng số `'default'` được export từ đúng một chỗ trong `@flexi/shared-types`.
  Không string literal rải rác, cùng lý do `resolveTenantSchema()` là choke
  point duy nhất cho tên schema.

### 3. Cái phải làm ngay để option B thật sự rẻ

Lợi thế "không phải migrate" của option B là **có điều kiện**, không miễn phí.
Nó chỉ đúng nếu chiều environment có mặt trong hình dạng dữ liệu ngay từ đầu,
kể cả khi nó chỉ mang một giá trị. Ba ràng buộc, bắt buộc:

1. **Mọi bảng app-scoped mang trạng thái phân giải được theo môi trường** —
   config override cấp app, biến môi trường, secret binding, artifact revision
   đang active, release/deployment — phải có cột
   `environment_code TEXT NOT NULL DEFAULT 'default'` **ngay từ migration đầu
   tiên tạo ra bảng đó**, và **mọi unique key của bảng đó phải bao gồm nó**.
   Một `UNIQUE (app_id, config_key)` hôm nay là một constraint phải drop vào
   ngày có environment thứ hai; `UNIQUE (app_id, environment_code, config_key)`
   thì không.
2. **Bảng tenant-scoped thì không nhận cột này.** `system_settings` trong schema
   tenant và `TenantSettings` ở control plane nằm trên trục tenant, không nằm
   trên trục app — chúng **không** được thêm `environment_code`. Nếu về sau
   `TenantSettings` được đưa vào catalog (đường migrate mà #209 đã ghi chú),
   nó đi theo trục tenant với scope `TENANT`, không theo trục environment.
3. **`environment_code` không bao giờ đến từ request body.** Cùng một quy tắc
   với `tenantId`: nó được resolve từ application trong context đã xác thực.
   Ở MVP giá trị luôn là `'default'`, nên quy tắc này chưa chặn được gì thật —
   nó được viết ra ở đây để nó đã có sẵn vào ngày nó bắt đầu quan trọng.

### 4. Configuration Engine giữ đúng 2 tầng — không có scope `ENVIRONMENT`

Đây là phần trả lời trực tiếp cho #209 và #85.

`core-system-configuration.mdx` mô tả precedence
`tenant override active → catalog default → CONFIG_KEY_NOT_FOUND` với scope
`SYSTEM`/`TENANT`. **Precedence này không đổi. Không thêm scope thứ ba.**

Lý do không phải là "hoãn lại": hai trục là hai thứ khác nhau và không nên gộp.

- Configuration Engine (Epic 2) phân giải config **của platform** theo trục
  `system → tenant`. Nó trả lời "tenant này được cấu hình thế nào".
- Config app-scoped `(app_id, environment_code)` phân giải config **của một
  application** theo trục app. Nó trả lời "app này chạy với giá trị gì".

Ép environment thành tầng thứ ba của resolver platform là trộn hai trục vào
một chuỗi precedence, và câu hỏi "override cấp tenant có đè lên giá trị cấp
environment của một app không" không có câu trả lời đúng — nó là câu hỏi sai.

Cụ thể với #209:

- `ConfigResolverService.getEffectiveValue(tenantId, configKey)` **giữ nguyên
  chữ ký hai tham số**. Không thêm `environmentCode`.
- `CONFIG_SCOPE_VIOLATION` vẫn chỉ có hai scope để vi phạm.
- Cache key `cfg:{tenant_id}:{config_key}` **giữ nguyên**. Không thêm chiều.
- Không có migration catalog nào phát sinh từ ADR này.
- Ghi chú "hiện tại cố ý làm 2 tầng" ở #209 chuyển từ _giả định tạm_ thành
  _quyết định đã chốt_, và có thể xoá khỏi phần rủi ro của issue.

### 5. Storage topology không đổi, và ADR-002 vẫn mở

MVP giữ nguyên **một** schema cho mỗi tenant: `tenant_<tenantId>`.

- `resolveTenantSchema(tenantId)` giữ nguyên chữ ký một tham số. Environment
  **không** xuất hiện trong tên schema ở MVP.
- Vì cardinality là 1, câu hỏi "hai environment của cùng một tenant nằm chung
  hay tách cluster/database" **không phát sinh ở MVP**. ADR-002 vì thế bị hoãn
  chứ không bị chặn, và cũng không được ADR này trả lời thay.
- Câu `tenant_tenantA_dev` / `tenant_tenantA_prod` ở mục 9 của
  `environment-release-management.mdx` là **target sau ADR-002**, không phải mô
  tả MVP. Nó được đánh dấu như vậy trong spec thay vì để đọc như hiện trạng.
- Cùng lý do đó, `#144` (Story 11.1.1) **vẫn bị chặn** — bởi ADR-002, không còn
  bởi ADR-001.

### 6. Environment không phải là security boundary ở MVP

Nói rõ để không ai xây quyền lên trên nó quá sớm:

- Biên giới cô lập vẫn là **tenant**, và nó vẫn được ép ở đúng chỗ cũ: claim
  trong JWT → `JwtAuthGuard` → CLS → `resolveTenantSchema()`. ADR này không
  thêm nguồn tenant nào và không thêm chỗ nào lấy được schema name.
- Biên giới phân quyền thứ hai là **application** (App RBAC, theo
  `application-management.mdx`), không phải environment.
- Ma trận RBAC theo cột DEV/STG/PROD ở mục 2 của
  `environment-release-management.mdx` là **target**. Ở MVP mọi ô của ma trận
  đó rơi vào một scope duy nhất, nên nó chưa cấm được gì; permission MVP được
  đặt tên theo app, không theo environment. Spec được ghi chú đúng như vậy để
  không ai đọc bảng đó như một biện pháp kiểm soát đang có hiệu lực.
- Secret vẫn không nằm trong release bundle; bundle chỉ mang SecretRef. Quy tắc
  này không đổi và không phụ thuộc số lượng environment.

### 7. Migration path lên multi-environment

Đây là phần phải giữ lời hứa "không migrate dữ liệu" của option B. Thứ tự bắt
buộc, và nó chỉ khởi động sau khi ADR-002 chốt topology.

**Bước 1 — Environment thành hàng thật.** Tạo bảng
`environments(id, application_id, code, type, is_active, created_at)` và
backfill đúng một hàng `code = 'default'` cho mỗi application đang có. Các cột
`environment_code` đã tồn tại từ mục 3 trở thành FK logic tới hàng đó. Không
hàng dữ liệu nào đổi ý nghĩa; đây là bước cộng thêm, rollback được.

**Bước 2 — Đặt tên lại default, và đặt cho đúng.** Scope `default` hôm nay là
nơi maker xây **và** là nơi người dùng cuối chạy — không có promotion nên
chúng là một. Do đó `default` **trở thành PROD**, không phải DEV. Đây là chỗ dễ
làm sai nhất của toàn bộ migration: đổi nó thành DEV nghĩa là dữ liệu đang phục
vụ người dùng thật bị dán nhãn môi trường phát triển, và PROD mới sẽ rỗng.

**Bước 3 — DEV được tạo mới, rỗng, rồi seed bằng snapshot artifact của PROD.**
Chỉ artifact (Pages, Workflows, schema definition, config non-secret), **không**
row data và **không** secret value — theo đúng Business Rule "Secret Isolation"
và "không copy secret value" ở Story 11.1.3.

**Bước 4 — Topology vật lý theo ADR-002.** Nếu ADR-002 chọn schema-per-
environment thì đây là nơi `tenant_<tenantId>` được **đổi tên** thành nhánh
PROD và `resolveTenantSchema()` đổi chữ ký thành `(tenantId, environmentCode)`.
Đổi tên, không sao chép — sao chép nghĩa là có hai bản dữ liệu người dùng thật
cùng lúc.

**Bước 5 — Promotion engine** (Epic 11: diff, approval, deployment, rollback).

Bước 4 là **điểm không quay lại**. Bước 1–3 rollback được; từ bước 4 trở đi,
mọi đường đọc dữ liệu tenant đã đổi hình dạng.

## Consequences

**Tích cực**

- #85 và #209 mở khoá ngay, và mở khoá **không kèm công việc nào**: resolver
  giữ 2 tầng, cache key giữ nguyên, không có migration catalog phát sinh. Rủi
  ro "một lần đổi precedence trên dữ liệu override đã có thật" biến mất.
- Không có dữ liệu nào phải migrate hôm nay, vì chưa có hàng environment nào
  tồn tại — đây là lý do chính chọn option B.
- Application trở thành đơn vị khép kín thật sự: export/import, dependency
  lock, quota, release đều nằm trong một biên giới, không tham chiếu ra ngoài.
- Hai spec hết mâu thuẫn: `application-management.mdx` (`(app_id,
environment_code)`) trở thành mô tả đúng, `environment-release-management.mdx`
  được sửa theo thay vì hai bên cùng đúng một nửa.
- `resolveTenantSchema()` và `JwtAuthGuard` không đổi. Không thêm lookup nào
  vào đường request.
- ADR-002 được hoãn một cách hợp lệ thay vì bị bỏ qua.

**Tiêu cực / phải chấp nhận**

- Không chia sẻ config/secret giữa các app trong cùng tenant. Tenant có N app
  dùng chung một hệ thống ngoài phải khai báo N lần và rotate N lần. Đây là chi
  phí vận hành thật, chịu nguyên ở MVP.
- MVP **không có** safety của DEV/PROD: maker sửa trực tiếp trên scope đang
  phục vụ người dùng cuối. Chỉ có publish/rollback ở cấp artifact bù lại, và nó
  không thay thế được một môi trường tách biệt.
- Mục 3 của `environment-release-management.mdx` phải hạ "2 môi trường DEV +
  PROD" khỏi MVP. Đây là **thu hẹp phạm vi MVP đã công bố**, cần stakeholder
  biết chứ không âm thầm sửa spec.
- Ràng buộc ở mục 3 (cột `environment_code` + unique key) là nợ phải trả ngay,
  ở mọi bảng app-scoped mới. Bỏ qua một bảng thì lời hứa "chỉ thêm hàng" của
  bước 1 hỏng đúng ở bảng đó, và hỏng theo kiểu phải drop constraint trên dữ
  liệu đang chạy.
- Bước 4 của migration là thao tác đổi tên schema trên dữ liệu production, cần
  cửa sổ bảo trì hoặc một chiến lược riêng. Option C tránh được đúng bước này —
  đây là cái giá thật của việc hoãn.

**Security / tenant isolation**

- Không có bề mặt tấn công mới. Environment không tạo thêm nguồn `tenantId`,
  không tạo thêm đường sinh tên schema, không tham gia vào việc phân giải
  quyền ở MVP.
- Vì environment ở MVP không phải biên giới bảo mật, mọi kiểm soát phải được
  đặt ở tenant hoặc app. Rủi ro cụ thể cần tránh: đọc ma trận RBAC DEV/STG/PROD
  ở mục 2 của spec như một kiểm soát đang có hiệu lực. Spec được ghi chú rõ là
  target.
- Secret binding gắn với `(app_id, environment_code)` ngay từ đầu, nên vào ngày
  có environment thứ hai, secret của DEV và PROD đã tách nhau về hình dạng dữ
  liệu — không phải tách bằng một lần migration lên bảng secret đang chứa giá
  trị thật.
- `environment_code` không nhận từ body/query, cùng quy tắc với `tenantId`.

## Điều kiện xét lại

Mở lại quyết định khi xảy ra **bất kỳ** điều nào — không sớm hơn:

1. Một tenant thật có nhiều app dùng chung cùng một hệ thống ngoài, và việc
   khai báo/rotate credential lặp lại trở thành khiếu nại hoặc sự cố thật (một
   lần rotate sót ở một app). Đây là ngưỡng để xét lại **ownership** (option A),
   không phải cardinality.
2. Khách hàng yêu cầu môi trường tách biệt trước khi Epic 11 tới lượt — tức là
   cardinality > 1 cần đến sớm hơn roadmap. Đây là ngưỡng để kéo bước 1–3 của
   mục 7 lên trước, không phải để đổi owner.
3. Xuất hiện tài nguyên phải chia sẻ giữa các app theo bản chất (ví dụ một
   connection pool dùng chung có quota ở cấp tenant). Khi đó lời giải nhiều khả
   năng là một khái niệm **tenant-scoped resource** mà app tham chiếu tới, chứ
   không phải chuyển environment về cho tenant sở hữu — và nó cần ADR riêng.

Điểm cần nhớ: mục 7 bước 4 là chỗ isolation model đổi hình. Nó phải là một ADR
riêng cùng ADR-002, không phải phần mở rộng của ADR này.

## Follow-up

- [#209](https://github.com/majinbaka/Flexi/issues/209): resolver giữ 2 tầng
  theo mục 4 — không đổi chữ ký, không đổi cache key, không migration. Ghi chú
  rủi ro ADR-001 trong issue có thể gỡ. **Due: trước khi #209 merge.**
- [#85](https://github.com/majinbaka/Flexi/issues/85): hết `Blocked by: #53`.
  Khi tạo bảng app-scoped, áp ràng buộc `environment_code` ở mục 3.
- [#144](https://github.com/majinbaka/Flexi/issues/144): **vẫn bị chặn**, bởi
  ADR-002 chứ không còn bởi ADR-001. Phạm vi story đổi theo mục 7: nó thực thi
  bước 1–4, không còn phải tự chọn ownership model.
- [#73](https://github.com/majinbaka/Flexi/issues/73): aggregate map lấy chuỗi
  sở hữu `Tenant → Application → Environment` ở mục 1 làm đầu vào đã chốt.
- ADR-002 (database topology) vẫn Open và **không** được ADR này trả lời thay.
  Nó chỉ hết gấp: cardinality 1 làm câu hỏi topology không phát sinh ở MVP.
- ADR-006, ADR-007 (artifact/revision contract) không bị ADR này quyết định
  thay; chúng chỉ thừa hưởng việc Application là aggregate root của release.
- Spec `environment-release-management.mdx`, `platform-roadmap.mdx`,
  `platform-decisions-risks.mdx` và `core-system-configuration.mdx` được cập
  nhật trong cùng PR với ADR này. `application-management.mdx` **không đổi** —
  nó đã mô tả đúng quyết định này từ trước.
