"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import { Eye, EyeOff } from "lucide-react";
import {
  askQuestion,
  createChat as createChatAPI,
  listChats,
  saveMessage,
  listMessages
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
  Settings,
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

type DocumentItem = {
  id: string;
  name: string;
  size: number;
  status: DocStatus;
  error?: string;
  uploadedAt: number;
  chat_id: string;
};
// ==========================================================
// CONFIG
// ==========================================================
// If your backend uses different routes or a different response
// shape, this is the only place you should need to change.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const ENDPOINTS = {
  query: `${API_URL}/llm-query`,
  documentsList: `${API_URL}/documents`,
  documentUpload: `${API_URL}/documents/upload`, // multipart/form-data, field name "file"
  documentDelete: (id: string, chatId: string) =>
  `${API_URL}/documents/${id}?chat_id=${chatId}`,
};

const STORAGE_KEY = "documind-chats";

const MAX_FILE_SIZE_MB = 25;
const ACCEPTED_FILE_TYPES = ".pdf,.doc,.docx,.txt,.md";

async function createChat(): Promise<Chat> {
  const data = await createChatAPI({
    chat_id: null,
  });

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


const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: Message;
}) {
  return (
    <div
      className={`flex ${
        message.role === "user" ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          message.role === "user" ? "bg-[#303030]" : "bg-transparent"
        }`}
      >
        <div className="prose prose-invert max-w-none text-sm leading-7">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
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
      className={`group flex items-center rounded-lg ${
        isActive ? "bg-[#182238]" : "hover:bg-[#182238]"
      }`}
    >
      <button
        onClick={() => onOpen(chat.id)}
        className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
      >
        {chat.title}
      </button>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(chat.id);
        }}
        title="Delete chat"
        className="mr-1 rounded-md p-2 text-gray-500 opacity-0 transition hover:bg-[#3a3a3a] hover:text-white group-hover:opacity-100"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
});

const DOC_STATUS_META: Record<
  DocStatus,
  { label: string; className: string }
> = {
  uploading: { label: "Uploading...", className: "text-[#9AA8C2]" },
  processing: { label: "Processing...", className: "text-[#9AA8C2]" },
  ready: { label: "Ready", className: "text-[#6EE7B7]" },
  error: { label: "Failed", className: "text-[#FB7185]" },
};

