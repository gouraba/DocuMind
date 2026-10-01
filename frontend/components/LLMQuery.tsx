"use client";

import { useState } from "react";
import { Sparkles, RotateCcw, Copy } from "lucide-react";
import { queryLLM } from "@/lib/api";
import type { LLMQueryResponse } from "@/types/api";
import ErrorMessage from "./ErrorMessage";
import { InlineSpinner } from "./Loading";
import { useToast } from "./Toast";

const DEFAULT_MODEL = "llama3-8b-8192";

const MODEL_OPTIONS = [
  "llama3-8b-8192",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
  "gemma-7b-it",
  "custom",
];

export default function LLMQuery() {
  const [query, setQuery] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [customModel, setCustomModel] = useState("");
  const [result, setResult] = useState<LLMQueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { showToast } = useToast();

  const effectiveModel = model === "custom" ? customModel.trim() : model;
  const canSubmit = query.trim() !== "" && effectiveModel !== "" && !loading;

  async function handleSubmit() {
    if (query.trim() === "") {
      setError("Enter a question first.");
      return;
    }
    if (effectiveModel === "") {
      setError("Enter a model name.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await queryLLM({ query, model: effectiveModel });
      setResult(res);
      showToast("success", "Answer received.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setQuery("");
    setResult(null);
    setError(null);
  }

  async function copyAnswer() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.answer);
      showToast("success", "Answer copied to clipboard.");
    } catch {
      showToast("error", "Couldn't copy — your browser blocked clipboard access.");
    }
  }

  return (
    <section className="flex flex-col gap-4 border border-[#2A313A] bg-[#12151A] p-5 sm:p-6">
      <div className="flex items-center gap-2 border-b border-[#2A313A] pb-4">
        <Sparkles size={16} className="text-[#5FB8A8]" />
        <h2 className="text-[15px] font-semibold text-[#E7E9EC]">AI Query</h2>
      </div>

      <div>
        <label htmlFor="llm-query" className="mb-1.5 block text-[13px] font-medium text-[#C9CDD3]">
          Question
        </label>
        <textarea
          id="llm-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask a question…"
          rows={4}
          className="w-full resize-y rounded-md border border-[#2A313A] bg-[#0D1013] px-3.5 py-2.5 text-sm text-[#E7E9EC] placeholder:text-[#4A525E] focus:border-[#5FB8A8] focus:outline-none focus:ring-1 focus:ring-[#5FB8A8]"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="model-select" className="mb-1.5 block text-[13px] font-medium text-[#C9CDD3]">
            Model
          </label>
          <select
            id="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border border-[#2A313A] bg-[#0D1013] px-3.5 py-2 text-sm text-[#E7E9EC] focus:border-[#5FB8A8] focus:outline-none focus:ring-1 focus:ring-[#5FB8A8]"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m === "custom" ? "Custom…" : m}
              </option>
            ))}
          </select>
        </div>
        {model === "custom" && (
          <div>
            <label htmlFor="custom-model" className="mb-1.5 block text-[13px] font-medium text-[#C9CDD3]">
              Model name
            </label>
            <input
              id="custom-model"
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. llama-3.3-70b-versatile"
              className="w-full rounded-md border border-[#2A313A] bg-[#0D1013] px-3.5 py-2 text-sm text-[#E7E9EC] placeholder:text-[#4A525E] focus:border-[#5FB8A8] focus:outline-none focus:ring-1 focus:ring-[#5FB8A8]"
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md bg-[#5FB8A8] px-4 py-2 text-sm font-medium text-[#0D1013] transition-colors hover:bg-[#7FCCBE] disabled:cursor-not-allowed disabled:bg-[#2A313A] disabled:text-[#8A93A0]"
        >
          {loading ? <InlineSpinner label="Asking…" /> : "Ask AI"}
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

      {result && (
        <div className="border border-[#2A313A] bg-[#161A1F] p-3.5">
          <div className="mb-2.5 flex items-center justify-between border-b border-[#2A313A] pb-2.5 font-mono text-[11px] text-[#8A93A0]">
            <span>
              model <span className="text-[#5FB8A8]">{result.model}</span>
            </span>
            <button
              onClick={copyAnswer}
              className="inline-flex items-center gap-1.5 text-[#8A93A0] transition-colors hover:text-[#5FB8A8]"
            >
              <Copy size={13} />
              Copy answer
            </button>
          </div>
          <p className="mb-2.5 text-[13px] text-[#8A93A0]">
            <span className="text-[#C9CDD3]">Q:</span> {result.query}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#E7E9EC]">
            {result.answer}
          </p>
        </div>
      )}

      {!result && !loading && (
        <div className="flex flex-col items-center justify-center gap-2 rounded border border-dashed border-[#2A313A] px-4 py-10 text-center">
          <Sparkles size={20} className="text-[#4A525E]" />
          <p className="text-sm text-[#8A93A0]">
            Ask a question to get an AI-generated answer.
          </p>
        </div>
      )}
    </section>
  );
}
