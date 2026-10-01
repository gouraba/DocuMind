"use client";

import { useMemo, useState } from "react";
import { Scissors, RotateCcw } from "lucide-react";
import { chunkText } from "@/lib/api";
import type { ChunkResponse } from "@/types/api";
import ChunkResults from "./ChunkResults";
import ErrorMessage from "./ErrorMessage";
import { ChunkSkeleton, InlineSpinner } from "./Loading";
import { useToast } from "./Toast";

const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_CHUNK_OVERLAP = 10;

export default function Chunker() {
  const [text, setText] = useState("");
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [chunkOverlap, setChunkOverlap] = useState(DEFAULT_CHUNK_OVERLAP);
  const [result, setResult] = useState<ChunkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { showToast } = useToast();

  const counts = useMemo(() => {
    const chars = text.length;
    const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
    return { chars, words };
  }, [text]);

  const validationError = useMemo(() => {
    if (text.trim() === "") return null; // don't nag before they've typed anything
    if (chunkSize <= 0) return "Chunk size must be greater than 0.";
    if (chunkOverlap < 0) return "Chunk overlap can't be negative.";
    if (chunkOverlap >= chunkSize) return "Chunk overlap must be smaller than chunk size.";
    return null;
  }, [text, chunkSize, chunkOverlap]);

  const canSubmit = text.trim() !== "" && !validationError && !loading;

  async function handleSubmit() {
    if (text.trim() === "") {
      setError("Enter some text to split first.");
      return;
    }
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await chunkText({
        text,
        chunk_size: chunkSize,
        chunk_overlap: chunkOverlap,
      });
      setResult(res);
      showToast("success", `Split into ${res.total_chunks} chunks.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setText("");
    setResult(null);
    setError(null);
  }

  return (
    <section className="flex flex-col gap-4 border border-[#2A313A] bg-[#12151A] p-5 sm:p-6">
      <div className="flex items-center gap-2 border-b border-[#2A313A] pb-4">
        <Scissors size={16} className="text-[#E3A857]" />
        <h2 className="text-[15px] font-semibold text-[#E7E9EC]">Text Chunker</h2>
      </div>

      <div>
        <label htmlFor="chunker-text" className="mb-1.5 block text-[13px] font-medium text-[#C9CDD3]">
          Text to split
        </label>
        <textarea
          id="chunker-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste or type the text you want chunked…"
          rows={10}
          className="w-full resize-y rounded-md border border-[#2A313A] bg-[#0D1013] px-3.5 py-2.5 text-sm text-[#E7E9EC] placeholder:text-[#4A525E] focus:border-[#E3A857] focus:outline-none focus:ring-1 focus:ring-[#E3A857]"
        />
        <div className="mt-1.5 flex justify-end gap-3 font-mono text-[11px] text-[#8A93A0]">
          <span>{counts.words} words</span>
          <span>{counts.chars} characters</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="chunk-size" className="mb-1.5 block text-[13px] font-medium text-[#C9CDD3]">
            Chunk size
          </label>
          <input
            id="chunk-size"
            type="number"
            min={1}
            value={chunkSize}
            onChange={(e) => setChunkSize(Number(e.target.value))}
            className="w-full rounded-md border border-[#2A313A] bg-[#0D1013] px-3.5 py-2 text-sm text-[#E7E9EC] focus:border-[#E3A857] focus:outline-none focus:ring-1 focus:ring-[#E3A857]"
          />
        </div>
        <div>
          <label htmlFor="chunk-overlap" className="mb-1.5 block text-[13px] font-medium text-[#C9CDD3]">
            Chunk overlap
          </label>
          <input
            id="chunk-overlap"
            type="number"
            min={0}
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(Number(e.target.value))}
            className="w-full rounded-md border border-[#2A313A] bg-[#0D1013] px-3.5 py-2 text-sm text-[#E7E9EC] focus:border-[#E3A857] focus:outline-none focus:ring-1 focus:ring-[#E3A857]"
          />
        </div>
      </div>

      {validationError && text.trim() !== "" && (
        <p className="text-xs text-[#F2C1C9]">{validationError}</p>
      )}

      <div className="flex items-center gap-2.5">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md bg-[#E3A857] px-4 py-2 text-sm font-medium text-[#0D1013] transition-colors hover:bg-[#EFC178] disabled:cursor-not-allowed disabled:bg-[#2A313A] disabled:text-[#8A93A0]"
        >
          {loading ? <InlineSpinner label="Splitting…" /> : "Split Text"}
        </button>
        <button
          onClick={handleClear}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-[#2A313A] px-3.5 py-2 text-sm font-medium text-[#C9CDD3] transition-colors hover:border-[#8A93A0] disabled:opacity-50"
        >
          <RotateCcw size={13} />
          Clear
        </button>
      </div>

      {error && <ErrorMessage message={error} />}

      <div className="pt-1">
        {loading && !result ? <ChunkSkeleton /> : <ChunkResults result={result} />}
      </div>
    </section>
  );
}
