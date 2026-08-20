import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { FieldDataType } from '@flexi/shared-types';

/**
 * `FieldDataType` values this story accepts. `RELATION` is deliberately
 * excluded -- CAP-4 (relation fields) is Story 4's scope, not this story's
 * (see spec's "Never" boundary). Kept as its own const array (rather than
 * filtering the enum inline at every `@IsEnum()` call site) so both
 * `CreateTableDto` and `update-field.dto.ts` reference the exact same
 * allowed set.
 */
export const NON_RELATION_FIELD_DATA_TYPES = Object.values(
  FieldDataType,
).filter((value) => value !== FieldDataType.RELATION);

/** One field definition inside a POST /api/tables body. */
export class CreateTableFieldDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEnum(NON_RELATION_FIELD_DATA_TYPES)
  dataType!: FieldDataType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

/** Body for POST /api/tables (CAP-1). */
export class CreateTableDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateTableFieldDto)
  fields!: CreateTableFieldDto[];
}
