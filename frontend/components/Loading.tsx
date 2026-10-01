import { Loader2 } from "lucide-react";

export function InlineSpinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-[#8A93A0]">
      <Loader2 size={14} className="animate-spin" />
      {label}
    </span>
  );
}

/** Skeleton rows shown in the chunk-results list while a request is in flight. */
export function ChunkSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded border border-[#2A313A] bg-[#161A1F] p-3.5"
        >
          <div className="mb-2.5 h-3 w-16 rounded bg-[#2A313A]" />
          <div className="h-3 w-full rounded bg-[#2A313A]" />
          <div className="mt-1.5 h-3 w-4/5 rounded bg-[#2A313A]" />
        </div>
      ))}
    </div>
  );
}
