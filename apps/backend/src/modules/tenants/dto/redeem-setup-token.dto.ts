import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Public payload for claiming a First Admin account from a one-time setup
 * link. The token is deliberately accepted only in the request body and is
 * never persisted or included in an error response.
 */
export class RedeemSetupTokenDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  // Keep the same password policy currently used by LoginDto: a non-empty
  // string. A stronger shared policy can be introduced for both flows later.
  @IsString()
  @IsNotEmpty()
  password!: string;
}