const DocumentRow = memo(function DocumentRow({
  doc,
  onDelete,
}: {
  doc: DocumentItem;
  onDelete: (id: string) => void;
}) {
  const meta = DOC_STATUS_META[doc.status];
  const isBusy = doc.status === "uploading" || doc.status === "processing";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[#3a3a3a] bg-[#232323] px-4 py-3">
      <FileIcon size={18} className="shrink-0 text-gray-400" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{doc.name}</p>

        <div className={`mt-0.5 flex items-center gap-1.5 text-xs ${meta.className}`}>
          {isBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : doc.status === "ready" ? (
            <CheckCircle2 size={13} />
          ) : (
            <AlertCircle size={13} />
          )}
          <span>
            {meta.label}
            {doc.status === "error" && doc.error ? `: ${doc.error}` : ""}
          </span>
          <span className="text-[#52627F]">&middot;</span>
          <span className="text-[#71809D]">{formatBytes(doc.size)}</span>
        </div>
      </div>

      <button
        onClick={() => onDelete(doc.id)}
        title="Delete document"
        disabled={doc.status === "uploading"}
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
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showRecentChats, setShowRecentChats] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  useEffect(() => {
  const getSession = async () => {
  console.log("AUTH: checking session...");

  const { data, error } = await supabase.auth.getSession();

  console.log("AUTH: session response received", data.session);

    if (error) {
      console.error("Failed to get session:", error.message);
    }

    setSession(data.session);
    setAuthLoading(false);
  };

  getSession();

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, newSession) => {
    setSession(newSession);
    setAuthLoading(false);
  });

  return () => {
    subscription.unsubscribe();
  };
}, []);
  const [view, setView] = useState<View>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  useEffect(() => {
  if (!session) return;

  const savedChatId = localStorage.getItem("documind-active-chat");

  if (savedChatId) {
    setActiveChatId(savedChatId);
    return;
  }

}, [session]);
  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
    });

    if (error) {
      console.error("Google login failed:", error.message);
    }
  };
  const signOut = async () => {
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

        if (error) {
          throw error;
        }
        setAuthError(
          "Account created. Check your email to confirm your account."
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) {
          throw error;
        }
      }
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "Authentication failed."
      );
    } finally {
      setAuthSubmitting(false);
    }
  };
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [hydrated, setHydrated] = useState(true);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] =
  useState<string[]>([]);

  const abortControllerRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedChatIdsRef = useRef<Set<string>>(new Set());


  // --------------------------------------------------
  // LOAD CHATS FROM LOCAL STORAGE
  // --------------------------------------------------

  useEffect(() => {
  const loadChats = async () => {
  try {
    console.log("LIST CHATS CALLED");

    const backendChats = await listChats();

    console.log("LIST CHATS RESULT:", backendChats);

    if (backendChats.length === 0) {
      setChats([]);
      setActiveChatId(null);
      localStorage.removeItem("documind-active-chat");
      return;
    }

    const chats: Chat[] = [];

    for (const chat of backendChats) {
      chats.push({
        id: chat.chat_id,
        title: chat.title || "New chat",
        messages: [],
      });
    }

    setChats(chats);
    setActiveChatId(null);
    localStorage.removeItem("documind-active-chat");

  } catch (error) {
    console.error("Failed to load chats:", error);
  } finally {
    setHydrated(true);
  }
};
  if (session) {
  loadChats();
} else if (!authLoading) {
  setHydrated(true);
}
}, [session,authLoading]);

  // --------------------------------------------------
  // SAVE CHATS
  // --------------------------------------------------

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  }, [chats, hydrated]);

  // --------------------------------------------------
  // CANCEL ANY IN-FLIGHT REQUEST ON UNMOUNT
  // --------------------------------------------------

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // --------------------------------------------------
  // DERIVED STATE (memoized so it's only recomputed
  // when the underlying data actually changes)
  // --------------------------------------------------

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? null,
    [chats, activeChatId]
  );

  const messages = activeChat?.messages ?? [];

  const readyDocuments = useMemo(
    () => documents.filter((d) => d.status === "ready"),
    [documents]
  );

  // --------------------------------------------------
  // AUTO-SCROLL TO LATEST MESSAGE
  // --------------------------------------------------

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, loading, activeChatId]);

  // --------------------------------------------------
  // DOCUMENTS: FETCH / UPLOAD / DELETE
  // --------------------------------------------------

  const fetchDocuments = useCallback(async () => {
      if (!activeChatId) {
      setDocuments([]);
      return;
    }
    setDocumentsLoading(true);
    setDocumentsError(null);

    try {
      const res= await fetch(`${API_URL}/documents?chat_id=${encodeURIComponent(activeChatId)}`);
      if (!res.ok) throw new Error(`Server responded ${res.status}`);

      const data = await res.json();
      console.log("DOCUMENT API RESPONSE:", data);
      console.log("ACTIVE CHAT ID:", activeChatId);
      type BackendDocument = {
        id: string;
        chat_id?: string;
        filename?: string;
        file_size?: number;
        status?: DocStatus;
        created_at?: string;
      };

      const list: BackendDocument[] =
        Array.isArray(data) ? data : data.documents ?? [];

    const mappedDocuments: DocumentItem[] = list.map((d) => ({
      id: d.id,
      name: d.filename ?? "Untitled",
      size: d.file_size ?? 0,
      status: d.status ?? "ready",
      uploadedAt: d.created_at
        ? new Date(d.created_at).getTime()
        : Date.now(),
      chat_id: d.chat_id ?? activeChatId ?? "",
    }));

      setDocuments(mappedDocuments);

      setSelectedDocumentIds((previous) => {
        const validIds = mappedDocuments
          .filter((doc) => doc.status === "ready")
          .map((doc) => doc.id);

        return previous.filter((id) => validIds.includes(id));
      });
    } catch (err) {
      setDocumentsError(
        err instanceof Error
          ? err.message
          : "Could not reach the documents endpoint."
      );
    } finally {
      setDocumentsLoading(false);
    }
  }, [activeChatId]);

  useEffect(() => {
    if (hydrated) fetchDocuments();
  }, [hydrated, fetchDocuments]);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);

      for (const file of list) {
        if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
          setDocumentsError(
            `"${file.name}" is over the ${MAX_FILE_SIZE_MB}MB limit.`
          );
          continue;
        }
        const chatId = activeChatId;

        if (!chatId) {
            throw new Error("Please select or create a chat before uploading a document.");
        }
        
        const tempId = crypto.randomUUID();

        const optimisticDoc: DocumentItem = {
          id: tempId,
          name: file.name,
          size: file.size,
          status: "uploading",
          uploadedAt: Date.now(),
          chat_id: chatId,
        };

        setDocuments((prev) => [optimisticDoc, ...prev]);

        try {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("chat_id", activeChatId);

          const res = await fetch(ENDPOINTS.documentUpload, {
            method: "POST",
            body: formData,
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => null);
            throw new Error(
              errData?.detail || `Upload failed (${res.status})`
            );
          }

          // The backend is the source of truth for the real id/status,
          // so refresh from it rather than trusting the optimistic row.
          const data = await res.json();

          setDocuments((prev) =>
          prev.map((d) =>
            d.id === tempId
              ? {
                  ...d,
                  id: data.document_id ?? tempId,
                  name: data.filename ?? file.name,
                  size: data.file_size ?? file.size,
                  status: "ready",
                  chat_id: data.chat_id ?? chatId,
                  uploadedAt: Date.now(),
                }
              : d
          )
        );
      }catch (err) {
        setDocuments((prev) =>
              prev.map((d) =>
                d.id === tempId
                  ? {
                      ...d,
                      status: "error",
                      error:
                        err instanceof Error
                          ? err.message
                          : "Upload failed",
                    }
                  : d
              )
            );
          }
        }
      },
      [activeChatId]
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

  const handleDeleteDocument = useCallback(async (id: string) => {
    let removed: DocumentItem | undefined;

    setDocuments((prev) => {
      removed = prev.find((d) => d.id === id);
      return prev.filter((d) => d.id !== id);
    });

    try {
      const res = await fetch(ENDPOINTS.documentDelete(id, activeChatId!), {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    } catch (err) {
      // Revert on failure so the UI doesn't lie about backend state.
      if (removed) {
        const restored = removed;
        setDocuments((prev) => [restored, ...prev]);
      }
      setDocumentsError(
        err instanceof Error ? err.message : "Could not delete document."
      );
    }
  }, [activeChatId]);

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
  try {
    if (loading) {
      abortActiveRequest();
    }

    // New chat is temporary.
    // Do NOT create a backend chat yet.
    setActiveChatId(null);
    localStorage.removeItem("documind-active-chat");

    setMessage("");
    setDocuments([]);
    setSelectedDocumentIds([]);
    setView("chat");
  } catch (error) {
    console.error("Failed to open new chat:", error);
  }
}, [loading, abortActiveRequest]);

  const openChat = useCallback(
  async (id: string) => {
    if (loading) abortActiveRequest();

    setActiveChatId(id);
    localStorage.setItem("documind-active-chat", id);
    setMessage("");
    setView("chat");

    // Clear the currently displayed messages immediately
    setChats((prevChats) =>
      prevChats.map((chat) =>
        chat.id === id
          ? {
              ...chat,
              messages: [],
            }
          : chat
      )
    );

    setChatLoading(true);

    try {
      const savedMessages = await listMessages(id);

      setChats((prevChats) =>
        prevChats.map((chat) =>
          chat.id === id
            ? {
                ...chat,
                messages: savedMessages.map((msg) => ({
                  id: msg.message_id,
                  role: msg.role,
                  content: msg.content,
                })),
              }
            : chat
        )
      );

      loadedChatIdsRef.current.add(id);
    } catch (error) {
      console.error("Failed to load chat messages:", error);
    } finally {
      setChatLoading(false);
    }
  },
  [loading, abortActiveRequest]
);
 

  const deleteChat = useCallback(
  async (id: string) => {
    try {
      if (loading && id === activeChatId) {
        abortActiveRequest();
      }
      const response = await fetch(`${API_URL}/chats/${id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Failed to delete chat."
        );
      }

      const remaining = chats.filter(
        (chat) => chat.id !== id
      );
      loadedChatIdsRef.current.delete(id);

      if (remaining.length === 0) {
        const freshChat = await createChat();

        setChats([freshChat]);
        setActiveChatId(freshChat.id);

        localStorage.setItem(
          "documind-active-chat",
          freshChat.id
        );
      } else {
        setChats(remaining);

        if (id === activeChatId) {
          setActiveChatId(remaining[0].id);

          localStorage.setItem(
            "documind-active-chat",
            remaining[0].id
          );
        }
      }

      setDocuments([]);
      setSelectedDocumentIds([]);
      setMessage("");
      setView("chat");

    }catch (error) {
        console.error("Failed to delete chat:", error);
        setChats((prev) => prev.filter((chat) => chat.id !== id));
        loadedChatIdsRef.current.delete(id);

        if (id === activeChatId) {
          localStorage.removeItem("documind-active-chat");
          setDocuments([]);
          setSelectedDocumentIds([]);
        }

    }
  },
  [
    chats,
    activeChatId,
    loading,
    abortActiveRequest,
  ]
);
  const updateActiveChat = useCallback(
    (
      updater: (chat: Chat) => Chat,
      chatIdOverride?: string
    ) => {
      const targetChatId = chatIdOverride ?? activeChatId;

      if (!targetChatId) return;

      setChats((prev) =>
        prev.map((chat) =>
          chat.id === targetChatId ? updater(chat) : chat
        )
      );
    },
    [activeChatId]
  );
  // --------------------------------------------------
  // SEND MESSAGE
  // --------------------------------------------------

  const sendMessage = useCallback(
  async (text?: string) => {
    const question = (text ?? message).trim();
    if (!question || loading) return;
    let chatId = activeChatId;
    if (!chatId) {
      try {
        const createdChat = await createChat();
        chatId = createdChat.id;
        const title =
          question.length > 35
            ? question.slice(0, 35) + "..."
            : question;

        const newChat: Chat = {
          ...createdChat,
          title,
          messages: [],
        };

        setChats((prev) => [newChat, ...prev]);
        setActiveChatId(chatId);

        localStorage.setItem(
          "documind-active-chat",
          chatId
        );

        loadedChatIdsRef.current.add(chatId);
      } catch (error) {
        console.error("Failed to create chat:", error);
        return;
      }
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
    };
    updateActiveChat((chat) => ({
      ...chat,
      title:
        chat.messages.length === 0
          ? question.length > 35
            ? question.slice(0, 35) + "..."
            : question
          : chat.title,
      messages: [...chat.messages, userMessage],
}), chatId);

    await saveMessage(chatId, "user", question);
    setMessage("");
    setLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      console.log("READY DOCUMENTS:", readyDocuments);
      console.log("ACTIVE CHAT ID IN SEND:", activeChatId);
      const chatDocuments = readyDocuments.filter(
        (document) => document.chat_id === chatId
  );
  const activeDocument =
  chatDocuments.length > 0
    ? chatDocuments[0]
    : null;
      const response = await fetch(`${API_URL}/ask/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          query: question,
          chat_id: chatId,
          document_id: activeDocument?.id ?? null,
          top_k: 5,
        }),
      });

      if (!response.ok) {
        const data = await response.json();

        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail)
        );
      }

      if (!response.body) {
        throw new Error("Streaming response is not available.");
      }

      const assistantMessageId = crypto.randomUUID();

      const assistantMessage: Message = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
      };

      updateActiveChat((chat) => ({
        ...chat,
        messages: [...chat.messages, assistantMessage],
      }), chatId);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let assistantContent = "";
      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");

        buffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event.split("\n");

          let eventType = "message";
          let dataLine = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            }

            if (line.startsWith("data:")) {
              dataLine += line.slice(5).trim();
            }
          }

          if (!dataLine) continue;

          if (dataLine === "[DONE]") {
            continue;
          }

          if (eventType === "error") {
            const errorMessage = JSON.parse(dataLine);
            throw new Error(errorMessage);
          }

          if (eventType === "sources") {
            continue;
          }

          const chunk = JSON.parse(dataLine);
            assistantContent += chunk;
            updateActiveChat((chat) => ({
              ...chat,
              messages: chat.messages.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      content: msg.content + chunk,
                    }
                  : msg
              ),
            }), chatId);
        }
      }
      if (assistantContent.trim()) {
        await saveMessage(
          chatId,
          "assistant",
          assistantContent
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        return;
      }

      const errorMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          error instanceof Error
            ? `Error: ${error.message}`
            : "Something went wrong.",
      };

      updateActiveChat((chat) => ({
        ...chat,
        messages: [...chat.messages, errorMessage],
      }), chatId);
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
    activeChatId,
    selectedDocumentIds,
    readyDocuments,
    updateActiveChat,
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
      if (e.key === "Enter" && !e.shiftKey) {
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
    <div className="flex min-h-screen items-center justify-center bg-[#212121] text-white">
      Loading...
    </div>
  );
}

  if (!session) {
  return (
   <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#171717] px-4 text-white">

  {/* Background glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.03] blur-3xl" />
      </div>

      <div className="relative w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#202020]/95 p-8 shadow-2xl backdrop-blur-xl">

        {/* Logo */}
        <div className="mb-6 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white text-lg font-bold text-black shadow-lg">
            D
          </div>
        </div>

        {/* Heading */}
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
              className="w-full rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3.5 pr-12 text-sm text-white outline-none transition placeholder:text-[#71809D] focus:border-[#5B8CFF] focus:ring-2 focus:ring-[#4F8CFF]/20"
            />

            <button
              type="button"
              onClick={() =>
                setShowConfirmPassword((prev) => !prev)
              }
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
        {/* ERROR */}
        {authError && (
          <p className="mb-3 text-sm text-[#FB7185]">
            {authError}
          </p>
        )}

        {/* EMAIL AUTH */}
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

        {/* DIVIDER */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-xs text-gray-500">OR</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        {/* GOOGLE */}
        <button
          type="button"
          onClick={signInWithGoogle}
          className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3.5 text-sm font-medium text-white transition hover:border-white/20 hover:bg-[#151E33]"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
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
              {/* TOGGLE */}
              <div className="mt-6 text-center">
                <span className="text-sm text-[#71809D]">
                  {authMode === "signin"
                    ? "Don't have an account?"
                    : "Already have an account?"}
                </span>

                <button
                  type="button"
                  onClick={() => {
                    setAuthMode(
                      authMode === "signin" ? "signup" : "signin"
                    );
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

    return (
        <div style={{ fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif" }} className="flex h-screen bg-[#080B14] text-white">
          {/* ==================================================
          SIDEBAR
      ================================================== */}

          {sidebarOpen && (
            <aside className="relative flex h-screen w-[290px] flex-col bg-[#0B1020]">
            {/* NEW CHAT */}
              <div className="p-3">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      if (loading) {
                        abortActiveRequest();
                      }

                      // Open a temporary new chat.
                      // Do NOT create it in Supabase yet.
                      setActiveChatId(null);
                      localStorage.removeItem("documind-active-chat");

                      setMessage("");
                      setDocuments([]);
                      setSelectedDocumentIds([]);
                      setView("chat");
                    } catch (error) {
                      console.error("Failed to open new chat:", error);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-xl border border-[#2A3958] bg-transparent shadow-[0_0_0_1px_rgba(79,140,255,0.03)] px-4 py-3 text-sm text-[#E6ECF8] transition hover:bg-[#182238]"
                >
                  <Plus size={19} />
                  <span>New chat</span>
                </button>
              </div>
          {/* NAVIGATION */}

          <div className="px-3 pt-4">
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
          </div>

          {/* RECENT CHATS */}
          <div className="px-3 pt-4">

            {/* TOGGLE */}
            <button
              type="button"
              onClick={() => setShowRecentChats((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs font-semibold tracking-wider text-gray-500 transition hover:bg-[#222] hover:text-gray-300"
            >
              <span>RECENT CHATS</span>

              <span className="text-sm">
                {showRecentChats ? "⌃" : "›"}
              </span>
            </button>

            {/* CHAT LIST */}
            {showRecentChats && (
              <div className="mt-1 space-y-1">
                {chats.map((chat) => (
                  <div
                    key={chat.id}
                    className={`group flex w-full items-center rounded-lg px-3 py-2.5 text-sm transition ${
                      activeChatId === chat.id && view === "chat"
                        ? "bg-[#2a2a2a] text-white"
                        : "text-gray-400 hover:bg-[#222] hover:text-gray-200"
                    }`}
                  >
                    {/* OPEN CHAT */}
                    <button
                      type="button"
                      onClick={() => openChat(chat.id)}
                      className="min-w-0 flex-1 truncate text-left"
                    >
                      {chat.title || "New chat"}
                    </button>

                    {/* DELETE CHAT */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(chat.id);
                      }}
                      className="ml-2 hidden rounded-md px-2 py-1 text-[#71809D] transition hover:bg-red-500/10 hover:text-[#FB7185] group-hover:block"
                      title="Delete chat"
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}

          </div>
          {/* ACCOUNT / SETTINGS */}
          
          <div className="absolute bottom-0 left-0 w-full border-t border-[#1F2A44] p-3">
            <button
              type="button"
              onClick={() => setView("settings")}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${
                view === "settings"
                  ? "bg-[#182238] text-white"
                  : "text-[#9AA8C2] hover:bg-[#151E33] hover:text-white"
              }`}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-sm font-semibold text-black">
                {session?.user?.email?.charAt(0).toUpperCase() || "U"}
              </div>

              <div className="min-w-0 text-left">
                <p className="truncate text-sm text-white">
                  {session?.user?.email || "User"}
                </p>

                <p className="text-xs text-[#71809D]">
                  Settings
                </p>
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
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mr-3 rounded-lg p-2 hover:bg-[#182238]"
          >
            {sidebarOpen ? <X size={20} /> : <MessageSquare size={20} />}
          </button>

          <div>
            <h1 className="text-sm font-semibold">DocuMind</h1>
            <p className="text-xs text-[#71809D]">AI Document Assistant</p>
          </div>
        </header>

        {/* ==================================================
            DOCUMENTS
        ================================================== */}
        <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_FILE_TYPES}
                onChange={handleFileInputChange}
                className="hidden"
              />

        {view === "documents" && (
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-10">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Documents</h2>
                  <p className="mt-2 text-sm text-[#9AA8C2]">
                    Upload documents to ask questions about them.
                  </p>
                </div>

                <button
                  onClick={fetchDocuments}
                  disabled={documentsLoading}
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
                <Upload size={28} className="mt-4 text-sm text-[#C7D2E6]" />

                <p className="mt-4 text-sm text-gray-300">
                  Drag & drop files here, or click to browse
                </p>

                <p className="mt-1 text-xs text-[#71809D]">
                  PDF, DOC, DOCX, TXT, MD &middot; up to {MAX_FILE_SIZE_MB}MB
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
                {documentsLoading && documents.length === 0 ? (
                  <p className="text-sm text-[#71809D]">
                    Loading documents...
                  </p>
                ) : documents.length === 0 ? (
                  <p className="text-sm text-[#71809D]">
                    No documents uploaded yet.
                  </p>
                ) : (
                  documents.map((doc) => (
                    <DocumentRow
                      key={doc.id}
                      doc={doc}
                      onDelete={handleDeleteDocument}
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

      {/* HEADER */}
      <div className="mb-8">
        <h2 className="text-3xl font-semibold text-white">
          Settings
        </h2>

        <p className="mt-2 text-sm text-[#71809D]">
          Manage your account and conversation preferences.
        </p>
      </div>

      {/* ACCOUNT */}
      <div className="mb-5 rounded-2xl border border-white/10 bg-[#111827] p-5">
        <p className="text-sm font-medium text-white">
          Account
        </p>

        <div className="mt-5 flex items-center gap-4">

          {/* AVATAR */}
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-lg font-semibold text-black">
            {session?.user?.email?.charAt(0).toUpperCase() || "U"}
          </div>

          {/* USER INFO */}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">
              {session?.user?.email || "User"}
            </p>

            <p className="mt-1 text-xs text-[#71809D]">
              {session?.user?.app_metadata?.provider === "google"
                ? "Google account"
                : "Email account"}
            </p>
          </div>
        </div>
      </div>

      {/* CHAT HISTORY */}
      <div className="mb-5 rounded-2xl border border-white/10 bg-[#111827] p-5">
        <p className="text-sm font-medium text-white">
          Chat history
        </p>

        <p className="mt-1 text-xs text-[#71809D]">
          Manage your conversations and saved chats.
        </p>

        {/* CLEAR HISTORY */}
        <button
          type="button"
          onClick={async () => {
            try {
              const res = await fetch(`${API_URL}/chats`, {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${
                    session?.access_token || ""
                  }`,
                },
              });

              if (!res.ok) {
                throw new Error("Failed to delete all chats");
              }

              localStorage.removeItem(STORAGE_KEY);
              localStorage.removeItem("documind-active-chat");

              const freshChat = await createChat();

              setChats([freshChat]);
              setActiveChatId(freshChat.id);
              setView("chat");
            } catch (error) {
              console.error("Failed to clear chat history:", error);
            }
          }}
          className="mt-5 rounded-lg border border-red-500/30 px-4 py-2.5 text-sm text-[#FB7185] transition hover:bg-red-500/10"
        >
          Clear all chat history
        </button>
      </div>

      {/* SIGN OUT */}
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
                {messages.length === 0 ? (
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
                        Ask questions about your documents or start a
                        conversation.
                      </p>
                    </div>

                    {/* EXAMPLES */}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                          type="button"
                          onClick={() => askExample("Summarize my document")}
                          className="rounded-xl border border-[#2A3958] p-5 text-left transition hover:bg-[#151E33]"
                          >
                          <p className="font-medium text-white">
                            Summarize my document
                          </p>
                          <p className="mt-2 text-sm text-[#71809D]">
                            Get a quick overview
                          </p>
                          </button>

                      <button
                        type="button"
                        onClick={() => askExample("Explain this document")}
                        className="rounded-xl border border-[#2A3958] p-5 text-left transition hover:bg-[#151E33]"
                      >
                        <p className="font-medium text-white">
                          Explain this document
                        </p>
                        <p className="mt-2 text-sm text-[#71809D]">
                          Understand it in simple terms
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => askExample("Find key information in my document")}
                        className="rounded-xl border border-[#2A3958] p-5 text-left transition hover:bg-[#151E33]"
                      >
                        <p className="font-medium text-white">
                          Find key information
                        </p>
                        <p className="mt-2 text-sm text-[#71809D]">
                          Search for important details
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => askExample("Ask questions about my document")}
                        className="rounded-xl border border-[#2A3958] p-5 text-left transition hover:bg-[#151E33]"
                      >
                        <p className="font-medium text-white">
                          Ask questions about my document
                        </p>
                        <p className="mt-2 text-sm text-[#71809D]">
                          Get answers using RAG
                        </p>
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-8">
                    {chatLoading ? (
                      <div className="flex min-h-[60vh] items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-[#9AA8C2]">
                          <Loader2 size={28} className="animate-spin" />
                          <span className="text-sm">Loading conversation...</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        {messages.map((msg) => (
                          <MessageBubble key={msg.id} message={msg} />
                        ))}

                        {loading && (
                          <div className="flex items-center gap-2 text-[#9AA8C2]">
                            <Loader2 size={18} className="animate-spin" />
                            <span className="text-sm">Thinking...</span>
                          </div>
                        )}
                      </>
                    )}

                    <div ref={bottomRef} />
                  </div>
                )}
              </div>
            </div>

            {/* INPUT */}

            <div className="w-full px-4 pb-6">
              <div className="mx-auto max-w-3xl">
                {readyDocuments.length > 0 && (
                  <div className="mb-2 flex items-center px-1">
                    <div className="flex items-center gap-2 rounded-full border border-[#2A3958] bg-[#182238] px-3 py-1.5 text-xs text-[#C7D2E6]">
                      <FileText size={13} />

                      <div className="flex max-w-[700px] flex-wrap gap-2">
                          {readyDocuments.map((doc) => (
                            <div
                              key={doc.id}
                              className="flex items-center gap-2 rounded-lg border border-[#2A3958] bg-[#182238] px-3 py-2 text-sm text-[#C7D2E6]"
                            >
                              <FileText size={16} className="text-[#9AA8C2]" />

                              <span className="max-w-[260px] truncate">
                                {doc.name}
                              </span>

                              <button
                                type="button"
                                onClick={() => handleDeleteDocument(doc.id)}
                                className="ml-1 text-[#71809D] transition hover:text-[#FB7185]"
                                title="Remove document"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                    </div>
                  </div>
                )}

                <div className="flex items-end rounded-2xl border border-[#344566] bg-[#111827] px-3 py-3 shadow-lg">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="mb-1 rounded-lg p-2 text-[#9AA8C2] hover:bg-[#263653] hover:text-white"
                    title="Documents"
                  >
                    <Paperclip size={20} />
                  </button>

                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything about your documents..."
                    rows={1}
                    className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[#71809D]"
                  />

                  <button
                    onClick={() =>
                      loading ? abortActiveRequest() : sendMessage()
                    }
                    disabled={!loading && !message.trim()}
                    title={loading ? "Stop generating" : "Send"}
                    className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-r from-[#4F8CFF] to-[#8B5CF6] text-white disabled:opacity-30"
                  >
                    {loading ? (
                      <Square size={16} className="fill-black" />
                    ) : (
                      <ArrowUp size={18} />
                    )}
                  </button>
                </div>

                <p className="mt-2 text-center text-xs text-[#71809D]">
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
