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
  ValidateNested,
} from 'class-validator';
import { FieldDataType } from '@flexi/shared-types';
import { NON_RELATION_FIELD_DATA_TYPES } from './create-table.dto';

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
 * - `add`: requires `name` + `dataType`; `required`/`config` optional.
 * - `remove`: requires `name` only.
 * - `modify`: requires `name` (the existing field); `dataType`/`required`/
 *   `config` describe the new definition. A `dataType` change is treated as
 *   destructive (expand/contract) by `buildFieldEditSteps()`.
 */
export class FieldEditDto {
  @IsIn(FIELD_EDIT_OPERATIONS)
  operation!: FieldEditOperation;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsEnum(NON_RELATION_FIELD_DATA_TYPES)
  dataType?: FieldDataType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

/** Body for PATCH /api/tables/:tableId/fields (CAP-2). */
export class UpdateFieldDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FieldEditDto)
  edits!: FieldEditDto[];
}
