"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ActionState } from "@/app/(app)/actions";
import { Icon } from "@/components/ui/icons";
import { Button, type ButtonVariant } from "@/components/ui/primitives";

interface ActionFormProps {
  action: (prev: ActionState | null, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  submitVariant?: ButtonVariant;
  children: React.ReactNode;
  resetOnSuccess?: boolean;
}

export function ActionForm({
  action,
  submitLabel,
  submitVariant = "primary",
  children,
  resetOnSuccess = true,
}: ActionFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) {
      formRef.current?.reset();
    }
  }, [state, resetOnSuccess]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      {state && (
        <div
          role="alert"
          aria-live="polite"
          className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs font-medium ${
            state.ok
              ? "border-emerald-200 bg-emerald-50/90 text-emerald-950"
              : "border-red-200 bg-red-50/90 text-red-950"
          }`}
        >
          <span
            className={`mt-0.5 shrink-0 ${
              state.ok ? "text-emerald-600" : "text-red-600"
            }`}
          >
            <Icon name={state.ok ? "check" : "danger"} size={16} />
          </span>
          <div className="space-y-1">
            <p className="font-semibold">{state.message}</p>
            {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 && (
              <ul className="list-disc pl-4 text-[11px]">
                {Object.entries(state.fieldErrors).map(([field, messages]) =>
                  (messages ?? []).map((msg, i) => (
                    <li key={`${field}-${i}`}>
                      <strong>{field}:</strong> {msg}
                    </li>
                  )),
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      <fieldset disabled={isPending} className="space-y-4 disabled:opacity-75">
        {children}
      </fieldset>

      <div className="flex items-center justify-end border-t border-slate-100 pt-3">
        <Button type="submit" variant={submitVariant} size="md" loading={isPending}>
          {isPending ? "Memproses ke Server..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
