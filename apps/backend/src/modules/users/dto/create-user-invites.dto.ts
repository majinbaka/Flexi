import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
} from 'class-validator';
import { MAX_INVITES_PER_BATCH } from '@flexi/shared-types';

export { MAX_INVITES_PER_BATCH };

/**
 * Body for POST /api/users/invites.
 *
 * `roleId` is optional and applies to every address in the batch: invite
 * one role at a time rather than pairing each address with its own, which
 * is what the Users specification describes ("danh sách email cùng role")
 * and what keeps the quota check a single number.
 */
export class CreateUserInvitesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_INVITES_PER_BATCH)
  @IsEmail({}, { each: true })
  emails!: string[];

  @IsOptional()
  @IsString()
  roleId?: string;
}
