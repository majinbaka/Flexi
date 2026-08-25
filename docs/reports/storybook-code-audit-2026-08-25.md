# Báo cáo rà soát Storybook và code

**Ngày rà soát:** 25/08/2026  
**Phạm vi:** `apps/frontend/src/docs`, stories/UI frontend, backend modules,
shared contracts, Prisma migrations và tài liệu `docs/`.  
**Phương pháp:** đọc mã nguồn tĩnh, đối chiếu route/API với tài liệu và build
Storybook. Không chạy e2e với Postgres hoặc kiểm tra gửi email/SMTP thật, nên
“đã triển khai” bên dưới nghĩa là có code và test đơn vị liên quan, không phải
xác nhận triển khai production.

## Kết quả và phần Storybook đã xử lý

Storybook build thành công với `pnpm --filter @flexi/frontend build-storybook`
(Storybook 10.5.8). Có 18 story frontend và toàn bộ MDX đều được biên dịch.

Đã chỉnh hệ thống tài liệu như sau:

- Thêm `apps/frontend/src/docs/current-product-state.mdx` tại **Docs → Current
  Product State**. Trang này là cửa vào theo trạng thái code hiện tại, có bảng
  theo khu vực, các route UI thật và quy ước về mock trong Storybook.
- Chỉnh `apps/frontend/src/docs/introduction.mdx`: sửa mô tả Pages từ “four
  routed screens” thành đúng các màn hình hiện có, bổ sung liên kết bắt đầu
  bằng Current Product State và phân biệt story cô lập với kiểm thử API.
- Chỉnh `apps/frontend/src/docs/specs-index.mdx`: đổi vai trò từ “tài liệu
  nguyên văn” sang kho lịch sử yêu cầu/kiến trúc; thêm thứ tự đọc và quy ước
  không dùng trạng thái “done/deferred/stub” trong SPEC làm trạng thái phát
  hành hiện tại.
- Cập nhật `docs/README.md` để đưa `reports/` vào cấu trúc tài liệu.

**Khắc phục sau audit (25/08/2026):** cả 39 SPEC lịch sử đã được sửa trực tiếp
để mang nhãn xác minh thời điểm và không còn tuyên bố trạng thái phát hành hiện
tại. Các thẻ frozen-after-approval cũ đã được gỡ vì người sở hữu tài liệu đã
cho phép chuẩn hoá chúng. deferred-work.md, README và ROADMAP đã được thay
bằng trạng thái/backlog hiện tại; hai HTML export thô, không được tham chiếu,
đã bị xoá. Các hồ sơ vẫn giữ phần yêu cầu và lý do lịch sử để truy vết.

## Phân loại hiện trạng code

| Khu vực                    | Đã xử lý                                                                                                                                                                                                                         | Còn thiếu / chưa xác nhận                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform foundation        | NestJS/React monorepo, Prisma, response envelope, exception filter, health endpoint, lint/format scripts, Storybook và design tokens                                                                                             | Chưa có frontend unit-test runner; cần e2e thật với dịch vụ local để xác nhận luồng xuyên tầng                                                                                |
| Authentication & RBAC      | `POST /auth/login`, refresh-token rotation, logout, `GET /auth/me`, JWT guard, permission guard, rate limit login/refresh, refresh-token reuse kill-switch. Frontend có AuthContext, ProtectedRoute, tenant login và admin login | Chưa có reset password, API quản trị account/role/permission, audit/notification khi phát hiện reuse token, đồng bộ session giữa tab                                          |
| Tenant onboarding          | Kiểm tra slug; request idempotent; queue provisioning; tạo tenant schema; bootstrap metadata/defaults/RBAC; first admin; setup token; activation, compensation/audit; list/filter tenant; frontend onboarding/list và phân quyền | SMTP thực chưa có; UI chưa poll trạng thái provisioning/lịch sử audit, chưa có luồng sử dụng setup token để đặt mật khẩu                                                      |
| Dynamic Tables backend     | Metadata `_meta_*` theo tenant schema; DDL queue; tạo bảng, cập nhật field, job status; CRUD row; validation runtime/cache; many-to-one relation và truy vấn relation. API có guard/permission                                   | Chưa có Table/Field Builder UI; guardrail giới hạn số table/column chưa thực thi; endpoint cũ `GET /dynamic-tables` vẫn là placeholder dù các endpoint `/tables` đã hoạt động |
| Frontend shell/UI          | 8 UI primitives, layout/sidebar/top nav, i18n EN/VI, story cho components và các page chính                                                                                                                                      | Story không kiểm thử backend thật; hầu hết route module vẫn là `PlaceholderPage`; HomePage vẫn mô tả module là stub nên chưa phản ánh các khu vực đã có backend               |
| Các feature module còn lại | Route module và placeholder backend/frontend có sẵn                                                                                                                                                                              | Workflows, Pages, Cron jobs, Mail templates, Wiki, i18n nội dung động, Settings, Logs chưa có nghiệp vụ                                                                       |

