# ADR-004: Error envelope và canonical error naming

| Trường         | Giá trị                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trạng thái     | Accepted                                                                                                                                                                        |
| Ngày           | 2026-08-28                                                                                                                                                                      |
| Decision owner | API Governance — @majinbaka; Frontend đồng thuận phần `ApiError`                                                                                                                |
| Issue          | [#56](https://github.com/majinbaka/Flexi/issues/56)                                                                                                                             |
| Blocking       | [#78](https://github.com/majinbaka/Flexi/issues/78) (error registry), [#76](https://github.com/majinbaka/Flexi/issues/76) (Story 0.2.1)                                         |
| Spec liên quan | `apps/frontend/src/docs/specifications/platform-decisions-risks.mdx`, `overview.mdx`, `product-capability-model.mdx`, `application-management.mdx`, `asset-file-management.mdx` |

## Context

### Repo đang là gì (đã đối chiếu code, không lấy từ planning doc)

- Envelope do đúng hai file sinh ra, đăng ký là `APP_INTERCEPTOR`/`APP_FILTER`
  trong `app.module.ts`: `apps/backend/src/common/response.interceptor.ts`
  (nhánh thành công) và `apps/backend/src/common/http-exception.filter.ts`
  (nhánh lỗi, `@Catch()` không tham số nên bắt cả `HttpException` lẫn lỗi
  không lường trước).
- **Envelope được khai báo bốn lần, không lần nào dùng chung.**
  `response.interceptor.ts:11` (`ApiSuccessEnvelope`),
  `http-exception.filter.ts:12` (`ApiErrorEnvelope`),
  `apps/frontend/src/lib/api-client.ts:72,78` (một cặp nữa), và
  `packages/shared-types/src/envelope.ts` — file cuối **có 0 importer** trong
  toàn repo (`ApiSuccessResponse|ApiErrorResponse|ApiResponse<` không xuất hiện
  ở bất kỳ file `.ts(x)` nào ngoài chính nó). Bốn bản đã lệch: filter có
  `fields`, `existingAttemptId`, `checks`; `envelope.ts` chỉ có `fields`;
  `api-client.ts` chỉ có `existingAttemptId`.
- **86 lời gọi `new *Exception(...)`** trong `apps/backend/src` (không tính
  `*.spec.ts`) và **cả 86 đều dùng dạng object**, không có dạng chuỗi. Trong đó
  83 lời gọi mang khoá `error:`; 3 lời gọi không mang (xem dưới).
- **37 error code khác nhau đang thật sự lên wire.** 34 code đến từ lời gọi
  exception trực tiếp, 3 code còn lại đi qua
  `DynamicTablesService.guardrailExceeded()`
  (`dynamic-tables.service.ts:1898`): `DYNAMIC_TABLES_PAGE_SIZE_EXCEEDED`,
  `DYNAMIC_TABLES_TABLE_LIMIT_EXCEEDED`, `DYNAMIC_TABLES_FIELD_LIMIT_EXCEEDED`.
- **Chỉ 19/37 code có nhà trong `packages/shared-types`**: `AUTH_ERROR_CODES`
  (7) và `USER_ERROR_CODES` (12), cả hai nằm trong `entities.ts:922` và `:953`.
  18 code còn lại là string literal rải trong service —
  `VALIDATION_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `UNAUTHORIZED`,
  `TENANT_NOT_FOUND`, `SLUG_ALREADY_IN_USE`, `IDEMPOTENCY_CONFLICT`,
  `INVALID_SETUP_TOKEN`, `IMPERSONATION_NOT_ALLOWED`, `FIRST_ADMIN_NOT_FOUND`,
  `ONBOARDING_RESERVATION_PENDING`, `ONBOARDING_ATTEMPT_NOT_FOUND`,
  `ONBOARDING_ATTEMPT_STATUS_UNAVAILABLE`, `READINESS_UNAVAILABLE`,
  `PROVISIONING_ENQUEUE_FAILED`, `CANNOT_DEACTIVATE_SELF` và ba code
  `DYNAMIC_TABLES_*` ở trên.
- Chiều ngược lại cũng có: `AUTH_ERROR_CODES.ACTOR_INACTIVE`
  (`entities.ts:933`) **không được ném ở đâu cả**. Điều kiện mà docblock của nó
  mô tả — actor sau một refresh token hợp lệ đã bị vô hiệu hoá — thực tế gộp
  vào `INVALID_REFRESH_TOKEN` (`auth.service.ts:141`, gộp có chủ ý để chống
  enumeration). Đây là một entry catalog chết, không phải một code chưa dùng.
- **Không có code nào đang ánh xạ tới hai HTTP status.** Đối chiếu toàn bộ 37
  code cho ra quan hệ một–một với đúng một lớp exception. Invariant "một code
  một status" đúng ở hôm nay chứ không phải một mục tiêu.
- **Zero code nào mang prefix `ERR_`.** Prefix `ERR_` chỉ tồn tại trong spec, và
  chỉ trong spec của các module còn là stub.
- Frontend rẽ nhánh theo code ở **10 chỗ** (`login-error.ts:13`,
  `SetupAccountPage.tsx:86`, `ResetPasswordPage.tsx:125,130,139`,
  `ChangePasswordPage.tsx:98`, `ForgotPasswordPage.tsx:100`,
  `TenantOnboardingPage.tsx:337,526,533`) qua `ApiError`
  (`api-client.ts:42`). `ApiError` chỉ mang `code`, `message`,
  `existingAttemptId` — nó **vứt** `fields` và `checks` mà backend đã gửi.
- Backend có **131 assertion** đụng vào `success`/`data` trong
  `apps/backend/test`, và **52 assertion** đụng vào `error.code` trong 5 file.

### Bốn chỗ envelope hiện tại đang rò contract, đều tìm ra khi đối chiếu

1. **`VALIDATION_ERROR` không phải cái mà validation thật sự trả về.**
   `ValidationPipe` toàn cục bind ở `main.ts:36` dùng `exceptionFactory` mặc
   định của Nest, tức `BadRequestException(string[])`, tức body
   `{ message: [...], error: 'Bad Request', statusCode: 400 }`. Filter đọc
   `body.error` (`http-exception.filter.ts:107`) nên **code trên wire là
   `'Bad Request'`** — có dấu cách, là HTTP reason phrase, không phải một
   identifier. Hành vi này đã được chốt bằng test:
   `apps/backend/test/self-registration.e2e-spec.ts:374` assert
   `error: { code: 'Bad Request' }`, kèm docblock nói rõ "asserted here as it
   is, not as it arguably ought to be". `VALIDATION_ERROR` (53 lần xuất hiện,
   nhiều nhất trong repo) chỉ là code của validation **viết tay** ở service.
2. **Mảng message bị làm phẳng.** `http-exception.filter.ts:102` gặp
   `Array.isArray(body.message)` thì `join(', ')`. 13 chỗ trong service ném
   `message: [...]` có cấu trúc; wire nhận về một chuỗi. Cấu trúc mảng mà #56
   yêu cầu "chốt cách biểu diễn" hiện **không tồn tại trên wire**, kể cả khi
   service đã tạo ra nó.
3. **429 không có code ổn định.** `ThrottlerGuard` ném `ThrottlerException`,
   và `ThrottlerException` gọi `super(string, 429)` — body dạng chuỗi, nên rơi
   vào nhánh `http-exception.filter.ts:84` và cho `code = HttpStatus[429]`, tức
   `'TOO_MANY_REQUESTS'`, kèm `message` là chuỗi tiếng Anh
   `'ThrottlerException: Too Many Requests'`. Frontend không tin cái đó: nó
   **tự chế** `RATE_LIMITED` (`api-client.ts:55`) cho 4 path trong
   `RATE_LIMITED_PATHS`. Client và server đang gọi tên khác nhau cho cùng một
   sự kiện, và server là bên không có tên.
4. **5xx rò thông điệp nội bộ.** Filter redact rất tốt cho lỗi _không_ phải
   `HttpException` (`:120`, luôn trả `INTERNAL_SERVER_ERROR` +
   `'An unexpected error occurred'`), nhưng `InternalServerErrorException` ném
   tay với body chuỗi thì đi qua nhánh `:84` và **message tới thẳng client**.
   Có đúng hai chỗ: `auth.service.ts:405` nội suy `authAccountId` vào câu
   `Data integrity violation: AuthAccount <id> backs both...`, và
   `first-admin.service.ts:112`. Cả hai đều là 500, tức là đúng loại lỗi mà
   client không được nhìn thấy chi tiết.

Ngoài ra `existingAttemptId` và `checks` là hai khoá mở rộng được **hard-code
theo endpoint ngay trong filter toàn cục**: `resolveSafeExistingAttemptId()`
(`:146`) kiểm tra đúng `status === 409 && code === 'IDEMPOTENCY_CONFLICT'`, và
`resolveSafeChecks()` (`:162`) tồn tại chỉ để phục vụ
`health.controller.ts:26`. Nguyên tắc allowlist ở đây là đúng — nó chặn thân
exception tuỳ ý rò ra ngoài — nhưng nơi khai báo thì sai: mỗi module mới muốn
một khoá mở rộng lại phải sửa filter. Hai module đã làm thế.

### Spec đang nói gì, và mâu thuẫn ở đâu

- `application-management.mdx:181` mô tả một payload Problem Details đầy đủ
  (`type`/`title`/`status`/`detail`/`code`/`meta`) cho conflict slug khi import,
  rồi `:194` tự thừa nhận backend đang dùng envelope và đẩy việc hoà giải sang
  "task implementation". Endpoint đó **chưa tồn tại**: module Application chưa
  có trong code (#82, #84 đều Open).
- `ERR_*` xuất hiện ở `scheduler-engine.mdx` (5 code), `connectors-and-integrations.mdx`
  (5), `collaboration-governance.mdx` (5), `environment-release-management.mdx`
  (2), `configuration-platform-proposal.mdx` (5). **Tất cả đều thuộc module còn
  là stub** (`workflows`, `cron-jobs`, `settings`, …) hoặc thuộc proposal chưa
  duyệt. Không có một dòng code nào phải đổi tên nếu bỏ prefix.
- `connectors-and-integrations.mdx:457` tự ghi nhận xung đột trong chính nó:
  business rule dùng `ERR_CIRCUIT_OPEN`, taxonomy dùng `ERR_RES_CIRCUIT_OPEN`.
- `collaboration-governance.mdx:433` dùng **422** cho `ERR_DEPENDENCY_BLOCK`.
  Repo chưa từng trả 422 ở bất kỳ route nào.
- `product-capability-model.mdx:600` mô tả contract `ApiError` mục tiêu gồm
  `correlationId` và `retryable` — hai trường envelope hiện tại không có.
- Decision Log (`platform-decisions-risks.mdx:205`) tóm ADR này thành "Chốt
  prefix ERR_ và HTTP mapping", tức đã ngầm chọn `ERR_` trước khi ai đối chiếu
  xem repo có dùng nó không. Nó không dùng.
- Xung đột nặng nhất, do chính comment của #56 nêu: bốn nơi đặt bốn tên cho
  hai (không phải một) tình huống 409 — `WORKFLOW_REVISION_CONFLICT` (#218),
  `STALE_VERSION_CONFLICT` (#50), `ERR_OPTIMISTIC_LOCK_CONFLICT`
  (`collaboration-governance.mdx:421`), và `APP_IMPORT_SLUG_CONFLICT` (#84).

### Vì sao phải chốt bây giờ

- ADR-003 đã chốt: đổi envelope sau khi v1 GA là breaking trên **toàn bộ**
  surface, tức là v2 cho cả platform. Cửa sổ để quyết định cái này miễn phí
  đóng lại đúng lúc #76 merge.
- #78 (canonical error registry) ghi `Blocked by: #56` và là nơi 18 string
  literal kia được gom lại. #76 đã mang sẵn ba gạch đầu dòng của ADR này trong
  phạm vi ("Áp dụng quyết định từ ADR-004", "Chuẩn hoá shape `VALIDATION_ERROR`",
  "Xuất type envelope từ `packages/shared-types/src/envelope.ts`") — chúng đang
  chờ nội dung.
- #208 và #216 **chưa merge** (cả hai Open; `CONFIG_ERROR_CODES` và
  `WORKFLOW_ERROR_CODES` không tồn tại trong `packages/shared-types`). Comment
  của #56 nói hai họ code này "đã ship" — đối chiếu cho thấy chưa. Đây là tin
  tốt và nó đổi kết luận: chốt naming **bây giờ** còn kịp trước khi hai catalog
  mới ra đời, migration cost bằng không chứ không phải "càng merge càng đắt".

## Options đã cân nhắc

### A. Giữ envelope `{ success, data, error }` (chọn)

Không phá 131 assertion e2e, 52 assertion error code, 10 chỗ rẽ nhánh frontend
và toàn bộ `api-client.ts`. Không mua được chuẩn công nghiệp. Đổi lại, bốn
khiếm khuyết ở phần Context vẫn phải sửa — nhưng cả bốn đều sửa được bằng thay
đổi **additive** hoặc thay đổi ở nhánh mà client hôm nay không chạm tới.

### B. Problem Details (RFC 7807/9457)

Chuẩn công nghiệp thật, có `Content-Type: application/problem+json`, có `type`
URI để tra cứu, và các gateway/observability tool hiểu sẵn. Giá: viết lại
`http-exception.filter.ts`, `response.interceptor.ts` (vì `success:false` biến
mất thì `success:true` cũng hết lý do tồn tại), `api-client.ts`, 10 chỗ rẽ
nhánh, 183 assertion, và một `type` URI namespace phải host được. **Loại**, vì
lợi ích của nó — cho consumer bên ngoài đọc lỗi mà không cần đọc doc của ta —
đúng bằng lợi ích mà ADR-003 mục 6 đã xác nhận là chưa tồn tại: hôm nay không
có consumer nào ngoài repo này.

### C. Hybrid — Problem Details lồng trong `error`

`{ success:false, data:null, error:{ type, title, status, detail, code, meta } }`.
Có mọi chi phí của B ở phía server, cộng thêm một tầng lồng cho client, và
không có lợi ích nào của B vì `Content-Type` vẫn là `application/json` nên
không tool nào nhận ra đó là Problem Details. **Loại** — nó là hình thái tệ
nhất trong ba, và `application-management.mdx:194` đang đề xuất đúng nó.

### D. Giữ envelope nhưng thêm `correlationId` + `retryable` ngay bây giờ

`product-capability-model.mdx:600` mô tả cả hai. **Loại ở lần này**, không phải
vĩnh viễn: `correlationId` chỉ có giá trị khi có nơi tra cứu nó, và trace
propagation thuộc epic logs (#52) chưa land; `retryable` suy được từ
`status` + registry nên đặt lên wire là nhân đôi nguồn sự thật. Điều kiện mở
lại nằm ở "Điều kiện xét lại" mục 2.

## Decision

### 1. Envelope giữ nguyên từng byte, và đóng băng cho v1

Wire shape không đổi:

```jsonc
{ "success": true,  "data": { /* ... */ }, "error": null }
{ "success": false, "data": null, "error": { "code": "...", "message": "..." } }
```

`success` là boolean literal, `data` là `null` khi lỗi, `error` là `null` khi
thành công. Không có Problem Details, không có `type`/`title`/`detail`, không có
`Content-Type` riêng. Mọi payload Problem Details trong spec là mô tả **nội
dung** cần có, không phải mô tả **shape** — chúng được dịch sang envelope, không
được nhúng vào envelope.

Từ ngày #76 merge, bất kỳ thay đổi nào ở ba khoá cấp một này là breaking theo
ADR-003 mục 8 và chỉ được làm ở ranh giới version.

### 2. Một khai báo duy nhất, ở `packages/shared-types/src/envelope.ts`

File đó thôi là dead code. `response.interceptor.ts`, `http-exception.filter.ts`
và `api-client.ts` import từ nó thay vì tự khai báo. Shape chốt:

```ts
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  error: null;
}

export interface ApiErrorPayload {
  /** Canonical code, có trong registry (#78). Đây là khoá duy nhất được rẽ nhánh. */
  code: string;
  /** Tiếng Anh, do server viết, không dịch. Không bao giờ là khoá rẽ nhánh. */
  message: string;
  /** Mảng message validation, giữ nguyên thứ tự và không nối chuỗi. */
  details?: string[];
  /** field -> code lỗi của field đó. */
  fields?: Record<string, string>;
  /** Khoá mở rộng do registry khai báo cho từng code — giữ nguyên tên đang có. */
  existingAttemptId?: string;
  checks?: Record<string, 'ok' | 'error'>;
}

export interface ApiErrorResponse {
  success: false;
  data: null;
  error: ApiErrorPayload;
}
```

`details` là trường **mới, optional** — additive, không client nào hỏng.
`existingAttemptId` và `checks` **giữ nguyên tên và giữ nguyên vị trí phẳng**;
gói chúng vào một object con sẽ phá `TenantOnboardingPage.tsx:526` và không mua
được gì.

Nguyên tắc allowlist của filter được giữ, nhưng nơi khai báo chuyển từ code sang
registry: mỗi entry registry nói code đó được phép mang khoá mở rộng nào và
kiểu gì; filter đọc registry. `resolveSafeExistingAttemptId()` và
`resolveSafeChecks()` mất phần điều kiện hard-code, không mất phần sanitize.

### 3. Naming: SCREAMING_SNAKE_CASE, `[<DOMAIN>_]<CONDITION>`, **không** prefix `ERR_`

Quy ước chốt:

- `A-Z` và `_`, ASCII, không dấu cách, không chữ thường, tối đa 48 ký tự.
- `<CONDITION>` là bắt buộc, `<DOMAIN>_` chỉ thêm khi điều kiện trần bị nhập
  nhằng giữa các module. `QUOTA_EXCEEDED` không cần domain vì chỉ Users có
  hạn mức seat; `DYNAMIC_TABLES_FIELD_LIMIT_EXCEEDED` cần, và code đó đã tồn
  tại đúng theo grammar này.
- Code **không được** là HTTP reason phrase (`'Bad Request'`, `'Not Found'`) và
  không được chứa dữ liệu tenant/user.
- **Không dùng prefix `ERR_`.** 37/37 code đang chạy không có nó; nó không mang
  thông tin nào mà khoá `error.code` chưa mang; và mọi `ERR_*` trong spec thuộc
  module chưa viết, nên bỏ prefix tốn 0 dòng code. Đổi lại, giữ `ERR_` sẽ bắt
  đổi tên 37 code đang chạy cộng 10 chỗ rẽ nhánh frontend để đạt đúng con số
  không lợi ích.
- `message` không phải contract. Sửa câu chữ tiếng Anh là additive; client nào
  match text là client sai, và không có client nào đang làm thế.

Ba code hôm nay lấy tên từ HTTP status (`UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`) hợp lệ theo quy ước này và **giữ nguyên** — chúng là spelling
identifier, không phải reason phrase.

### 4. HTTP status mapping: một code, đúng một status

Invariant đã đúng cho cả 37 code hôm nay; từ nay nó là luật, cưỡng chế bằng
registry (status là thuộc tính của entry, không phải lựa chọn của call site).

| Status | Dùng cho                                                        | Ví dụ đang chạy                                                         |
| ------ | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 400    | Input sai shape/giá trị, và tiền điều kiện nghiệp vụ không thoả | `VALIDATION_ERROR`, `QUOTA_EXCEEDED`, `INVALID_OTP`, `CANNOT_LOCK_SELF` |
| 401    | Chưa xác thực, hoặc credential/token không dùng được            | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`          |
| 403    | Đã xác thực nhưng không được phép, hoặc policy đóng             | `FORBIDDEN`, `SELF_REG_DISABLED`, `IMPERSONATION_NOT_ALLOWED`           |
| 404    | Không tìm thấy **trong phạm vi tenant của caller**              | `NOT_FOUND`, `TENANT_NOT_FOUND`, `INVITE_NOT_FOUND`                     |
| 409    | Xung đột trạng thái — đúng ba loại, xem mục 6                   | `SLUG_ALREADY_IN_USE`, `EMAIL_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`   |
| 429    | Vượt rate limit                                                 | `RATE_LIMITED` (mục 7)                                                  |
| 503    | Phụ thuộc tạm không phục vụ được; caller thử lại được           | `READINESS_UNAVAILABLE`, `ONBOARDING_RESERVATION_PENDING`               |
| 500    | Ngoài dự kiến. Message luôn bị redact (mục 8)                   | `INTERNAL_SERVER_ERROR`                                                 |

Hai kết luận có hiệu lực ngay:

- **`QUOTA_EXCEEDED` giữ 400.** Đóng dòng `quota-status` trong Decision Log
  (`platform-decisions-risks.mdx:150`). 402 cần một mặt phẳng billing chưa tồn
  tại; 403 sai vì đây không phải vấn đề quyền; 409 sai vì không có state nào
  đang xung đột. Đây là tiền điều kiện của request không thoả — đúng 400, và
  `DYNAMIC_TABLES_*_LIMIT_EXCEEDED` đã ở đó rồi.
- **422 không được dùng.** Repo chưa từng trả 422; `ERR_DEPENDENCY_BLOCK`
  (`collaboration-governance.mdx:433`) chuyển về 400 khi module đó được viết.
  Một status ít dùng chỉ có giá trị nếu client phân biệt nó với 400, và client
  ở đây rẽ nhánh theo `code`, không theo status.

### 5. `VALIDATION_ERROR`: một code, `message` là chuỗi, mảng nằm ở `details`

Đây là câu trả lời cho điều kiện đóng "chốt cách biểu diễn `VALIDATION_ERROR`
với mảng message (shape hiện có)".

1. **Mọi thất bại validation đều mang code `VALIDATION_ERROR`**, kể cả từ
   `ValidationPipe`. `configureApp()` — hàm mà ADR-003 mục 5 đã bắt #76 trích
   ra — truyền `exceptionFactory` trả
   `new BadRequestException({ error: 'VALIDATION_ERROR', message: errors })`.
   Code `'Bad Request'` biến mất khỏi wire. `self-registration.e2e-spec.ts:374`
   được sửa trong cùng commit; docblock ở đó đã báo trước chính xác việc này.
2. **`message` vẫn là `string`.** Filter vẫn `join(', ')`. Không đổi thành
   `string | string[]`: `ApiError extends Error` nên `message` phải là chuỗi, và
   một union sẽ bắt cả 10 chỗ rẽ nhánh frontend phải narrow để in một câu.
3. **Mảng được giữ nguyên ở `details: string[]`**, đúng thứ tự, không nối, không
   cắt bớt. 13 chỗ service đang ném `message: [...]` không phải sửa gì — filter
   ghi cả hai: `message` (đã nối) và `details` (nguyên bản).
4. **`fields` là kênh máy đọc, `details` là kênh người đọc.** `fields` map
   `field -> FIELD_ERROR_CODE` (14 chỗ đang dùng, ví dụ
   `tenants.service.ts:182`); `details` mang câu tiếng Anh. Hai trường độc lập,
   đều optional, không trường nào bắt buộc trường kia.
5. **`ApiError` phía frontend phải mang `details` và `fields`.** Hôm nay
   `api-client.ts:46` vứt cả hai, nên form không có cách hiển thị lỗi theo
   field dù backend đã gửi. Thêm hai property là additive.

### 6. 409 có đúng ba điều kiện và đúng ba code — hết xung đột bốn tên

Comment của #56 gộp bốn tên vào "cùng một tình huống". Đối chiếu cho thấy đó là
**hai** tình huống khác nhau, và repo đã có tên cho một trong hai:

| Điều kiện                                            | Code canonical         | Thay cho                                                                                            |
| ---------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Optimistic locking trên artifact có version          | `REVISION_CONFLICT`    | `WORKFLOW_REVISION_CONFLICT` (#218), `STALE_VERSION_CONFLICT` (#50), `ERR_OPTIMISTIC_LOCK_CONFLICT` |
| Vi phạm uniqueness của một slug trong phạm vi tenant | `SLUG_ALREADY_IN_USE`  | `APP_IMPORT_SLUG_CONFLICT` (#84) — **đã tồn tại** ở `tenants.service.ts:604`                        |
| Phát lại một idempotency key đã dùng                 | `IDEMPOTENCY_CONFLICT` | — (giữ nguyên, đang chạy)                                                                           |

`APP_IMPORT_SLUG_CONFLICT` **không** phải optimistic-locking conflict: không có
version nào bị lệch, chỉ có một unique constraint `(tenant_id, slug)` bị đụng —
đúng thứ `SLUG_ALREADY_IN_USE` đang làm cho tenant. Gộp nó vào nhóm
revision-conflict sẽ tạo ra một code thứ tư cho một điều kiện đã có tên.

`REVISION_CONFLICT` là code chung cho mọi artifact có version (workflow, page,
query, asset, mail template). Module **không** được thêm domain prefix vào nó:
client xử lý cả năm loại giống hệt nhau (refetch, hiện diff, cho merge tay), và
loại artifact đã nằm trong URL. Payload đi kèm — revision hiện tại của server,
đủ để client dựng diff — do #93 định nghĩa cùng `If-Match`; ADR này chốt tên và
status, không chốt shape payload đó.

### 7. Không có HTTP reason phrase nào lên wire

Filter chỉ tin `body.error` khi nó là một code hợp lệ trong registry. Ngoài ra,
code đến từ một bảng status → code canonical duy nhất, không phải từ
`HttpStatus[status]` hay từ `body.error` do Nest tự sinh. Ba trường hợp thật
hôm nay:

- `ValidationPipe` → `VALIDATION_ERROR` (mục 5), thay cho `'Bad Request'`.
- `ThrottlerGuard` → **`RATE_LIMITED`**, 429. Đây đúng là chuỗi mà
  `api-client.ts:55` đang tự chế; sau #76 client xoá phần tự chế và đọc code từ
  server, kèm xoá luôn `RATE_LIMITED_PATHS` — một danh sách path phải đi bảo trì
  song song với `auth.controller.ts` mà không có gì bắt nó đồng bộ.
- 404 do router Nest (path không khớp controller nào) → `NOT_FOUND`, thay cho
  `'Not Found'`.

`'HTTP_ERROR'` (`http-exception.filter.ts:86,107`) là fallback không bao giờ
đạt tới sau thay đổi này; nó bị xoá chứ không được giữ làm lưới an toàn — một
lưới an toàn im lặng ở đây nghĩa là một code không tra được lọt ra production.

### 8. 5xx luôn redact

Mọi phản hồi có `status >= 500` trả `code: 'INTERNAL_SERVER_ERROR'` và
`message: 'An unexpected error occurred'`, bất kể exception là gì. Câu chữ do
lập trình viên viết chỉ đi vào log (`http-exception.filter.ts:53` đã log sẵn
stack). Hôm nay nhánh không-phải-`HttpException` (`:120`) làm đúng điều này,
nhánh `HttpException` dạng chuỗi thì không — và chính hai chỗ đi qua nhánh đó
là `auth.service.ts:405` (nội suy `authAccountId` vào message) và
`first-admin.service.ts:112`. Không client nào rẽ nhánh theo 5xx, nên đây là
thay đổi không phá gì.

### 9. Registry và cách cưỡng chế (phạm vi #78)

- Registry ở `packages/shared-types/src/errors.ts`. Mỗi entry: `code`, `status`,
  `description`, khoá mở rộng được phép, `aliases` (mục 10), và cờ đánh dấu các
  code **gộp có chủ ý** để chống enumeration.
- `AUTH_ERROR_CODES` và `USER_ERROR_CODES` không bị xoá — chúng trở thành view
  đọc từ registry, nên 40+ call site và 10 chỗ frontend không phải đổi trong
  cùng lúc. `ACTOR_INACTIVE` bị **xoá**, không phải được hiện thực hoá: điều
  kiện của nó gộp vào `INVALID_REFRESH_TOKEN` có chủ ý.
- Cờ "gộp có chủ ý" là bắt buộc, không phải trang trí. `INVALID_OTP`
  (`password-reset.service.ts:45`), `INVITE_TOKEN_EXPIRED` và
  `SELF_REG_DISABLED` (trả cho cả tenant không tồn tại lẫn tenant đã tắt,
  `self-registration.e2e-spec.ts:344`) cố tình gộp nhiều điều kiện làm một để
  không xác nhận sự tồn tại của account/invite/tenant. Một refactor "cho gọn"
  tách chúng ra sẽ mở lại lỗ enumeration; registry phải nói rõ điều đó tại chỗ.
- Cưỡng chế: ESLint `no-restricted-syntax` cấm string literal ở thuộc tính
  `error` bên trong `new *Exception({ ... })` — service phải import hằng từ
  registry. Đây là kiểm tra tĩnh, chạy trong `pnpm lint` sẵn có, không cần hạ
  tầng mới. Filter **không** được biến code lạ thành 500 lúc runtime: nó sẽ đổi
  một 400 thành 500 ở production, tệ hơn cái nó phòng.
- Bảng error code trong Storybook sinh từ registry (#78 đã có gạch đầu dòng
  này). Bảng viết tay trong `collaboration-governance.mdx`,
  `connectors-and-integrations.mdx`, `scheduler-engine.mdx` được thay khi module
  tương ứng được viết, không phải trước.

### 10. Alias policy: registry-level trước GA, version boundary sau GA

Điều kiện đóng của #56 yêu cầu "alias policy cho error code đổi tên". Chốt hai
chế độ, ranh giới trùng đúng ranh giới ADR-003 mục 6:

**Trước v1 GA (hôm nay — không consumer nào ngoài repo, client và server phát
hành cùng một artifact):** đổi tên là một commit sửa cả server, client, spec và
test. Không có alias trên wire. Spelling cũ vào `aliases` của entry và **bị
khoá vĩnh viễn khỏi việc tái sử dụng** — một test đọc registry và fail nếu một
spelling đã retire xuất hiện lại làm `code` của bất kỳ entry nào. Đây là toàn
bộ chi phí, và nó là lý do ADR này rẻ khi land trước #208/#216.

**Từ v1 GA:** `code` là một phần của contract. Theo ADR-003 mục 8, đổi tên một
code — hoặc tách một code thành hai — là **breaking**, vì client đang rẽ nhánh
theo nó. Vậy nên nó chỉ xảy ra ở ranh giới version, và cơ chế alias đã có sẵn:
hai version dual-mount cùng lúc, v cũ tiếp tục phát spelling cũ trong ≥ 6 tháng.
Không thêm cơ chế alias nào ở tầng wire — không phát hai code, không thêm
trường `deprecatedCode`. Thêm một code **mới** cho một điều kiện **mới** vẫn là
additive.

`aliases` do đó luôn là tài liệu + lưới an toàn cho lint, không bao giờ là dữ
liệu runtime.

### 11. Security và tenant isolation

- Không có bề mặt mới. Envelope không đổi, không thêm trường nào mang dữ liệu
  chưa từng ra khỏi server.
- Mục 8 **thu hẹp** bề mặt: một message 500 có nội suy `authAccountId` hết rò.
- Mục 9 biến các gộp chống enumeration từ tri thức nằm trong docblock thành dữ
  liệu registry, để #78 refactor 18 string literal mà không vô tình tách chúng.
- 404 vẫn là "không thấy trong phạm vi tenant của caller" (mục 4), không phải
  "không tồn tại". Quy ước này giữ nguyên vì nó là thứ ngăn một token của tenant
  B dò ra id của tenant A.
- `details`, `fields`, `checks` vẫn đi qua sanitizer của filter
  (`resolveSafeFields`, `resolveSafeChecks`): chỉ giá trị đúng kiểu mới lọt, thân
  exception tuỳ ý thì không. `details` chỉ nhận `string[]` và chỉ cho
  `VALIDATION_ERROR` theo khai báo registry.
- `message` là tiếng Anh do server viết và **không được** chứa dữ liệu tenant.
  Mục 3 nói rõ nó không phải contract, nên không có lý do nội suy giá trị người
  dùng vào đó để client parse.

## Danh sách spec phải sửa

**Nhóm 1 — sửa trong PR này** (câu văn về trạng thái quyết định):

- `overview.mdx:14` — "Problem Details vẫn chờ ADR-004" → đã chốt: giữ envelope.
- `asset-file-management.mdx:515` và `:918` — envelope hết "chờ ADR-004".
- `product-capability-model.mdx:42` (một trong ba mâu thuẫn chặn Epic nền tảng),
  `:605` (`rule` của contract `ApiError`), `:623`, `:847` (câu về alias `ERR_*`).
- `platform-decisions-risks.mdx` — dòng `error-shape` (`:57`), dòng
  `quota-status` (`:150`), dòng `ADR-004` (`:202`).
- `application-management.mdx:194` — bỏ chỉ dẫn "chốt cách nhúng Problem Details
  vào envelope"; payload ở `:181` là mô tả nội dung, dịch sang envelope.
- `connectors-and-integrations.mdx:563` (dòng decision `error-code`) và `:569`
  (dòng decision `api-versioning`).
- `testing-preview-debugging.mdx:309` và `scheduler-engine.mdx:369` — câu
  "envelope chưa được xác nhận từ implementation" không còn đúng; phần endpoint
  của cả hai câu thì vẫn đúng và được giữ.

**Nhóm 2 — sửa cùng code, không sửa trước** (#78, và phần envelope của #76):
bảng error code viết tay trong `collaboration-governance.mdx:403-448`,
`connectors-and-integrations.mdx:404-455` (gồm cả xung đột
`ERR_CIRCUIT_OPEN`/`ERR_RES_CIRCUIT_OPEN` ở `:457`),
`scheduler-engine.mdx:408-447`, `environment-release-management.mdx:273,274,326`.
Mười bảy code `ERR_*` này thuộc module chưa viết; đổi tên chúng trong spec
trước khi có registry chỉ tạo ra một danh sách thứ hai phải đồng bộ tay.

**Không thuộc phạm vi ADR này**: `configuration-platform-proposal.mdx`,
`extension-engine-proposal.mdx`, `platform-ux-requirements.mdx` là proposal chưa
duyệt; chúng theo convention khi được nâng thành spec.

## Consequences

**Tích cực**

- #78 hết `Blocked by: #56` và có đủ đầu vào để viết: shape, grammar, bảng
  status, ba code 409 canonical, alias policy, và danh sách chính xác 18 string
  literal cần gom cùng 1 entry catalog cần xoá.
- Xung đột bốn tên cho 409 đóng lại **trước** khi #218, #84 và #93 viết code —
  không có migration nào phải trả.
- #208 và #216 gỡ được câu phòng ngừa "nếu #78/#56 chốt naming khác thì đổi tên
  một lần cho toàn bộ catalog". Naming đã chốt, và nó là naming mà hai issue đó
  đang định dùng (không prefix, SCREAMING_SNAKE_CASE).
- Ba dòng mâu thuẫn trong Decision Log đóng cùng lúc: `error-shape`,
  `quota-status`, và phần error của `connection-state`.
- Bốn khai báo envelope gộp về một, và `packages/shared-types/src/envelope.ts`
  hết là dead code — nó vốn đã được #76 và #78 liệt kê là baseline.
- Client bớt hai thứ tự chế: `RATE_LIMITED` và `RATE_LIMITED_PATHS`. Danh sách
  path thứ hai phải đồng bộ tay với `auth.controller.ts` biến mất.
- Form phía frontend lần đầu tiên đọc được `fields` — dữ liệu backend đã gửi
  suốt nhưng `ApiError` vứt đi.

**Tiêu cực / phải chấp nhận**

- **Không có chuẩn công nghiệp.** Bất kỳ consumer bên ngoài nào cũng phải đọc
  doc của ta để hiểu lỗi. Đây là giá thật của option A và nó chỉ rẻ khi tập
  consumer ngoài repo bằng rỗng — cùng giả định mà ADR-003 mục 6 đã đặt cược,
  nên hai ADR sẽ sai hoặc đúng cùng nhau.
- **`success` là dữ liệu thừa** so với HTTP status, và nó ở lại vĩnh viễn trong
  v1. Mọi client phải đọc hai nguồn để biết một request có thành công không.
- **Đóng băng envelope nghĩa là `correlationId` bị hoãn tới ranh giới version.**
  Thêm một trường optional vẫn là additive nên vẫn làm được trong v1 — nhưng chỉ
  khi có nơi tra cứu (mục D). Nếu #52 land muộn, debug production trong giai
  đoạn đó không có trace id trên response.
- **`code` không còn tự do đổi sau GA.** Mục 10 biến một hằng chuỗi thành một
  cam kết version. Đặt sai tên một code từ nay là nợ kỹ thuật có kỳ hạn 6 tháng.
- **`VALIDATION_ERROR` giờ có hai kênh chi tiết** (`details` và `fields`) và
  không có luật nào bắt endpoint chọn kênh nào. Registry mô tả được, nhưng
  không cưỡng chế được — trong ngắn hạn sẽ có endpoint dùng cả hai và endpoint
  không dùng gì.
- **Sửa `ValidationPipe` là thay đổi hành vi có test đang khoá.**
  `self-registration.e2e-spec.ts:374` sẽ đỏ đúng theo thiết kế. Nếu #76 sửa test
  mà không sửa `exceptionFactory` — hoặc ngược lại — kết quả là một code sai
  lọt ra mà CI vẫn xanh.

**Security / tenant isolation**

Xem mục 11. Tóm tắt: không bề mặt mới; một chỗ rò message 500 được bịt; các gộp
chống enumeration được ghi thành dữ liệu để #78 không tách nhầm; quy ước 404
theo phạm vi tenant giữ nguyên.

## Điều kiện xét lại

Mở lại quyết định khi xảy ra **bất kỳ** điều nào — không sớm hơn:

1. Platform phát hành SDK, API key hoặc partner integration cho consumer ngoài
   repo. Khi đó lợi ích của Problem Details (mục B) lần đầu tiên khác không, và
   câu hỏi là có gánh một v2 để đổi shape hay không — một ADR mới, không phải
   sửa mục 1.
2. Epic logs (#52) land trace propagation. Khi đó `correlationId` có nơi tra
   cứu; thêm nó là additive nên **không** cần ADR mới, chỉ cần cập nhật mục 2 và
   registry. Ghi ra đây để không ai mở ADR cho một thay đổi additive.
3. Xuất hiện một gateway, API portal hoặc observability tool trong hạ tầng biết
   đọc `application/problem+json` và việc không nói thứ tiếng đó gây mất tín
   hiệu thật (không phải mất tính thẩm mỹ).

**Không phải điều kiện xét lại**: một module thấy Problem Details "chuẩn hơn"
và muốn dùng riêng cho endpoint của nó. Mục 1 đã trả lời — payload trong spec là
mô tả nội dung, không phải shape. Ghi ra đây vì
`application-management.mdx:194` đang mời làm đúng việc đó.

## Follow-up

- [#78](https://github.com/majinbaka/Flexi/issues/78) (Story 0.2.3): hết
  `Blocked by: #56`. Phạm vi được ADR này bổ sung so với mô tả issue: xoá
  `ACTOR_INACTIVE` (mục 9), giữ `AUTH_ERROR_CODES`/`USER_ERROR_CODES` làm view
  thay vì thay thế, đánh cờ "gộp có chủ ý" cho ba code chống enumeration, thêm
  `REVISION_CONFLICT` và ghi `aliases` cho ba spelling nó thay, và lint rule
  cấm string literal ở thuộc tính `error` thay vì kiểm tra runtime.
- [#76](https://github.com/majinbaka/Flexi/issues/76) (Story 0.2.1): ba gạch đầu
  dòng "Envelope (ADR-004)" giờ có nội dung — mục 2 (một khai báo), mục 5
  (`exceptionFactory` trong `configureApp()`, `details`, `ApiError` mang
  `details`/`fields`), mục 7 (`RATE_LIMITED` từ server, xoá
  `RATE_LIMITED_PATHS`), mục 8 (redact 5xx). Sửa
  `self-registration.e2e-spec.ts:374` **cùng commit** với `exceptionFactory`.
  Theo ADR-003 mục 8, ADR-003 và ADR-004 phải land cùng nhau chứ không nối tiếp.
- [#208](https://github.com/majinbaka/Flexi/issues/208),
  [#216](https://github.com/majinbaka/Flexi/issues/216): câu phòng ngừa về
  naming hết hiệu lực. `CONFIG_ERROR_CODES` và `WORKFLOW_ERROR_CODES` theo mục 3
  (không prefix) và mục 4 (status thuộc registry); cả hai đăng ký vào registry
  của #78 thay vì tạo hằng riêng nếu #78 land trước.
- [#218](https://github.com/majinbaka/Flexi/issues/218): `WORKFLOW_REVISION_CONFLICT`
  → `REVISION_CONFLICT` (mục 6). Payload conflict theo #93, không tự định nghĩa.
- [#84](https://github.com/majinbaka/Flexi/issues/84): `APP_IMPORT_SLUG_CONFLICT`
  → dùng lại `SLUG_ALREADY_IN_USE`; payload Problem Details ở
  `application-management.mdx:181` dịch sang envelope, không nhúng.
- [#93](https://github.com/majinbaka/Flexi/issues/93): "409 kèm payload conflict"
  giờ có tên — `REVISION_CONFLICT`. #93 vẫn sở hữu shape của payload đó và của
  `If-Match`; ADR này không chốt hộ.
- [#50](https://github.com/majinbaka/Flexi/issues/50) đã đóng với
  `STALE_VERSION_CONFLICT` trong mô tả epic. Không mở lại issue; spelling đó vào
  `aliases` và Pages dùng `REVISION_CONFLICT` khi nó được viết.
- Vai trò **API Governance** (ADR-003 mục 9) nhận thêm phần error naming vào
  remit: approve code mới, quyết `aliases`, và giữ invariant một-code-một-status.
  CODEOWNERS ở #76 nên phủ `packages/shared-types/src/errors.ts` khi file đó ra
  đời.
- ADR-001, ADR-002, ADR-003 **không bị sửa**. ADR này không chạm trục
  environment, trục lưu trữ hay trục base path.
- Spec Nhóm 1 được cập nhật trong cùng PR với ADR này; Nhóm 2 trong #78/#76.
