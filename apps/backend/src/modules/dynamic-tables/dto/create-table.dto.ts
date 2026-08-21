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
 * `FieldDataType` values `CreateTableDto` accepts at table-creation time.
 * `RELATION` is deliberately excluded here -- per Story 4/CAP-4, a relation
 * field can only be added via the field-edit path (`PATCH
 * .../fields`/`FieldEditDto`, which allows the full `FieldDataType` set
 * instead), never at table-creation time.
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
