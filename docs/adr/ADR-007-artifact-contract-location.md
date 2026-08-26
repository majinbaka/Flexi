# ADR-007: Nơi đặt common artifact/revision/dependency contract

| Trường         | Giá trị                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trạng thái     | Accepted                                                                                                                                                     |
| Ngày           | 2026-08-26                                                                                                                                                   |
| Decision owner | Solution Architecture                                                                                                                                        |
| Issue          | [#59](https://github.com/majinbaka/Flexi/issues/59)                                                                                                          |
| Blocking       | Epic 3 (Artifact Registry, Versioning and Dependency Engine); Epic 6 và Epic 7 không được tự định nghĩa schema riêng                                         |
| Spec liên quan | `apps/frontend/src/docs/specifications/platform-decisions-risks.mdx`, `collaboration-governance.mdx`, `platform-roadmap.mdx`, `product-capability-model.mdx` |

## Context

Page, Workflow, Query và Asset đều là artifact có cùng nhu cầu: tham chiếu lẫn
nhau (`ResourceRef`), tách Draft mutable khỏi revision immutable, mô tả schema
của definition (`schemaVersion`), xác minh toàn vẹn khi đóng gói release
(`checksum`), và chặn ghi đè đồng thời giữa hai editor (optimistic concurrency
token).

Trạng thái hiện tại của repo:

- `packages/shared-types` là nơi duy nhất chia sẻ type giữa `apps/backend` và
  `apps/frontend`. Nó được resolve qua `node_modules`, **không** live-link, nên
  phải `pnpm run build:shared-types` trước khi chạy app và sau mỗi lần sửa
  `packages/shared-types/src`.
- Package này đã là source of truth cho vài giá trị mà Prisma lưu dưới dạng
  string thay vì enum native (`DynamicField.dataType`, `Permission.scope`) —
  tức là tiền lệ "một nơi định nghĩa, hai app validate" đã tồn tại và đang chạy.
- Chưa có artifact nào ngoài Dynamic Tables được implement. Page, Workflow,
  Query, Asset hiện là stub trả `{ status: 'not-implemented' }`.

Nếu không chốt trước, mỗi module sẽ tự đặt tên field theo cách riêng (`version`
vs `revision` vs `rev`, `hash` vs `checksum` vs `etag`), và dependency engine ở
Epic 3 sẽ phải viết adapter cho từng artifact type thay vì một contract.

## Options đã cân nhắc

### A. Đặt trong `packages/shared-types`

- **Được**: không thêm package/build step nào; cả hai app đã import sẵn; đi
  đúng tiền lệ enum hiện có.
- **Mất**: package dễ phình và trộn lẫn nhiều loại type (envelope HTTP, entity,
  permission, contract); mọi consumer phải rebuild khi contract đổi, kể cả
  consumer không dùng contract.

### B. Package riêng `packages/artifact-contract`

- **Được**: tách concern rõ, versioning độc lập, có thể publish riêng về sau.
- **Mất**: thêm một build step vào chuỗi `build:shared-types → backend →
frontend` và vào CI; hiện chỉ có đúng hai consumer, cả hai đều đã phụ thuộc
  `shared-types` — package thứ hai chưa mua được gì ngoài overhead.

### C. Schema registry runtime

- **Được**: governance mạnh nhất; validate/compat check ở runtime, không cần
  redeploy để phát hiện breaking change.
- **Mất**: thêm một service phải vận hành, backup, và bảo vệ; chi phí này không
  tương xứng khi artifact engine còn chưa tồn tại.

## Decision

### 1. Vị trí: `packages/shared-types`, trong namespace `contracts/` riêng

Common artifact contract nằm ở `packages/shared-types/src/contracts/`, mỗi
contract một file (`resource-ref.ts`, `revision.ts`, `dependency-edge.ts`,
`concurrency.ts`), re-export qua barrel `src/index.ts` như phần còn lại của
package.

Ràng buộc để namespace này không biến thành "chỗ đổ type chung":

- `src/contracts/` chỉ chứa contract dùng chung bởi từ hai artifact type trở
  lên. Type riêng của một module ở lại module đó.
- Không import ngược từ `contracts/` sang `entities.ts`/`envelope.ts`. Contract
  là tầng dưới cùng, không biết gì về HTTP envelope hay Prisma entity.
- Contract chỉ là type, enum và hằng số thuần. Không runtime dependency, không
  logic I/O — package này build bằng `tsc` trơn cho cả CJS lẫn ESM.

**Điều kiện tách ra `packages/artifact-contract`** (option B) — tách khi xảy ra
_bất kỳ_ điều nào, không tách sớm hơn:

1. Có consumer thứ ba không phải `apps/backend`/`apps/frontend` (SDK ngoài,
   worker service tách rời, CLI).
2. `src/contracts/` cần một runtime dependency (validator, hàm hash) mà
   `shared-types` không nên kéo theo.
3. Contract phải được version và publish độc lập với nhịp của hai app.

**Điều kiện chuyển sang schema registry** (option C): khi artifact schema cần
được thêm hoặc migrate bởi tenant/extension tại runtime, tức là không còn biết
trước tại compile time. Trước thời điểm đó, registry là over-engineering.

### 2. Versioning của contract

Có hai trục version, không được trộn:

| Trục                     | Áp dụng cho                                    | Ai đọc                                     |
| ------------------------ | ---------------------------------------------- | ------------------------------------------ |
| `schemaVersion` (semver) | Hình dạng definition của **một artifact type** | Migration/compat layer khi load definition |
| Version của package npm  | Toàn bộ `@flexi/shared-types`                  | Build/dependency của hai app               |

Quy tắc cho `schemaVersion`:

- Mỗi artifact type giữ `schemaVersion` riêng (Page 1.2.0 và Workflow 1.0.0
  hoàn toàn hợp lệ cùng lúc). Không có một `schemaVersion` toàn platform.
- **PATCH**: sửa mô tả, không đổi hình dạng.
- **MINOR**: thêm field optional, thêm giá trị enum mà reader cũ bỏ qua an
  toàn. Reader cũ phải đọc được definition mới.
- **MAJOR**: xóa/đổi tên field, đổi kiểu, thêm field bắt buộc, thu hẹp enum.
  MAJOR bắt buộc kèm một migration đăng ký trong migration registry
  (Story 3.1.3) và không được deploy nếu thiếu migration đó.
- Revision đã publish lưu lại `schemaVersion` mà nó được viết ra. Runtime đọc
  revision theo `schemaVersion` của chính revision đó rồi migrate lên bản hiện
  tại, chứ không giả định mọi revision đều ở version mới nhất.
- Contract shape dùng chung (`ResourceRef`, `DependencyEdge`) đi theo semver của
  package; breaking change ở đây là breaking change của cả hai app và phải qua
  cùng quy trình ở mục 3.

### 3. Quy trình thay đổi contract

1. Thay đổi `src/contracts/` phải có review của contract owner (Solution
   Architecture) — không tự merge trong PR feature.
2. PR phải nêu rõ: MAJOR/MINOR/PATCH, artifact type bị ảnh hưởng, và migration
   đi kèm nếu là MAJOR.
3. MAJOR phải cập nhật spec liên quan trong cùng PR (`product-capability-model.mdx`
   cho contract table, spec của artifact type đó) — contract và spec không được
   lệch qua một release.
4. Sau khi merge phải chạy `pnpm run build:shared-types`; CI đã build theo thứ
   tự shared-types → backend → frontend nên breaking change sẽ fail ngay ở bước
   build, đó là hàng rào tự động mong muốn.
5. Deprecate trước khi xóa: field bị bỏ được đánh `@deprecated` ít nhất một
   MINOR trước khi xóa ở MAJOR kế tiếp.

### 4. Optimistic concurrency token: integer version, không phải content hash

Token là **số nguyên tăng đơn điệu trên mỗi resource**, không phải hash nội
dung:

- Mỗi mutable artifact (Draft) có `version: number`, bắt đầu từ 1, tăng đúng 1
  cho mỗi lần ghi thành công.
- Client gửi lại version đã đọc khi ghi. Version không khớp → `409 CONFLICT`.
  Ghi phải là một câu update có điều kiện (`WHERE id = ? AND version = ?`), để
  việc phát hiện xung đột nằm ở database chứ không ở tầng ứng dụng — so sánh
  rồi mới ghi ở service layer vẫn có khe race.
- Trên đường truyền HTTP, token đi qua header `If-Match` và `ETag` dưới dạng
  chuỗi đục (`"7"`). Client không được suy diễn hay tự tăng giá trị; dạng
  integer là chi tiết của server, đổi được về sau mà không phá client.
- Tên field trong contract là `version`. Artifact nào giữ thêm con trỏ tới
  revision đã publish (`current_version`) thì đặt tên token là `draft_version`
  để không lẫn hai khái niệm — đây là cùng một token, chỉ khác nhãn. Spec
  `collaboration-governance.mdx` dùng tên `draft_version`.

`checksum` (SHA-256 của definition đã canonicalize) vẫn tồn tại nhưng phục vụ
mục đích khác và **không** dùng để khóa: xác minh toàn vẹn của revision
immutable, dedupe revision khi publish mà nội dung không đổi, và so khớp trong
ReleaseBundle manifest.

Vì sao không dùng version hash làm token:

- Hash chỉ nói "nội dung khác", không nói "cái nào mới hơn". Audit, diff và
  rollback đều cần thứ tự, và integer cho thứ tự miễn phí.
- Hash phụ thuộc vào canonicalization ổn định (thứ tự key, unicode
  normalization, float). Một thay đổi vô hại ở serializer sẽ làm sai lệch hàng
  loạt token đang lưu.
- Hai lần sửa đưa nội dung về trạng thái cũ sẽ tạo lại hash cũ, khiến một ghi
  đè cũ trở nên "hợp lệ" trở lại — chính lỗi mà optimistic locking cần chặn.
- Integer so sánh rẻ hơn và index gọn hơn khi kiểm tra ngay trong câu UPDATE.

Hệ quả: sơ đồ optimistic locking trong `collaboration-governance.mdx` được sửa
từ "hash match/mismatch" sang "version match/mismatch".

## Consequences

**Tích cực**

- Epic 3 mở khóa: Story 3.1.1 có nơi để đặt code và một định nghĩa token cụ
  thể.
- Epic 6 (Page) và Epic 7 (Workflow) import cùng một `ResourceRef` thay vì mỗi
  bên định nghĩa một biến thể; dependency engine chỉ phải hiểu một hình dạng.
- Không thêm build step nào vào `pnpm build` hay CI.

**Tiêu cực / phải chấp nhận**

- `@flexi/shared-types` gánh thêm một concern. Rào chắn là ba ràng buộc ở mục 1
  và ba điều kiện tách package — cần được kiểm tra ở review, không tự thực thi.
- Mọi thay đổi contract vẫn buộc rebuild cả hai app, kể cả app không đụng tới
  artifact.
- Không có compat check ở runtime cho tới khi có migration registry
  (Story 3.1.3); trước đó, hàng rào duy nhất là compile time và review.

**Security / tenant isolation**

- `ResourceRef` mang `resourceId` chứ không mang thẩm quyền. Tenant vẫn được
  resolve duy nhất từ `JwtAuthGuard` qua CLS store; không có code path nào được
  lấy `tenantId` từ một ref trong body request.
- Mọi ref phải được resolve trong phạm vi tenant của caller. Ref trỏ ra ngoài
  tenant là lỗi validate, không phải cross-tenant read.
- Contract không được chứa secret value; chỉ `SecretRef` đi qua boundary
  (ràng buộc này thuộc ADR-008, nhắc lại ở đây vì contract là nơi dễ vi phạm
  nhất).

## Follow-up

- Story 3.1.1 — implement `src/contracts/` theo quyết định này.
- Story 3.1.2 — tách Draft mutable khỏi Published revision, dùng `version` cho
  Draft và `checksum` cho revision.
- Story 3.1.3 — migration registry cho `schemaVersion` MAJOR.
- ADR-012 sẽ dùng revision + checksum ở đây làm đầu vào cho semantics
  release/rollback; ADR này không quyết định phần đó.
