import { headers } from "next/headers";
import { getAuth } from "@/server/auth";
import { loadActorContext, type ActorContext } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { UnauthenticatedError } from "@/server/errors";

/**
 * Resolve the current authenticated user and RBAC permissions from Next.js request headers.
 */
export async function getSessionActor(): Promise<ActorContext | null> {
  const reqHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: reqHeaders });
  if (!session?.user?.id) {
    return null;
  }
  const db = getDb();
  const ctx = await loadActorContext(db, session.user.id, {
    ipAddress: reqHeaders.get("x-forwarded-for") ?? undefined,
    requestId: reqHeaders.get("x-request-id") ?? undefined,
  });
  if (!ctx || ctx.user.status !== "active") {
    return null;
  }
  return ctx;
}

export async function requireSessionActor(): Promise<ActorContext> {
  const ctx = await getSessionActor();
  if (!ctx) {
    throw new UnauthenticatedError();
  }
  return ctx;
}
