# Báo Cáo Nghiên Cứu Kiến Trúc Schema Và Tối Ưu Hiệu Năng Cho Module Dynamic Table Builder

## Executive Summary
* Mô hình Runtime Physical DDL hiện là giải pháp thống trị ở các nền tảng no-code/low-code mã nguồn mở như Baserow, NocoDB và Directus nhờ khả năng tận dụng tối đa hiệu năng truy vấn SQL bản địa và tính minh bạch của cấu trúc dữ liệu.
* Khi mở rộng quy mô lên hàng nghìn bảng và hàng triệu bản ghi trong mô hình multi-tenancy row-level, Runtime DDL phải đối mặt với nguy cơ phình to thư mục hệ thống Postgres (Catalog Bloat) và hiện tượng nghẽn bộ nhớ đệm quan hệ (relcache invalidation), trong khi mô hình Hybrid (JSONB) bị giới hạn bởi chi phí khuếch đại ghi (WAL/TOAST bloat).
* Chiến lược đánh chỉ mục (indexing) hiệu quả cho các trường dữ liệu do người dùng tự định nghĩa đòi hỏi sự phân tách rõ ràng: tự động tạo chỉ mục B-Tree ghép cho các khóa ngoại và cột phân tách tenant_id, đồng thời chỉ kích hoạt chỉ mục mờ GIN (pg_trgm) hoặc chỉ mục biểu thức (Expression Index) theo cơ chế opt-in khi người dùng yêu cầu.
* Việc đảm bảo an toàn DDL tại runtime đòi hỏi cơ chế kiểm soát khóa gắt gao; hệ thống phải thiết lập SET lock_timeout = '2s' cho mọi câu lệnh ALTER TABLE, ưu tiên các thao tác thay đổi schema bất đồng bộ không gây khóa (O(1) complexity) và bọc các cập nhật metadata trong giao dịch SQL thuần.
* Các con số ranh giới vận hành (guardrails) chuẩn hóa từ các sản phẩm dẫn đầu thị trường cho thấy: giới hạn API rate-limit phổ biến từ 5 đến 10 request/giây cho mỗi tenant/base, dung lượng bảng đạt từ 50,000 đến 500,000 bản ghi trên các gói thương mại, và phân trang REST API khống chế ở mức 50–100 bản ghi mỗi request.
* Knex.js là lựa chọn query builder động tối ưu nhất để thay thế Prisma (vốn bị giới hạn bởi compile-time schema), hỗ trợ xây dựng truy vấn SQL linh hoạt, kết hợp với kỹ thuật JSON Aggregation (json_agg) nhằm triệt tiêu hoàn toàn sự cố N+1 query trên các REST API endpoint.

## 1. Landscape: Các Chiến Lược Schema Đang Thống Trị Hệ Sinh Thái
Trong thiết kế các nền tảng low-code/no-code cho phép người dùng cuối tự xây dựng cấu trúc dữ liệu lúc runtime, hệ sinh thái công nghệ hiện đại chia thành bốn nhóm kiến trúc lưu trữ chính.

### Dynamic Physical Runtime DDL
Chiến lược này thực thi trực tiếp các câu lệnh SQL DDL (CREATE TABLE, ALTER TABLE ADD COLUMN) vào cơ sở dữ liệu quan hệ mỗi khi người dùng bổ sung một bảng hoặc một trường dữ liệu mới.
* Baserow: Nền tảng mã nguồn mở xây dựng trên nền Django và PostgreSQL. Mỗi bảng do người dùng định nghĩa được chuyển hóa trực tiếp thành một bảng vật lý SQL thật sự trong Postgres, với các kiểu trường dữ liệu của Baserow ánh xạ tương ứng sang các kiểu dữ liệu bản địa của SQL.
* NocoDB: Đóng vai trò là một lớp quản lý thông minh đặt trên cơ sở dữ liệu quan hệ có sẵn. NocoDB biến các thao tác trên giao diện người dùng thành các lệnh DDL vật lý trực tiếp trên PostgreSQL, MySQL hoặc SQLite.
* Directus: Hoạt động theo nguyên lý "Database-First", đóng vai trò một lớp vỏ bọc (wrapper) chiếu 1:1 cấu trúc bộ sưu tập (Collection) và trường (Field) thành các bảng và cột SQL thực tế.
* Retool Database (Retool DB): Cung cấp trải nghiệm quản lý dữ liệu dạng bảng tính nhưng chạy trực tiếp trên cơ sở dữ liệu PostgreSQL thực sự, hỗ trợ đầy đủ khóa chính, khóa ngoại, ràng buộc duy nhất và kiểu dữ liệu chuẩn.

