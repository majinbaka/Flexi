# ADR-002: Database topology cho tenant × environment

| Trường         | Giá trị                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trạng thái     | Accepted                                                                                                                                                                                                                   |
| Ngày           | 2026-08-28                                                                                                                                                                                                                 |
| Decision owner | Platform Architecture + SRE                                                                                                                                                                                                |
| Issue          | [#54](https://github.com/majinbaka/Flexi/issues/54)                                                                                                                                                                        |
| Blocking       | [#144](https://github.com/majinbaka/Flexi/issues/144), [#151](https://github.com/majinbaka/Flexi/issues/151), [#208](https://github.com/majinbaka/Flexi/issues/208), [#216](https://github.com/majinbaka/Flexi/issues/216) |
| Spec liên quan | `apps/frontend/src/docs/specifications/operational-architecture.mdx`, `platform-decisions-risks.mdx`, `environment-release-management.mdx`, `platform-roadmap.mdx`, `workflow-automation-architecture.mdx`                 |

## Context

### Repo đang là gì (đã đối chiếu code, không lấy từ planning doc)

- **Đúng một cluster, đúng một `DATABASE_URL`.** Cả bốn thứ chạm Postgres đều
  đọc cùng một biến: `PrismaService` (`prisma.service.ts:23`),
  `TenantKnexService` (`tenant-knex.service.ts:38`), BullMQ backend
  (`bullmq-postgres.ts:23`) và `prisma/seed.ts`. `env.validation.ts:106` khai
  `DATABASE_URL` là một string bắt buộc — không có chỗ cho một DSN thứ hai.
- **Một pool Knex duy nhất cho toàn app**, `{ min: 2, max: 50 }`, dựng ở
  `onModuleInit()`. Docblock ghi rõ chủ ý: "never a per-tenant pool, which would
  exhaust Postgres `max_connections` as tenant count grows".
- **Không có `SET search_path` ở bất kỳ đâu.** Mọi truy vấn data plane đi qua
  `forCurrentTenant()` / `schemaForCurrentTenant()`, tức `withSchema()` —
  identifier được qualify trong từng câu lệnh. Docblock của `TenantKnexService`
  nêu đúng lý do: PgBouncer transaction-mode có thể tái sử dụng một backend
  connection cho tenant khác giữa hai statement.
- **`resolveTenantSchema(tenantId)` nhận đúng một tham số** và là choke point
  duy nhất sinh tên schema, có allowlist regex và chặn tràn 63 byte
  (`MAX_SCHEMA_NAME_LENGTH`) vì Postgres truncate im lặng chứ không báo lỗi.
- **Một schema tenant không phải một đơn vị kích thước cố định.** Lúc provision
  nó đã có 10 bảng: 7 từ `tenant-seed.service.ts` (`system_settings`,
  `statuses`, `roles`, `permissions`, `role_permissions`, `categories`,
  `notification_templates`) + 3 meta table của dynamic-tables (`_meta_tables`,
  `_meta_fields`, `_meta_migrations`). Số bảng còn lại do người dùng tự tạo, và
  đó chính là sản phẩm — một low-code platform không có trần cho con số này.
- **Đã tồn tại một transaction span hai mặt phẳng.**
  `UserDeletionService.hardDelete()`
  (`apps/backend/src/modules/users/user-deletion.service.ts:136`) mở **một**
  Knex transaction rồi ghi vào cả `public` (`tenant_users`, `auth_audit_logs`)
  lẫn schema tenant, và docblock nói rõ đó là chủ ý: "One physical PostgreSQL
  transaction owns every hard-delete write... Prisma is intentionally not used
  inside". Nó đúng **chỉ vì** hai schema đang nằm trong cùng một database.
- **Readiness hiện chỉ kiểm control plane.** `HealthService.getReadiness()`
  chạy `SELECT 1` qua Prisma và đọc `bullmq.migration`. Pool Knex của data
  plane **không** nằm trong readiness. Tình cờ, đó đúng là hình dạng ADR này
  cần giữ (xem mục 5.8).
- **Chưa có khái niệm environment ở tầng lưu trữ**, theo đúng ADR-001: MVP có
  cardinality 1, `environment_code = 'default'`, schema vẫn là
  `tenant_<tenantId>` không hậu tố.

### Spec đang nói gì, và mâu thuẫn ở đâu

- `operational-architecture.mdx` mục 13 để ngỏ "Chiến lược Schema Scale Limit"
  với một con số duy nhất: **2.000 schemas/instance** do RAM overhead của
  catalog cache, kèm câu hỏi cho stakeholder về nhóm khách hàng.
- `environment-release-management.mdx` mục 13 câu 1 hỏi thẳng STG/PROD của cùng
  một tenant nằm chung instance hay tách server vật lý; mục 9 viết sẵn
  `tenant_tenantA_dev` / `tenant_tenantA_prod` nhưng đã được đánh dấu là target
  chờ ADR này.
- `workflow-automation-architecture.mdx` mục 13 vẫn để mở "giữ shared schema +
  tenantId hay chuyển workflow runtime sang schema-per-tenant".
- `platform-decisions-risks.mdx` ghi mâu thuẫn `isolation-topology`: repo xác
  nhận schema-per-tenant, nhưng một số proposal còn nêu shared schema +
  tenantId, còn release spec đề xuất schema per tenant per env.

Ba spec đang mô tả ba trục khác nhau (số schema trên một instance; environment
nằm ở đâu; workflow runtime nằm ở mặt phẳng nào) như thể chúng là ba câu hỏi
độc lập. Chúng là **một** câu hỏi: mặt phẳng nào tách theo cái gì.

### Vì sao phải chốt bây giờ

ADR-001 đã làm câu hỏi này hết **gấp** — cardinality 1 nghĩa là ở MVP không có
hai environment nào để đặt ở đâu cả. Nhưng nó không làm câu hỏi này hết **đắt**,
và chi phí đang tăng theo từng issue merge chứ không đứng yên:

- `hardDelete()` đã merge và đã span hai mặt phẳng trong một transaction vật lý.
  Đó là **một** chỗ. Không có quyết định nào ghi ra thì sẽ có chỗ thứ hai, thứ
  ba, và mỗi chỗ là một lần phải đổi atomicity trên đường xoá dữ liệu người dùng
  thật.
- **#208** đặt `system_config_catalog`, `tenant_config_overrides`,
  `system_config_audit_logs` ở `public` và tự ghi chú "nếu ADR-002 chốt khác thì
  sửa ở đây trước khi #48/2 build lên trên".
- **#216** đặt toàn bộ 7 bảng workflow ở `public` row-scoped theo `tenantId` với
  cùng một ghi chú, và `WorkflowTriggerDedupe` đang khai unique trên hash của
  `tenant_id + workflow_id + dedupe_key` — không có chiều environment.

Nói cách khác, hai module MVP đã tự quyết định thay ADR này. Chốt bây giờ thì
việc còn lại là **xác nhận hoặc sửa vài dòng migration chưa chạy**. Chốt sau khi
#208–#215 và #216–#229 merge thì đó là migration trên dữ liệu thật.

## Options đã cân nhắc

### A. Cùng cluster cho tất cả (schema-per-tenant-per-environment, một instance)

Mọi environment của mọi tenant nằm chung một Postgres cluster, phân tách bằng
schema `tenant_<tenantId>_<envCode>`.

- **Được**: không có gì phải làm — `TenantKnexService` giữ nguyên một pool,
  `DATABASE_URL` giữ nguyên, promotion DEV→PROD có thể dùng SQL trực tiếp trong
  một transaction. Rẻ nhất ở ngày 1.
- **Mất**: blast radius là toàn bộ platform — một `ALTER` sai ở DEV của một
  tenant khoá bảng trên cùng cluster đang phục vụ PROD của mọi tenant khác.
  Backup và PITR không tách được: mọi restore drill của PROD kéo theo toàn bộ
  khối lượng DEV/STG, làm RTO tệ đi mà không phục vụ ai. Và nó đạt ngưỡng
  relation nhanh gấp ba (3 schema/tenant thay vì 1). Điểm nặng nhất: nó **không
  cần** indirection placement ở ngày 1, nên vào ngày phải shard, việc thêm
  indirection là một thay đổi trên đường đọc dữ liệu production đang chạy.

### B. Tách cluster hoàn toàn theo environment (DEV / STG / PROD riêng)

Ba cluster, mỗi environment một cái.

- **Được**: isolation sạch nhất, mỗi environment có SLA/backup/patch window
  riêng, capacity model đơn giản (mỗi cluster 1 schema/tenant).
- **Mất**: ba estate phải vận hành, patch, monitor, backup, và **hai** trong ba
  không phục vụ khách hàng. Chi phí không phải ×3 ở compute (non-prod nhàn hơn)
  mà ở **ops surface**: ba lần nâng cấp Postgres, ba bộ alert, ba bộ credential,
  ba lần chứng minh compliance. Với một platform chưa có Epic 11, đây là mua
  isolation giữa DEV và STG — hai môi trường **không có** SLA khách hàng — bằng
  tiền và người thật.

### B′. Tách database trong cùng cluster (đã loại, ghi ra để không ai chọn nhầm)

- Postgres không cho query xuyên database. Nghĩa là phương án này vẫn buộc phải
  trả **đúng cái giá đắt nhất** của việc tách — một connection pool riêng, không
  join, không transaction xuyên mặt phẳng — mà **không nhận được** bất kỳ lợi
  ích nào: vẫn chung RAM, `shared_buffers`, `max_connections`, WAL, autovacuum
  worker, vẫn cùng một lần restart, vẫn cùng một blast radius, vẫn cùng một
  `pg_dump` window.
- Đây là phương án tệ nhất trong tất cả, và nó hấp dẫn vì trông giống "tách" mà
  không phải dựng hạ tầng mới. Loại dứt khoát.

### C. Hybrid — PROD tách cluster, DEV/STG chung cluster (chọn)

Hai vai trò cluster: `prod` và `nonprod`. Schema-per-tenant-per-environment bên
trong mỗi cluster.

- **Được**: mua đúng biên giới có SLA. Blast radius, backup/PITR, patch window
  và cam kết RTO/RPO chỉ có ý nghĩa ở PROD; DEV/STG chia sẻ với nhau là chấp
  nhận được vì không môi trường nào trong hai môi trường đó phục vụ người dùng
  cuối. Hai estate thay vì ba. Và — điểm quyết định — nó **bắt buộc** phải có
  bảng placement `(tenant, environment) → cluster` ngay từ đầu, mà đó chính là
  indirection cần cho sharding. Chọn C là mua sẵn khả năng shard, không phải chỉ
  mua isolation.
- **Mất**: promotion DEV→PROD vượt biên giới cluster nên không còn là SQL —
  không `CREATE TABLE ... LIKE`, không transaction xuyên cluster. Hai estate
  phải vận hành. Và cluster non-prod — cái rẻ nhất, ít SLA nhất — lại là cluster
  chạm ngưỡng scale **trước** (mục 8).

## Decision

Chọn **option C — Hybrid: PROD tách cluster, DEV/STG chung cluster**.

### 1. Ba mặt phẳng dữ liệu, và chỉ một trong ba tách theo environment

Đây là mệnh đề gốc; mọi mục còn lại là hệ quả của nó.

**Control plane** — Prisma, schema `public`, row-scoped theo `tenantId`. Gồm
`Tenant`, `AuthAccount`, `SystemUser`, `TenantUser`, `Role`/`Permission`/
`RolePermission`, `RefreshToken`, `SetupToken`, `TenantOnboardingAttempt` +
`TenantOnboardingAuditLog`, `ImpersonationSession`, `TenantSettings`, catalog
config (#208), artifact/revision + audit của workflow (#216), và bảng của BullMQ.
Control plane nằm ở **đúng một database và không bao giờ nhân bản theo
environment.** Lý do không phải tiết kiệm: các bảng này nằm trên **trục tenant**,
không có chiều environment. Một hàng `Tenant` không phải "tenant bản DEV"; một
`AuthAccount` không đăng nhập vào một environment.

**Tenant data plane** — Knex, schema `tenant_<tenantId>[_<envCode>]`. Gồm dữ
liệu bảng động của người dùng, meta table và seed table. **Đây là mặt phẳng duy
nhất tách theo environment, và là mặt phẳng duy nhất tách theo cluster.**

**Ephemeral plane** — Redis, object storage, queue payload. Tách bằng key space
(`queue:tenant_id:env_id:...` đã có sẵn `env_id` theo
`environment-release-management.mdx` mục 9), không tách bằng cluster ở ADR này.

### 2. "Tách" nghĩa là tách cluster

PROD nằm trên một Postgres cluster riêng — process riêng, RAM riêng,
`max_connections` riêng, WAL riêng, backup riêng, patch window riêng. Không phải
database riêng trong cùng cluster (option B′), không phải chỉ schema riêng.

Nếu implementation không dựng được cluster thứ hai ở một môi trường nào đó (ví
dụ `docker compose` local), thì cách đúng là **trỏ cả hai vai trò cluster vào
cùng một DSN** và giữ nguyên toàn bộ code path placement/pool. Sai cách là bỏ
qua placement rồi thêm lại sau — mục 4 tồn tại để chuyện đó không xảy ra.

### 3. Naming và choke point

- Target: `tenant_<tenantId>_<envCode>`. MVP giữ `tenant_<tenantId>` không hậu
  tố cho tới bước đổi tên ở ADR-001 mục 7 bước 4.
- `resolveTenantSchema()` đổi chữ ký thành `(tenantId, environmentCode)` **tại
  bước đó, không sớm hơn**, và vẫn là choke point duy nhất. Ba ràng buộc khi đổi:
  1. `environmentCode` lấy từ closed set export ở `@flexi/shared-types` (cùng
     một chỗ đã export hằng `'default'` theo ADR-001 mục 2), **không** phải free
     text đi vào tên identifier.
  2. Kiểm tra 63 byte chạy trên **tên đã ghép hậu tố**, không phải trên
     `tenant_<id>` rồi mới nối thêm. Hôm nay `tenant_` (7) + cuid (25) + `_prod`
     (5) = 37 byte nên còn dư nhiều, nhưng thứ tự "ghép trước, check sau" là
     điều kiện để `MAX_SCHEMA_NAME_LENGTH` tiếp tục bảo vệ đúng cái nó đang bảo
     vệ. Ghép sau khi check là mở lại đúng lớp bug mà file đó viết ra để chặn.
  3. **Không có fallback về tên không hậu tố.** Trong lúc migration đổi tên,
     cả `tenant_x` và `tenant_x_prod` có thể cùng tồn tại trên hệ thống ở các
     tenant khác nhau; một `catch → thử tên cũ` biến tính chất an toàn ở mục 10
     thành vô hiệu.
- Thêm choke point thứ hai, mới: `resolveTenantCluster(tenantId, environmentCode)
→ clusterId`. Nó **không** được suy ra bằng `if (env === 'prod')` rải rác
  trong code, cùng lý do `resolveTenantSchema()` tồn tại.

### 4. Placement map — artifact bắt buộc, và là lý do Hybrid rẻ hơn nó trông

Hai bảng control-plane, tạo cùng story chuyển đổi topology (#144):

- `data_clusters(id, role, region, dsn_secret_ref, state, created_at)` —
  `role ∈ {prod, nonprod}`, `state ∈ {active, draining, retired}`.
- `tenant_data_placements(tenant_id, environment_code, cluster_id, state,
created_at)`, unique `(tenant_id, environment_code)`.

Điểm mấu chốt của toàn bộ ADR này: Hybrid **bắt buộc** phải có indirection đó
ngay từ ngày đầu, vì PROD và non-prod đã là hai cluster khác nhau. Một khi nó
tồn tại, **shard chỉ là thêm hàng** — thêm một `data_clusters` row, đổi
`tenant_data_placements` của các tenant được chọn. Backend không đổi dòng code
nào để shard.

Option A rẻ hơn ở ngày 1 đúng vì nó không cần bảng này. Nó đắt đúng vào ngày
phải shard, và ngày đó indirection phải được chèn vào đường đọc dữ liệu
production đang chạy. Hybrid không mua isolation bằng tiền — nó mua **khả năng
shard mà không cần ADR thứ hai** bằng tiền.

Hai quy tắc:

- `cluster_id` **không bao giờ đến từ request** — body, query hay header. Cùng
  một quy tắc đã áp cho `tenantId` (ADR-009, `JwtAuthGuard` → CLS) và cho
  `environment_code` (ADR-001 mục 3.3). Nguồn duy nhất là placement map, tra
  bằng `(tenantId, environmentCode)` đã xác thực.
- DSN **không** nằm trong bảng, chỉ `dsn_secret_ref`. Bảng placement đọc được
  bởi nhiều code path; DSN thì không.

### 5. `TenantKnexService`: một pool cho mỗi cluster — không phải mỗi tenant, không phải mỗi environment

Đây là phần trả lời trực tiếp điều kiện đóng issue "xác nhận ảnh hưởng tới
`TenantKnexService` connection pooling".

**5.1 — Registry theo `cluster_id`.** `TenantKnexService` giữ một `Map<clusterId,
Knex>` thay cho một field `knex` duy nhất. Số pool = **số cluster**, không nhân
theo tenant và không nhân theo environment. Nguyên tắc chống cạn
`max_connections` mà docblock hiện tại nêu ra giữ nguyên hiệu lực, chỉ đổi đơn
vị từ "một" thành "một trên mỗi cluster".

**5.2 — Pool dựng lazy, không dựng ở `onModuleInit()`.** Pool cho một cluster chỉ
được tạo khi có request/job đầu tiên route tới cluster đó, và bị reap sau một
khoảng idle. Nếu không, số pool tăng theo số shard ngay cả với shard chưa có
traffic — và mục 4 hứa "shard chỉ là thêm hàng" sẽ kèm một hoá đơn connection.
Tính chất lazy này đã có sẵn ở tầng dưới: docblock hiện tại ghi rõ dựng pool
**không** mở connection thật, pool của `pg` chỉ mở khi có query chạy.

**5.3 — `min: 2` hạ về `min: 0` cho pool data plane.** Giữ `min: 2` × K cluster
nghĩa là số connection idle tăng tuyến tính theo số shard: 6 shard là 12
connection giữ vĩnh viễn chỉ để đứng yên. Control plane (Prisma) giữ warm pool
như hiện tại; data plane thì không.

**5.4 — `max` trở thành ngân sách, không còn là hằng số.** `max: 50` hôm nay hợp
lệ vì có đúng một pool và đúng một cluster. Với K pool trên R replica backend,
tổng connection tới một cluster là `R × max`. Quy tắc thay thế, tính **trên mỗi
cluster**:

```
max_per_pool = floor(
  (max_connections
   − superuser_reserved_connections
   − prisma_pool          (chỉ ở control-plane cluster)
   − bullmq_pool          (chỉ ở control-plane cluster)
   − ops_reserve ≥ 5)     (psql, pg_dump, migration runner)
  / backend_replicas
)
```

Cluster PROD nhận phần lớn ngân sách; cluster non-prod nhận ít hơn. Lưu ý phải
nói rõ vì dễ suy luận ngược: cluster non-prod chứa **gấp đôi** số schema nhưng
**không** cần nhiều connection hơn — schema không tiêu thụ connection, request
đồng thời mới tiêu thụ, và non-prod có ít request đồng thời hơn.

**5.5 — `onModuleDestroy()` destroy mọi pool.** Guard `if (this.knex)` hiện tại
thành vòng lặp trên registry, giữ nguyên lý do ban đầu của guard: một pool chưa
kịp dựng không được ném `TypeError` che mất lỗi startup thật.

**5.6 — `SET search_path` bị cấm vĩnh viễn, và lý do vừa nặng thêm.** Hôm nay
quy tắc này chống rò **giữa tenant** khi PgBouncer transaction-mode tái sử dụng
backend connection. Sau ADR này, một `SET` sót lại trên connection tái sử dụng
còn rò **giữa environment** — một request DEV đọc trúng schema PROD trên cùng
cluster non-prod, hoặc ngược lại. Quy tắc được nâng từ convention trong docblock
lên invariant của ADR.

**5.7 — Prisma không biết đến data-plane cluster nào.** `PrismaService` giữ đúng
một connection tới control plane. Không thêm datasource, không bật
`multiSchema`, không có Prisma client thứ hai. Toàn bộ độ phức tạp multi-cluster
nằm trong đúng một file — `tenant-knex.service.ts` — đúng như AD-3 ("chỉ
`TenantKnexService` được chạm raw knex") đã dựng sẵn. Đây là lợi ích trực tiếp
của việc choke point đã tồn tại trước khi cần đến nó.

**5.8 — BullMQ ở lại control plane.** Queue backend giữ nguyên `DATABASE_URL`
của control-plane cluster. Job payload mang `tenantId` + `environmentCode`;
worker resolve cluster qua mục 4 y hệt request path — không có đường tắt nào
cho worker.

**5.9 — Readiness phải tách theo cluster, và mặc định là không kiểm data plane.**
`getReadiness()` hiện chỉ kiểm Prisma và `bullmq.migration` — tức chỉ control
plane. **Giữ nguyên hình dạng đó.** Phản xạ tự nhiên khi có nhiều cluster là
thêm mọi data-plane cluster vào readiness; làm vậy nghĩa là cluster non-prod —
cái rẻ nhất, ít SLA nhất — chết sẽ đánh rớt readiness của pod đang phục vụ PROD,
**đảo ngược đúng mục đích của toàn bộ quyết định này**. Quy tắc:

- Readiness `error` khi và chỉ khi control plane (Prisma hoặc queue) mất.
- Trạng thái của từng data-plane cluster xuất hiện ở một field riêng, mang giá
  trị `degraded`, và **không** tham gia vào `status` tổng.
- Pod chỉ được cấp credential của các cluster nó thực sự phục vụ; một pod không
  phục vụ non-prod thì không báo cáo gì về non-prod.

### 6. Điều bị cấm từ hôm nay, vì nó đã bị vi phạm một lần

Ba quy tắc dưới đây có hiệu lực **ngay**, không phải từ Epic 11. Chúng miễn phí
hôm nay và không vá rẻ được sau khi có năm mươi chỗ vi phạm.

1. **Không transaction nào được span control plane và tenant data plane.** Chỗ
   nào cần atomic xuyên hai mặt phẳng thì dùng saga có compensation — đúng
   pattern `provisioning.service.ts` đã dùng và đã có audit log cho từng bước.
2. **Không FK nào giữa `public` và schema tenant, theo cả hai chiều.** Hôm nay
   chưa có: FK trong `tenant-seed.service.ts` (`role_permissions` → `roles` /
   `permissions`) và trong `ddl-worker.ts` (relation field) đều schema-qualified
   **trong cùng một tenant schema**. Liên kết `_meta_tables.owner_column →
tenant_users.id` là tham chiếu **logic**, không có FK — đó là đúng, giữ vậy.
3. **Không JOIN nào giữa `public` và schema tenant trong cùng một câu query.**

Vi phạm đã có, và nó có chủ ý: `UserDeletionService.hardDelete()`
(`apps/backend/src/modules/users/user-deletion.service.ts:136`) mở một Knex
transaction rồi ghi vào `public` (`tenant_users`, `auth_audit_logs`) và schema
tenant trong cùng transaction đó, để chuyển quyền sở hữu bản ghi và xoá user
một cách atomic. Nó đúng hôm nay vì hai schema ở cùng database. Sau ADR-001 mục
7 bước 4, `trx.withSchema('public')` và `trx.withSchema(tenantSchema)` nằm trên
hai cluster và transaction đó **không còn tồn tại được**.

Xử lý: **không sửa ngay.** Đổi nó bây giờ là đánh mất atomicity thật trên đường
xoá dữ liệu người dùng để phòng một rủi ro chưa xảy ra. Nó được ghi thành nợ có
chủ nợ — story chuyển đổi topology (#144) phải chuyển `hardDelete()` sang saga
có compensation **trong cùng lần đổi tên schema**, không phải sau. Điều bắt buộc
từ hôm nay chỉ là: **không thêm chỗ thứ hai.**

### 7. #208 và #216: placement `public` được xác nhận — kèm hai ràng buộc bắt buộc

Trả lời trực tiếp phần rà soát backlog trên issue.

**#208 — không đổi gì.** `system_config_catalog`, `tenant_config_overrides`,
`system_config_audit_logs` ở `public` là **đúng** theo mục 1. Config phân giải
trên trục `system → tenant` (ADR-001 mục 4), không có chiều environment. Ghi chú
rủi ro "nếu ADR-002 chốt khác" trong issue có thể gỡ. Không phát sinh migration
nào từ ADR này.

**#216 — `WorkflowRevision`, `WorkflowWebhookSecret`, `WorkflowAuditLog`: giữ ở
`public`.** Đây là artifact design-time và audit; artifact được **promote giữa**
các environment chứ không **thuộc về** một environment. Chúng cùng mặt phẳng với
registry, đúng như #93/#94 giả định.

**#216 — `WorkflowRun`, `WorkflowRunStep`, `WorkflowStepAttempt`,
`WorkflowTriggerDedupe`: giữ ở `public`, row-scoped theo `tenantId`**, với hai
ràng buộc bắt buộc:

- **Ràng buộc 1 — `environment_code` từ migration đầu tiên, và nó phải nằm trong
  mọi unique key.** Đây là ADR-001 mục 3 áp vào đúng chỗ nó có hậu quả cụ thể:
  `WorkflowTriggerDedupe` đang khai unique trên hash của `tenant_id +
workflow_id + dedupe_key`. Thiếu `environment_code`, một webhook trùng
  `dedupe_key` bắn vào DEV sẽ **nuốt** run tương ứng của PROD trong suốt 72 giờ
  — im lặng, và biểu hiện ra ngoài như "workflow production không chạy". Unique
  đúng là `tenant_id + environment_code + workflow_id + dedupe_key`. Cùng quy
  tắc cho `WorkflowRun.concurrencyKey`.
- **Ràng buộc 2 — không FK nào từ nhóm bảng này sang tenant schema.**
  `WorkflowRun.revisionId → WorkflowRevision` (`onDelete: Restrict`) hợp lệ và
  giữ nguyên vì cả hai đầu ở control plane. Một FK sang bảng động là vi phạm
  mục 6.2.

**Hạn chế phải nói thẳng:** `WorkflowRunStep.input`/`output` chứa dữ liệu nghiệp
vụ thật của PROD. Vì chúng ở control plane, **một phần dữ liệu PROD nằm ngoài
cluster PROD.** "PROD tách" trong ADR này nghĩa là tách **dữ liệu bảng động**,
không phải tách tuyệt đối. Hai biện pháp bù, bắt buộc chứ không tuỳ chọn:

1. Control-plane cluster được xếp **cùng security tier và cùng chính sách
   backup/PITR với cluster PROD**, không phải tier của non-prod. Nó chứa
   `AuthAccount`, `RefreshToken` và run payload — nó **là** hạ tầng production.
2. Retention của run context (30 ngày, do #68/ADR-016 chốt) là biện pháp **thu
   hẹp bề mặt dữ liệu**, không phải tối ưu dung lượng. Nếu ADR-016 nới retention
   thì phải nới có ý thức về mục này.

Ngưỡng để mở lại: "Điều kiện xét lại" mục 3.

**Hệ quả cho spec:** dòng "Database tenant isolation" ở
`workflow-automation-architecture.mdx` mục 13 **được đóng** — workflow runtime
**không** chuyển sang schema-per-tenant. #216 và các phần sau của epic #49 build
tiếp mà không chờ.

### 8. Ngưỡng scale và trigger shard

Đơn vị đo **không phải** số schema.

Áp lực catalog của Postgres đến từ số **relation** trong `pg_class` (bảng +
index + toast + sequence), và số relation trên một schema tenant là **biến**,
không phải hằng: mỗi tenant mới đã có sẵn 10 bảng lúc provision (mục "Repo đang
là gì"), rồi cộng thêm số bảng người dùng tự tạo — mà đó chính là sản phẩm. Con
số "2.000 schemas/instance" trong `operational-architecture.mdx` là một xấp xỉ
chỉ đúng khi mỗi schema có kích thước cố định; với một low-code platform, hai
cluster cùng 1.500 schema có thể chênh nhau ba lần về áp lực catalog. Nó được
thay bằng bảng dưới đây, đo **trên mỗi cluster**:

| Metric                                     | Soft — cảnh báo, lập kế hoạch shard | Hard — dừng nhận tenant mới lên cluster đó |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------ |
| Số relation trong `pg_class`               | 50.000                              | 150.000                                    |
| Số schema tenant                           | 800                                 | 1.500                                      |
| Thời lượng `pg_dump -Fc` toàn cluster      | 50% cửa sổ backup                   | 80% cửa sổ backup                          |
| Connection đang dùng / ngân sách ở mục 5.4 | 60%                                 | 85%                                        |

**Trigger shard**: bất kỳ hàng nào chạm ngưỡng Hard, **hoặc** hai hàng bất kỳ
cùng chạm Soft. Chạm Hard nghĩa là cluster đó chuyển `state = draining` trong
`data_clusters`: tenant hiện có tiếp tục chạy, tenant mới được đặt lên cluster
khác.

Ba metric sau không phải để cho đủ. `pg_dump` duration thường là thứ **hỏng
trước tiên** trong thực tế — nó vỡ cửa sổ backup từ lâu trước khi catalog cache
thành nút cổ chai, và nó là metric duy nhất trong bảng gắn trực tiếp với cam kết
RTO ở #151.

**Điểm phản trực giác, phải đưa vào capacity plan:** cluster non-prod chạm ngưỡng
**trước**. Nó giữ 2 schema/tenant (DEV + STG) trong khi PROD giữ 1 — với cùng
một số tenant, nó có gấp đôi số relation. Cluster rẻ nhất, ít SLA nhất, là
cluster phải shard đầu tiên. Kế hoạch capacity vì thế tính **theo cluster**,
không theo tổng số tenant của platform.

**Đơn vị shard là một tenant trên một vai trò cluster.** Mọi schema của tenant đó
trên cluster đó di chuyển cùng nhau. Không bao giờ tách DEV và STG của cùng một
tenant sang hai cluster non-prod khác nhau — làm vậy là mua thêm một chiều
placement mà không đổi lấy gì, và nó phá tính chất "promotion trong non-prod là
cùng cluster".

**Cách shard**: thêm hàng `data_clusters`, `pg_dump`/restore ở mức schema trong
cửa sổ bảo trì (hoặc logical replication cho tenant lớn), đổi
`tenant_data_placements`, drop schema nguồn sau khi verify. Không có thay đổi
code — đó là điều mục 4 mua về.

### 9. Backup, restore, HA/DR — cái Hybrid thật sự mua được

Đây là lợi ích cụ thể nhất của quyết định này, và nó là đầu vào trực tiếp của
#151.

- Cam kết RTO/RPO chỉ đưa ra trên **cluster PROD và control-plane cluster** (mục
  7). Cluster non-prod là best-effort: backup thưa hơn, **không** PITR, không
  cam kết. Đây là chỗ tiết kiệm chi phí thật của Hybrid — không phải ở compute,
  mà ở tần suất backup và storage của WAL archive.
- Restore PROD không kéo theo dữ liệu DEV/STG của toàn bộ tenant. Với option A,
  mọi restore drill và mọi PITR đều phải kéo theo khối lượng non-prod, làm RTO
  tệ đi mà không phục vụ ai. Đó là lý do #151 khả thi dưới option C và tốn kém
  vô ích dưới option A.
- **Data residency** (#151): residency là thuộc tính của cluster.
  `data_clusters.region` + placement map ở mục 4 đã đủ để biểu diễn, không cần
  mô hình mới. Tenant có yêu cầu residency được đặt lên một cluster PROD trong
  vùng. Non-prod có thể tập trung một chỗ — **chỉ khi** quy tắc "không sao chép
  row data PROD xuống non-prod" ở mục 10 được giữ.
- Patch/upgrade Postgres: non-prod đi trước prod, và đó là giá trị vận hành
  miễn phí mà option A không có — dưới option A, nâng cấp cluster là nâng cấp
  PROD.

### 10. Security và tenant isolation

- Biên giới cô lập **vẫn là tenant**, và vẫn được ép ở đúng chỗ cũ: claim trong
  JWT → `JwtAuthGuard` → CLS → `resolveTenantSchema()`. ADR này **thêm đúng
  một** mắt xích vào chuỗi đó — `resolveTenantCluster()` — và nó chịu đúng cùng
  quy tắc: nguồn duy nhất là context đã xác thực, không nhận từ body/query/
  header, không suy ra rải rác bằng `if`.
- Environment trở thành biên giới **vận hành**, không phải biên giới **phân
  quyền**. ADR-001 mục 6 không đổi: RBAC vẫn đặt ở tenant và app.
- **Hậu tố environment trong tên schema không phải trang trí — nó là tính chất
  an toàn.** Một request PROD bị route nhầm sang cluster non-prod tìm
  `tenant_x_prod`, không thấy, và **fail loud**. Nếu tên schema giống nhau ở
  hai cluster, cùng một lỗi route sẽ trả về dữ liệu của environment khác, đúng
  và im lặng — lớp sự cố tệ nhất có thể có ở đây. Đó là lý do mục 3.3 cấm
  fallback về tên không hậu tố.
- **Quy tắc cứng: không row data nào của PROD được sao chép xuống cluster
  non-prod.** ADR-001 mục 7 bước 3 đã nói DEV chỉ seed bằng artifact snapshot
  (Pages, Workflow definition, schema definition, config non-secret — không row
  data, không secret value). ADR này nâng nó từ quy tắc migration thành **điều
  kiện an ninh**: nếu nó bị phá, cluster non-prod đang giữ PII production ở một
  tier bảo mật thấp hơn, backup lỏng hơn, và có thể ở sai vùng residency — toàn
  bộ lý do chấp nhận Hybrid sụp. Không có ngoại lệ "chỉ để debug một lần".
- Bề mặt mới thật sự có: **credential của nhiều cluster**. Chúng chỉ tồn tại
  dưới dạng `dsn_secret_ref`, không nằm trong bảng placement, không vào log, và
  một backend pod chỉ được cấp credential của các cluster nó thực sự phục vụ.
- Không có nguồn `tenantId` mới, không có đường sinh tên schema mới, không có
  bypass mới trong `PermissionsGuard`.

## Consequences

**Tích cực**

- #208 và #216 mở khoá ngay. #208 không đổi gì; #216 đổi ba unique key (thêm
  `environment_code`) trên migration **chưa chạy** — chi phí gần bằng không, và
  đó chính là lý do phải chốt trước khi hai epic đó merge.
- Mâu thuẫn `isolation-topology` trong Decision Log đóng lại: schema-per-tenant
  được xác nhận cho data plane, `public` + `tenantId` được xác nhận cho control
  plane, và "schema per tenant per env" của release spec trở thành mô tả đúng
  của target.
- `workflow-automation-architecture.mdx` mục 13 bớt một quyết định mở.
- Mục 4 làm sharding trở thành thao tác dữ liệu thay vì thay đổi kiến trúc. Đây
  là lợi ích lớn nhất và nó đến gần như miễn phí, vì Hybrid buộc phải có
  indirection đó dù có định shard hay không.
- #151 (HA/DR, residency, restore drill) trở nên khả thi: có một cluster để cam
  kết RTO/RPO trên đó, và `data_clusters.region` đã biểu diễn được residency mà
  không cần mô hình mới.
- MVP **không đổi một dòng nào**. `resolveTenantSchema()` giữ chữ ký một tham
  số, `TenantKnexService` giữ một pool, `DATABASE_URL` giữ nguyên. Toàn bộ chi
  phí rơi vào #144, đúng chỗ ADR-001 mục 7 bước 4 đã đặt sẵn.

**Tiêu cực / phải chấp nhận**

- **Hai estate hạ tầng** phải vận hành, patch, monitor, backup và cấp
  credential. Ít hơn option B một estate, nhiều hơn option A một estate.
- **Promotion DEV→PROD vượt biên giới cluster**: không `CREATE TABLE ... LIKE`,
  không transaction xuyên cluster, không copy một phát. Promotion buộc phải là
  logic (apply artifact bundle) — điều mà ADR-001 đã cam kết, nên đây vừa là chi
  phí vừa là hàng rào ép đúng kỷ luật. Preflight schema migration của Epic 11
  phải chạy riêng trên cluster PROD.
- **`hardDelete()` là nợ đã biết**, phải chuyển sang saga trong cùng lần đổi tên
  schema ở #144. Không sửa bây giờ, nhưng cũng không được có chỗ thứ hai.
- **Cluster non-prod chạm ngưỡng scale trước** (mục 8). Cluster rẻ nhất phải
  shard đầu tiên — trái trực giác, và nếu capacity plan tính theo tổng tenant
  thay vì theo cluster thì sẽ bị bất ngờ.
- **Một phần dữ liệu PROD nằm ngoài cluster PROD** (run payload ở control plane,
  mục 7). "PROD tách" là tách dữ liệu bảng động, không phải tách tuyệt đối, và
  phải nói đúng như vậy với stakeholder.
- **DEV và STG chia blast radius.** Một query chạy loạn ở DEV của một tenant có
  thể làm chậm STG của tenant khác. Chấp nhận: STG không có SLA khách hàng.
  Nhưng nếu STG được dùng cho UAT có cam kết, giả định này sai và phải xét lại.
- Ngân sách connection ở mục 5.4 là **công việc vận hành lặp lại**: mỗi lần đổi
  số replica backend hoặc thêm shard là một lần tính lại. Option A không có việc
  này.

**Security / tenant isolation**

- Không có bề mặt tấn công mới ở tầng ứng dụng: không nguồn `tenantId` mới,
  không đường sinh tên schema mới, không bypass phân quyền mới.
- Bề mặt mới ở tầng hạ tầng: credential của cluster thứ hai, và một lớp lỗi mới
  là **route nhầm cluster**. Lớp lỗi đó được xử lý bằng thiết kế chứ không bằng
  kiểm tra runtime: hậu tố environment trong tên schema khiến route nhầm trở
  thành "schema không tồn tại" thay vì "trả về dữ liệu environment khác" (mục
  10).
- Lợi ích an ninh thật, có điều kiện: cluster non-prod **không chứa PII
  production** — nhưng chỉ khi quy tắc "không copy row data" được giữ tuyệt đối.
  Nếu nó bị phá, tình trạng còn tệ hơn option A, vì lúc đó có PII production
  nằm ở nơi được cấu hình như thể không có.
- Control-plane cluster phải được xếp tier production. Đây là chỗ dễ sai nhất
  khi triển khai: nó không có chữ "prod" trong tên vai trò, nhưng nó chứa
  `AuthAccount`, `RefreshToken` và run payload.

## Điều kiện xét lại

Mở lại quyết định khi xảy ra **bất kỳ** điều nào — không sớm hơn:

1. Sau 12 tháng vận hành, cluster non-prod duy trì dưới 10% tải và dưới 15% số
   relation của cluster PROD. Khi đó chi phí vận hành estate thứ hai không được
   biện minh và có thể gộp về option A — **nhưng chỉ khi giữ nguyên placement
   map ở mục 4**, vì bỏ nó là bỏ luôn khả năng shard.
2. STG được dùng cho UAT có cam kết SLA với khách hàng. Giả định "DEV và STG
   chia blast radius là chấp nhận được" khi đó sai, và lời giải là tách STG —
   tức là đi về option B, không phải sửa vá.
3. Xuất hiện yêu cầu compliance **có thật** (audit, hợp đồng, hoặc quy định
   residency) buộc run I/O của PROD phải nằm trong cluster PROD hoặc trong vùng
   của tenant. Khi đó `WorkflowRun`/`WorkflowRunStep`/`WorkflowStepAttempt`
   chuyển sang tenant data plane, và đó là **ADR riêng** vì nó kéo bốn bảng ra
   khỏi Prisma sang Knex. Ngưỡng là yêu cầu compliance có thật, không phải "sạch
   về kiến trúc".
4. Số relation hết là ràng buộc chi phối (đổi engine, đổi cách lưu bảng động,
   hoặc Postgres cải thiện catalog cache). Khi đó mục 8 đổi **số**, không đổi
   quyết định.

Không phải điều kiện xét lại: **một khách hàng enterprise yêu cầu cluster PROD
riêng cho riêng họ.** Placement map ở mục 4 đã biểu diễn được — đó là một hàng
`data_clusters` mà đúng một tenant trỏ vào. Ghi ra đây để không ai mở ADR mới
cho việc đó.

## Follow-up

- [#144](https://github.com/majinbaka/Flexi/issues/144) (Story 11.1.1): hết
  `Blocked by: #54`. Phạm vi được ADR này bổ sung, ngoài bước 1–4 của ADR-001
  mục 7: dựng `data_clusters` + `tenant_data_placements` (mục 4), đổi
  `TenantKnexService` thành pool registry theo cluster (mục 5), đổi chữ ký
  `resolveTenantSchema()` với quy tắc ghép-trước-check-sau (mục 3), và **chuyển
  `UserDeletionService.hardDelete()` sang saga có compensation trong cùng lần
  đổi tên schema** (mục 6).
- [#151](https://github.com/majinbaka/Flexi/issues/151) (Story 12.1.2): hết
  `Blocked by: #54`. Cam kết RTO/RPO chỉ trên cluster PROD và control plane;
  residency biểu diễn bằng `data_clusters.region` (mục 9).
- [#208](https://github.com/majinbaka/Flexi/issues/208): placement `public`
  **được xác nhận, không đổi**. Ghi chú rủi ro ADR-002 trong issue có thể gỡ.
  **Due: trước khi #208 merge.**
- [#216](https://github.com/majinbaka/Flexi/issues/216): placement `public`
  **được xác nhận**, kèm ràng buộc bắt buộc — thêm `environment_code` vào
  `WorkflowRun`, `WorkflowRunStep`, `WorkflowStepAttempt`,
  `WorkflowTriggerDedupe` ngay từ migration đầu tiên, và đưa nó vào unique của
  `WorkflowTriggerDedupe` cùng vào `concurrencyKey` của `WorkflowRun` (mục 7).
  **Due: trước khi #216 merge.**
- [#68](https://github.com/majinbaka/Flexi/issues/68) (ADR-016, retention):
  retention của run context là biện pháp thu hẹp bề mặt dữ liệu PROD nằm ngoài
  cluster PROD (mục 7), không chỉ là chính sách dung lượng.
- Quy tắc mục 6 (không transaction/FK/JOIN xuyên mặt phẳng) áp cho **mọi** issue
  từ nay, không riêng #208/#216. Ứng viên cần soát khi tới lượt: các epic pages
  (#50), cron-jobs, logs — bất cứ module nào ghi vừa control plane vừa dữ liệu
  bảng động.
- ADR-001 **không bị sửa**. ADR này thực hiện đúng phần mà ADR-001 mục 5 và mục
  7 bước 4 đã ghi là để lại cho ADR-002.
- Spec `operational-architecture.mdx`, `platform-decisions-risks.mdx`,
  `environment-release-management.mdx`, `platform-roadmap.mdx` và
  `workflow-automation-architecture.mdx` được cập nhật trong cùng PR với ADR này.
