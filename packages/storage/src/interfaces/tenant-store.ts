export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface CreateTenantInput {
  readonly name: string;
}

/**
 * Tenant directory. Minimal for now: every API key belongs to a tenant, and
 * rate limits are tiered per tenant. We will grow this with billing/quota
 * fields later, but the interface should stay small.
 */
export interface TenantStore {
  create(input: CreateTenantInput): Promise<Tenant>;

  findById(id: string): Promise<Tenant | null>;

  list(): Promise<readonly Tenant[]>;
}
