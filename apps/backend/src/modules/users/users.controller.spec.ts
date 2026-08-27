import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import {
  ActorType,
  AuthenticatedUserDto,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
} from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccountLifecycleService } from './account-lifecycle.service';
import { UserInvitesController } from './user-invites.controller';
import { UsersAdminService } from './users-admin.service';
import { UsersController } from './users.controller';
import { UsersModule } from './users.module';
import { UserDeletionService } from './user-deletion.service';

describe('UsersController', () => {
  const caller: AuthenticatedUserDto = {
    authAccountId: 'auth_admin',
    actorType: ActorType.TENANT,
    tenantId: 'tenant_1',
    tenantUserId: 'tu_admin',
    email: 'admin@example.com',
    name: 'Admin',
    roles: ['TENANT_ADMIN'],
    permissions: [TENANT_USER_READ_PERMISSION, TENANT_USER_MANAGE_PERMISSION],
  };

  function buildControllers() {
    const usersAdminService = {
      listUsers: jest.fn(),
      getUser: jest.fn(),
      updateUser: jest.fn(),
      directCreate: jest.fn(),
      approveUser: jest.fn(),
      lockUser: jest.fn(),
      unlockUser: jest.fn(),
    } as unknown as jest.Mocked<UsersAdminService>;
    const accountLifecycleService = {
      activate: jest.fn(),
      deactivate: jest.fn(),
    } as unknown as jest.Mocked<AccountLifecycleService>;
    const userDeletionService = {
      deleteUser: jest.fn(),
    } as unknown as jest.Mocked<UserDeletionService>;

    return {
      usersAdminService,
      accountLifecycleService,
      userDeletionService,
      controller: new UsersController(
        usersAdminService,
        accountLifecycleService,
        userDeletionService,
      ),
    };
  }

  it('delegates each route to the service with the caller it was given', async () => {
    const {
      controller,
      usersAdminService,
      accountLifecycleService,
      userDeletionService,
    } = buildControllers();
    const query = { page: '2', status: 'active', keyword: '  ' };
    const createBody = { email: 'new@example.com', fullName: 'New Person' };
    const updateBody = { fullName: 'Renamed' };

    await controller.listUsers(query, caller);
    await controller.getUser('tu_1', caller);
    await controller.updateUser('tu_1', updateBody, caller);
    await controller.directCreate(createBody, caller);
    await controller.approveUser('tu_1', caller);
    await controller.lockUser('tu_1', caller);
    await controller.unlockUser('tu_1', caller);
    await controller.deactivate('tu_1', caller);
    await controller.activate('tu_1', caller);
    await controller.deleteUser(
      'tu_1',
      { mode: 'hard', transferToUserId: 'tu_2' },
      caller,
    );

    // Parsed on the way in: numbers through the shared query parser,
    // blank filters dropped rather than matched against the empty string.
    expect(usersAdminService.listUsers).toHaveBeenCalledWith(
      {
        status: 'active',
        roleId: undefined,
        keyword: undefined,
        page: 2,
        pageSize: undefined,
      },
      caller,
    );
    expect(usersAdminService.getUser).toHaveBeenCalledWith('tu_1', caller);
    expect(usersAdminService.updateUser).toHaveBeenCalledWith(
      'tu_1',
      updateBody,
      caller,
    );
    expect(usersAdminService.directCreate).toHaveBeenCalledWith(
      createBody,
      caller,
    );
    expect(usersAdminService.approveUser).toHaveBeenCalledWith('tu_1', caller);
    expect(usersAdminService.lockUser).toHaveBeenCalledWith('tu_1', caller);
    expect(usersAdminService.unlockUser).toHaveBeenCalledWith('tu_1', caller);
    expect(accountLifecycleService.deactivate).toHaveBeenCalledWith(
      'tu_1',
      caller,
    );
    expect(accountLifecycleService.activate).toHaveBeenCalledWith(
      'tu_1',
      caller,
    );
    expect(userDeletionService.deleteUser).toHaveBeenCalledWith(
      'tu_1',
      'hard',
      'tu_2',
      caller,
    );
  });

  /**
   * Every route here needs a session and none of them can name its
   * permission statically: the code depends on the caller's actor type, so
   * the service asserts it. A `@RequirePermissions()` appearing on one of
   * these would silently demand the TENANT spelling of a system caller.
   */
  it.each([
    'listUsers',
    'getUser',
    'updateUser',
    'directCreate',
    'approveUser',
    'lockUser',
    'unlockUser',
    'deactivate',
    'activate',
  ] as const)(
    'authenticates %s and leaves the permission to the service',
    (route) => {
      const method = UsersController.prototype[route];

      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
        JwtAuthGuard,
      ]);
      expect(
        Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method),
      ).toBeUndefined();
    },
  );

  /** A directly created user is a created resource. */
  it('answers 201 when a user is created directly', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        UsersController.prototype.directCreate,
      ),
    ).toBe(HttpStatus.CREATED);
  });

  /**
   * Nest maps routes in the order controllers are declared and Express
   * answers with the first match, so `GET users/:userId` would swallow
   * `GET users/invites` if this order were ever flipped -- the invite
   * listing would start answering `404 USER_NOT_FOUND` for a user called
   * "invites". Cheap to assert here; the e2e suite calls both for real.
   */
  it('registers the invite routes before the :userId routes', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      UsersModule,
    ) as unknown[];

    expect(controllers.indexOf(UserInvitesController)).toBeLessThan(
      controllers.indexOf(UsersController),
    );
  });
});
