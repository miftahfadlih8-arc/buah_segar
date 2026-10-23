import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import { getDb } from "@/server/db";
import { accounts, sessions, users, verifications } from "@/server/db/schema";

const DEV_TEST_FALLBACK_SECRET = "dev-test-fallback-secret-minimum-32-chars-buah-bekasi";

/**
 * Production (NODE_ENV=production, which includes Vercel Preview builds) must never run
 * with the development fallback secret or an implicit localhost URL.
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): {
  secret: string;
  baseURL: string;
} {
  const isProduction = env.NODE_ENV === "production";
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (isProduction && (!secret || secret.length < 32 || secret === DEV_TEST_FALLBACK_SECRET)) {
    throw new Error(
      "Konfigurasi tidak aman: BETTER_AUTH_SECRET wajib diisi (minimal 32 karakter acak) pada lingkungan produksi.",
    );
  }
  const explicitUrl = env.BETTER_AUTH_URL?.trim();
  const vercelUrl = env.VERCEL_URL?.trim();
  const baseURL = explicitUrl || (vercelUrl ? `https://${vercelUrl}` : undefined);
  if (isProduction && !baseURL) {
    throw new Error(
      "Konfigurasi tidak lengkap: BETTER_AUTH_URL wajib diisi pada lingkungan produksi.",
    );
  }
  return {
    secret: secret || DEV_TEST_FALLBACK_SECRET,
    baseURL: baseURL ?? "http://localhost:3000",
  };
}

export function createAuth() {
  const db = getDb();
  const { secret, baseURL } = resolveAuthConfig();
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        status: {
          type: "string",
          defaultValue: "active",
          required: true,
        },
        phone: {
          type: "string",
          required: false,
        },
      },
    },
    plugins: [username()],
  });
}

declare global {
  var __buahAuth: ReturnType<typeof createAuth> | undefined;
}

export function getAuth() {
  if (!globalThis.__buahAuth) {
    globalThis.__buahAuth = createAuth();
  }
  return globalThis.__buahAuth;
}
