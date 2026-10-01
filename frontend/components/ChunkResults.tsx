"use client";

import { Copy, FileStack } from "lucide-react";
import type { ChunkResponse } from "@/types/api";
import { useToast } from "./Toast";

export default function ChunkResults({ result }: { result: ChunkResponse | null }) {
  const { showToast } = useToast();

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("success", `${label} copied to clipboard.`);
    } catch {
      showToast("error", "Couldn't copy — your browser blocked clipboard access.");
    }
  }

  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded border border-dashed border-[#2A313A] px-4 py-12 text-center">
        <FileStack size={22} className="text-[#4A525E]" />
        <p className="text-sm text-[#8A93A0]">
          Chunks will appear here once you split some text.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2A313A] pb-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-[#8A93A0]">
          <span>
            total <span className="text-[#E7E9EC]">{result.total_chunks}</span>
          </span>
          <span>
            chunk_size <span className="text-[#E7E9EC]">{result.chunk_size}</span>
          </span>
          <span>
            chunk_overlap <span className="text-[#E7E9EC]">{result.chunk_overlap}</span>
          </span>
        </div>
        <button
          onClick={() => copy(result.chunks.join("\n\n"), "All chunks")}
          className="inline-flex items-center gap-1.5 rounded border border-[#2A313A] px-2.5 py-1.5 text-xs font-medium text-[#E7E9EC] transition-colors hover:border-[#E3A857] hover:text-[#E3A857]"
        >
          <Copy size={13} />
          Copy all
        </button>
      </div>

      <div className="max-h-[520px] space-y-2.5 overflow-y-auto pr-1">
        {result.chunks.map((chunk, i) => (
          <div
            key={i}
            className="border border-[#2A313A] bg-[#161A1F] p-3.5"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[11px] text-[#E3A857]">
                chunk {i + 1} of {result.total_chunks}
              </span>
              <button
                onClick={() => copy(chunk, `Chunk ${i + 1}`)}
                aria-label={`Copy chunk ${i + 1}`}
                className="text-[#8A93A0] transition-colors hover:text-[#E3A857]"
              >
                <Copy size={13} />
              </button>
            </div>
            <p className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-[#C9CDD3]">
              {chunk}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
