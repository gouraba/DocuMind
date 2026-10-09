"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import {
  createChat as createChatAPI,
  listChats,
  saveMessage,
  listMessages,
} from "@/lib/api";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Plus,
  MessageSquare,
  FileText,
  Paperclip,
  ArrowUp,
  Square,
  Loader2,
  Trash2,
  X,
  Upload,
  File as FileIcon,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Eye,
  EyeOff,
  RotateCw,
} from "lucide-react";

// ==========================================================
// TYPES
// ==========================================================

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Chat = {
  id: string;
  title: string;
  messages: Message[];
};

type View = "chat" | "documents" | "settings";

type DocStatus = "uploading" | "processing" | "ready" | "error";

// What the backend worker is doing (documents.stage).
type DocStage = "queued" | "extracting" | "indexing" | "done" | "failed";

type DocumentItem = {
  id: string; // backend document_id (a temporary id until the upload is accepted)
  key: string; // stable React key: survives the temporary-id -> document_id swap
  chat_id: string;
  name: string;
  size: number;
  status: DocStatus;
  stage?: DocStage;
  progress?: number; // uploading: % of bytes sent | processing: backend % (undefined = not started)
  processedChunks?: number;
  totalChunks?: number;
  error?: string;
  uploadedAt: number;
  pending?: boolean; // every byte is sent, the server has not answered yet
  remote?: boolean; // this row exists in the backend database
  file?: File; // kept in memory (this tab only) so a failed file can be retried
  acceptedSeq?: number; // list-request counter when the server accepted (202) the upload
  justReady?: boolean; // turned ready while we were watching -> short highlight
};

// POST /documents/upload answers 202 { status: "processing", document_id, ... }
type UploadResponse = {
  status?: string;
  document_id?: string;
  filename?: string;
  file_size?: number;
  chat_id?: string;
  detail?: unknown;
};

// GET /documents?chat_id=... -> one row per document of that chat
type BackendDocument = {
  id: string;
  chat_id?: string;
  name?: string;
  filename?: string;
  size?: number;
  file_size?: number;
  status?: string;
  stage?: string | null;
  progress?: number;
  total_chunks?: number;
  processed_chunks?: number;
  error?: string | null;
  uploaded_at?: string;
};

type Toast = {
  type: "uploading" | "success" | "error";
  message: string;
};

// ==========================================================
// CONFIG
// ==========================================================
// If your backend uses different routes, this is the only
// place you should need to change.

const API_URL =  process.env.NEXT_PUBLIC_API_URL||"http://localhost:8000";

const ENDPOINTS = {
  ask: `${API_URL}/ask/stream`,
  documentsList: (chatId: string) =>
    `${API_URL}/documents?chat_id=${encodeURIComponent(chatId)}`,
  documentUpload: `${API_URL}/documents/upload`, // multipart/form-data, field "file" + "chat_id"
  documentDelete: (id: string, chatId: string) =>
    `${API_URL}/documents/${id}?chat_id=${encodeURIComponent(chatId)}`,
  chatDelete: (id: string) => `${API_URL}/chats/${id}`,
  chatsClear: `${API_URL}/chats`,
};

const ACTIVE_CHAT_KEY = "documind-active-chat";

const MAX_FILE_SIZE_MB = 25;
const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"]; // what the backend accepts
const ACCEPTED_FILE_TYPES = ACCEPTED_EXTENSIONS.join(",");

// Shown top-right in the header: if you don't see it, an older build is live.
const BUILD_TAG = "UI v4";

// Free hosting sleeps when idle. If the backend was last seen awake longer
// ago than this, uploads ping /health first and wait for it to wake up.
const SERVER_STALE_MS = 4 * 60 * 1000;

// While a document is still processing, ask the backend for its real state this often.
const POLL_MS = 2000;

// ==========================================================
// HELPERS
// ==========================================================

async function createChat(): Promise<Chat> {
  const data = await createChatAPI({ chat_id: null });

  return {
    id: data.chat_id,
    title: data.title || "New chat",
    messages: [],
  };
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function titleFrom(question: string) {
  return question.length > 35 ? question.slice(0, 35) + "..." : question;
}

// Parses one Server-Sent-Event block ("event: x\ndata: y").
function parseSSE(raw: string): { event: string; data: string } {
  let event = "message";
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }

  return { event, data: data.join("\n") };
}

// Backend may send JSON-encoded strings, JSON objects or plain text.
function decodeChunk(data: string): string {
  try {
    const value = JSON.parse(data);
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      return String(
        value.content ??
          value.text ??
          value.delta ??
          value.detail ??
          value.message ??
          ""
      );
    }
    return String(value ?? "");
  } catch {
    return data;
  }
}

// FastAPI sends 422 errors as a list of { loc, msg } objects.
function formatDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const text = detail
      .map((d) =>
        d && typeof d === "object" && "msg" in d
          ? String((d as { msg: unknown }).msg)
          : String(d)
      )
      .join("; ");
    return text || fallback;
  }
  return fallback;
}

// One plain sentence for a failed backend call (shown on the card / in a toast).
function statusMessage(status: number, detail: string): string {
  if (status === 401) return "Your session expired. Please sign in again.";
  if (status === 502 || status === 503 || status === 504) {
    return "The server is waking up. Please try again in a moment.";
  }
  if (detail) return detail;
  if (status === 413) return `File is larger than ${MAX_FILE_SIZE_MB}MB.`;
  return status >= 500
    ? "Server error. Please try again."
    : `Request failed (${status})`;
}

async function readError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null);
  return new Error(statusMessage(res.status, formatDetail(body?.detail, "")));
}

const isAbort = (e: unknown) =>
  (e as { name?: string } | null)?.name === "AbortError";

// Last time the backend answered. Free hosting sleeps when idle.
let lastServerOk = 0;

// Every backend route needs the user's Supabase ACCESS token (never a service
// key). getSession() also refreshes an expired token for us.
async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You are signed out. Please sign in again.");
  return token;
}

