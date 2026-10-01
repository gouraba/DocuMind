"use client";

import { useEffect, useState } from "react";
import { checkHealth } from "@/lib/api";

type Status = "checking" | "online" | "offline";

const POLL_INTERVAL_MS = 15000;

export default function BackendStatus() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await checkHealth();
        if (!cancelled) setStatus(res.status === "ok" ? "online" : "offline");
      } catch {
        if (!cancelled) setStatus("offline");
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const config: Record<Status, { label: string; dot: string; text: string }> = {
    checking: { label: "Checking backend", dot: "bg-[#8A93A0]", text: "text-[#8A93A0]" },
    online: { label: "Backend online", dot: "bg-[#6FCF97]", text: "text-[#B8E6C9]" },
    offline: { label: "Backend offline", dot: "bg-[#E5697A]", text: "text-[#F2C1C9]" },
  };

  const c = config[status];

  return (
    <div
      className={`flex items-center gap-2 rounded-full border border-[#2A313A] bg-[#161A1F] px-3 py-1.5 text-xs font-medium ${c.text}`}
      role="status"
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot} ${status === "checking" ? "animate-pulse" : ""}`} />
      {c.label}
    </div>
  );
}
