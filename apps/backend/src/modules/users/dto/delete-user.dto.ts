import { IsIn, IsOptional, IsString } from 'class-validator';

/** Query contract for `DELETE /api/users/:userId`. */
export class DeleteUserDto {
  @IsOptional()
  @IsIn(['soft', 'hard'])
  mode?: 'soft' | 'hard';

  @IsOptional()
  @IsString()
  transferToUserId?: string;
}
