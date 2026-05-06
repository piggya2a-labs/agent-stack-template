/**
 * src/trigger/init.ts — Trigger.dev v4 global initialization + middleware
 *
 * Loaded automatically by the Trigger.dev runtime before each task execution.
 * Registers global middleware that applies to all tasks.
 *
 * Auto tenant-tag injection: reads payload.tenant_id and applies
 * `tenant:<id>` tag at task start, so callers never need to pass it manually.
 */
import { tasks, tags, locals } from "@trigger.dev/sdk";

const TenantLocal = locals.create<{ tenant_id?: string }>("tenant");

tasks.middleware("auto-tenant-tag", async ({ payload, next }) => {
  let tenantId: string | undefined;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.tenant_id === "string" && p.tenant_id.length > 0) {
      tenantId = p.tenant_id;
    }
  }
  if (tenantId) {
    locals.set(TenantLocal, { tenant_id: tenantId });
    try {
      await tags.add(`tenant:${tenantId}`);
    } catch {
      // Tag already exists or transient failure — non-fatal
    }
  }
  await next();
});
