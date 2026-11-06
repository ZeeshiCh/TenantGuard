import {
  Module,
  Injectable,
  Inject,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type {
  DynamicModule,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  createTenantGuard,
  InvalidTenantContextError,
  TenantAuthorizationError,
  type TenantAuthorizer,
} from '@tenantguard/core';
import { requireTenant, nodeContext } from '@tenantguard/node';
export const TENANTGUARD_OPTIONS = Symbol('TENANTGUARD_OPTIONS');
export type TenantGuardOptions<Request = unknown> =
  | { authorize: TenantAuthorizer<Request>; resolveTenant?: never }
  | {
      /** @deprecated Prefer authorize, returning tenant and authenticated principal. */
      resolveTenant: (
        request: Request,
      ) => string | undefined | Promise<string | undefined>;
      authorize?: never;
    };
@Injectable()
export class TenantGuardInterceptor implements NestInterceptor {
  constructor(
    @Inject(TENANTGUARD_OPTIONS) private readonly options: TenantGuardOptions,
  ) {}
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request: unknown = context.switchToHttp().getRequest();
    const guard = createTenantGuard({
      carrier: nodeContext,
      authorize:
        this.options.authorize ??
        (async (input: unknown) => {
          const tenantId = await this.options.resolveTenant!(input);
          return tenantId === undefined ? undefined : { tenantId };
        }),
    });
    // Resolve once before subscription; the handler subscription must run inside ALS.
    let tenant;
    try {
      tenant = await guard.authorize(request);
    } catch (error) {
      if (
        error instanceof TenantAuthorizationError ||
        error instanceof InvalidTenantContextError
      )
        throw new UnauthorizedException('Verified tenant required');
      throw error;
    }
    return new Observable((subscriber) =>
      nodeContext.run(tenant, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}
export const CurrentTenant = createParamDecorator(() => requireTenant());
@Module({})
export class TenantGuardModule {
  static forRoot<Request = unknown>(
    options: TenantGuardOptions<Request>,
  ): DynamicModule {
    return {
      module: TenantGuardModule,
      providers: [
        { provide: TENANTGUARD_OPTIONS, useValue: options },
        TenantGuardInterceptor,
      ],
      exports: [TenantGuardInterceptor],
    };
  }
}