### JSONB / Dynamic Hybrid Model
Chiến lược này duy trì các bảng vật lý cố định cho các đối tượng chính nhưng lưu trữ toàn bộ các thuộc tính do người dùng tùy biến vào một cột kiểu JSONB. Khi các trường cụ thể cần thực hiện thao tác lọc hoặc sắp xếp thường xuyên, hệ thống sẽ tự động khởi tạo các cột ảo (Generated Columns) hoặc đánh chỉ mục biểu thức (Expression Indexes) trên đường dẫn JSON tương ứng. Xano sử dụng mô hình này để cho phép mở rộng schema linh hoạt mà không cần can thiệp DDL vào cấu trúc cơ sở dữ liệu sản xuất.

### Entity-Attribute-Value (EAV)
Chiến lược này lưu trữ toàn bộ dữ liệu động vào một vài bảng cố định (gồm bảng Entities, Attributes, và Values). Mô hình này hoàn toàn loại bỏ việc thay đổi schema ở tầng cơ sở dữ liệu nhưng hiện bị hầu hết các nền tảng hiện đại từ bỏ do sự sụt giảm hiệu năng nghiêm trọng khi phải thực hiện quá nhiều phép JOIN phức tạp.

### In-Memory Grid Engine Kết Hợp Persistence
* Airtable: Không sử dụng trực tiếp cơ sở dữ liệu quan hệ để xử lý các truy vấn runtime. Hệ thống xây dựng một engine lưu trữ bảng tính trên bộ nhớ RAM (viết bằng C++) để đạt được tốc độ tính toán công thức và liên kết cực nhanh, sau đó mới thực hiện đồng bộ bất đồng bộ xuống cơ sở dữ liệu đệm.

| Chiến lược Schema | Nền tảng tiêu biểu | Cơ chế lưu trữ cốt lõi | Ưu điểm chính | Nhược điểm chính |
|---|---|---|---|---|
| Runtime DDL | Baserow, NocoDB, Directus, Retool DB | Bảng và cột SQL vật lý thực sự | Tốc độ truy vấn SQL bản địa, bảo toàn toàn vẹn dữ liệu, dễ dàng xuất dữ liệu | Gây khóa DDL khi thay đổi cấu trúc, làm phình thư mục hệ thống |
| Hybrid (JSONB) | Xano, Dynamic JSON Extensions | Cột JSONB kết hợp Generated Columns | Tránh DDL lock, cô lập dữ liệu giữa các tenant linh hoạt | Tốn bộ nhớ lưu trữ, chi phí ghi lại toàn bộ tài liệu JSON lớn |
| EAV | Legacy CMS, Salesforce Core | Bảng tĩnh entity_id, attribute_id, value | Không cần DDL runtime, linh hoạt thuộc tính tuyệt đối | Bùng nổ phép JOIN, hiệu năng suy giảm nghiêm trọng ở scale lớn |
| In-Memory Engine | Airtable | In-memory C++ grid engine + Persistence store | Phản hồi tính toán tức thì, trải nghiệm mượt mượt | Chi phí tài nguyên RAM rất cao, giới hạn số lượng bản ghi gắt gao |

**Ý Nghĩa Cho Nền Tảng Row-Level Multi-Tenant, REST-Only, Postgres:** Trong kiến trúc multi-tenancy phân tách bằng tenant_id trên một cơ sở dữ liệu Postgres dùng chung, việc áp dụng Runtime DDL đòi hỏi mọi bảng vật lý do người dùng tạo bắt buộc phải chứa cột tenant_id. Mô hình này mang lại hiệu năng truy vấn REST API tối ưu do tận dụng được chỉ mục B-Tree kết hợp giữa tenant_id và các cột dữ liệu vật lý. Ngược lại, nếu chọn mô hình Hybrid JSONB, ứng dụng sẽ loại bỏ hoàn toàn rủi ro DDL Lock trên sản xuất, nhưng phải trả giá bằng chi phí xử lý phức tạp khi thực hiện lọc, sắp xếp và tính toán qua các REST API endpoint.

