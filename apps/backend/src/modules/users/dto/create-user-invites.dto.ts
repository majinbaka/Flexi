import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Upper bound on one batch. Not a business rule -- it bounds the work a
 * single request can ask for: every invite in the batch costs a bcrypt
 * hash, three inserts and an SMTP round trip, and the whole batch is
 * all-or-nothing, so an unbounded list would hold one transaction open for
 * as long as the caller cared to make it.
 */
export const MAX_INVITES_PER_BATCH = 50;

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
