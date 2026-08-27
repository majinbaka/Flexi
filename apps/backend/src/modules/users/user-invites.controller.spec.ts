import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import {
  ActorType,
  AuthenticatedUserDto,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
} from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { UserInvitesController } from './user-invites.controller';
import { UserInviteService } from './user-invite.service';

describe('UserInvitesController', () => {
  const caller: AuthenticatedUserDto = {
    authAccountId: 'auth_admin',
    actorType: ActorType.TENANT,
    tenantId: 'tenant_1',
    tenantUserId: 'tu_admin',
    email: 'admin@example.com',
    name: 'Admin',
    roles: ['TENANT_ADMIN'],
    permissions: [TENANT_USER_INVITE_PERMISSION],
  };

  function buildService(): jest.Mocked<UserInviteService> {
    return {
      createInvites: jest.fn(),
      listInvites: jest.fn(),
      resendInvite: jest.fn(),
      revokeInvite: jest.fn(),
      redeemInvite: jest.fn(),
    } as unknown as jest.Mocked<UserInviteService>;
  }

  it('delegates each route to the service with the caller it was given', async () => {
    const service = buildService();
    const controller = new UserInvitesController(service);
    const dto = { emails: ['invitee@example.com'], roleId: 'role_1' };

    await controller.createInvites(dto, caller);
    await controller.listInvites(caller);
    await controller.resendInvite('inv_1', caller);
    await controller.revokeInvite('inv_1', caller);

    expect(service.createInvites).toHaveBeenCalledWith(dto, caller);
    expect(service.listInvites).toHaveBeenCalledWith(caller);
    expect(service.resendInvite).toHaveBeenCalledWith('inv_1', caller);
    expect(service.revokeInvite).toHaveBeenCalledWith('inv_1', caller);
  });

  it.each([
    ['createInvites', TENANT_USER_INVITE_PERMISSION],
    ['listInvites', TENANT_USER_READ_PERMISSION],
    ['resendInvite', TENANT_USER_INVITE_PERMISSION],
    ['revokeInvite', TENANT_USER_INVITE_PERMISSION],
  ] as const)('guards %s behind %s', (route, permission) => {
    const method = UserInvitesController.prototype[route];

    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
      JwtAuthGuard,
      PermissionsGuard,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method)).toEqual([
      permission,
    ]);
  });

  /**
   * The invitee holds an emailed token and, by construction, no session --
   * a guard here would make the invite impossible to accept.
   */
  it('leaves redemption public and answers 200', () => {
    const method = UserInvitesController.prototype.redeemInvite;

    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toBeUndefined();
    expect(
      Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method),
    ).toBeUndefined();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.OK);
  });

  /** A created invite is a created resource; Nest's POST default is right. */
  it('answers 201 when invites are created', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        UserInvitesController.prototype.createInvites,
      ),
    ).toBeUndefined();
  });
});
