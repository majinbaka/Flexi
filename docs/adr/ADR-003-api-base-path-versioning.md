# ADR-003: API base path, versioning và compatibility policy

| Trường         | Giá trị                                                                                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trạng thái     | Accepted                                                                                                                                                                                                                                                                                                              |
| Ngày           | 2026-08-28                                                                                                                                                                                                                                                                                                            |
| Decision owner | API Governance                                                                                                                                                                                                                                                                                                        |
| Issue          | [#55](https://github.com/majinbaka/Flexi/issues/55)                                                                                                                                                                                                                                                                   |
| Blocking       | [#76](https://github.com/majinbaka/Flexi/issues/76), [#230](https://github.com/majinbaka/Flexi/issues/230), [#238](https://github.com/majinbaka/Flexi/issues/238)                                                                                                                                                     |
| Spec liên quan | `apps/frontend/src/docs/specifications/` — `overview.mdx`, `platform-decisions-risks.mdx`, `product-capability-model.mdx`, `platform-roadmap.mdx`, `asset-file-management.mdx`, `iam-multi-tenant.mdx`, `logs.mdx`, `pages.mdx`, `workflow-automation-architecture.mdx` (Nhóm 1); thêm 14 file ở Nhóm 2 sửa trong #76 |

## Context

### Repo đang là gì (đã đối chiếu code, không lấy từ planning doc)

- **Global prefix là `api`, không version.** Đúng một dòng:
  `app.setGlobalPrefix('api')` (`apps/backend/src/main.ts:16`). Không có
  `enableVersioning()` ở bất kỳ đâu trong repo.
- **Nhưng `v1` đã có mặt trong code — nằm sai chỗ.** Sáu route của
  `TenantsController` nhét segment version vào chính route path:
  `@Get('v1/super-admin/tenants')` (`tenants.controller.ts:53`), cùng với các
  dòng `:68`, `:83`, `:102`, `:121` và `@Post('v1/setup/redeem')` (`:136`).
  Cùng controller đó, `@Get('tenants')` (`:48`) lại không có `v1`. Nên hôm nay
  production đang phục vụ **hai namespace song song**: `/api/auth/login` và
  `/api/v1/super-admin/tenants` — không phải do một quyết định, mà do một
  module tự chọn prefix. Đúng điều mà `product-capability-model.mdx` mục "API
  capability ở mức contract" đã cấm trước: "không module nào tự chọn prefix".
- **Frontend đã đi theo, cũng bằng cách nhét `/v1` vào call site.** Năm chỗ:
  `SetupAccountPage.tsx:28`, `TenantProvisioningPage.tsx:38`,
  `TenantOnboardingPage.tsx:94` và `:107`, `TenantsPage.tsx:100`.
- **`api-client.ts` không hardcode base path.** `API_BASE_URL` đọc từ
  `import.meta.env.VITE_API_BASE_URL` (`api-client.ts:19`) và request ghép
  `${API_BASE_URL}${path}` (`:164`). Base path là **cấu hình build-time**, khai
  ở năm nơi: `.env.example:58`, `start.sh:165`, `vite.config.ts:38` (pin cho
  Vitest), `docker-compose.prod.yml:71`, `apps/frontend/Dockerfile:25`.
- **Hai `Set` trong `api-client.ts` khớp path tương đối, không khớp URL đầy
  đủ**: `NO_REFRESH_PATHS` (`:31`) và `RATE_LIMITED_PATHS` (`:62`) chứa
  `/auth/login`, `/auth/refresh`… Đổi base path **không** chạm vào chúng. Ba
  file test frontend khai lại base URL thành một const —
  `api-client.spec.ts:12`, `AuthContext.spec.tsx:19`,
  `dynamic-tables-api.spec.ts:17` — và không file test frontend nào assert
  đường dẫn `/v1/super-admin/*` (chúng mock ở tầng `apiGet`/`apiPost`).
- **`nginx.conf` khớp prefix, không khớp chính xác.** `location /api/`
  (`apps/frontend/nginx.conf:15`) proxy mọi thứ dưới `/api/`, nên `/api/v1/...`
  đi qua mà không cần sửa reverse proxy.
- **Health đang bị hạ tầng phụ thuộc theo URL cứng.** `HEALTHCHECK` của
  `apps/backend/Dockerfile:62` gọi `/api/health`; `start.sh:297` chờ
  `/api/health`; `docs/deployment.md` dẫn `/api/health` và `/api/health/ready`
  ở bốn chỗ (`:53`, `:54`, `:57`, `:102`).
- **Không có Swagger/OpenAPI.** Không có `@nestjs/swagger` trong repo, nên
  không có artifact máy đọc được nào mô tả surface hiện tại — mọi contract chỉ
  tồn tại trong `.mdx` và trong test.
- **Bootstrap của e2e là bản sao chép tay của `main.ts`, và đã lệch.** Bốn file
  e2e tự gọi `app.setGlobalPrefix('api')` ở năm chỗ (`app.e2e-spec.ts:114`,
  `users-admin.e2e-spec.ts:144`, `dynamic-tables.e2e-spec.ts:58`,
  `self-registration.e2e-spec.ts:155` và `:850`), kèm comment thừa nhận đây là
  sao chép. Nhưng chỉ **hai trong bốn** file dựng lại `ValidationPipe`
  (`users-admin.e2e-spec.ts:145`, `self-registration.e2e-spec.ts:156`) — nghĩa
  là `app.e2e-spec.ts` và `dynamic-tables.e2e-spec.ts` đang test một app
  **không có** global validation, trong khi production có. Cấu hình bootstrap
  đã trôi rồi, trước cả ADR này.
- **Bề mặt test bám URL cứng**: 142 lời gọi supertest tới `/api...` trong bốn
  file e2e, trong đó **25 đã là `/api/v1`** (toàn bộ là nhóm super-admin
  tenants) và **117 còn lại là `/api/<path>`**.

### Spec đang nói gì, và mâu thuẫn ở đâu

`overview.mdx:10` nói thẳng trạng thái: prefix hiện tại là `/api`, còn `/api/v1`
"vẫn chờ ADR chung, không phải convention đã triển khai". Nhưng bên dưới nó,
**22 file** dưới `apps/frontend/src/docs/` đã viết contract bằng `/api/v1`, và
**14 file** viết endpoint bằng `/api/<path>` — có file làm **cả hai**:

- `iam-multi-tenant.mdx` có 5 path `/api/v1` và 3 path `/api/auth/*`, và mục
  "API capability contracts mục tiêu" (`:466`) phải viết hẳn một đoạn giải
  thích rằng "một số tenant-management API có thêm `/v1`, nhưng auth hiện là
  `/api/auth/*`" — spec đang mô tả sự lộn xộn thay vì mô tả một contract.
- `users.mdx` viết `POST /api/v1/invites` (`:131`),
  `POST /api/v1/users/direct-create` (`:141`), `POST /api/v1/auth/register`
  (`:151`) và `POST /api/v1/setup/redeem` (`:373`). Ba cái đầu **sai so với
  code đang chạy** (`/api/users/invites`, `/api/users/direct-create`,
  `/api/auth/register`); cái thứ tư **đúng**. Một file, cùng một convention,
  75% sai — vì convention chưa có gì để đúng theo.
- Bốn spec khác phải mở ngoặc xin lỗi ở đúng chỗ đáng lẽ là contract:
  `asset-file-management.mdx:513` ("strategy versioning… phải được chốt trước
  khi implementation"), `pages.mdx:514` ("việc thêm namespace `/v1` phải được
  thực hiện nhất quán ở controller hoặc route module"),
  `workflow-automation-architecture.mdx:333`, `logs.mdx:398`.
- `product-capability-model.mdx:621` né bằng cách khai một placeholder
  `{apiBase}` và giao cho ADR này ánh xạ nó. Placeholder đó **không được dùng ở
  bất kỳ bảng nào** trong chính file đó — nó chỉ tồn tại trong một câu văn.
- `platform-decisions-risks.mdx:49` ghi mâu thuẫn `api-base` là một trong sáu
  mâu thuẫn nguồn; `:193` ghi ADR-003 là `Blocking — Open`; `:551` ghi tài liệu
  "REST API Governance" phải viết và phụ thuộc ADR-003 + ADR-004.

### Vì sao phải chốt bây giờ

Không phải vì migration sẽ đắt hơn nếu chờ — mà vì **giá của việc không chốt
đang được trả bằng những thứ không hoàn tác được**:

- Mỗi issue mới phải tự phát minh lại câu trả lời. #230 và #238 (epic logs #52)
  đều phải viết một dòng risk giống hệt nhau — "spec viết endpoint dưới `/api`;
  giữ global prefix hiện tại, đổi sang `v1` là việc của #76" — và đó là cách
  đúng để né, nhưng nó có nghĩa là mọi story sau cũng phải né. #76 đã bị
  `Blocked by: #55` từ đầu.
- **`TenantsController` là bằng chứng rằng cơ chế né không phải lúc nào cũng
  hoạt động.** Ở đó không ai né; module tự chọn `v1/` và nó đã merge. Chi phí
  chưa phải là code — chi phí là spec `users.mdx` viết sai ba trong bốn path vì
  tác giả suy ra convention từ module gần nhất mình thấy.
- Gate 0 của roadmap (`platform-roadmap.mdx:91`) có exit criteria là "ADR-001…008
  approved; contract owners và compatibility policy được chỉ định". Compatibility
  policy **là** sản phẩm của ADR này, không phải hệ quả phụ.
- Cửa sổ để cắt rẻ đang đóng lại theo lịch chứ không theo ý muốn: hôm nay có
  **đúng một** consumer là SPA first-party, deploy cùng artifact. Từ Epic 1 trở
  đi có API key và consumer ngoài repo, và lúc đó cùng một thay đổi không còn
  là đổi config nữa — nó là một sự kiện breaking có người ngoài chịu hậu quả.

## Options đã cân nhắc

### A. Giữ `/api`, không version

Không phải "giữ nguyên hiện trạng" — hiện trạng có `v1` trong sáu route. Option
này là **gỡ `v1/` khỏi `TenantsController` và năm call site frontend**, rồi cấm
version segment vĩnh viễn.

Rẻ nhất hôm nay: 11 chỗ sửa, 25 path e2e sửa, không đổi env, không đổi spec nào
đang viết `/api/...`. Nhưng nó không trả lời được câu hỏi mà 22 file spec đang
hỏi, và nó biến mọi breaking change tương lai thành đàm phán riêng lẻ: không có
chỗ nào để đặt `v2`, nên lựa chọn duy nhất còn lại là header-based versioning
(`Accept` hoặc header riêng) — thứ không cache được đơn giản, không dán được
vào tài liệu, không thử được bằng trình duyệt, và phải chốt bằng một ADR khác
đúng lúc đang có sự cố. Loại vì nó hoãn quyết định chứ không đưa ra quyết định.

### B. Chuyển sang `/api/v1` bằng một lần cắt (chọn)

Toàn bộ surface sản phẩm chuyển sang `/api/v1/...` trong một PR (#76). `/api/...`
không còn tồn tại sau đó. Chi phí thật, đo được (mục "Consequences"), và toàn bộ
rơi vào first-party.

### C. Dual-mount `/api` và `/api/v1` trong giai đoạn chuyển tiếp

Nghe như phương án an toàn, và sẽ đúng là an toàn nếu có consumer bên ngoài để
bảo vệ. Hôm nay không có. Cái nó thực sự mua: mỗi route tồn tại ở hai URL, và
mỗi thứ khoá theo URL phải chọn URL nào là canonical — throttler key, audit log
path, e2e sweep `STUB_FEATURE_MODULES`, và bất kỳ metric nào gắn nhãn route.
Chi phí đó không phải một dòng config; nó là một lớp mơ hồ nằm trong mọi hệ
thống quan sát và mọi bài test, và nó phải được dọn **lần thứ hai** khi window
đóng. Loại **cho lần cắt này** — nhưng không loại vĩnh viễn: mục 6 quy định
dual-mount là **bắt buộc** cho v1 → v2, đúng lúc nó có thứ để bảo vệ.

## Decision

Chốt **`/api/v1`** làm base path cho toàn bộ API sản phẩm, cắt một lần, không
dual-mount ở lần cắt này. Cụ thể:

### 1. Mount bằng URI versioning của Nest, không nối chuỗi vào global prefix

Giữ nguyên `app.setGlobalPrefix('api')` và thêm:

```ts
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
```

Nest chèn segment version giữa global prefix và route path, cho `/api/v1/...`
với `prefix: 'v'` mặc định. **Không** dùng `setGlobalPrefix('api/v1')`.

Lý do không phải thẩm mỹ. Version là thuộc tính của **route**, không phải của
mount point, và hai thứ chỉ có ở cách thứ nhất:

- `@Version('2')` trên một controller đơn lẻ, tức v2 mở được từng route một chứ
  không phải mở cả surface cùng lúc. Với chuỗi nối, đường duy nhất để có v2 là
  đổi global prefix (breaking mọi thứ trong một nhịp) hoặc nhét `v2/` vào từng
  `@Controller()` — **đúng cái sai mà `tenants.controller.ts` đang mắc**, chỉ
  khác là lần này cả team cùng mắc.
- `VERSION_NEUTRAL` cho route cố tình không có version (mục 2). Với chuỗi nối
  thì route đó phải nằm ngoài global prefix, tức nằm ở gốc domain — mất luôn
  `location /api/` của nginx.

### 2. Hai loại route nằm ngoài version namespace

Đánh dấu `VERSION_NEUTRAL`, giữ nguyên ở `/api/...`:

**2.1. Health.** `/api/health` và `/api/health/ready` là tín hiệu vận hành, không
phải contract sản phẩm. Version hoá chúng nghĩa là mỗi lần bump major phải sửa
`Dockerfile:62`, `start.sh:297`, bốn chỗ trong `docs/deployment.md`, cộng probe
của mọi môi trường triển khai — để đổi lấy con số không, vì không consumer nào
đàm phán schema với một liveness probe. Đây cũng là lý do carve-out này phải
nằm trong ADR chứ không trong PR: nó là lời hứa rằng URL đó không đổi qua các
major version.

**2.2. Webhook receive endpoint.** `workflow-automation-architecture.mdx:304`
đang đặc tả `POST /api/v1/webhooks/triggers/{token}` với permission `Public`.
URL đó được **dán vào hệ thống bên thứ ba** và tồn tại theo vòng đời của token,
không theo vòng đời của API. Nếu nó nằm trong version namespace thì sunset v1
sẽ làm chết webhook của mọi tenant đã cấu hình xong từ lâu — một thao tác
deprecation nội bộ biến thành sự cố tích hợp của khách hàng. Chốt:
`POST /api/webhooks/triggers/{token}`, `VERSION_NEUTRAL`, và **spec phải sửa
theo ADR này** chứ không ngược lại. Đổi lại, payload của webhook receive phải
tự mang version riêng nếu cần (field trong body hoặc trong token), vì nó không
còn được version bởi URL.

**2.3. Không có loại thứ ba nào khác.** Ghi ra để chặn việc mở rộng danh sách
theo thói quen. Đặc biệt, `GET /api/v1/assets/{asset_id}/download-url`
(`asset-file-management.mdx:600`) **thuộc** version namespace. Nó là một lời gọi
API bình thường, chỉ tình cờ trả về một signed URL; chính signed URL đó trỏ tới
object storage và vốn đã nằm ngoài domain này, nên không cần carve-out.

### 3. Gỡ `v1/` khỏi route path và call site — nếu không sẽ thành `/api/v1/v1/...`

Bật URI versioning trong khi `TenantsController` vẫn khai `@Get('v1/...')` cho
ra `/api/v1/v1/super-admin/tenants`. Đây là **lỗi im lặng**: không phải lỗi biên
dịch, không phải cảnh báo khi khởi động, chỉ là 404 lúc chạy. Cùng lúc, năm call
site frontend cũng đang tự thêm `/v1` vào path tương đối, nên chúng sẽ ghép với
base path mới thành đúng lỗi đó lần thứ hai.

Phải gỡ trong cùng PR với việc bật versioning, không sớm hơn và không muộn hơn:

| Nơi                                          | Sửa                                                            |
| -------------------------------------------- | -------------------------------------------------------------- |
| `tenants.controller.ts:53,68,83,102,121,136` | Bỏ tiền tố `v1/` khỏi 6 route path                             |
| `SetupAccountPage.tsx:28`                    | `/v1/setup/redeem` → `/setup/redeem`                           |
| `TenantProvisioningPage.tsx:38`              | Bỏ `/v1` khỏi template literal                                 |
| `TenantOnboardingPage.tsx:94,107`            | Bỏ `/v1` khỏi hai path                                         |
| `TenantsPage.tsx:100`                        | Bỏ `/v1` khỏi template literal                                 |
| `app.e2e-spec.ts` (25 path `/api/v1/...`)    | Giữ nguyên chuỗi URL — chúng đã đúng, chỉ là đúng vì lý do sai |

Ràng buộc chung, áp từ hôm nay: **không `@Controller()` hay `@Get()`/`@Post()`
nào được chứa segment `v1`, `v2`… trong path.** Version chỉ đến từ
`enableVersioning()` và `@Version()`. Đây là quy tắc nên được cưỡng chế bằng
lint hoặc bằng một test đọc `RouterExplorer`, không bằng review.

### 4. Base path phía frontend là cấu hình, không phải code

Issue #55 và #76 đều ghi phạm vi là "migrate route + `api-client.ts`". Đối
chiếu code thì **`api-client.ts` không nằm trong phạm vi**: nó đọc
`VITE_API_BASE_URL` (`:19`) và không biết gì về `/api`. Phạm vi thật ở phía
frontend:

- **Năm nơi khai giá trị env**: `.env.example:58`, `start.sh:165`,
  `vite.config.ts:38`, `docker-compose.prod.yml:71`, `apps/frontend/Dockerfile:25`.
  Tất cả đổi `/api` → `/api/v1`.
- **Ba const trong test**: `api-client.spec.ts:12`, `AuthContext.spec.tsx:19`,
  `dynamic-tables-api.spec.ts:17`.
- **Năm call site ở mục 3.**
- **Không đổi**: `NO_REFRESH_PATHS`, `RATE_LIMITED_PATHS` (path tương đối),
  `nginx.conf` (`location /api/` khớp theo prefix).

Ghi rõ ở đây vì cách mô tả sai trong issue dẫn tới ước lượng sai và tới việc
tìm sai chỗ khi có lỗi.

### 5. Bootstrap phải có một nguồn duy nhất trước khi bật versioning

Cấu hình bootstrap hiện được sao chép tay vào e2e và **đã lệch**: bốn file e2e
đều sao chép `setGlobalPrefix`, nhưng chỉ hai file sao chép `ValidationPipe`
(mục Context). Versioning là thiết lập thứ ba đi cùng đường đó, và nó là thiết
lập mà việc lệch gây hại nhiều nhất: một e2e quên `enableVersioning()` sẽ
**pass** trên `/api/...` trong khi production chỉ phục vụ `/api/v1/...`. Test
xanh, prod 404.

Chốt: #76 trích một hàm dùng chung — đề xuất
`apps/backend/src/bootstrap/configure-app.ts`, export
`configureApp(app: INestApplication): void` chứa prefix, versioning và global
pipes — `main.ts` gọi nó, và **mọi** file e2e gọi nó thay cho phần sao chép hiện
tại. Đây là điều kiện bắt buộc của #76, không phải cải tiến tuỳ chọn: không có
nó thì mục 1 không có cách nào được test đúng.

### 6. Deprecation window và điều kiện để nó bằng không

**Lần cắt này: window = 0.** `/api/<path>` không được giữ song song sau khi #76
merge. Điều đó chỉ hợp lệ khi **cả hai** điều kiện sau đúng, và ADR ghi chúng ra
để lần sau không ai viện dẫn tiền lệ này:

1. Không có consumer nào ngoài repo — không API key, không integration bên thứ
   ba, không SDK đã phát hành. Đúng ở thời điểm 2026-08-28.
2. Client và server được phát hành như **một** artifact: `docker-compose.prod.yml`
   build frontend với `VITE_API_BASE_URL` tại thời điểm build image, nên không
   tồn tại trạng thái "frontend cũ nói chuyện với backend mới" ngoài khoảng thời
   gian rolling update.

Ngay khi một trong hai điều kiện hết đúng — mốc thực tế là public API/API key
đầu tiên từ Epic 1 — window = 0 không còn hợp lệ và policy ở mục 7 áp dụng.

**Rolling update.** Trong lúc #76 triển khai, image frontend cũ (`/api`) và
backend mới (`/api/v1`) có thể cùng chạy vài phút. Deploy phải là
stop-then-start cho cặp này, hoặc chấp nhận lỗi trong cửa sổ đó. Đây là lần
**duy nhất** được chấp nhận như vậy; từ v2 trở đi dual-mount làm cửa sổ này biến
mất.

### 7. Compatibility policy từ v1 trở đi

1. **Version mới chỉ mở khi có breaking change** (mục 8). Additive không mở
   version. Một v2 chỉ vì "dọn dẹp" là vi phạm policy này.
2. **Dual-mount là bắt buộc**, không tuỳ chọn: từ ngày v(n+1) đạt Generally
   Available, v(n) phải tiếp tục phục vụ đầy đủ.
3. **Window tối thiểu 6 tháng**, tính từ ngày v(n+1) **GA**, không tính từ ngày
   announce. Announce sớm không rút ngắn được window.
4. **`Deprecation` (RFC 9745) và `Sunset` (RFC 8594) header trên mọi response
   của v(n)** kể từ ngày announce, kèm link tới migration guide. Deprecation im lặng bị
   cấm — nếu consumer chỉ biết khi endpoint chết thì window không tồn tại về mặt
   thực tế.
5. **Hết window là điều kiện cần, không phải điều kiện đủ.** Không tắt v(n) khi
   còn traffic > 0 từ consumer đã định danh. Traffic từ consumer **không** định
   danh được không chặn việc tắt — nếu không thì bot làm ADR này thành vĩnh viễn.
6. **Tối đa hai version sống cùng lúc.** Cần version thứ ba nghĩa là nhịp
   breaking change quá nhanh so với khả năng migrate của consumer, và câu trả
   lời là chậm lại, không phải mount thêm.
7. **Version là của cả platform, không của module.** Không có
   `/api/v1/pages` + `/api/v2/workflows`. Mục 1 cho phép `@Version('2')` từng
   route để **triển khai** v2 dần dần, nhưng v2 chỉ GA khi toàn bộ surface đã có
   ở v2.

### 8. Breaking và additive — phân loại có hiệu lực

**Additive (không mở version mới):**

- Thêm field **optional** vào response body.
- Thêm field optional vào request body, với default giữ nguyên hành vi cũ.
- Thêm endpoint mới, hoặc thêm HTTP method mới cho path đã có.
- Thêm giá trị mới vào enum **ở chiều request** (client gửi lên).
- Nới lỏng validation; nới rộng rate limit; thêm header response mới.

**Breaking (phải mở version mới):**

- Xoá hoặc đổi tên field trong response; đổi kiểu của field.
- Thêm field **required** vào request; siết validation; siết rate limit tới mức
  đổi hành vi của caller đang đúng.
- Đổi HTTP status hoặc đổi `error.code` cho **cùng một tình huống**.
- Đổi default của pagination, sort hoặc filter — client đọc trang đầu sẽ nhận
  tập khác mà không có tín hiệu nào.
- **Thêm giá trị mới vào enum ở chiều response.** Đây là mục dễ bị cãi nhất nên
  ghi rõ lý do: `packages/shared-types` là nguồn duy nhất của các union đó và
  cả hai app cùng import nó (xem CLAUDE.md, "Shared types package"), nên client
  TypeScript narrow trên union đóng và một giá trị lạ rơi vào nhánh không tồn
  tại. Ngoại lệ **duy nhất**: enum được khai là open-ended ngay từ v1 và spec
  ghi rõ client phải có nhánh default.
- **Đổi ngữ nghĩa mà giữ nguyên tên và kiểu.** Không type check nào bắt được,
  không test nào của consumer đỏ. Phải khai báo thủ công; bỏ sót là lỗi
  governance, không phải lỗi kỹ thuật.

**Không thuộc phân loại này**: hình dạng envelope `{ success, data, error }` và
registry của `error.code` là phạm vi **ADR-004**. Nhưng hai ADR khớp nhau ở một
điểm cứng: đổi envelope là breaking trên **toàn bộ** surface, nên ADR-004 phải
chốt và land **trong hoặc trước** #76. Nếu v1 GA với envelope hiện tại rồi
ADR-004 chọn Problem Details, hệ quả theo policy này là **v2 cho cả platform**
— không phải một lần sửa nhỏ. #76 đã gom cả hai vào một story; giữ nguyên như
vậy.

### 9. API Governance owner

Decision owner là **vai trò API Governance**, và vai trò đó phải có người cụ
thể trước khi #76 merge — `platform-decisions-risks.mdx:163` đã quy định
"Decision owner là vai trò, stakeholder cần gán người cụ thể và due date", và
ADR này không tự gán được người. Phần ADR chốt được là **remit**:

- **Sở hữu**: mục 1–3 (cách mount và hai carve-out), mục 7 (policy) và mục 8
  (phân loại). Sửa bất kỳ mục nào trong số đó là một ADR mới, không phải một PR.
- **Phải có approve của vai trò này**: bất kỳ PR nào chạm `main.ts`,
  `configure-app.ts`, hoặc thêm/đổi/xoá route path; bất kỳ thay đổi nào rơi vào
  cột "Breaking" ở mục 8; bất kỳ đề xuất carve-out `VERSION_NEUTRAL` mới.
- **Cưỡng chế bằng cơ chế, không bằng trí nhớ**: repo chưa có `.github/CODEOWNERS`.
  Tạo file đó trong #76 với entry cho `apps/backend/src/main.ts`,
  `apps/backend/src/bootstrap/`, `docs/adr/` và
  `apps/frontend/src/docs/specifications/`.
- **Nợ đã biết**: không có OpenAPI trong repo, nên hôm nay không có cách nào tự
  động phát hiện breaking change; toàn bộ mục 8 phụ thuộc vào con người đọc
  diff. Đó là lý do tài liệu "REST API Governance"
  (`platform-decisions-risks.mdx:551`) nên gồm cả việc sinh OpenAPI, và là lý do
  nó phụ thuộc ADR này.

### 10. Security và tenant isolation

- **Không có bề mặt tấn công mới.** Version segment không mang dữ liệu, không
  tham gia authz, không tham gia phân giải tenant. Tenant vẫn đến từ
  `JwtAuthGuard.canActivate()` và CLS store, không từ URL.
- **Một rủi ro thật, đúng một lần**: nếu #76 gỡ `v1/` khỏi `TenantsController`
  mà **không** bật versioning (hoặc ngược lại), sáu route super-admin —
  `SYSTEM_TENANTS_READ_PERMISSION`, `SYSTEM_TENANTS_ONBOARD_PERMISSION` — đổi
  URL. Chúng vẫn được `JwtAuthGuard` + `PermissionsGuard` bảo vệ ở URL mới, nên
  hậu quả là 404 chứ không phải mở quyền. Nhưng nó phải là **một** commit, và
  e2e của nhóm super-admin (25 path) là lưới an toàn — chúng phải xanh mà không
  cần sửa chuỗi URL.
- **Carve-out webhook (mục 2.2) là carve-out có tính bảo mật.** Endpoint đó
  `Public`, nên nó là bề mặt không xác thực duy nhất nằm ngoài version
  namespace. Bù lại bằng thiết kế đã có trong spec: authz đến từ token trong
  path, và ADR-002 mục 7 đã bắt buộc `environment_code` trong unique của
  `WorkflowTriggerDedupe`. Việc nằm ngoài `/v1` **không** nới bất kỳ ràng buộc
  nào trong số đó.
- **Health nằm ngoài version namespace không làm lộ thêm gì**: `/api/health` là
  liveness không phụ thuộc, `/api/health/ready` trả trạng thái dependency và đã
  công khai ở URL hiện tại — ADR này không đổi mức phơi bày của chúng.

## Danh sách spec phải sửa

Điều kiện đóng của #55 yêu cầu liệt kê danh sách này. Nó được chia theo **thời
điểm**, và việc chia là có chủ ý: viết `/api/v1` vào một spec mô tả hành vi đang
chạy, trước khi code chuyển, chỉ là đổi một câu đúng thành một câu sai.

**Nhóm 1 — sửa trong PR của ADR này** (câu văn về _trạng thái quyết định_, không
phải path):

| File                                                      | Nội dung phải sửa                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `specifications/overview.mdx:10`                          | "`/api/v1`… vẫn chờ ADR chung" → đã chốt, đang chờ #76 triển khai |
| `specifications/platform-decisions-risks.mdx:49`          | Mâu thuẫn `api-base`: ghi kết luận                                |
| `specifications/platform-decisions-risks.mdx:193`         | Hàng ADR-003: `Open` → `Accepted` + link file ADR                 |
| `specifications/product-capability-model.mdx:621`         | `{apiBase}` ánh xạ tới `/api/v1`                                  |
| `specifications/platform-roadmap.mdx:91`                  | Gate 0 exit: bổ sung ADR-002 và ADR-003 vào danh sách đã có       |
| `specifications/asset-file-management.mdx:513`, `:915`    | Bỏ điều kiện "chờ chốt versioning"                                |
| `specifications/iam-multi-tenant.mdx:466`                 | Bỏ đoạn mô tả sự lộn xộn `/v1` lẫn `/api/auth/*`                  |
| `specifications/pages.mdx:514`                            | Bỏ "phải được thực hiện nhất quán ở controller hoặc route module" |
| `specifications/logs.mdx:398`                             | "Tất cả endpoint nằm dưới `/api`" → `/api/v1`                     |
| `specifications/workflow-automation-architecture.mdx:333` | Bỏ ghi chú prefix + sửa `:304` theo mục 2.2                       |

**Nhóm 2 — sửa trong #76, cùng commit với thay đổi code** (path thật, `/api/<x>`
→ `/api/v1/<x>`). Tổng **48 tham chiếu** trong 14 file:

| File                                                  | Số tham chiếu |
| ----------------------------------------------------- | ------------- |
| `specifications/authentication.mdx`                   | 13            |
| `specifications/dynamic-tables.mdx`                   | 9             |
| `specifications/data-modeling-query-builder.mdx`      | 7             |
| `specifications/scheduler-engine.mdx`                 | 4             |
| `specifications/iam-multi-tenant.mdx`                 | 2             |
| `specifications/pages.mdx`                            | 2             |
| `specifications/testing-preview-debugging.mdx`        | 2             |
| `specifications/workflow-automation-architecture.mdx` | 2             |
| `current-product-state.mdx`                           | 2             |
| `specifications/core-system-configuration.mdx`        | 1             |
| `specifications/logs.mdx`                             | 1             |
| `specifications/mail-templates.mdx`                   | 1             |
| `specifications/page-builder.mdx`                     | 1             |
| `specifications/workflows.mdx`                        | 1             |

Một ngoại lệ: `workflow-automation-architecture.mdx:304`
(`POST /api/webhooks/triggers/{token}`) **giữ nguyên** — nó là carve-out ở mục
2.2 và không nằm trong 48 tham chiếu trên.

Ngoài `.mdx`: `README.md:34` và `README.md:60`. **Không đổi**:
`docs/deployment.md` (chỉ tham chiếu `/api/health`, đã carve-out ở mục 2.1).

**Nhóm 3 — trở thành đúng sau khi #76 land, không phải sửa base path**: 22 file
đang viết `/api/v1`. Trong đó `users.mdx:141` (`/api/v1/users/direct-create`),
`:151` (`/api/v1/auth/register`) và `:373` (`/api/v1/setup/redeem`) khớp
controller ngay khi prefix chuyển. Ngoại lệ duy nhất là `users.mdx:131`
(`POST /api/v1/invites`), sai ở phần **sau** prefix chứ không ở prefix:
controller là `@Controller('users/invites')`, nên nó phải là
`/api/v1/users/invites`. Sửa cùng Nhóm 2.

**Không thuộc phạm vi ADR này**: `configuration-platform-proposal.mdx`,
`extension-engine-proposal.mdx`, `platform-ux-requirements.mdx` là proposal chưa
được duyệt; chúng theo convention khi được nâng thành spec.

## Consequences

**Tích cực**

- #76 hết `Blocked by: #55`, và mở khoá luôn phần versioning trong #230/#238 —
  cả hai đang mang một dòng risk chỉ tồn tại vì ADR này chưa có.
- Mâu thuẫn `api-base` trong Decision Log đóng lại. 22 file spec viết `/api/v1`
  trở thành đúng sau #76 thay vì "chưa xác nhận", tức phần lớn tài liệu target
  không phải sửa gì.
- Chấm dứt hình thái "module tự chọn prefix" bằng một quy tắc kiểm tra được
  (mục 3: không segment version nào trong route path), thay vì bằng một câu
  khuyến nghị trong spec.
- Mục 5 sửa một khiếm khuyết có sẵn, độc lập với versioning: `app.e2e-spec.ts`
  và `dynamic-tables.e2e-spec.ts` hiện test một app không có `ValidationPipe`.
  Sau `configureApp()`, e2e chạy đúng cấu hình production.
- `nginx.conf` và toàn bộ `docs/deployment.md` không đổi. Carve-out health là lý
  do — và đó là 5 tham chiếu vận hành không bị động vào.

**Tiêu cực / phải chấp nhận**

- **117 path e2e phải sửa** (142 lời gọi supertest, 25 đã là `/api/v1`), trong
  đó 31 là template literal nên không thay được bằng find-and-replace thuần.
  Đây là phần lớn nhất của #76 và nó là công việc cơ học, dễ sai lặng lẽ.
- **Một cửa sổ rolling update có lỗi** (mục 6). Chấp nhận đúng một lần.
- **URL cũ chết ngay**: bookmark, script curl, Postman collection cá nhân của
  team đều hỏng sau #76. Không có redirect. Đây là giá của window = 0 và nó
  rơi vào nội bộ.
- **`/api/v1` không tự làm API ổn định.** Nó chỉ tạo _chỗ_ để đặt cam kết. Nếu
  mục 7 và mục 8 không được cưỡng chế thì kết quả là một v1 thay đổi ngầm — tệ
  hơn `/api` không version, vì cái tên hứa điều mà hành vi không giữ.
- **Nợ OpenAPI trở nên đắt hơn** (mục 9). Từ nay có một policy phân loại
  breaking/additive mà không có công cụ nào kiểm tra tự động.
- **Tối đa hai version sống cùng lúc (mục 7.6) là ràng buộc thật.** Nếu v2 GA
  và một consumer lớn không migrate kịp 6 tháng, lựa chọn là gia hạn window hoặc
  chấp nhận làm hỏng consumer đó — không có lối thoát bằng cách mount thêm.

**Security / tenant isolation**

Xem mục 10. Tóm tắt: không bề mặt mới ở tầng ứng dụng; một rủi ro triển khai
duy nhất (mục 3 và mục 1 phải cùng một commit) mà hậu quả là 404 chứ không phải
mở quyền; một endpoint `Public` nằm ngoài version namespace theo thiết kế, với
authz không đổi.

## Điều kiện xét lại

Mở lại quyết định khi xảy ra **bất kỳ** điều nào — không sớm hơn:

1. Xuất hiện yêu cầu phải phục vụ hai contract khác nhau cho **cùng một** route
   trong cùng một khoảng thời gian dài hạn (không phải trong window migration).
   Khi đó URI versioning không đủ và câu hỏi là header/content negotiation —
   một ADR riêng, không phải sửa mục 1.
2. Platform phát hành SDK hoặc API key cho consumer bên ngoài. Mục 6 tự hết
   hiệu lực khi đó; nhưng nếu window 6 tháng ở mục 7.3 tỏ ra sai so với hợp
   đồng thực tế, sửa **số** đó bằng ADR mới, không sửa cơ chế.
3. Có OpenAPI + kiểm tra breaking change tự động trong CI. Khi đó mục 8 chuyển
   từ "phân loại để người đọc diff" sang "cấu hình cho công cụ", và phần cưỡng
   chế của mục 9 viết lại.

**Không phải điều kiện xét lại**: một module muốn version riêng vì nhịp thay đổi
của nó nhanh hơn phần còn lại. Mục 7.7 đã trả lời; ghi ra đây để không ai mở ADR
mới cho việc đó.

## Follow-up

- [#76](https://github.com/majinbaka/Flexi/issues/76) (Story 0.2.1): hết
  `Blocked by: #55`; vẫn `Blocked by: #56` (ADR-004) — và theo mục 8, hai ADR
  phải land cùng nhau chứ không nối tiếp. Phạm vi được ADR này bổ sung so với
  mô tả issue: trích `configureApp()` (mục 5), gỡ `v1/` khỏi
  `TenantsController` và 5 call site frontend (mục 3), carve-out
  `VERSION_NEUTRAL` cho health và webhook (mục 2), sửa 5 nơi khai
  `VITE_API_BASE_URL` thay vì sửa `api-client.ts` (mục 4), và sửa spec Nhóm 2
  trong cùng commit. Tạo `.github/CODEOWNERS` (mục 9).
- [#230](https://github.com/majinbaka/Flexi/issues/230),
  [#238](https://github.com/majinbaka/Flexi/issues/238) (epic logs #52): giữ
  nguyên cách né hiện tại — bám prefix hiện tại, để #76 đổi cho toàn bộ API.
  Dòng risk trong hai issue có thể trỏ tới ADR này thay vì mô tả câu hỏi mở.
- Vai trò **API Governance** phải được gán người cụ thể + due date trước khi
  #76 merge (mục 9). Đây là mục duy nhất của #55 mà ADR không tự đóng được.
- Tài liệu "REST API Governance" (`platform-decisions-risks.mdx:551`) hết phụ
  thuộc ADR-003; còn phụ thuộc ADR-004. Phạm vi của nó nên gồm việc sinh
  OpenAPI, theo nợ đã ghi ở mục 9.
- Mọi issue mở public API mới từ Epic 1 trở đi: mục 6 điều kiện (1) sẽ hết đúng
  ở issue đầu tiên phát hành API key. Issue đó phải mang theo việc chuyển policy
  sang chế độ mục 7, không coi đó là việc của người sau.
- ADR-001 và ADR-002 **không bị sửa**. ADR này không chạm trục environment hay
  trục lưu trữ.
- Spec Nhóm 1 được cập nhật trong cùng PR với ADR này; Nhóm 2 trong #76.
