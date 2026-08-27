import { IsEmail } from 'class-validator';

/**
 * Body for POST /api/auth/forgot-password. Which account this resolves to
 * is not in the body: as with login, `x-tenant-id` present routes to a
 * TenantUser of that tenant and absent routes to a SystemUser -- an email
 * address is not globally unique, so the header is what disambiguates.
 *
 * Case/whitespace normalisation happens in the service rather than through
 * a `@Transform` here, because the global `ValidationPipe` is bound in
 * `main.ts` and so is not in the chain for every way the app is
 * constructed. Normalising at the single point that also does the lookup
 * keeps the two from ever disagreeing.
 */
export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}
