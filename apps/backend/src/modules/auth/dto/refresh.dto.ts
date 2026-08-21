import { IsNotEmpty, IsString } from 'class-validator';

/** Body for POST /api/auth/refresh. */
export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