## API và UI đang có

### Backend đã có hành vi thật

- Auth: `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`.
- System tenant admin: `/v1/super-admin/tenants`, kiểm tra slug và tạo
  onboarding attempt, tái tạo setup link.
- Dynamic tables: tạo table/field edit async, job status và CRUD rows dưới
  `/tables`.
- Health: `/health`.

### Frontend đang nối API

- `LoginPage`/`AdminLoginPage` gọi AuthContext và API auth.
- `TenantOnboardingPage` gọi kiểm tra slug và tạo onboarding attempt.
- `TenantsPage` gọi danh sách tenant có bộ lọc/phân trang.

Chưa có frontend gọi API Dynamic Tables. Các route `auth`, `dynamic-tables`,
`workflows`, `pages`, `cron-jobs`, `mail-templates`, `wiki`, `i18n`,
`settings`, `logs` trong sidebar vẫn render `PlaceholderPage`; `/tenants` là
ngoại lệ đã có màn hình thật.

## Các mock, placeholder và giới hạn còn lại

| Loại                           | Vị trí                                                                                            | Ý nghĩa thực tế                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mock Storybook                 | `apps/frontend/src/stories/decorators.tsx`                                                        | `MockAuthProvider` thay backend/auth session để hiển thị trạng thái UI; chỉ phục vụ story                                                        |
| Mock dữ liệu story             | `TenantOnboardingPage.stories.tsx`, `TenantsPage.stories.tsx`                                     | Dependency injection tạo state loading/success/error/phân quyền; không phải API giả trong runtime                                                |
| Mock có chủ đích trong runtime | `EmailDeliveryService`                                                                            | Luôn trả `SMTP_NOT_CONFIGURED`; onboarding có thể tạo setup link nhưng chưa gửi email thật                                                       |
| Placeholder backend            | `GET /tenants`, `GET /dynamic-tables` và module Workflows/Pages/Cron/Mail/Wiki/i18n/Settings/Logs | Các endpoint compatibility/skeleton này trả `status: 'not-implemented'`; không phản ánh hết các endpoint thật cùng module tenants/dynamic-tables |
| Placeholder frontend           | `PlaceholderPage` + route map                                                                     | Các module ngoài `/tenants` chưa có màn hình nghiệp vụ, kể cả Dynamic Tables dù backend đã triển khai một phần lớn                               |

## Sai khác tài liệu cần lưu ý

- `flexi-core-scaffold.mdx` mô tả toàn bộ module là stub tại thời điểm scaffold;
  hiện không còn đúng với auth, tenant onboarding và dynamic tables.
- Nhiều SPEC/bài review dùng từ “deferred” theo mốc viết tài liệu. Một số đã
  được xử lý sau đó, ví dụ admin login, auth rate limiting, refresh-token
  reuse detection và nhiều bước onboarding.
- Một số comment code vẫn tự gọi `TenantsService`/`DynamicTablesController`
  là “stub”. Đây đúng cho endpoint status cũ, nhưng không đúng nếu đọc như mô
  tả toàn bộ module; các endpoint nghiệp vụ mới nằm cạnh chúng.
- Trước khi khắc phục, `docs/process/deferred-work.md` là backlog lịch sử
  khá dài và còn chứa các mục đã có code. File này nay đã được thay bằng
  backlog ngắn, đã đối chiếu; khi lập kế hoạch mới vẫn phải dùng Current
  Product State và code/test làm nguồn trạng thái.

## Ưu tiên đề xuất

1. Hoàn thiện UI Dynamic Tables và bỏ/đánh dấu rõ route placeholder cũ để
   frontend phản ánh backend hiện có.
2. Tích hợp SMTP và luồng nhận setup token/đặt mật khẩu cho first admin.
3. Thêm frontend test runner, sau đó ưu tiên auth refresh, onboarding form và
   tenant list; bổ sung e2e với Postgres cho queue/provisioning.
4. Chốt và thực thi guardrails Dynamic Tables; sau đó tiếp tục các module
   placeholder theo ưu tiên sản phẩm.

## Bằng chứng chính

- Storybook/docs: `apps/frontend/src/docs/`, `apps/frontend/.storybook/` và
  18 file `*.stories.tsx`.
- Frontend runtime: `apps/frontend/src/router.tsx`, `src/auth/`,
  `src/pages/TenantOnboardingPage.tsx`, `src/pages/TenantsPage.tsx`,
  `src/lib/api-client.ts`.
- Backend runtime: `apps/backend/src/modules/auth/`, `modules/tenants/`,
  `modules/dynamic-tables/`, `src/tenancy/`.
- Database evolution: 11 Prisma migration từ khởi tạo đến onboarding audit.
- Automated coverage hiện có: 20 backend unit-spec files; frontend có
  Storybook stories nhưng chưa có test script/runner riêng.
