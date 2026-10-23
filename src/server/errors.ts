/**
 * Domain errors. Server actions translate these into user-facing Indonesian messages;
 * they never leak stack traces or SQL to the client.
 */
export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Sesi berakhir. Silakan masuk kembali.") {
    super("UNAUTHENTICATED", message);
  }
}

export class ForbiddenError extends AppError {
  readonly permission: string;
  constructor(permission: string, message = "Anda tidak memiliki izin untuk tindakan ini.") {
    super("FORBIDDEN", message);
    this.permission = permission;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Data tidak ditemukan.") {
    super("NOT_FOUND", message);
  }
}

export class ValidationError extends AppError {
  readonly fieldErrors: Record<string, string[]>;
  constructor(fieldErrors: Record<string, string[]>, message = "Periksa kembali isian Anda.") {
    super("VALIDATION", message);
    this.fieldErrors = fieldErrors;
  }
}

/** Optimistic-lock failure or uniqueness violation. */
export class ConflictError extends AppError {
  constructor(message = "Data telah diubah oleh pengguna lain. Muat ulang lalu coba lagi.") {
    super("CONFLICT", message);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = "Kunci permintaan sudah dipakai untuk data yang berbeda.") {
    super("IDEMPOTENCY_CONFLICT", message);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string) {
    super("BUSINESS_RULE", message);
  }
}
