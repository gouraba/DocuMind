import { supabase } from "@/lib/supabase";
import type {
  APIError,
  AskRequest,
  AskResponse,
  ChunkRequest,
  ChunkResponse,
  HealthResponse,
  LLMQueryRequest,
  LLMQueryResponse,
} from "@/types/api";

// Every request goes through here. Never hardcode a host anywhere else in
// the app — that's the whole point of this file.
const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL && typeof window !== "undefined") {
  // Fails loudly in the browser console rather than silently hitting
  // a relative path that happens to 404.
  // eslint-disable-next-line no-console
  console.error(
    "NEXT_PUBLIC_API_URL is not set. Copy .env.example to .env.local and set it."
  );
}

class APIClientError extends Error implements APIError {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/**
 * Turns whatever the backend (or the network) handed back into one
 * readable sentence. Never surfaces a raw stack trace or a [object Object].
 */
async function toReadableError(response: Response): Promise<APIClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Body wasn't JSON (e.g. a plain-text 502 from a proxy). Fall through.
  }

  // FastAPI validation errors: { detail: [{ loc, msg, type }, ...] }
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { detail?: unknown }).detail)
  ) {
    const details = (body as { detail: Array<{ loc: unknown[]; msg: string }> })
      .detail;
    const messages = details.map((d) => {
      const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : undefined;
      return field ? `${field}: ${d.msg}` : d.msg;
    });
    return new APIClientError(messages.join("; "), response.status);
  }

  // FastAPI HTTPException: { detail: "some string" }
  if (
    body &&
    typeof body === "object" &&
    typeof (body as { detail?: unknown }).detail === "string"
  ) {
    return new APIClientError(
      (body as { detail: string }).detail,
      response.status
    );
  }

  // Fallback by status code, since we couldn't parse anything useful.
  if (response.status === 503) {
    return new APIClientError(
      "The backend is temporarily unavailable. Try again in a moment.",
      503
    );
  }
  if (response.status >= 500) {
    return new APIClientError(
      "The backend hit an internal error processing that request.",
      response.status
    );
  }
  return new APIClientError(
    `Request failed with status ${response.status}.`,
    response.status
  );
}

async function request<TResponse>(
  path: string,
  options?: RequestInit
): Promise<TResponse> {
  if (!API_URL) {
    throw new APIClientError(
      "NEXT_PUBLIC_API_URL is not configured. See .env.example.",
      null
    );
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(options?.headers);
  if (!(options?.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (session?.access_token) {
    headers.set(
      "Authorization",
      `Bearer ${session.access_token}`
    );
  }

  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new APIClientError(
      "Couldn't reach the backend. Is it running, and is NEXT_PUBLIC_API_URL correct?",
      null
    );
  }

  if (!response.ok) {
    throw await toReadableError(response);
  }

  return (await response.json()) as TResponse;
}
export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health", { method: "GET" });
}

export async function chunkText(
  payload: ChunkRequest
): Promise<ChunkResponse> {
  return request<ChunkResponse>("/chunk", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function queryLLM(
  payload: LLMQueryRequest
): Promise<LLMQueryResponse> {
  return request<LLMQueryResponse>("/llm-query", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export async function askQuestion(
  payload: AskRequest
): Promise<AskResponse> {
  return request<AskResponse>("/ask", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createChat(
  payload: { chat_id: string | null }
): Promise<{
  chat_id: string;
  title: string;
  existing: boolean;
}> {
  return request("/chats", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export async function listChats(): Promise<
  Array<{
    chat_id: string;
    title: string;
    created_at: string;
    updated_at: string;
  }>
> {
  console.log("LIST CHATS CALLED");

  const result = await request<
    Array<{
      chat_id: string;
      title: string;
      created_at: string;
      updated_at: string;
    }>
  >("/chats", {
    method: "GET",
  });

  console.log("LIST CHATS RESULT:", result);

  return result;
}
export async function saveMessage(
  chatId: string,
  role: "user" | "assistant",
  content: string
) {
  return request<{
    message_id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }>(`/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      role,
      content,
    }),
  });
}
export async function listMessages(
  chatId: string
): Promise<
  Array<{
    message_id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }>
> {
  return request(`/chats/${chatId}/messages`, {
    method: "GET",
  });
}
