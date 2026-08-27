# ADR-009: User identity và membership model

| Trường         | Giá trị                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Trạng thái     | Accepted                                                                                                                        |
| Ngày           | 2026-08-27                                                                                                                      |
| Decision owner | IAM Product + Security                                                                                                          |
| Issue          | [#61](https://github.com/majinbaka/Flexi/issues/61)                                                                             |
| Blocking       | Story 1.1.2; phần switch tenant/impersonation của [#194](https://github.com/majinbaka/Flexi/issues/194)                         |
| Spec liên quan | `apps/frontend/src/docs/specifications/platform-decisions-risks.mdx`, `iam-multi-tenant.mdx`, `users.mdx`, `authentication.mdx` |

## Context

### Repo đang là gì (đã đối chiếu code, không lấy từ planning doc)

- `AuthAccount` (`apps/backend/prisma/schema.prisma`) giữ `email` +
  `passwordHash` và **không** có cột `tenantId`. Quan hệ khai báo là
  `SystemUser[]` và `TenantUser[]` — tức schema cho phép nhiều actor trên một
  account; ràng buộc "đúng một" chỉ tồn tại ở service layer.
- Chỗ duy nhất ép invariant đó là
  `AuthService.resolveActorByAuthAccountId()`, và nó ép bằng cách _phát hiện_
  vi phạm: query cả hai bảng rồi ném `InternalServerErrorException` nếu account
  backing cả hai. Không có đường nào ở tầng DB chặn việc tạo ra trạng thái đó.
- `email` chỉ có `@@index([email])`, không unique. Uniqueness theo tenant do
  `TenantUserDirectoryService.assertEmailAvailable()` giữ, và chính docblock của
  service ghi nhận đây là hạn chế có chủ ý: địa chỉ nằm ở `AuthAccount`, tenant
  nằm ở `TenantUser`, Postgres không đặt unique index xuyên hai bảng — nên "hai
  lần tạo đồng thời cùng một địa chỉ trong cùng tenant đều có thể lọt".
- `TenantUser` đã có `@@unique([tenantId, authAccountId])`.
- Login phân nhánh bằng header `x-tenant-id`: có header → `resolveTenantActor`,
  không có → `resolveSystemActor`. `AccessTokenPayload` mang đúng **một**
  `tenantId`, và `impersonatedBy` được khai báo sẵn nhưng không bao giờ gán.
- `RefreshToken`, `PasswordResetOtp`, `UserInvite` đều treo dưới `AuthAccount`
  (hoặc dưới tenant, với `UserInvite`).

Nói cách khác: **implementation hiện tại đã là tenant-local identity trên thực
tế**, nhưng chỉ ở tầng service, không có gì ở tầng dữ liệu nói ra điều đó.

### Vì sao phải chốt bây giờ

`iam-multi-tenant.mdx` và `users.mdx` mô tả một mục tiêu khác: Global User dùng
chung identity giữa nhiều tenant, `POST /auth/switch-tenant`, và impersonation
của System Admin. Hai mô tả này chỉ hợp lệ nếu một người có membership ở nhiều
tenant. Chừng nào chưa chốt, mỗi story IAM tiếp theo phải tự đoán, và ba thứ
đang bị chặn: hình dạng bảng, ý nghĩa của uniqueness email, và hình dạng token.

## Options đã cân nhắc

### A. Global `AuthAccount` + membership nhiều-nhiều

Một identity toàn cục, bảng `TenantMembership(authAccountId, tenantId, ...)`,
token mang `activeTenantId` + danh sách membership; `switch-tenant` phát token
mới cho một membership khác.

- **Được**: một người một mật khẩu; switch tenant không cần đăng nhập lại; SSO
  một IdP phủ nhiều tenant; đúng với mô tả trong spec hiện tại.
- **Mất**: email trở thành định danh toàn cục — chiếm chỗ xuyên tenant, và một
  tenant biết được địa chỉ nào "đã tồn tại" trên platform. Credential bị lộ có
  blast radius bằng **mọi** tenant người đó tham gia. Mọi đường lấy `tenantId`
  phải kiểm tra membership, không chỉ kiểm tra token — thêm một lớp mà
  `JwtAuthGuard` hiện không có. Xóa tenant không còn xóa được identity kèm theo.

### B. Identity tenant-local (chọn)

`AuthAccount` thuộc đúng một namespace: một tenant, hoặc control plane. Cùng một
người ở hai tenant là hai account độc lập, hai mật khẩu.

- **Được**: isolation phát biểu được trong một câu; blast radius của một
  credential là đúng một tenant; uniqueness email ép được ở tầng DB (đóng lại
  race mà service đang phải chấp nhận); không có join xuyên tenant nào trên
  đường login; xóa tenant cascade luôn identity của nó.
- **Mất**: không có switch tenant; một người ở N tenant có N mật khẩu, N luồng
  reset, và sau này N lần enroll MFA; SSO phải cấu hình theo từng tenant.

### C. Tách `Person` phía trên `AuthAccount` ngay bây giờ

Giữ credential ở `AuthAccount` tenant-local, thêm `Person` toàn cục để nhóm các
account của cùng một người lại (chỉ để hiển thị/liên kết, không dùng để
authorize).

- **Được**: mở đường cho "một người, nhiều tenant" mà không phá isolation.
- **Mất**: hôm nay không mua được gì — chưa có UI, chưa có persona nào cần nó, và
  một bảng identity thứ hai không authorize gì là thứ rất dễ bị dùng sai về sau.
  Đây là **escape hatch** của quyết định này (xem "Điều kiện xét lại"), không
  phải phần được implement bây giờ.

## Decision

Chọn **option B — identity tenant-local**.

### 1. Model

`AuthAccount` có thêm `tenantId String?`, FK tới `Tenant` với
`onDelete: Cascade`:

- `tenantId` **non-null** → identity thuộc namespace của tenant đó. Nó chỉ được
  back một `TenantUser` của **cùng** `tenantId`.
- `tenantId` **null** → identity thuộc namespace control plane. Nó chỉ được back
  một `SystemUser`.

Invariant XOR hiện có không bị bỏ; nó được nâng từ "phát hiện khi đọc" lên
"phát biểu trong dữ liệu". Cụ thể:

- `TenantUser` chỉ được tạo khi `authAccount.tenantId === tenantUser.tenantId`.
- `SystemUser` chỉ được tạo khi `authAccount.tenantId IS NULL`.
- Cả hai kiểm tra này vẫn ở service layer vì chúng xuyên hai bảng, nhưng bây giờ
  chúng so hai cột cụ thể thay vì đếm số hàng ở bảng kia. Kiểm tra "backing cả
  hai" trong `resolveActorByAuthAccountId()` **giữ nguyên** — nó là hàng rào
  cuối, và một hàng rào cuối vẫn cần thiết khi ràng buộc không nằm ở DB.

Hệ quả phải nói thẳng: **cùng một người ở hai tenant là hai người khác nhau đối
với hệ thống.** Hai mật khẩu, hai phiên, hai luồng reset, hai `mustChangePassword`,
hai lịch sử audit. Đây là chi phí đã chấp nhận, không phải thiếu sót cần vá.

System actor **không có membership tenant**. Họ chạm dữ liệu tenant bằng đúng
hai đường: endpoint platform-scoped, hoặc impersonation (mục 4). Không có đường
thứ ba, và đặc biệt không có "thêm một hàng `TenantUser` cho system admin".

### 2. Uniqueness email: theo tenant, ép ở tầng DB

- Namespace tenant: `@@unique([tenantId, email])` →
  `auth_accounts_tenantId_email_key`.
- Namespace control plane: unique **một phần** trên `email` với
  `WHERE "tenantId" IS NULL`. Phải viết tay bằng SQL trong migration:
  `@@unique([tenantId, email], nullsNotDistinct: true)` bị Prisma 7.9.1 từ chối
  (`P1012 No such argument`, đã kiểm chứng bằng `prisma validate`), và Postgres
  mặc định coi các NULL là phân biệt, nên riêng `@@unique` ở trên **không** phủ
  được hàng system.
- Chuẩn hóa là một phần ý nghĩa của ràng buộc: email luôn `trim().toLowerCase()`
  trước khi ghi, qua đúng một helper (`TenantUserDirectoryService.normalizeEmail`).
  Một địa chỉ không đi qua chuẩn hóa là một địa chỉ không ai đăng nhập được —
  điều này đã đúng trước ADR, nay thành điều kiện đúng đắn của index.
- `assertEmailAvailable()` **giữ lại** để trả `409 EMAIL_ALREADY_EXISTS` với
  thông điệp không lộ thông tin. Nó chuyển vai từ "hàng rào" thành "pre-check cho
  thông điệp đẹp"; hàng rào thật là index, và `P2002` trên index đó phải được bắt
  và map về đúng mã lỗi ấy. Đây là điểm đóng lại race mà docblock của service
  đang mô tả.
- Email **không** unique toàn cục. Cùng một địa chỉ ở hai tenant là hợp lệ và là
  điều bình thường. Không có API nào được trả lời câu hỏi "địa chỉ này có tồn tại
  ở tenant khác không".

#### Soft delete và việc giải phóng địa chỉ

Hiện `findMemberByEmail()` bỏ qua member `DELETED`, nghĩa là địa chỉ được giải
phóng ngay khi xóa mềm — nhưng hàng `AuthAccount` thì vẫn giữ địa chỉ đó. Sau khi
có unique index, mời lại một người đã bị xóa sẽ đụng constraint.

Quyết định: **tái sử dụng `AuthAccount` cũ**, không tạo hàng thứ hai. Mời lại một
địa chỉ đã bị xóa mềm trong cùng tenant sẽ tái kích hoạt membership trên chính
account đó (reset password/`mustChangePassword` theo luồng invite bình thường).
Lý do: giữ liền mạch chuỗi audit và refresh-token ownership, và tránh việc phải
đổi email của hàng cũ thành dạng tombstone — một thao tác ghi đè dữ liệu định
danh chỉ để lách index.

Đây cũng chính là con đường duy nhất hiện tại có thể sinh ra hai hàng cùng
`(tenant, email)`, nên nó phải được sửa **trước** khi bật index (xem mục 5).

### 3. Token: giữ nguyên hình dạng, không có "active tenant"

`AccessTokenPayload` không đổi. Cụ thể là **không** thêm `memberships[]`, không
thêm `activeTenantId`, không thêm `availableTenants`.

Lý do: câu hỏi "token biểu diễn tenant đang active thế nào khi có nhiều
membership" không còn tồn tại. Một account có đúng một tenant, nên `tenantId`
trong token vừa là tenant duy nhất vừa là tenant đang active. Việc chọn tenant
xảy ra ở thời điểm **xác thực**, qua header `x-tenant-id`, chứ không ở thời điểm
dùng token.

Kéo theo:

- `POST /api/v1/auth/switch-tenant` **không được xây**, và bị gỡ khỏi target API
  surface trong `iam-multi-tenant.mdx`. Affordance "switch tenant" trên UI trở
  thành một tenant picker dẫn về màn hình login, không phải một lần đổi token.
- Refresh token gắn với `AuthAccount`, do đó gắn với đúng một tenant. Một lần
  refresh không bao giờ đổi được tenant. `JwtAuthGuard` giữ nguyên vai trò là
  nguồn duy nhất của `tenantId`/`schema` trong CLS.
- `ERR_TENANT_MISMATCH` mà spec đề xuất không cần thiết cho luồng switch (không
  có luồng đó); nếu sau này xuất hiện thì nó thuộc về validate ref, không thuộc
  về session.

### 4. Impersonation: vẫn làm được, và không cần membership

Đây là lý do quyết định này không giết phần còn lại của #194. Impersonation là
**ủy quyền**, không phải membership:

- System actor có permission tương ứng gọi endpoint impersonate với một
  `TenantUser` đích.
- Server phát một access token **tenant-scoped** cho actor đích: `sub` =
  `authAccountId` của người bị impersonate, `tenantId`/`tenantUserId` của họ,
  permission của họ; `impersonatedBy` = định danh của system actor — đúng field
  đã được dành sẵn, nên payload không đổi hình dạng.
- Ràng buộc: TTL tối đa 15 phút theo SRS; **không** phát refresh token kèm theo
  (thoát impersonation = token hết hạn hoặc bị revoke, rồi quay về session
  System Admin của chính họ); tenant phải opt-in; audit cả lúc bắt đầu lẫn lúc
  kết thúc; UI bắt buộc có banner.
- Vì token được **phát mới** chứ không phải nới rộng token sẵn có, đây là đường
  vượt biên tenant duy nhất, và nó có audit. Không có code path nào lấy
  `tenantId` từ body request — ràng buộc này không đổi.

### 5. Migration từ ràng buộc 1-1 hiện tại

Thứ tự bắt buộc. Bước 0 quyết định các bước sau có gộp được vào một migration
hay không.

**Bước 0 — audit dữ liệu, trước khi viết migration.** Ba truy vấn:

1. Trùng `(tenant, email đã chuẩn hóa)` trong cùng tenant, kể cả member
   `DELETED` — đây là thứ duy nhất làm hỏng bước 4.
2. `AuthAccount` mồ côi (không có `SystemUser` lẫn `TenantUser`). Chúng sẽ
   được backfill thành `tenantId = NULL` và bị **hiểu nhầm thành account
   control plane**, nên phải xử lý riêng (xóa, hoặc gán tenant) chứ không để
   trôi qua.
3. `AuthAccount` backing cả hai loại actor — vi phạm invariant hiện tại; nếu có
   thì phải sửa tay trước.

**Bước 1 — migration cộng thêm, an toàn trên DB đang chạy.** Thêm cột
`tenantId TEXT NULL` + FK `ON DELETE CASCADE` + index. Không hàng nào đổi ý
nghĩa; code hiện tại không đọc cột này.

**Bước 2 — backfill.**

```sql
UPDATE "auth_accounts" a
   SET "tenantId" = tu."tenantId"
  FROM "tenant_users" tu
 WHERE tu."authAccountId" = a."id";
```

An toàn vì `TenantUser` đã unique trên `(tenantId, authAccountId)` và một
account chỉ back một actor.

**Bước 3 — verify.** Không còn hàng nào có `tenantId IS NULL` mà lại tồn tại
`tenant_users` trỏ tới nó; số account `tenantId IS NULL` đúng bằng số
`SystemUser` cộng số mồ côi đã xử lý ở bước 0.

**Bước 4 — bật ràng buộc** (migration riêng nếu bước 0 không sạch):

```sql
CREATE UNIQUE INDEX "auth_accounts_tenantId_email_key"
  ON "auth_accounts" ("tenantId", "email");

CREATE UNIQUE INDEX "auth_accounts_system_email_key"
  ON "auth_accounts" ("email") WHERE "tenantId" IS NULL;
```

Index thứ hai là object Prisma không mô hình hóa được — cùng nhóm với các CHECK
constraint viết tay ở `20260821194500_tenant_lifecycle_status_checks`. Ghi lại ở
đây vì hệ quả của nó là: nếu một migration sau này drop rồi tạo lại
`auth_accounts`, index này phải được thêm lại bằng tay.

Đây là **điểm không quay lại** của migration. Bước 1–3 rollback được bằng cách
drop cột; từ bước 4 trở đi, dữ liệu vi phạm sẽ bị chặn ở tầng ghi.

**Bước 5 — code đi kèm, cùng PR với bước 4.** Bắt `P2002` trên hai index trên và
map về `EMAIL_ALREADY_EXISTS`; sửa luồng mời lại theo mục 2; thêm hai assert ở
mục 1; test cho từng nhánh.

## Consequences

**Tích cực**

- Isolation phát biểu được trong một câu và kiểm chứng được bằng schema:
  credential không bao giờ đi qua ranh giới tenant.
- Uniqueness email chuyển từ "service cố gắng" sang "DB đảm bảo"; race mà
  `TenantUserDirectoryService` đang phải ghi chú như hạn chế biến mất.
- Xóa tenant cascade luôn identity của tenant đó — không còn account mồ côi trỏ
  về một tenant không tồn tại, và câu chuyện xóa dữ liệu người dùng gọn hơn hẳn.
- Không thêm lookup nào vào đường login hay vào `JwtAuthGuard`.
- Story 1.1.2 và phần impersonation của #194 mở khóa ngay.

**Tiêu cực / phải chấp nhận**

- Người dùng ở nhiều tenant chịu UX kém: N mật khẩu, N lần reset, sau này N lần
  enroll MFA. Persona tư vấn/đối tác bị ảnh hưởng nặng nhất.
- Không có switch tenant. `POST /auth/switch-tenant` bị gỡ khỏi target API
  surface, không phải hoãn.
- SSO sau này cấu hình theo từng tenant. Có thể lập luận đây mới là đúng, nhưng
  nó chặn kịch bản "một IdP doanh nghiệp phủ nhiều tenant con".
- Hai index unique là ràng buộc thật: dữ liệu bẩn tồn tại từ trước phải được dọn
  trước, không thể vừa migrate vừa sửa.
- Nếu về sau cần global identity thì đó là một migration thật (xem escape hatch),
  chứ không phải một lần đổi cờ.

**Security / tenant isolation**

- Một mật khẩu bị lộ chỉ mở được đúng một tenant. Đây là lợi ích chính.
- System actor không tích lũy được membership tenant; không có "super admin có
  mặt trong mọi tenant" để mà bị chiếm.
- Impersonation là đường vượt biên duy nhất, và nó phát token mới, có TTL ngắn,
  không kèm refresh token, và được audit hai đầu.
- API không được để lộ sự tồn tại của một địa chỉ ở tenant khác. Thông điệp
  `EMAIL_ALREADY_EXISTS` chỉ nói về tenant hiện tại, và luồng self-registration
  dùng chung câu chữ với luồng invite để hai bên không phân biệt được.
- `tenantId` vẫn chỉ đến từ `JwtAuthGuard` qua CLS. ADR này không thêm nguồn
  tenant nào khác.

## Điều kiện xét lại

Mở lại quyết định khi xảy ra **bất kỳ** điều nào — không sớm hơn:

1. Có persona trả tiền thường xuyên làm việc trên nhiều tenant (tư vấn, agency,
   đối tác triển khai), và số lần đăng nhập lại trở thành khiếu nại thật.
2. Có khách hàng enterprise cần một IdP phủ nhiều tenant với một tài khoản.
3. Platform chuyển sang mô hình marketplace, nơi một người dùng đi qua nhiều
   tenant là luồng chính chứ không phải ngoại lệ.

Đường đi khi đó (option C, cộng thêm, không mất dữ liệu):

1. Thêm `Person` toàn cục và `AuthAccount.personId` nullable.
2. Liên kết các account hiện có theo email **đã xác minh** — chỉ khi người dùng
   chủ động xác nhận, không tự động gộp theo chuỗi email.
3. Chuyển credential lên `Person`, biến `AuthAccount` tenant-local thành hàng
   membership.
4. Lúc đó mới thêm `activeTenantId` vào token và mở `switch-tenant`.

Điểm cần nhớ: bước 3 là chỗ isolation bị nới. Nó phải là một ADR riêng với
threat model riêng, không phải phần mở rộng của ADR này.

## Follow-up

- [#197](https://github.com/majinbaka/Flexi/issues/197): migration bước 0–5 ở
  mục 5, kèm test cho `P2002`, cho luồng mời lại sau soft delete, và cho hai
  assert namespace.
- [#194](https://github.com/majinbaka/Flexi/issues/194): giữ phần impersonation
  theo mục 4; phần switch tenant bị gỡ khỏi scope.
- Story 1.1.2: không còn bị chặn.
- ADR-005 (permission grammar) không bị ADR này quyết định thay. Catalog quyền
  vẫn là câu hỏi mở riêng.
- Spec `iam-multi-tenant.mdx`, `users.mdx`, `platform-decisions-risks.mdx` được
  cập nhật trong cùng PR với ADR này.
