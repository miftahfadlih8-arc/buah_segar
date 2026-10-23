"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Button, type ButtonSize, type ButtonVariant } from "./primitives";

interface ModalDialogTriggerProps {
  triggerLabel: string;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  triggerIcon?: IconName;
  title: string;
  subtitle?: string;
  children: ReactNode;
  maxWidthClass?: string;
}

export function ModalDialogTrigger({
  triggerLabel,
  triggerVariant = "primary",
  triggerSize = "md",
  triggerIcon = "plus",
  title,
  subtitle,
  children,
  maxWidthClass = "max-w-2xl",
}: ModalDialogTriggerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  function openDialog() {
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        icon={triggerIcon}
        onClick={openDialog}
      >
        {triggerLabel}
      </Button>

      <dialog
        ref={dialogRef}
        onClick={(e) => {
          if (e.target === dialogRef.current) {
            closeDialog();
          }
        }}
        className={`m-auto w-full ${maxWidthClass} rounded-2xl border border-slate-200 bg-white p-0 text-left text-slate-900 shadow-2xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="Tutup dialog"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="max-h-[80vh] overflow-y-auto p-6">{children}</div>
      </dialog>
    </>
  );
}

interface ConfirmActionButtonProps {
  action: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string | number>;
  buttonLabel: string;
  buttonVariant?: ButtonVariant;
  buttonSize?: ButtonSize;
  confirmTitle: string;
  confirmDescription: string;
  confirmButtonLabel?: string;
  reasonFieldName?: string;
  reasonDefaultValue?: string;
  requireReason?: boolean;
}

export function ConfirmActionButton({
  action,
  hiddenFields,
  buttonLabel,
  buttonVariant = "secondary",
  buttonSize = "sm",
  confirmTitle,
  confirmDescription,
  confirmButtonLabel = "Ya, Lanjutkan",
  reasonFieldName,
  reasonDefaultValue = "",
  requireReason = false,
}: ConfirmActionButtonProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState(reasonDefaultValue);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openConfirm() {
    setErrorMsg(null);
    dialogRef.current?.showModal();
  }

  function closeConfirm() {
    if (!isPending) {
      dialogRef.current?.close();
    }
  }

  function handleConfirmSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (requireReason && reasonFieldName && !reason.trim()) {
      setErrorMsg("Alasan tindakan wajib diisi.");
      return;
    }
    setErrorMsg(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(hiddenFields)) {
      fd.set(k, String(v));
    }
    if (reasonFieldName) {
      fd.set(reasonFieldName, reason.trim());
    }

    startTransition(async () => {
      try {
        await action(fd);
        dialogRef.current?.close();
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : "Tindakan gagal diproses oleh server. Periksa kembali syarat dokumen.",
        );
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={buttonSize}
        onClick={openConfirm}
        loading={isPending}
      >
        {buttonLabel}
      </Button>

      <dialog
        ref={dialogRef}
        onClick={(e) => {
          if (e.target === dialogRef.current) {
            closeConfirm();
          }
        }}
        className="m-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-0 text-left text-slate-900 shadow-2xl"
      >
        <form onSubmit={handleConfirmSubmit} className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                buttonVariant === "danger"
                  ? "bg-red-50 text-red-600"
                  : "bg-amber-50 text-amber-600"
              }`}
            >
              <Icon name={buttonVariant === "danger" ? "danger" : "alert"} size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">{confirmTitle}</h3>
              <p className="mt-1 text-xs text-slate-600">{confirmDescription}</p>
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
            >
              {errorMsg}
            </div>
          )}

          {reasonFieldName && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Catatan / Alasan {requireReason && <span className="text-red-600">*</span>}
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required={requireReason}
                placeholder="Masukkan alasan yang dapat diaudit..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={closeConfirm}
              disabled={isPending}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant={buttonVariant === "danger" ? "danger" : "primary"}
              size="sm"
              loading={isPending}
            >
              {isPending ? "Memproses..." : confirmButtonLabel}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