## 2. Đánh Đổi Hiệu Năng Ở Scale Lớn
### Đánh Đổi Trong Mô Hình Runtime DDL
* Catalog Bloat trong Postgres: Cơ sở dữ liệu quản lý cấu trúc thông qua các bảng hệ thống như pg_class, pg_attribute, và pg_index. Việc khởi tạo hàng nghìn bảng động làm phình to các bảng hệ thống này, buộc Trình lập kế hoạch truy vấn (Query Planner) phải tiêu tốn nhiều chu kỳ CPU hơn chỉ để tra cứu metadata trước khi thực thi SQL.
* Hiện Tượng Tràn Relcache (Relation Cache Invalidation): Mỗi bảng vật lý yêu cầu Postgres duy trì thông tin cấu trúc trong bộ nhớ đệm relcache. Số lượng bảng quá lớn khiến bộ nhớ này bị tràn liên tục, làm sụt giảm tốc độ của tất cả các truy vấn trong hệ thống.
* Phân Mảnh Connection Pool: Việc truy vấn trên quá nhiều bảng vật lý khác nhau làm giảm hiệu quả tái sử dụng các Prepared Statements, gây áp lực lớn lên các bộ quản lý kết nối như PgBouncer.

### Đánh Đổi Trong Mô Hình JSONB / Hybrid
* Khuếch Đại Ghi (Write Amplification & WAL Bloat): Postgres lưu trữ các đối tượng JSONB lớn thông qua cơ chế TOAST. Mỗi thao tác cập nhật dù chỉ một trường nhỏ bên trong JSONB vẫn buộc cơ sở dữ liệu phải ghi lại toàn bộ đối tượng dữ liệu đó vào tệp WAL và bộ nhớ đệm, gây lãng phí IOPS nghiêm trọng.
* Chi Phí Parse JSON Ở Lớp Ứng Dụng: Khi trả dữ liệu qua REST API, Node.js/NestJS phải tiêu tốn tài nguyên CPU để chuyển đổi chuỗi JSONB thành đối tượng JavaScript, thay vì nhận trực tiếp các kiểu dữ liệu nhị phân chuẩn từ driver Postgres.

| Tiêu chí Hiệu năng | Runtime DDL | Hybrid (JSONB) | EAV |
|---|---|---|---|
| Thời gian Lập kế hoạch Truy vấn | Chậm dần khi số bảng hệ thống (pg_class) tăng cao | Cực nhanh (chỉ vận hành trên số ít bảng cố định) | Rất chậm do cây truy vấn JOIN phức tạp |
| Tối ưu Dung lượng Đĩa | Rất cao nhờ các kiểu dữ liệu chuẩn của Postgres | Tốn dung lượng do lưu trữ lặp lại các JSON key-names | Tốn dung lượng lớn cho chỉ mục và metadata |
| Tốc độ Đọc (REST API Read) | Tối đa (Native SQL Performance) | Trung bình (Tốn chi phí parse JSON ở backend) | Rất chậm khi bảng có nhiều cột |
| Tốc độ Ghi (REST API Write) | Tối đa (Chỉ ghi đúng cột dữ liệu sửa đổi) | Bị ảnh hưởng khi payload JSON lớn (TOAST amplification) | Chậm (Phải insert/update nhiều dòng cho 1 record) |
| Khả năng Cô lập Multi-tenant | Dễ cạn kiệt tài nguyên nếu tenant tạo quá nhiều bảng | Phân tách row-level cực tốt trên bảng dùng chung | Dễ nghẽn CPU khi nhiều tenant cùng truy vấn |

**Ý Nghĩa:** Đối với hệ thống phân tách theo tenant_id, chiến lược Runtime DDL đòi hỏi phải thiết lập cơ chế kiểm soát chặt chẽ số lượng bảng tối đa trên mỗi tenant để bảo vệ bảng hệ thống pg_class. Nếu dự kiến quy mô toàn hệ thống vượt quá 20,000 bảng động, việc áp dụng mô hình lai — dùng Runtime DDL cho các bảng chính có lưu lượng lớn và dùng JSONB cho các trường tùy chỉnh có tần suất truy vấn thấp — là hướng đi an toàn nhất.

