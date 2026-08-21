import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { FieldDataType } from '@flexi/shared-types';

/** The three field-edit operations CAP-2 supports on PATCH /api/tables/:tableId/fields. */
export type FieldEditOperation = 'add' | 'remove' | 'modify';
export const FIELD_EDIT_OPERATIONS: FieldEditOperation[] = [
  'add',
  'remove',
  'modify',
];

/**
 * One field-edit operation inside a PATCH body. Shape varies by
 * `operation`, but kept as a single flat DTO (rather than a discriminated
 * union of DTO classes) to match `class-validator`'s whole-class
 * `@ValidateNested()` pattern used elsewhere in this module -- fields not
 * relevant to a given operation are simply left undefined and ignored by
 * `buildFieldEditSteps()`.
 *
 * - `add`: requires `name` + `dataType`; `required`/`config` optional. A
 *   `dataType: RELATION` "add" additionally requires `relatedTableId`
 *   (CAP-4/Story 4) -- the field-edit path is the only place a `RELATION`
 *   field can be introduced (table-creation's `CreateTableDto` keeps
 *   excluding it).
 * - `remove`: requires `name` only.
 * - `modify`: requires `name` (the existing field); `dataType`/`required`/
 *   `config` describe the new definition. A `dataType` change is treated as
 *   destructive (expand/contract) by `buildFieldEditSteps()`. Changing an
 *   existing field's `dataType` to or from `RELATION` is rejected
 *   synchronously (400) instead -- converting a live column to/from an FK
 *   is out of scope (removing and re-adding the field is the supported
 *   workaround).
 */
export class FieldEditDto {
  @IsIn(FIELD_EDIT_OPERATIONS)
  operation!: FieldEditOperation;

  @IsString()
  @IsNotEmpty()
  name!: string;

  /**
   * Full `FieldDataType` set on the field-edit path -- unlike
   * `CreateTableDto`'s `NON_RELATION_FIELD_DATA_TYPES` allowlist, `RELATION`
   * is allowed here (Story 4/CAP-4: relations are added only via this
   * PATCH path, never at table-creation time).
   */
  @IsOptional()
  @IsEnum(FieldDataType)
  dataType?: FieldDataType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  /**
   * The target `_meta_tables.id` this relation field points at -- required
   * only when `dataType === RELATION` (`@ValidateIf`-gated). Kept as its own
   * first-class property, not folded into `config`, since it drives DDL
   * (`.inTable()`) and metadata (`_meta_fields.relation_target_table_id`),
   * both structural rather than a per-field validation constraint (Design
   * Notes).
   */
  @ValidateIf((dto: FieldEditDto) => dto.dataType === FieldDataType.RELATION)
  @IsString()
  @IsNotEmpty()
  relatedTableId?: string;
}

/** Body for PATCH /api/tables/:tableId/fields (CAP-2). */
export class UpdateFieldDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FieldEditDto)
  edits!: FieldEditDto[];
}
