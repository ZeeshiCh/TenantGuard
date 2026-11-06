/** IDs are opaque and case-sensitive. Database-specific encodings belong in adapters. */
export interface TenantContext {
  readonly tenantId: string;
  readonly principalId?: string;
  readonly correlationId?: string;
}
export class InvalidTenantContextError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantContextError';
  }
}
export class MissingTenantError extends Error {
  constructor() {
    super('A verified tenant context is required');
    this.name = 'MissingTenantError';
  }
}
export class TenantAuthorizationError extends Error {
  constructor() {
    super('Tenant access denied');
    this.name = 'TenantAuthorizationError';
  }
}
export class TenantSwitchError extends Error {
  constructor() {
    super('Cannot switch tenants or principals inside an active context');
    this.name = 'TenantSwitchError';
  }
}
export function validateTenantId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new InvalidTenantContextError(
      'tenantId must be a nonempty string of at most 256 characters without surrounding whitespace or control characters',
    );
  }
}
/** Trusted application boundary only; this function does not authenticate or authorize. */
export function createTenantContext(
  input: TenantContext,
): Readonly<TenantContext> {
  validateTenantId(input.tenantId);
  for (const value of [input.principalId, input.correlationId]) {
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        !value.length ||
        value.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(value))
    )
      throw new InvalidTenantContextError('Invalid context metadata');
  }
  return Object.freeze({
    tenantId: input.tenantId,
    ...(input.principalId === undefined
      ? {}
      : { principalId: input.principalId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
  });
}
export interface ContextCarrier {
  get(): Readonly<TenantContext> | undefined;
  run<T>(context: Readonly<TenantContext>, callback: () => T): T;
}
/** Called after authentication; return a context only after membership and status checks. */
export type TenantAuthorizer<Input> = (
  input: Input,
) => TenantContext | undefined | Promise<TenantContext | undefined>;
export interface TenantGuard<Input> {
  authorize(input: Input): Promise<Readonly<TenantContext>>;
  run<T>(
    input: Input,
    callback: (context: Readonly<TenantContext>) => T | Promise<T>,
  ): Promise<T>;
}
export function createTenantGuard<Input>(options: {
  authorize: TenantAuthorizer<Input>;
  carrier?: ContextCarrier;
}): TenantGuard<Input> {
  const authorize = async (input: Input): Promise<Readonly<TenantContext>> => {
    const context = await options.authorize(input);
    if (!context) throw new TenantAuthorizationError();
    return createTenantContext(context);
  };
  return Object.freeze({
    authorize,
    async run<T>(
      input: Input,
      callback: (context: Readonly<TenantContext>) => T | Promise<T>,
    ): Promise<T> {
      const context = await authorize(input);
      const parent = options.carrier?.get();
      if (
        parent &&
        (parent.tenantId !== context.tenantId ||
          parent.principalId !== context.principalId)
      )
        throw new TenantSwitchError();
      return options.carrier
        ? options.carrier.run(context, () => callback(context))
        : callback(context);
    },
  });
}