async function apiFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${await getToken()}`,
    },
  });
  if (res.ok) lastServerOk = Date.now();
  return res;
}

// Pings /health until the backend answers (a sleeping Render service replies
// 502 without CORS headers, which fetch reports as a network error).
async function waitForServer(
  maxAttempts = 24,
  isCancelled: () => boolean = () => false
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isCancelled()) return false;
    try {
      const res = await fetch(`${API_URL}/health`, {
        cache: "no-store",
        signal:
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(8000)
            : undefined,
      });
      if (res.ok) {
        lastServerOk = Date.now();
        return true;
      }
    } catch {
      // still asleep / starting
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return false;
}

// fetch() can't report upload progress, so uploads use XMLHttpRequest.
// Resolves when the server ANSWERS: 202 means "accepted for processing", not ready.
function uploadWithProgress(
  file: File,
  chatId: string,
  token: string,
  on: { progress: (percent: number) => void; sent: () => void },
  signal: AbortSignal
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new DOMException("Upload cancelled", "AbortError");
    if (signal.aborted) {
      reject(cancelled());
      return;
    }

    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    form.append("chat_id", chatId);

    xhr.open("POST", ENDPOINTS.documentUpload);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const done = () => signal.removeEventListener("abort", abort);

    xhr.onabort = () => {
      done();
      reject(cancelled());
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        on.progress(Math.round((e.loaded / e.total) * 100));
      }
    };
    // "every byte sent" is the real signal: from here the SERVER is working
    xhr.upload.onload = () => on.sent();

    xhr.onload = () => {
      done();
      let body: UploadResponse | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON (e.g. a proxy error page): the status code decides
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        lastServerOk = Date.now();
        resolve(body ?? {});
      } else {
        reject(
          new Error(statusMessage(xhr.status, formatDetail(body?.detail, "")))
        );
      }
    };

    xhr.onerror = () => {
      done();
      reject(
        new Error("Could not reach the server. Check your connection and retry.")
      );
    };

    xhr.send(form);
  });
}

// A row from GET /documents. Anything the backend has not marked ready/error
// is still being worked on: "ready" is never guessed.
function fromBackend(row: BackendDocument, chatId: string): DocumentItem {
  const status: DocStatus =
    row.status === "ready" || row.status === "error" ? row.status : "processing";

  return {
    id: row.id,
    key: row.id,
    chat_id: row.chat_id ?? chatId,
    name: row.name ?? row.filename ?? "Untitled",
    size: row.size ?? row.file_size ?? 0,
    status,
    stage: (row.stage ?? undefined) as DocStage | undefined,
    progress: row.progress ?? (status === "ready" ? 100 : 0),
    processedChunks: row.processed_chunks,
    totalChunks: row.total_chunks,
    error: row.error ?? undefined,
    uploadedAt: Date.parse(row.uploaded_at ?? "") || Date.now(),
    remote: true,
  };
}

// Reuse the old object when nothing about a row changed, so polling an
// unchanged list causes no re-render at all.
function mergeStable(prev: DocumentItem[], next: DocumentItem[]): DocumentItem[] {
  const old = new Map(prev.map((d) => [d.id, d] as const));
  const merged = next.map((d) => {
    const o = old.get(d.id);
    return o &&
      o.status === d.status &&
      o.stage === d.stage &&
      o.progress === d.progress &&
      o.processedChunks === d.processedChunks &&
      o.totalChunks === d.totalChunks &&
      o.error === d.error &&
      o.name === d.name &&
      o.size === d.size
      ? o
      : d;
  });
  return merged.length === prev.length && merged.every((d, i) => d === prev[i])
    ? prev
    : merged;
}

// The one place that turns a document into the words (and bar) the user sees.
function describeDoc(d: DocumentItem): {
  label: string;
  percent: number | null; // null = nothing measurable yet -> sliding bar
  tone: "busy" | "ok" | "bad";
} {
  if (d.status === "uploading") {
    return d.progress === undefined
      ? { label: "Waiting to upload...", percent: null, tone: "busy" }
      : {
          label: `Uploading... ${d.progress}%`,
          percent: d.progress,
          tone: "busy",
        };
  }

  if (d.status === "processing") {
    if (d.pending) {
      return { label: "Uploaded — processing...", percent: null, tone: "busy" };
    }
    if (d.stage === "extracting") {
      return { label: "Reading document...", percent: null, tone: "busy" };
    }
    if (d.stage === "indexing") {
      const total = d.totalChunks ?? 0;
      return total > 0
        ? {
            label: `Indexing... ${d.processedChunks ?? 0} / ${total} chunks ${d.progress ?? 0}%`,
            percent: d.progress ?? 0,
            tone: "busy",
          }
        : { label: "Indexing...", percent: null, tone: "busy" };
    }
    return {
      label: d.stage === "queued" ? "Queued..." : "Processing...",
      percent: null,
      tone: "busy",
    };
  }

  if (d.status === "ready") return { label: "✓ Ready", percent: null, tone: "ok" };

  return {
    label: `✕ Failed${d.error ? `: ${d.error}` : ""}`,
    percent: null,
    tone: "bad",
  };
}

const fileKey = (chatId: string, f: File) =>
  `${chatId}|${f.name}|${f.size}|${f.lastModified}`;

// ==========================================================
// STYLES (plain CSS injected by this file: no Tailwind plugin,
// no tailwind.config / globals.css change needed)
// ==========================================================

const DOCUMIND_CSS = `
@keyframes dm-pop { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes dm-ring { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,.55); } 100% { box-shadow: 0 0 0 14px rgba(74,222,128,0); } }
@keyframes dm-shake { 0%, 100% { transform: translateX(0); } 20%, 60% { transform: translateX(-5px); } 40%, 80% { transform: translateX(5px); } }
@keyframes dm-slide { from { left: -40%; } to { left: 100%; } }