## 3. Chiến Lược Indexing Cho Field Do User Định Nghĩa
### Auto-Indexing vs Opt-In Indexing
* Auto-Indexing: Khóa chính (id) và cột phân tách đa người dùng (tenant_id); các trường liên kết quan hệ (Foreign Keys / Single-select relationships); chỉ mục ghép (Composite Index) chuẩn hóa (tenant_id, created_at) để phục vụ phân trang mặc định cho các REST API endpoint.
* Opt-In Indexing: Các trường kiểu chuỗi, số, ngày tháng mà người dùng thiết lập làm điều kiện lọc thường xuyên. Hệ thống chỉ thực thi lệnh tạo index khi người dùng đánh dấu trường đó là "Filterable" hoặc "Searchable" trên giao diện.

### Xử Lý Trường Cardinality Cao Và Free-Text Search
* Trường Cardinality Cao (Mã định danh, Email, Phone): `CREATE INDEX idx_custom_field ON tenant_table (tenant_id, custom_email_column);`
* Free-Text Search (Runtime DDL): `CREATE INDEX idx_text_trgm ON tenant_table USING gin (custom_text_column gin_trgm_ops);`
* Free-Text Search (Hybrid JSONB): `CREATE INDEX idx_json_field ON tenant_data_table USING btree (tenant_id, (data->>'field_key'));`

| Loại trường dữ liệu | Kiểu Index Postgres đề xuất | Chiến lược khởi tạo | Mục tiêu tối ưu |
|---|---|---|---|
| Tenant ID & Foreign Key | Composite B-Tree Index | Tự động (Auto) | Cô lập dữ liệu tenant và tăng tốc JOIN liên kết |
| Ngày tạo / ID (Phân trang) | B-Tree (tenant_id, id DESC) | Tự động (Auto) | Tăng tốc phân trang REST API |
| Trường lọc chuẩn (Number, Date) | B-Tree (tenant_id, field_name) | Người dùng bật (Opt-in) | Tăng tốc truy vấn lọc REST |
| Văn bản ngắn (Tìm kiếm LIKE) | GIN pg_trgm Index | Người dùng bật (Opt-in) | Hỗ trợ tìm kiếm chuỗi không phân biệt hoa thường |
| Dữ liệu JSONB Động | Expression Index / GIN jsonb_path_ops | Người dùng bật (Opt-in) | Tăng tốc truy vấn vào các thuộc tính bên trong JSON |

**Ý Nghĩa:** Trong môi trường row-level multi-tenant, mọi chỉ mục được khởi tạo bắt buộc phải chứa cột tenant_id ở vị trí ưu tiên đầu tiên (Leading Column). Thiết kế này bảo đảm máy chủ cơ sở dữ liệu chỉ quét qua nhánh cây chỉ mục thuộc về tenant hiện tại, ngăn chặn triệt để hiện tượng quét chỉ mục toàn cục.

## 4. An Toàn Runtime DDL Ở Multi-Tenant Scale
### Hành Vi Lock Trong Postgres
Khi thực thi các lệnh ALTER TABLE, Postgres yêu cầu khóa ACCESS EXCLUSIVE trên bảng tương ứng, chặn toàn bộ đọc/ghi từ tất cả tenant. Nếu có truy vấn SELECT dài đang chạy, ALTER TABLE phải xếp hàng chờ, và mọi SELECT đến sau cũng dồn hàng chờ theo, dẫn tới cạn kiệt kết nối (Connection Pool Starvation).

### Chiến Lược Thay Đổi Schema An Toàn (Online Schema Change)
* Timeout bắt buộc: `SET lock_timeout = '2s';` trước mọi lệnh DDL.
* Thêm cột mới: từ Postgres 11 trở đi, `ADD COLUMN ... DEFAULT` diễn ra tức thì (O(1)).
* Đổi kiểu dữ liệu: quy trình 4 bước bất đồng bộ — tạo cột mới, ghi đồng thời ở tầng ứng dụng, batch backfill nền, chuyển hướng và xóa cột cũ.
* Transactional DDL: bọc thay đổi bảng vật lý và cập nhật metadata (14 bảng Prisma) trong cùng một SQL Transaction.

**Ý Nghĩa:** Ứng dụng NestJS cần triển khai một hàng đợi tác vụ (Redis BullMQ) chuyên biệt cho DDL, xử lý bất đồng bộ ngoài luồng request-response.

