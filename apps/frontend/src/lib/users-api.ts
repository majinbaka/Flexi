import type {
  CreatedUserInviteDto,
  InviteUsersResponseDto,
  RedeemUserInviteRequestDto,
  RedeemUserInviteResponseDto,
  TenantSettingsDto,
  UpdateTenantSettingsRequestDto,
  UpdateUserRequestDto,
  UserDeletionResponseDto,
  UserDetailDto,
  UserInviteDto,
  UserListQueryDto,
  UserListResponseDto,
  UserStatusChangeResponseDto,
} from '@flexi/shared-types';
import { apiDelete, apiGet, apiPatch, apiPost } from './api-client';

/**
 * Users administration, the invite lifecycle and the tenant's
 * self-registration policy.
 *
 * One function per route that exists in
 * `apps/backend/src/modules/users/*.controller.ts` and nothing else --
 * every screen in this feature area goes through here rather than calling
 * `api-client` directly, so the set of endpoints the UI depends on is
 * readable in one file.
 *
 * Two things the Users screens would otherwise want have no endpoint yet
 * and are therefore absent here rather than faked: a readable seat-usage
 * projection (`TenantSeatUsageDto` is only ever returned as a *result* of
 * inviting or direct-creating, never on its own) and a role listing (no
 * `RoleDto` is served anywhere). See the notes on `InviteUsersDialog` and
 * `SelfRegistrationSettingsPage`.
 */

/** Options shared by Users requests, including cancellation. */
export interface UsersRequestOptions {
  signal?: AbortSignal;
}

/** Query contract of `DELETE /api/users/:userId`. */
export interface DeleteUserOptions extends UsersRequestOptions {
  /** `soft` preserves the membership as `deleted`; `hard` removes it. */
  mode?: 'soft' | 'hard';
  /** Required by a hard delete when the user still owns dynamic rows. */
  transferToUserId?: string;
}

/** Body of `POST /api/users/invites`. */
export interface CreateUserInvitesRequest {
  emails: string[];
  roleId?: string;
}

function appendQuery(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function userPath(userId: string, suffix = ''): string {
  return `/users/${encodeURIComponent(userId)}${suffix}`;
}

function invitePath(inviteId: string, suffix = ''): string {
  return `/users/invites/${encodeURIComponent(inviteId)}${suffix}`;
}

export function listUsers(
  query: UserListQueryDto = {},
  options: UsersRequestOptions = {},
): Promise<UserListResponseDto> {
  return apiGet<UserListResponseDto>(
    appendQuery('/users', {
      status: query.status,
      roleId: query.roleId,
      keyword: query.keyword,
      page: query.page,
      pageSize: query.pageSize,
    }),
    options,
  );
}

export function getUser(
  userId: string,
  options: UsersRequestOptions = {},
): Promise<UserDetailDto> {
  return apiGet<UserDetailDto>(userPath(userId), options);
}

export function updateUser(
  userId: string,
  request: UpdateUserRequestDto,
  options: UsersRequestOptions = {},
): Promise<UserDetailDto> {
  return apiPatch<UserDetailDto>(userPath(userId), request, options);
}

export function approveUser(
  userId: string,
  options: UsersRequestOptions = {},
): Promise<UserStatusChangeResponseDto> {
  return apiPatch<UserStatusChangeResponseDto>(
    userPath(userId, '/approve'),
    undefined,
    options,
  );
}

export function lockUser(
  userId: string,
  options: UsersRequestOptions = {},
): Promise<UserStatusChangeResponseDto> {
  return apiPatch<UserStatusChangeResponseDto>(
    userPath(userId, '/lock'),
    undefined,
    options,
  );
}

export function unlockUser(
  userId: string,
  options: UsersRequestOptions = {},
): Promise<UserStatusChangeResponseDto> {
  return apiPatch<UserStatusChangeResponseDto>(
    userPath(userId, '/unlock'),
    undefined,
    options,
  );
}

/**
 * `mode` and `transferToUserId` travel as query params, which is what the
 * route's `DeleteUserDto` reads -- a DELETE body would be dropped.
 */
export function deleteUser(
  userId: string,
  { mode, transferToUserId, ...options }: DeleteUserOptions = {},
): Promise<UserDeletionResponseDto> {
  return apiDelete<UserDeletionResponseDto>(
    appendQuery(userPath(userId), { mode, transferToUserId }),
    options,
  );
}

export function listInvites(
  options: UsersRequestOptions = {},
): Promise<UserInviteDto[]> {
  return apiGet<UserInviteDto[]>('/users/invites', options);
}

export function createInvites(
  request: CreateUserInvitesRequest,
  options: UsersRequestOptions = {},
): Promise<InviteUsersResponseDto> {
  return apiPost<InviteUsersResponseDto>('/users/invites', request, options);
}

export function resendInvite(
  inviteId: string,
  options: UsersRequestOptions = {},
): Promise<CreatedUserInviteDto> {
  return apiPost<CreatedUserInviteDto>(
    invitePath(inviteId, '/resend'),
    undefined,
    options,
  );
}

export function revokeInvite(
  inviteId: string,
  options: UsersRequestOptions = {},
): Promise<UserInviteDto> {
  return apiPost<UserInviteDto>(
    invitePath(inviteId, '/revoke'),
    undefined,
    options,
  );
}

/**
 * Public: the caller holds an emailed token and has no session yet, so the
 * request must not carry -- or be retried with -- whatever session happens
 * to exist in this browser.
 */
export function redeemInvite(
  request: RedeemUserInviteRequestDto,
  options: UsersRequestOptions = {},
): Promise<RedeemUserInviteResponseDto> {
  return apiPost<RedeemUserInviteResponseDto>(
    '/users/invites/redeem',
    request,
    {
      ...options,
      skipAuth: true,
    },
  );
}

export function getTenantSettings(
  options: UsersRequestOptions = {},
): Promise<TenantSettingsDto> {
  return apiGet<TenantSettingsDto>('/tenant-settings', options);
}

export function updateTenantSettings(
  request: UpdateTenantSettingsRequestDto,
  options: UsersRequestOptions = {},
): Promise<TenantSettingsDto> {
  return apiPatch<TenantSettingsDto>('/tenant-settings', request, options);
}

/**
 * Ends the impersonation session the current access token belongs to.
 *
 * The backend answers `204` and mints nothing in return: an impersonation
 * token is access-token-only by design, so the client's way back is its own
 * System Admin session, not a refresh of this one.
 */
export function endImpersonation(
  options: UsersRequestOptions = {},
): Promise<void> {
  return apiDelete<void>('/admin/impersonation', options);
}