.dm-pop { animation: dm-pop .3s cubic-bezier(.2,.8,.2,1) both; }
.dm-ring { animation: dm-ring 1.1s ease-out 3; }
.dm-shake { animation: dm-shake .45s ease-in-out; }
.dm-indeterminate { position: absolute; top: 0; bottom: 0; left: 0; width: 40%; border-radius: 9999px; background: linear-gradient(90deg, #4F8CFF, #8B5CF6); animation: dm-slide 1.1s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .dm-pop, .dm-ring, .dm-shake, .dm-indeterminate { animation: none; }
  .dm-indeterminate { width: 100%; opacity: .5; }
}

.dm-md > :first-child { margin-top: 0; }
.dm-md > :last-child { margin-bottom: 0; }
.dm-md p { margin: .6rem 0; }
.dm-md ul, .dm-md ol { margin: .6rem 0; padding-left: 1.4rem; }
.dm-md ul { list-style: disc; }
.dm-md ol { list-style: decimal; }
.dm-md li { margin: .25rem 0; }
.dm-md h1, .dm-md h2, .dm-md h3, .dm-md h4 { font-weight: 600; margin: 1.1rem 0 .5rem; line-height: 1.35; }
.dm-md h1 { font-size: 1.35rem; }
.dm-md h2 { font-size: 1.2rem; }
.dm-md h3 { font-size: 1.05rem; }
.dm-md strong { font-weight: 600; color: #fff; }
.dm-md a { color: #7C9CFF; text-decoration: underline; }
.dm-md code { background: #182238; border-radius: .35rem; padding: .1rem .35rem; font-size: .85em; }
.dm-md pre { background: #0B1020; border: 1px solid #1F2A44; border-radius: .75rem; padding: .9rem 1rem; overflow-x: auto; margin: .8rem 0; }
.dm-md pre code { background: transparent; padding: 0; }
.dm-md blockquote { border-left: 3px solid #2A3958; margin: .8rem 0; padding-left: .9rem; color: #9AA8C2; }
.dm-md table { border-collapse: collapse; margin: .8rem 0; display: block; overflow-x: auto; }
.dm-md th, .dm-md td { border: 1px solid #2A3958; padding: .4rem .7rem; text-align: left; }
.dm-md th { background: #111827; font-weight: 600; }
.dm-md hr { border: 0; border-top: 1px solid #1F2A44; margin: 1rem 0; }
`;

// ==========================================================
// SMALL COMPONENTS
// ==========================================================

const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: Message;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser ? "bg-[#182238]" : "bg-transparent"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-7">
            {message.content}
          </p>
        ) : (
          <div className="dm-md max-w-none text-sm leading-7">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
});

const SidebarChatItem = memo(function SidebarChatItem({
  chat,
  isActive,
  onOpen,
  onDelete,
}: {
  chat: Chat;
  isActive: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className={`group flex items-center rounded-lg transition ${
        isActive
          ? "bg-[#182238] text-white"
          : "text-[#9AA8C2] hover:bg-[#151E33] hover:text-[#E6ECF8]"
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(chat.id)}
        className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm"
      >
        {chat.title || "New chat"}
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(chat.id);
        }}
        title="Delete chat"
        className="mr-1 rounded-md p-2 text-[#71809D] opacity-0 transition hover:bg-red-500/10 hover:text-[#FB7185] focus:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
});

const TONE_TEXT = {
  busy: "text-[#8F9BB3]",
  ok: "text-green-400",
  bad: "text-red-400",
} as const;

// A real percentage, or a sliding bar while there is nothing to measure yet.
function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="relative mt-1 h-1 w-full min-w-[140px] overflow-hidden rounded-full bg-[#1F2A44]"
    >
      {percent === null ? (
        <div className="dm-indeterminate" />
      ) : (
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#4F8CFF] to-[#8B5CF6] transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="Upload this file again"
      className="flex shrink-0 items-center gap-1 rounded-md border border-red-400/40 px-2 py-1 text-[11px] text-red-200 transition hover:bg-white/10 hover:text-white"
    >
      <RotateCw size={12} />
      Retry
    </button>
  );
}

// The attachment card above the message box (current chat only).
const DocChip = memo(function DocChip({
  doc,
  used,
  onToggle,
  onDelete,
  onRetry,
}: {
  doc: DocumentItem;
  used: boolean;
  onToggle: (doc: DocumentItem) => void;
  onDelete: (id: string) => void;
  onRetry: (doc: DocumentItem) => void;
}) {
  const info = describeDoc(doc);
  const busy = doc.status === "uploading" || doc.status === "processing";
  const ready = doc.status === "ready";

  return (
    <div
      onClick={() => onToggle(doc)}
      title={
        ready
          ? used
            ? "Used for answers — click to exclude"
            : "Excluded — click to include"
          : undefined
      }
      className={`dm-pop flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
        ready ? "cursor-pointer" : "cursor-default"
      } ${
        doc.status === "error"
          ? "dm-shake border-red-500/40 bg-[#2A1518] text-red-200"
          : ready && used
          ? "border-[#7C9CFF] bg-[#24345A] text-white"
          : "border-[#2A3958] bg-[#182238] text-[#9AA8C2]"
      }${doc.justReady ? " dm-ring" : ""}`}
    >
      {busy ? (
        <Loader2 size={16} className="shrink-0 animate-spin text-[#7C9CFF]" />
      ) : doc.status === "error" ? (
        <AlertCircle size={16} className="shrink-0 text-red-400" />
      ) : (
        <FileText size={16} className="shrink-0 text-[#9AA8C2]" />
      )}

      <div className="flex min-w-0 flex-col">
        <span className="max-w-[260px] truncate">{doc.name}</span>
        <span
          className={`max-w-[300px] break-words text-[11px] ${TONE_TEXT[info.tone]}`}
        >
          {info.label}
          {ready && !used ? " · excluded" : ""}
        </span>
        {busy && <ProgressBar percent={info.percent} />}
      </div>

      {doc.status === "error" && doc.file && (
        <RetryButton onClick={() => onRetry(doc)} />
      )}

      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(doc.id);
        }}
        className="ml-1 text-[#71809D] transition hover:text-[#FB7185] disabled:opacity-30"
        title="Remove document"
      >
        ×
      </button>
    </div>
  );
});

// The same document in the Documents view.
const DocumentRow = memo(function DocumentRow({
  doc,
  onDelete,
  onRetry,
}: {
  doc: DocumentItem;
  onDelete: (id: string) => void;
  onRetry: (doc: DocumentItem) => void;
}) {
  const info = describeDoc(doc);
  const busy = doc.status === "uploading" || doc.status === "processing";

  return (
    <div
      className={`dm-pop flex items-center gap-3 rounded-xl border bg-[#111827] px-4 py-3 ${
        doc.status === "error" ? "dm-shake border-red-500/40" : "border-[#2A3958]"
      }${doc.justReady ? " dm-ring" : ""}`}
    >
      <FileIcon size={18} className="shrink-0 text-gray-400" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{doc.name}</p>

        <div
          className={`mt-0.5 flex items-center gap-1.5 text-xs ${TONE_TEXT[info.tone]}`}
        >
          {busy && <Loader2 size={13} className="shrink-0 animate-spin" />}
          <span className="min-w-0 break-words">{info.label}</span>
          <span className="text-[#52627F]">&middot;</span>
          <span className="shrink-0 text-[#71809D]">{formatBytes(doc.size)}</span>
        </div>

        {busy && <ProgressBar percent={info.percent} />}
      </div>

      {doc.status === "error" && doc.file && (
        <RetryButton onClick={() => onRetry(doc)} />
      )}

      <button
        type="button"
        onClick={() => onDelete(doc.id)}
        title="Delete document"
        disabled={busy}
        className="rounded-md p-2 text-[#71809D] hover:bg-[#263653] hover:text-white disabled:opacity-30"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
});

// ==========================================================
// MAIN COMPONENT
// ==========================================================

export default function Home() {
  // ---------------- auth state ----------------
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // ---------------- app state ----------------
  const [view, setView] = useState<View>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showRecentChats, setShowRecentChats] = useState(true);

  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);

  // Documents belong to ONE chat and the backend database is the source of truth:
  //  - serverDocs = what GET /documents last said about the ACTIVE chat
  //  - localDocs  = cards for uploads started in this tab (bytes still being
  //                 sent, failed uploads, the file kept for Retry)
  const [serverDocs, setServerDocs] = useState<DocumentItem[]>([]);
  const [localDocs, setLocalDocs] = useState<DocumentItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // By default EVERY ready document in the chat is used for RAG.
  // Clicking a chip excludes / re-includes it.
  const [excludedDocIds, setExcludedDocIds] = useState<string[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  // Free hosting sleeps when idle: the first requests get a 502 until it wakes up.
  const [serverReady, setServerReady] = useState(false);
  const [waking, setWaking] = useState(false);

  // ---------------- refs ----------------
  const abortControllerRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const loadedChatIdsRef = useRef<Set<string>>(new Set());
  const activeChatIdRef = useRef<string | null>(null);
  const creatingChatRef = useRef<Promise<string> | null>(null);
  const chatOpenRequestRef = useRef(0);
  const documentsRef = useRef<DocumentItem[]>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // documents: stale-answer protection, polling and upload bookkeeping
  const fetchSeqRef = useRef(0); // bumped by every list request and every chat change
  const listAbortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<Map<string, DocStatus>>(new Map()); // last status seen per document
  const deletingRef = useRef<Set<string>>(new Set());
  const uploadsRef = useRef<Map<string, { ctrl: AbortController; chatId: string }>>(
    new Map()
  );
  const inFlightRef = useRef<Set<string>>(new Set()); // the same file twice at once
  const pollFailuresRef = useRef(0);

  const userId = session?.user?.id ?? null;

  // What this chat shows: the backend's rows for the ACTIVE chat plus this tab's
  // own cards. Everything is filtered by chat_id, so a document can never show
  // up in another chat, not even for a single render while switching.
  const documents = useMemo(() => {
    if (!activeChatId) return [];
    const mine = localDocs.filter((d) => d.chat_id === activeChatId);
    const local = new Map(mine.map((d) => [d.id, d] as const));
    const server = serverDocs
      .filter((d) => d.chat_id === activeChatId)
      .map((d) => {
        const l = local.get(d.id);
        // same card as before: keep its React key (no flicker) and its file (Retry)
        return l ? { ...d, key: l.key, file: l.file } : d;
      });
    const listed = new Set(server.map((d) => d.id));
    return [...mine.filter((d) => !listed.has(d.id)), ...server];
  }, [serverDocs, localDocs, activeChatId]);

  // Poll only while the BACKEND is working on something (bytes still on their
  // way do not count: the server does not know that file yet).
  const hasProcessing = useMemo(
    () => documents.some((d) => d.status === "processing" && !d.pending),
    [documents]
  );
  const isUploading = useMemo(
    () => documents.some((d) => d.status === "uploading" || d.pending),
    [documents]
  );

  // --------------------------------------------------
  // SMALL UTILITIES
  // --------------------------------------------------

  const notify = useCallback(
    (type: Toast["type"], text: string, hideAfterMs?: number) => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast({ type, message: text });
      if (hideAfterMs) {
        toastTimerRef.current = setTimeout(() => setToast(null), hideAfterMs);
      }
    },
    []
  );

  const selectChat = useCallback((id: string | null) => {
    activeChatIdRef.current = id;
    setActiveChatId(id);
    if (id) sessionStorage.setItem(ACTIVE_CHAT_KEY, id);
    else sessionStorage.removeItem(ACTIVE_CHAT_KEY);
  }, []);

  // Stop uploads that are still sending bytes (all of them, or one chat's).
  const abortUploads = useCallback((chatId?: string) => {
    uploadsRef.current.forEach((upload, id) => {
      if (chatId && upload.chatId !== chatId) return;
      upload.ctrl.abort();
      uploadsRef.current.delete(id);
    });
  }, []);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  // --------------------------------------------------
  // AUTH SESSION
  // --------------------------------------------------

  useEffect(() => {
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) console.error("Failed to get session:", error.message);
      setSession(data.session);
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setAuthLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      console.error("Google login failed:", error.message);
      setAuthError(error.message);
    }
  };

  const signOut = async () => {
    abortControllerRef.current?.abort();
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error("Logout failed:", error.message);
      return;
    }
    setSession(null);
    setView("chat");
  };

  const handleEmailAuth = async () => {
    setAuthError("");
    if (!authEmail.trim() || !authPassword) {
      setAuthError("Please enter your email and password.");
      return;
    }
    if (authMode === "signup" && authPassword !== authConfirmPassword) {
      setAuthError("Passwords do not match.");
      return;
    }
    setAuthSubmitting(true);
    try {
      if (authMode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
        setAuthError(
          "Account created. Check your email to confirm your account."
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
      }
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Authentication failed."
      );
    } finally {
      setAuthSubmitting(false);
    }
  };

  // --------------------------------------------------
  // LOAD CHATS (from backend) WHEN USER LOGS IN
  // --------------------------------------------------

  // --------------------------------------------------
  // WAKE UP THE BACKEND (free hosting sleeps when idle)
  // --------------------------------------------------

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;

    // after ~2 minutes carry on anyway so real errors become visible
    waitForServer(24, () => cancelled).then(() => {
      if (!cancelled) setServerReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const fetchMessages = useCallback(async (id: string) => {
    const saved = await listMessages(id);
    const msgs: Message[] = saved.map((m) => ({
      id: m.message_id,
      role: m.role as Message["role"],
      content: m.content,
    }));
    setChats((prev) =>
      prev.map((chat) => (chat.id === id ? { ...chat, messages: msgs } : chat))
    );
    loadedChatIdsRef.current.add(id);
  }, []);

  useEffect(() => {
    if (authLoading) return;

    if (!userId) {
      setChats([]);
      selectChat(null);
      setServerDocs([]);
      setLocalDocs([]);
      setExcludedDocIds([]);
      abortUploads();
      setToast(null);
      loadedChatIdsRef.current.clear();
      return;
    }

    if (!serverReady) return;

    let cancelled = false;

    (async () => {
      try {
        const backendChats = await listChats();
        if (cancelled) return;

        const list: Chat[] = backendChats.map((c) => ({
          id: c.chat_id,
          title: c.title || "New chat",
          messages: [],
        }));
        setChats(list);

        const saved = sessionStorage.getItem(ACTIVE_CHAT_KEY);
        if (saved && list.some((c) => c.id === saved)) {
          selectChat(saved);
          setChatLoading(true);
          try {
            await fetchMessages(saved);
          } catch (error) {
            console.error(`Failed to load messages for chat ${saved}:`, error);
          } finally {
            if (!cancelled) setChatLoading(false);
          }
        } else {
          selectChat(null);
        }
      } catch (error) {
        console.error("Failed to load chats:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, authLoading, serverReady, selectChat, fetchMessages, abortUploads]);

  // Cancel any in-flight request on unmount
  useEffect(() => {
    const uploads = uploadsRef.current;
    return () => {
      abortControllerRef.current?.abort();
      listAbortRef.current?.abort();
      uploads.forEach((upload) => upload.ctrl.abort());
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // --------------------------------------------------
  // DERIVED STATE
  // --------------------------------------------------

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? null,
    [chats, activeChatId]
  );

  const messages = useMemo(() => activeChat?.messages ?? [], [activeChat]);
  const lastMessage = messages[messages.length - 1];

  const readyDocuments = useMemo(
    () => documents.filter((d) => d.status === "ready"),
    [documents]
  );

  const ragDocuments = useMemo(
    () => readyDocuments.filter((d) => !excludedDocIds.includes(d.id)),
    [readyDocuments, excludedDocIds]
  );

  // --------------------------------------------------
  // AUTO-SCROLL + TEXTAREA AUTOSIZE
  // --------------------------------------------------

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: loading ? "auto" : "smooth",
      block: "end",
    });
  }, [messages.length, lastMessage?.content.length, loading, activeChatId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [message, view]);

  // --------------------------------------------------
  // CHAT CREATION (lazy: only when really needed)
  // --------------------------------------------------

  const ensureChat = useCallback(async (): Promise<string> => {
    if (activeChatIdRef.current) return activeChatIdRef.current;

    if (!creatingChatRef.current) {
      creatingChatRef.current = (async () => {
        const created = await createChat();
        loadedChatIdsRef.current.add(created.id);
        setChats((prev) => [created, ...prev]);
        selectChat(created.id);
        return created.id;
      })().finally(() => {
        creatingChatRef.current = null;
      });
    }

    return creatingChatRef.current;
  }, [selectChat]);

  const updateChat = useCallback(
    (chatId: string, updater: (chat: Chat) => Chat) => {
      setChats((prev) =>
        prev.map((chat) => (chat.id === chatId ? updater(chat) : chat))
      );
    },
    []
  );

  // --------------------------------------------------
  // DOCUMENTS: the backend database is the source of truth
  // --------------------------------------------------

  // GET /documents?chat_id=<chat>. The answer is only used if it is still the
  // newest request AND that chat is still the open one, so switching chats can
  // never let an old answer in.
  const refreshDocuments = useCallback(
    async (chatId: string, quiet = false) => {
      listAbortRef.current?.abort();
      const ctrl = new AbortController();
      listAbortRef.current = ctrl;
      const seq = ++fetchSeqRef.current;

      if (!quiet) {
        setDocumentsLoading(true);
        setDocumentsError(null);
      }

      try {
        const res = await apiFetch(ENDPOINTS.documentsList(chatId), {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) throw await readError(res);
        const data = await res.json();

        // the chat changed (or a newer request started) while this was loading
        if (seq !== fetchSeqRef.current || chatId !== activeChatIdRef.current) {
          return;
        }

        const rows: BackendDocument[] = Array.isArray(data)
          ? data
          : data.documents ?? [];
        const seen = statusRef.current;
        const becameReady: DocumentItem[] = [];
        const failed: DocumentItem[] = [];

        const incoming = rows
          .filter((row) => !deletingRef.current.has(row.id))
          .map((row) => {
            const doc = fromBackend(row, chatId);
            const before = seen.get(doc.id);
            if (before === "processing" && doc.status === "ready") {
              doc.justReady = true;
              becameReady.push(doc);
            } else if (before === "processing" && doc.status === "error") {
              failed.push(doc);
            }
            seen.set(doc.id, doc.status);
            return doc;
          });

        const byId = new Map(incoming.map((d) => [d.id, d] as const));
        setServerDocs((prev) => mergeStable(prev, incoming));

        // A card started in this tab hands over to the backend's row once the
        // backend lists it as ready (or no longer lists it). Until then it is
        // kept, so the card never blinks and a failed file can be retried.
        setLocalDocs((prev) => {
          const kept = prev.filter((l) => {
            if (
              l.chat_id !== chatId ||
              l.acceptedSeq === undefined ||
              l.acceptedSeq >= seq
            ) {
              return true;
            }
            const row = byId.get(l.id);
            return !!row && row.status !== "ready";
          });
          return kept.length === prev.length ? prev : kept;
        });

        pollFailuresRef.current = 0;
        setDocumentsError(null);

        if (becameReady.length) {
          notify(
            "success",
            becameReady.length === 1
              ? `${becameReady[0].name} — Ready ✓`
              : `${becameReady.length} documents — Ready ✓`,
            3500
          );
        } else if (failed.length) {
          notify(
            "error",
            `${failed[0].name} failed: ${failed[0].error ?? "it could not be processed"}`,
            5000
          );
        }
      } catch (err) {
        if (isAbort(err) || seq !== fetchSeqRef.current) return;
        const text =
          err instanceof Error ? err.message : "Could not reach the server.";
        setDocumentsError(text);
        if (!quiet) notify("error", `Could not load documents: ${text}`, 4000);
        else if (++pollFailuresRef.current === 3) {
          notify("error", "Can't reach the server. Still trying...", 4000);
        }
      } finally {
        if (seq === fetchSeqRef.current) setDocumentsLoading(false);
      }
    },
    [notify]
  );

  // Chat changed (or signed in/out): forget the old chat's rows at once, then
  // load the new chat's rows from the backend. This also restores them after a
  // page reload.
  useEffect(() => {
    fetchSeqRef.current++;
    listAbortRef.current?.abort();
    statusRef.current.clear();
    pollFailuresRef.current = 0;
    setServerDocs((prev) => (prev.length ? [] : prev));
    setDocumentsError(null);
    setDocumentsLoading(false);
    if (userId && activeChatId) refreshDocuments(activeChatId);
  }, [userId, activeChatId, refreshDocuments]);

  // Poll ONLY the open chat and ONLY while one of its documents is processing:
  // a single timer, stopped as soon as everything is ready/failed, the chat
  // changes, the user signs out or the component unmounts.
  useEffect(() => {
    if (!userId || !activeChatId || !hasProcessing) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (!document.hidden) await refreshDocuments(activeChatId, true);
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [userId, activeChatId, hasProcessing, refreshDocuments]);

  // Free hosting sleeps when idle. After a quiet period make sure the server
  // answers before sending a file (short ping first, banner only if needed).
  const ensureAwake = useCallback(async () => {
    if (Date.now() - lastServerOk < SERVER_STALE_MS) return true;
    if (await waitForServer(1)) return true;
    setWaking(true);
    const ok = await waitForServer();
    setWaking(false);
    return ok;
  }, []);

  // Sends ONE file. The card shows the real upload progress; when every byte is
  // sent it says "processing" (the server is working), and when the server
  // answers 202 it stays "processing" until GET /documents says it is ready.
  const uploadOne = useCallback(
    async (card: DocumentItem, awake: boolean) => {
      const file = card.file as File;
      const chatId = card.chat_id;
      const tempId = card.id;
      const ctrl = new AbortController();
      uploadsRef.current.set(tempId, { ctrl, chatId });

      const patch = (changes: Partial<DocumentItem>) =>
        setLocalDocs((prev) =>
          prev.map((d) => (d.id === tempId ? { ...d, ...changes } : d))
        );

      try {
        if (!awake) {
          throw new Error("The server is not responding. Please retry in a minute.");
        }
        const token = await getToken();
        let lastPct = -1;
        patch({ progress: 0 });

        const body = await uploadWithProgress(
          file,
          chatId,
          token,
          {
            progress: (pct) => {
              if (pct === lastPct) return;
              lastPct = pct;
              patch({ progress: pct });
            },
            sent: () =>
              patch({ progress: 100, status: "processing", pending: true }),
          },
          ctrl.signal
        );

        const docId = body.document_id;
        if (!docId) throw new Error("The server did not return a document id.");

        const acceptedSeq = fetchSeqRef.current;
        setLocalDocs((prev) =>
          prev.map((d) =>
            d.id === tempId
              ? {
                  ...d,
                  id: docId,
                  name: body.filename ?? d.name,
                  size: body.file_size ?? d.size,
                  status: "processing" as const,
                  stage: "queued" as const,
                  progress: 0,
                  pending: false,
                  remote: true,
                  acceptedSeq,
                }
              : d
          )
        );

        // only the open chat is watched: ask the backend right away
        if (chatId === activeChatIdRef.current) {
          statusRef.current.set(docId, "processing");
          notify(
            "uploading",
            `Upload complete — processing ${body.filename ?? file.name}...`,
            4000
          );
          refreshDocuments(chatId, true);
        }
      } catch (err) {
        if (isAbort(err)) {
          setLocalDocs((prev) => prev.filter((d) => d.id !== tempId));
          return;
        }
        console.error("Upload failed:", err);
        const text = err instanceof Error ? err.message : "Upload failed";
        patch({ status: "error", error: text, pending: false });
        notify("error", `${file.name}: ${text}`, 5000);
      } finally {
        uploadsRef.current.delete(tempId);
        inFlightRef.current.delete(fileKey(chatId, file));
      }
    },
    [notify, refreshDocuments]
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const valid: File[] = [];
      const rejected: string[] = [];

      for (const file of Array.from(files)) {
        const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
        if (!ACCEPTED_EXTENSIONS.includes(ext)) {
          rejected.push(`${file.name}: unsupported file type`);
        } else if (file.size === 0) {
          rejected.push(`${file.name}: the file is empty`);
        } else if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
          rejected.push(`${file.name}: larger than ${MAX_FILE_SIZE_MB}MB`);
        } else {
          valid.push(file);
        }
      }

      if (rejected.length) {
        notify(
          "error",
          rejected.length > 1
            ? `${rejected[0]} (+${rejected.length - 1} more)`
            : rejected[0],
          4000
        );
      }
      if (!valid.length) return;

      // The file belongs to the chat that is open. Only when there is none yet
      // do we use the normal "new chat" creation (same as sending a message).
      let chatId = activeChatIdRef.current;
      if (!chatId) {
        notify("uploading", "Starting a new chat...");
        if (!(await ensureAwake())) {
          notify(
            "error",
            "The server is not responding. Please try again in a minute.",
            5000
          );
          return;
        }
        try {
          chatId = await ensureChat();
        } catch (error) {
          console.error("Failed to create chat for upload:", error);
          notify("error", "Could not start a chat for this upload.", 4000);
          return;
        }
      }
      const targetChat: string = chatId;

      // the same file twice at once (double drop) is one upload
      const fresh = valid.filter((file) => {
        const key = fileKey(targetChat, file);
        if (inFlightRef.current.has(key)) return false;
        inFlightRef.current.add(key);
        return true;
      });
      if (!fresh.length) {
        notify("error", "That file is already uploading.", 3000);
        return;
      }

      // the cards appear NOW, before a single byte is sent
      const cards: DocumentItem[] = fresh.map((file) => {
        const id = crypto.randomUUID();
        return {
          id,
          key: id,
          chat_id: targetChat,
          name: file.name,
          size: file.size,
          status: "uploading",
          uploadedAt: Date.now(),
          file,
        };
      });
      setLocalDocs((prev) => [...cards, ...prev]);
      notify(
        "uploading",
        cards.length === 1
          ? `Uploading ${cards[0].name}...`
          : `Uploading ${cards.length} files...`
      );

      // One file at a time (gentle on a small server). Each card has its own
      // progress and its own error: one failure never stops the others.
      const awake = await ensureAwake();
      for (const card of cards) await uploadOne(card, awake);
    },
    [ensureAwake, ensureChat, notify, uploadOne]
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) uploadFiles(e.target.files);
      e.target.value = "";
    },
    [uploadFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
    },
    [uploadFiles]
  );

  const handleDeleteDocument = useCallback(
    async (id: string) => {
      const target = documentsRef.current.find((d) => d.id === id);
      if (
        !target ||
        target.status === "uploading" ||
        target.status === "processing"
      ) {
        return;
      }

      // gone from the screen now; deletingRef keeps a poll that is already in
      // flight from bringing it back
      deletingRef.current.add(id);
      statusRef.current.delete(id);
      setServerDocs((prev) => prev.filter((d) => d.id !== id));
      setLocalDocs((prev) => prev.filter((d) => d.id !== id));

      if (!target.remote) return; // a failed upload: the backend never saw it

      try {
        const res = await apiFetch(ENDPOINTS.documentDelete(id, target.chat_id), {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 404) throw await readError(res);
      } catch (err) {
        // The backend still has it: show it again instead of pretending.
        deletingRef.current.delete(id);
        if (target.chat_id === activeChatIdRef.current) {
          setServerDocs((prev) =>
            prev.some((d) => d.id === id)
              ? prev
              : [{ ...target, key: target.id }, ...prev]
          );
        }
        const text =
          err instanceof Error ? err.message : "Could not delete the document.";
        setDocumentsError(text);
        notify("error", text, 4000);
      }
    },
    [notify]
  );

  // Retry = remove the failed card (and its backend row, if there is one) and
  // upload the same file again as a fresh card.
  const handleRetry = useCallback(
    (doc: DocumentItem) => {
      if (!doc.file) return;
      handleDeleteDocument(doc.id);
      uploadFiles([doc.file]);
    },
    [handleDeleteDocument, uploadFiles]
  );

  const toggleDocumentUse = useCallback((doc: DocumentItem) => {
    if (doc.status !== "ready") return;
    setExcludedDocIds((prev) =>
      prev.includes(doc.id) ? prev.filter((x) => x !== doc.id) : [...prev, doc.id]
    );
  }, []);

  // --------------------------------------------------
  // ABORT / STOP GENERATING
  // --------------------------------------------------

  const abortActiveRequest = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  }, []);

  // --------------------------------------------------
  // CHAT LIST ACTIONS
  // --------------------------------------------------

  const newChat = useCallback(() => {
    chatOpenRequestRef.current++;
    if (loading) abortActiveRequest();

    selectChat(null);
    setChatLoading(false);
    setMessage("");
    setView("chat");
  }, [loading, abortActiveRequest, selectChat]);

  const openChat = useCallback(
    async (id: string) => {
      setView("chat");
      if (id === activeChatIdRef.current) return;

      if (loading) abortActiveRequest();

      const requestId = ++chatOpenRequestRef.current;

      selectChat(id);
      setMessage("");

      if (loadedChatIdsRef.current.has(id)) {
        setChatLoading(false);
        return;
      }

      setChatLoading(true);
      try {
        await fetchMessages(id);
      } catch (err) {
        console.error("Failed to load chat messages:", err);
        notify("error", "Could not load this chat's messages.", 4000);
      } finally {
        if (requestId === chatOpenRequestRef.current) setChatLoading(false);
      }
    },
    [loading, abortActiveRequest, selectChat, fetchMessages, notify]
  );

  const deleteChat = useCallback(
    async (id: string) => {
      if (loading && id === activeChatIdRef.current) abortActiveRequest();

      try {
        const res = await apiFetch(ENDPOINTS.chatDelete(id), { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => null);
          throw new Error(
            typeof data?.detail === "string"
              ? data.detail
              : "Failed to delete chat."
          );
        }
      } catch (error) {
        console.error("Failed to delete chat:", error);
        notify(
          "error",
          error instanceof Error ? error.message : "Failed to delete chat.",
          4000
        );
        return;
      }

      loadedChatIdsRef.current.delete(id);
      abortUploads(id);
      setLocalDocs((prev) => prev.filter((d) => d.chat_id !== id));
      setChats((prev) => prev.filter((chat) => chat.id !== id));

      if (id === activeChatIdRef.current) {
        selectChat(null);
        setMessage("");
      }
    },
    [loading, abortActiveRequest, abortUploads, selectChat, notify]
  );

  const clearAllChats = useCallback(async () => {
    if (!window.confirm("Delete ALL chats? This cannot be undone.")) return;

    try {
      if (loading) abortActiveRequest();

      const res = await apiFetch(ENDPOINTS.chatsClear, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete all chats");

      loadedChatIdsRef.current.clear();
      abortUploads();
      setLocalDocs([]);
      setServerDocs([]);
      setChats([]);
      selectChat(null);
      setView("chat");
    } catch (error) {
      console.error("Failed to clear chat history:", error);
      notify("error", "Failed to clear chat history.", 4000);
    }
  }, [loading, abortActiveRequest, abortUploads, selectChat, notify]);

  // --------------------------------------------------
  // SEND MESSAGE  (RAG is used only when documents exist)
  // --------------------------------------------------

  const sendMessage = useCallback(
    async (text?: string) => {
      const question = (text ?? message).trim();
      if (!question || loading) return;

      if (
        documents.some((d) => d.status === "uploading" || d.status === "processing")
      ) {
        notify(
          "uploading",
          "Your document is still being processed. Ask again once it shows Ready.",
          3000
        );
        return;
      }

      let chatId: string;
      try {
        chatId = await ensureChat();
      } catch (error) {
        console.error("Failed to create chat:", error);
        notify("error", "Could not start a new chat. Try again.", 4000);
        return;
      }

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: question,
      };

      updateChat(chatId, (chat) => ({
        ...chat,
        title: chat.messages.length === 0 ? titleFrom(question) : chat.title,
        messages: [...chat.messages, userMessage],
      }));

      setMessage("");
      setView("chat");
      setLoading(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        await saveMessage(chatId, "user", question);
      } catch (error) {
        console.error("Failed to save user message:", error);
      }

      // RAG only when this chat has ready documents the user hasn't excluded.
      const docsForRag = readyDocuments.filter(
        (d) => d.chat_id === chatId && !excludedDocIds.includes(d.id)
      );

      let assistantContent = "";

      try {
        const response = await apiFetch(ENDPOINTS.ask, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            query: question,
            chat_id: chatId,
            document_id: docsForRag[0]?.id ?? null,
            document_ids: docsForRag.map((d) => d.id),
            top_k: 5,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(
            typeof data?.detail === "string"
              ? data.detail
              : data?.detail
              ? JSON.stringify(data.detail)
              : `Request failed (${response.status})`
          );
        }

        if (!response.body) {
          throw new Error("Streaming response is not available.");
        }

        const assistantMessageId = crypto.randomUUID();

        updateChat(chatId, (chat) => ({
          ...chat,
          messages: [
            ...chat.messages,
            { id: assistantMessageId, role: "assistant", content: "" },
          ],
        }));

        const processEvent = (raw: string) => {
          const { event, data } = parseSSE(raw);

          if (!data || data.trim() === "[DONE]") return;
          if (event === "sources") return;

          if (event === "error") {
            throw new Error(decodeChunk(data) || "The server reported an error.");
          }

          const chunk = decodeChunk(data);
          if (!chunk) return;

          assistantContent += chunk;
          updateChat(chatId, (chat) => ({
            ...chat,
            messages: chat.messages.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: msg.content + chunk }
                : msg
            ),
          }));
        };

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";

          for (const event of events) processEvent(event);
        }

        if (buffer.trim()) processEvent(buffer);

        if (assistantContent.trim()) {
          try {
            await saveMessage(chatId, "assistant", assistantContent);
          } catch (error) {
            console.error("Failed to save assistant message:", error);
          }
        } else {
          updateChat(chatId, (chat) => ({
            ...chat,
            messages: chat.messages.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: "_No answer was returned._" }
                : msg
            ),
          }));
        }
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") {
          // user pressed stop: keep what was already generated
          if (assistantContent.trim()) {
            saveMessage(chatId, "assistant", assistantContent).catch((e) =>
              console.error("Failed to save partial answer:", e)
            );
          }
          return;
        }

        updateChat(chatId, (chat) => ({
          ...chat,
          messages: [
            ...chat.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content:
                error instanceof Error
                  ? `Error: ${error.message}`
                  : "Something went wrong.",
            },
          ],
        }));
      } finally {
        if (abortControllerRef.current === controller) {
          setLoading(false);
          abortControllerRef.current = null;
        }
      }
    },
    [
      message,
      loading,
      documents,
      readyDocuments,
      excludedDocIds,
      ensureChat,
      updateChat,
      notify,
    ]
  );

  const askExample = useCallback(
    (question: string) => {
      setView("chat");
      sendMessage(question);
    },
    [sendMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // --------------------------------------------------
  // LOADING SHELL
  // --------------------------------------------------

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#171717] text-white">
        Loading...
      </div>
    );
  }

  // --------------------------------------------------
  // LOGIN SCREEN
  // --------------------------------------------------

  if (!session) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#171717] px-4 text-white">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.03] blur-3xl" />
        </div>

        <div className="relative w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#202020]/95 p-8 shadow-2xl backdrop-blur-xl">
          <div className="mb-6 flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white text-lg font-bold text-black shadow-lg">
              D
            </div>
          </div>

          <div className="mb-7 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              Welcome to DocuMind
            </h1>
            <p className="mt-2 text-sm leading-6 text-[#9AA8C2]">
              Your intelligent workspace for understanding documents.
            </p>
          </div>

          <p className="mb-6 text-sm text-[#9AA8C2]">
            {authMode === "signin"
              ? "Sign in to continue to DocuMind."
              : "Create your DocuMind account."}
          </p>

          {/* EMAIL */}
          <div className="relative mb-3">
            <input
              type="email"
              placeholder="Email address"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-[#71809D] focus:border-[#5B8CFF] focus:ring-2 focus:ring-[#4F8CFF]/20"
            />
          </div>

          {/* PASSWORD */}
          <div className="relative mb-3">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && authMode === "signin") {
                  handleEmailAuth();
                }
              }}
              className="w-full rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3.5 pr-12 text-sm text-white outline-none transition placeholder:text-[#71809D] focus:border-[#5B8CFF] focus:ring-2 focus:ring-[#4F8CFF]/20"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#71809D] hover:bg-white/5 hover:text-[#C7D2E6]"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {/* CONFIRM PASSWORD - SIGN UP ONLY */}
          {authMode === "signup" && (
            <div className="relative mb-3">
              <input
                type={showConfirmPassword ? "text" : "password"}
                placeholder="Confirm password"
                value={authConfirmPassword}
                onChange={(e) => setAuthConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleEmailAuth();
                }}
                className="w-full rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3.5 pr-12 text-sm text-white outline-none transition placeholder:text-[#71809D] focus:border-[#5B8CFF] focus:ring-2 focus:ring-[#4F8CFF]/20"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#71809D] hover:bg-white/5 hover:text-[#C7D2E6]"
                aria-label={
                  showConfirmPassword
                    ? "Hide confirm password"
                    : "Show confirm password"
                }
              >
                {showConfirmPassword ? (
                  <EyeOff size={18} />
                ) : (
                  <Eye size={18} />
                )}
              </button>
            </div>
          )}

          {authError && (
            <p className="mb-3 text-sm text-[#FB7185]">{authError}</p>
          )}

          <button
            type="button"
            onClick={handleEmailAuth}
            disabled={authSubmitting}
            className="mb-4 w-full rounded-xl bg-white px-4 py-3.5 text-sm font-medium text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {authSubmitting
              ? "Please wait..."
              : authMode === "signin"
              ? "Sign In"
              : "Create Account"}
          </button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-xs text-gray-500">OR</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          <button
            type="button"
            onClick={signInWithGoogle}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3.5 text-sm font-medium text-white transition hover:border-white/20 hover:bg-[#151E33]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M21.35 12.27c0-.78-.07-1.54-.2-2.27H12v4.3h5.22a4.46 4.46 0 0 1-1.93 2.93v2.45h3.13c1.83-1.69 2.93-4.18 2.93-7.41Z"
              />
              <path
                fill="#34A853"
                d="M12 21.75c2.62 0 4.82-.87 6.43-2.35l-3.13-2.45c-.87.58-1.98.93-3.3.93-2.54 0-4.69-1.72-5.46-4.03H3.31v2.53A9.72 9.72 0 0 0 12 21.75Z"
              />
              <path
                fill="#FBBC05"
                d="M6.54 13.85a5.85 5.85 0 0 1 0-3.7V7.62H3.31a9.75 9.75 0 0 0 0 8.76l3.23-2.53Z"
              />
              <path
                fill="#EA4335"
                d="M12 6.12c1.43 0 2.72.49 3.73 1.45l2.8-2.8C16.81 3.2 14.62 2.25 12 2.25a9.72 9.72 0 0 0-8.69 5.37l3.23 2.53C7.31 7.84 9.46 6.12 12 6.12Z"
              />
            </svg>
            Continue with Google
          </button>

          <div className="mt-6 text-center">
            <span className="text-sm text-[#71809D]">
              {authMode === "signin"
                ? "Don't have an account?"
                : "Already have an account?"}
            </span>
            <button
              type="button"
              onClick={() => {
                setAuthMode(authMode === "signin" ? "signup" : "signin");
                setAuthError("");
              }}
              className="ml-2 text-sm font-medium text-white transition hover:text-[#C7D2E6]"
            >
              {authMode === "signin" ? "Sign Up" : "Sign In"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // MAIN APP
  // --------------------------------------------------

  const hasDocuments = documents.length > 0;
  const showThinking =
    loading &&
    (!lastMessage ||
      lastMessage.role !== "assistant" ||
      lastMessage.content === "");

  const examples = hasDocuments
    ? [
        { title: "Summarize my document", sub: "Get a quick overview" },
        { title: "Explain this document", sub: "Understand it in simple terms" },
        {
          title: "Find key information in my document",
          sub: "Search for important details",
        },
        {
          title: "What are the main conclusions?",
          sub: "Answers grounded in your files",
        },
      ]
    : [
        { title: "Explain how RAG works", sub: "Chat about anything" },
        { title: "Help me write a professional email", sub: "Drafting help" },
        { title: "Give me ideas for a side project", sub: "Brainstorming" },
        { title: "Explain a concept in simple words", sub: "Learning" },
      ];

  return (
    <div
      style={{
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
      className="flex h-screen bg-[#080B14] text-white"
    >
      <style>{DOCUMIND_CSS}</style>

      {/* ==================================================
          SIDEBAR
      ================================================== */}

      {sidebarOpen && (
        <aside className="flex h-screen w-[290px] shrink-0 flex-col bg-[#0B1020]">
          {/* NEW CHAT */}
          <div className="p-3">
            <button
              type="button"
              onClick={newChat}
              className="flex w-full items-center gap-3 rounded-xl border border-[#2A3958] bg-transparent px-4 py-3 text-sm text-[#E6ECF8] transition hover:bg-[#182238]"
            >
              <Plus size={19} />
              <span>New chat</span>
            </button>
          </div>

          {/* NAVIGATION */}
          <div className="space-y-1 px-3 pt-2">
            <button
              type="button"
              onClick={() => setView("chat")}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm transition ${
                view === "chat"
                  ? "bg-[#182238] text-white"
                  : "text-[#9AA8C2] hover:bg-[#151E33] hover:text-[#E6ECF8]"
              }`}
            >
              <MessageSquare size={19} />
              <span>Chat</span>
            </button>

            <button
              type="button"
              onClick={() => setView("documents")}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm transition ${
                view === "documents"
                  ? "bg-[#182238] text-white"
                  : "text-[#9AA8C2] hover:bg-[#151E33] hover:text-[#E6ECF8]"
              }`}
            >
              <FileText size={19} />
              <span>Documents</span>
            </button>
          </div>

          {/* RECENT CHATS */}
          <div className="flex min-h-0 flex-1 flex-col px-3 pt-4">
            <button
              type="button"
              onClick={() => setShowRecentChats((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs font-semibold tracking-wider text-gray-500 transition hover:bg-[#151E33] hover:text-gray-300"
            >
              <span>RECENT CHATS</span>
              <span className="text-sm">{showRecentChats ? "⌃" : "›"}</span>
            </button>

            {showRecentChats && (
              <div className="mt-1 min-h-0 flex-1 space-y-1 overflow-y-auto pb-2">
                {chats.length === 0 && (
                  <p className="px-3 py-2 text-xs text-[#52627F]">
                    No chats yet.
                  </p>
                )}
                {chats.map((chat) => (
                  <SidebarChatItem
                    key={chat.id}
                    chat={chat}
                    isActive={activeChatId === chat.id && view === "chat"}
                    onOpen={openChat}
                    onDelete={deleteChat}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ACCOUNT / SETTINGS */}
          <div className="shrink-0 border-t border-[#1F2A44] p-3">
            <button
              type="button"
              onClick={() => setView("settings")}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${
                view === "settings"
                  ? "bg-[#182238] text-white"
                  : "text-[#9AA8C2] hover:bg-[#151E33] hover:text-white"
              }`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-black">
                {session.user?.email?.charAt(0).toUpperCase() || "U"}
              </div>

              <div className="min-w-0 text-left">
                <p className="truncate text-sm text-white">
                  {session.user?.email || "User"}
                </p>
                <p className="text-xs text-[#71809D]">Settings</p>
              </div>
            </button>
          </div>
        </aside>
      )}

      {/* ==================================================
          MAIN
      ================================================== */}

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* HEADER */}
        <header className="flex h-14 shrink-0 items-center border-b border-[#1F2A44] px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mr-3 rounded-lg p-2 hover:bg-[#182238]"
          >
            {sidebarOpen ? <X size={20} /> : <MessageSquare size={20} />}
          </button>

          <div>
            <h1 className="text-sm font-semibold">DocuMind</h1>
            <p className="text-xs text-[#71809D]">AI Document Assistant</p>
          </div>

          {/* if you can't see this tag, an older build is still deployed */}
          <span className="ml-auto text-[10px] text-[#52627F]">{BUILD_TAG}</span>
        </header>

        {/* SERVER WAKE-UP BANNER */}
        {(!serverReady || waking) && (
          <div className="flex items-center justify-center gap-2 border-b border-[#7C9CFF]/20 bg-[#182238] px-4 py-2 text-xs text-[#C7D2E6]">
            <Loader2 size={14} className="animate-spin text-[#7C9CFF]" />
            <span>
              Waking up the server — this can take up to a minute on free
              hosting...
            </span>
          </div>
        )}

        {/* TOAST (visible in every view) */}
        {toast && (
          <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2">
            <div
              className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm shadow-lg ${
                toast.type === "error"
                  ? "border-red-500/30 bg-[#2A1518] text-red-300"
                  : toast.type === "success"
                  ? "border-green-500/30 bg-[#112219] text-green-300"
                  : "border-[#7C9CFF]/30 bg-[#182238] text-[#C7D2E6]"
              }`}
            >
              {toast.type === "uploading" ? (
                <Loader2 size={16} className="animate-spin text-[#7C9CFF]" />
              ) : toast.type === "success" ? (
                <CheckCircle2 size={16} className="text-green-400" />
              ) : (
                <AlertCircle size={16} className="text-red-400" />
              )}
              <span>{toast.message}</span>
            </div>
          </div>
        )}

        {/* hidden file picker shared by every view */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* ==================================================
            DOCUMENTS
        ================================================== */}
        {view === "documents" && (
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-10">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Documents</h2>
                  <p className="mt-2 text-sm text-[#9AA8C2]">
                    Documents attached to the current chat. Questions use them
                    automatically (RAG).
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => activeChatId && refreshDocuments(activeChatId)}
                  disabled={documentsLoading || !activeChatId}
                  className="rounded-lg border border-[#2A3958] px-3 py-2 text-xs text-[#C7D2E6] hover:bg-[#182238] disabled:opacity-50"
                >
                  {documentsLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    "Refresh"
                  )}
                </button>
              </div>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`mt-8 cursor-pointer rounded-xl border border-dashed p-10 text-center transition ${
                  isDragging
                    ? "border-white bg-[#182238]"
                    : "border-[#344566] hover:border-[#4B5F86]"
                }`}
              >
                <Upload size={28} className="mx-auto text-[#C7D2E6]" />

                <p className="mt-4 text-sm text-gray-300">
                  Drag & drop files here, or click to browse
                </p>

                <p className="mt-1 text-xs text-[#71809D]">
                  PDF, DOCX, TXT, MD &middot; up to {MAX_FILE_SIZE_MB}MB
                  each
                </p>
              </div>

              {documentsError && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-[#FB7185]">
                  <XCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{documentsError}</span>
                </div>
              )}

              <div className="mt-6 space-y-2">
                {!activeChatId ? (
                  <p className="text-sm text-[#71809D]">
                    No chat is open. Open a chat, or upload a file to start one.
                  </p>
                ) : documentsLoading && documents.length === 0 ? (
                  <p className="text-sm text-[#71809D]">Loading documents...</p>
                ) : documents.length === 0 ? (
                  <p className="text-sm text-[#71809D]">
                    No documents in this chat yet.
                  </p>
                ) : (
                  documents.map((doc) => (
                    <DocumentRow
                      key={doc.key}
                      doc={doc}
                      onDelete={handleDeleteDocument}
                      onRetry={handleRetry}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ==================================================
            SETTINGS
        ================================================== */}
        {view === "settings" && (
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-6 py-10">
              <div className="mb-8">
                <h2 className="text-3xl font-semibold text-white">Settings</h2>
                <p className="mt-2 text-sm text-[#71809D]">
                  Manage your account and conversation preferences.
                </p>
              </div>

              <div className="mb-5 rounded-2xl border border-white/10 bg-[#111827] p-5">
                <p className="text-sm font-medium text-white">Account</p>

                <div className="mt-5 flex items-center gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-lg font-semibold text-black">
                    {session.user?.email?.charAt(0).toUpperCase() || "U"}
                  </div>

                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                      {session.user?.email || "User"}
                    </p>
                    <p className="mt-1 text-xs text-[#71809D]">
                      {session.user?.app_metadata?.provider === "google"
                        ? "Google account"
                        : "Email account"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mb-5 rounded-2xl border border-white/10 bg-[#111827] p-5">
                <p className="text-sm font-medium text-white">Chat history</p>
                <p className="mt-1 text-xs text-[#71809D]">
                  Manage your conversations and saved chats.
                </p>

                <button
                  type="button"
                  onClick={clearAllChats}
                  className="mt-5 rounded-lg border border-red-500/30 px-4 py-2.5 text-sm text-[#FB7185] transition hover:bg-red-500/10"
                >
                  Clear all chat history
                </button>
              </div>

              <button
                type="button"
                onClick={signOut}
                className="w-full rounded-2xl border border-white/10 bg-[#111827] px-5 py-4 text-left text-sm font-medium text-[#C7D2E6] transition hover:bg-[#1A2740] hover:text-white"
              >
                Sign out
              </button>
            </div>
          </div>
        )}

        {/* ==================================================
            CHAT
        ================================================== */}
        {view === "chat" && (
          <>
            {/* CHAT AREA */}
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-10">
                {chatLoading ? (
                  <div className="flex animate-pulse flex-col gap-4">
                    {[...Array(5)].map((_, i) => (
                      <div
                        key={i}
                        className={`flex gap-3 ${
                          i % 2 === 0 ? "" : "flex-row-reverse"
                        }`}
                      >
                        <div className="h-7 w-7 shrink-0 rounded-full bg-[#1F2A44]" />
                        <div className="flex max-w-[65%] flex-col gap-2">
                          <div
                            className={`h-3.5 rounded-full bg-[#1F2A44] ${
                              i % 2 === 0 ? "w-52" : "w-40"
                            }`}
                          />
                          <div
                            className={`h-3.5 rounded-full bg-[#1F2A44] ${
                              i % 2 === 0 ? "w-72" : "w-56"
                            }`}
                          />
                          {i % 3 === 0 && (
                            <div className="h-3.5 w-36 rounded-full bg-[#1F2A44]" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <>
                    {/* WELCOME */}
                    <div className="mb-12 text-center">
                      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-r from-[#4F8CFF] to-[#8B5CF6] text-white">
                        D
                      </div>

                      <h2 className="text-2xl font-semibold">
                        How can I help you?
                      </h2>

                      <p className="mt-2 text-sm text-[#9AA8C2]">
                        {hasDocuments
                          ? "Your documents are attached — I'll answer from them."
                          : "Chat about anything, or attach a document and I'll answer from it."}
                      </p>
                    </div>

                    {/* EXAMPLES */}
                    <div className="grid gap-3 sm:grid-cols-2">
                      {examples.map((ex) => (
                        <button
                          key={ex.title}
                          type="button"
                          onClick={() => askExample(ex.title)}
                          className="rounded-xl border border-[#2A3958] p-5 text-left transition hover:bg-[#151E33]"
                        >
                          <p className="font-medium text-white">{ex.title}</p>
                          <p className="mt-2 text-sm text-[#71809D]">
                            {ex.sub}
                          </p>
                        </button>
                      ))}

                      {!hasDocuments && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-xl border border-dashed border-[#344566] p-5 text-left transition hover:bg-[#151E33] sm:col-span-2"
                        >
                          <p className="flex items-center gap-2 font-medium text-white">
                            <Paperclip size={16} /> Upload a document
                          </p>
                          <p className="mt-2 text-sm text-[#71809D]">
                            PDF, DOCX, TXT or MD — questions will then use
                            RAG over your file
                          </p>
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-6">
                    {messages.map((msg) => (
                      <MessageBubble key={msg.id} message={msg} />
                    ))}

                    {showThinking && (
                      <div className="flex items-center gap-2 text-[#9AA8C2]">
                        <Loader2 size={18} className="animate-spin" />
                        <span className="text-sm">Thinking...</span>
                      </div>
                    )}
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            </div>

            {/* INPUT */}
            <div className="w-full px-4 pb-6">
              <div className="mx-auto max-w-3xl">
                {hasDocuments && (
                  <div className="mb-2 px-1">
                    <div className="flex flex-wrap gap-2">
                      {documents.map((doc) => (
                        <DocChip
                          key={doc.key}
                          doc={doc}
                          used={!excludedDocIds.includes(doc.id)}
                          onToggle={toggleDocumentUse}
                          onDelete={handleDeleteDocument}
                          onRetry={handleRetry}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-end rounded-2xl border border-[#344566] bg-[#111827] px-3 py-3 shadow-lg">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mb-1 rounded-lg p-2 text-[#9AA8C2] hover:bg-[#263653] hover:text-white"
                    title={
                      isUploading
                        ? "Uploading... (you can attach more files)"
                        : "Attach documents"
                    }
                  >
                    {isUploading ? (
                      <Loader2 size={20} className="animate-spin" />
                    ) : (
                      <Paperclip size={20} />
                    )}
                  </button>

                  <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      ragDocuments.length > 0
                        ? "Ask anything about your documents..."
                        : "Message DocuMind..."
                    }
                    rows={1}
                    className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[#71809D]"
                  />

                  <button
                    type="button"
                    onClick={() => (loading ? abortActiveRequest() : sendMessage())}
                    disabled={!loading && !message.trim()}
                    title={loading ? "Stop generating" : "Send"}
                    className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-r from-[#4F8CFF] to-[#8B5CF6] text-white disabled:opacity-30"
                  >
                    {loading ? (
                      <Square size={16} className="fill-white" />
                    ) : (
                      <ArrowUp size={18} />
                    )}
                  </button>
                </div>

                <p className="mt-2 text-center text-xs text-[#71809D]">
                  {ragDocuments.length > 0
                    ? `Answering from ${ragDocuments.length} document${
                        ragDocuments.length > 1 ? "s" : ""
                      } (RAG). `
                    : ""}
                  DocuMind can make mistakes. Check important information.
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}