## 5. Giới Hạn & Guardrails Vận Hành Cho End-User

| Metric Guardrail | Airtable | NocoDB | Baserow | Teable | Đề xuất cho hệ thống Target |
|---|---|---|---|---|---|
| Max Rows / Base (hoặc Tenant) | 1k/50k/125k/500k | 1k/50k/300k/Unlimited | 3k/10k/100k | 1k/250k | 100,000 bản ghi / tenant table |
| API Rate Limit | 5 req/s/base | 5 req/s/user | Qua Throttler | 10 req/s | 10-20 req/s/tenant |
| Max Columns / Table | ~500 cột | Theo DB backend | Theo Postgres | Theo Postgres | 100 cột / bảng |
| REST Page Size Limit | Tối đa 100/page | Mặc định 25-50 | Mặc định 100 | Tùy chỉnh | Mặc định 50, tối đa 100 |
| Batch Operation Limit | 10 records/request | Tùy chỉnh JSON | Tùy chỉnh JSON | Tùy chỉnh JSON | Tối đa 50 records/request |

**Cấu Hình Guardrail Cho NestJS:** `@nestjs/throttler` + Redis storage theo tenant_id (429 + Retry-After: 30 khi vượt 10-20 req/s); body parser giới hạn 2MB; `statement_timeout = '5s'` cho kết nối truy vấn động.

## 6. Query / CRUD Layer: Thay Thế Prisma Và Tối Ưu REST API
Prisma chỉ quản lý 14 bảng metadata cố định, không dùng được cho bảng runtime do yêu cầu compile-time schema.

* **Knex.js** (khuyến nghị): ổn định nhất trong hệ sinh thái Node.js, hỗ trợ cả DML và DDL động, connection pooling, transaction savepoints, streaming. Nhược điểm: cần tự xây lớp ép kiểu.
* **Kysely**: cú pháp hiện đại, type-safe, nhưng khó dùng với bảng/cột hoàn toàn động.
* **Slonik / Raw SQL (pg)**: tốc độ tối đa, an toàn SQL injection, nhưng tốn chi phí bảo trì logic ghép chuỗi filter động.

**Giải pháp N+1:**
* JSON Aggregation một query duy nhất qua `json_agg`/`json_build_object` (ví dụ SQL kèm theo trong báo cáo gốc).
* DataLoader pattern cho REST: gộp khóa ngoại, một câu `WHERE id IN (...)`, ghép trong bộ nhớ Node.js.

**Caching Metadata:** Redis key `schema:{tenant_id}:{table_id}`, invalidate ngay khi có DDL.

## 7. Failure Modes & Bài Học Postmortem Thực Tế
1. **Postgres Catalog Cache Invalidation Outage** — 80,000 bảng vật lý sau 6 tháng, pg_attribute phình to, query planning time tăng từ 0.5ms lên 200ms. Khắc phục: VACUUM FULL ANALYZE định kỳ + tái sử dụng bảng vật lý.
2. **Lock Starvation Cascading Failure** — ALTER TABLE trên bảng 2 triệu bản ghi chờ 30s phía sau một SELECT dài, dồn toàn bộ request phía sau, connection pool cạn trong 3s, hàng loạt lỗi 504. Khắc phục: `lock_timeout = '2s'` + hàng đợi DDL bất đồng bộ.
3. **TOAST Bloat IOPS Exhaustion** — PATCH tần suất cao trên cột JSONB gây sao chép toàn bộ document mỗi lần update, WAL tăng hàng trăm GB/ngày, DB chuyển Read-Only. Khắc phục: tách trường update tần suất cao ra cột SQL vật lý riêng.
4. **N+1 REST API Disaster** — bảng có 10 trường liên kết, truy vấn tuần tự tạo >1,000 query con/request, CPU 100%. Khắc phục: JSON Aggregation gom về một query.

**Ý Nghĩa:** Kiến trúc Dynamic Table Builder bền vững trên Postgres cần kết hợp Runtime DDL (bảng chính) + B-Tree Composite index (tenant_id leading) + lớp Knex.js tách biệt khỏi Prisma + kiểm soát DDL bất đồng bộ với lock_timeout ngắn + guardrails nghiêm ngặt (rate limit, row limit, JSON aggregation).
