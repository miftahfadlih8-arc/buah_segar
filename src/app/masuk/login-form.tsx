"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/ui/icons";
import { Button, Input } from "@/components/ui/primitives";

export interface DevQuickFillConfig {
  accounts: Array<{ u: string; label: string }>;
  password: string;
}

interface LoginFormProps {
  isDevMode: boolean;
  devQuickFill?: DevQuickFillConfig | null;
}

export function LoginForm({ isDevMode, devQuickFill }: LoginFormProps) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);

    try {
      const trimmed = identifier.trim();
      const isEmail = trimmed.includes("@");
      const endpoint = isEmail ? "/api/auth/sign-in/email" : "/api/auth/sign-in/username";
      const payload = isEmail
        ? { email: trimmed.toLowerCase(), password }
        : { username: trimmed.toLowerCase(), password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status >= 500) {
          setErrorMsg(
            "Server gagal terhubung ke database (HTTP 500). Pastikan DATABASE_URL di Vercel memakai format postgresql://... dari Supabase lalu Redeploy.",
          );
        } else if (res.status === 403) {
          setErrorMsg(
            "Domain origin ditolak (HTTP 403). Pastikan BETTER_AUTH_URL di Vercel sesuai dengan alamat website ini lalu Redeploy.",
          );
        } else {
          setErrorMsg("Username/email atau kata sandi tidak sesuai, atau akun sedang dinonaktifkan.");
        }
        setSubmitting(false);
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setErrorMsg("Gagal menghubungi server otentikasi. Periksa koneksi jaringan Anda.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} method="POST" className="space-y-4" noValidate>
      {errorMsg && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-900"
        >
          <Icon name="danger" size={16} className="mt-0.5 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div>
        <label htmlFor="identifier" className="mb-1.5 block text-xs font-semibold text-slate-700">
          Username atau Email Kerja <span className="text-red-600">*</span>
        </label>
        <Input
          id="identifier"
          name="identifier"
          type="text"
          required
          autoComplete="username"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="next"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            if (errorMsg) setErrorMsg(null);
          }}
          placeholder="contoh: nama.pengguna atau email@perusahaan.id"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="password" className="block text-xs font-semibold text-slate-700">
            Kata Sandi <span className="text-red-600">*</span>
          </label>
          <button
            type="button"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((prev) => !prev)}
            className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline"
          >
            {showPassword ? "Sembunyikan sandi" : "Tampilkan sandi"}
          </button>
        </div>
        <Input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          required
          minLength={8}
          autoComplete="current-password"
          enterKeyHint="done"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (errorMsg) setErrorMsg(null);
          }}
          aria-describedby="password-hint"
        />
        <p id="password-hint" className="mt-1 text-[11px] text-slate-500">
          Minimal 8 karakter. Jangan berbagi akun antar operator gudang atau kasir.
        </p>
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={submitting}
        className="w-full"
      >
        {submitting ? "Memverifikasi Sesi..." : "Masuk ke Sistem Operasional"}
      </Button>

      {isDevMode && devQuickFill && devQuickFill.password.length >= 8 && (
        <fieldset className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-xs text-amber-950">
          <legend className="px-1.5 font-bold text-amber-900">
            Akun Sintetis Pengembangan Lokal (Hanya Mode Dev)
          </legend>
          <p className="mb-2.5 text-[11px] text-amber-800">
            Pilih peran kerja untuk mengisi kredensial uji secara otomatis:
          </p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {devQuickFill.accounts.map((item) => (
              <button
                key={item.u}
                type="button"
                onClick={() => {
                  setIdentifier(item.u);
                  setPassword(devQuickFill.password);
                  setErrorMsg(null);
                }}
                className="rounded-lg border border-amber-300/90 bg-white px-2.5 py-1.5 text-left text-[11px] font-semibold text-slate-800 transition hover:border-amber-400 hover:bg-amber-100/60"
              >
                <div>{item.label}</div>
                <div className="font-mono text-[10px] font-normal text-slate-500">@{item.u}</div>
              </button>
            ))}
          </div>
        </fieldset>
      )}
    </form>
  );
}
