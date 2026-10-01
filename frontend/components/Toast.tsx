"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, XCircle, X } from "lucide-react";

type ToastKind = "success" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  showToast: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  }, []);

  const dismiss = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 sm:bottom-6 sm:right-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`flex items-start gap-2.5 rounded-md border px-3.5 py-3 shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2 duration-200 ${
              t.kind === "success"
                ? "border-[#2E4A3E] bg-[#132019]/95 text-[#B8E6C9]"
                : "border-[#4A2E33] bg-[#201315]/95 text-[#F2C1C9]"
            }`}
            style={{ maxWidth: "22rem" }}
          >
            {t.kind === "success" ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            ) : (
              <XCircle size={16} className="mt-0.5 shrink-0" />
            )}
            <p className="text-sm leading-snug">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="ml-auto shrink-0 opacity-60 hover:opacity-100"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
