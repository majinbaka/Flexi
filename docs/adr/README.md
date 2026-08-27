# Architecture Decision Records

Thư mục này chứa ADR — quyết định kiến trúc đã được chốt, kèm context và hệ
quả. Decision Log ở
`apps/frontend/src/docs/specifications/platform-decisions-risks.mdx` là danh
sách _cần chốt_ (ADR-001…ADR-020) và trạng thái của chúng; thư mục này là nơi
lưu bản ghi đầy đủ của những ADR đã được viết.

Quy ước:

- Một file cho mỗi ADR: `ADR-<số>-<slug>.md`.
- Số ADR lấy theo Decision Log, không tự đánh số mới. ADR chưa có file trong
  thư mục này nghĩa là chưa được ghi, không phải bị mất.
- ADR đã `Accepted` là immutable. Muốn đổi quyết định thì viết ADR mới và đánh
  dấu ADR cũ là `Superseded by ADR-xxx`; chỉ sửa tại chỗ khi vá lỗi chính tả
  hoặc link.
- Mỗi ADR phải nêu decision owner, options đã cân nhắc, tác động tới
  security/tenant isolation, và các spec `.mdx` phải cập nhật theo.

## Index

| ADR                                                          | Quyết định                                 | Trạng thái |
| ------------------------------------------------------------ | ------------------------------------------ | ---------- |
| [ADR-001](./ADR-001-environment-owner-cardinality.md)        | Environment owner và cardinality           | Accepted   |
| [ADR-002](./ADR-002-database-topology-tenant-environment.md) | Database topology cho tenant × environment | Accepted   |
| [ADR-009](./ADR-009-user-identity-membership-model.md)       | User identity và membership model          | Accepted   |

ADR-003…008 và 010…020 vẫn Open; xem Decision Log để biết owner và priority.
Bản nháp ADR-007 từng được viết ở PR #160 nhưng PR đó đã đóng mà không merge,
nên ADR-007 vẫn tính là chưa ghi.
