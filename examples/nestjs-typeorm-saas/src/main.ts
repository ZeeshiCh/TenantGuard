import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Module, UseInterceptors } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { TenantGuardModule, TenantGuardInterceptor } from '@tenantguard/nestjs';
import { withTenantTransaction } from '@tenantguard/typeorm';
// Demo credentials map server-side to authorized tenants. Replace with your identity provider.
const token = process.env.DEMO_API_TOKEN;
const tenant = process.env.DEMO_TENANT_ID;
if (!token || !tenant || !process.env.DATABASE_URL)
  throw new Error('Set DATABASE_URL, DEMO_API_TOKEN and DEMO_TENANT_ID');
const db = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL });
@Controller('orders')
@UseInterceptors(TenantGuardInterceptor)
class OrdersController {
  @Get() list() {
    return withTenantTransaction(db, (manager) =>
      manager.query('SELECT * FROM orders'),
    );
  }
}
@Module({
  imports: [
    TenantGuardModule.forRoot({
      authorize: (request: { headers: { authorization?: string } }) => {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        return supplied.length === expected.length &&
          timingSafeEqual(supplied, expected)
          ? { tenantId: tenant, principalId: 'demo-user' }
          : undefined;
      },
    }),
  ],
  controllers: [OrdersController],
})
class AppModule {}
await db.initialize();
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
