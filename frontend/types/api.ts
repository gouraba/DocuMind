// Types mirror the FastAPI backend's request/response bodies exactly.
// Do not add fields the backend doesn't return — keep this in sync with the API contract.

export interface RootResponse {
  message: string;
  endpoints: Record<string, string>;
}

export interface HealthResponse {
  status: string;
}

export interface ChunkRequest {
  text: string;
  chunk_size: number;
  chunk_overlap: number;
}

export interface ChunkResponse {
  chunk_size: number;
  chunk_overlap: number;
  total_chunks: number;
  chunks: string[];
}

export interface LLMQueryRequest {
  query: string;
  model: string;
}

export interface LLMQueryResponse {
  query: string;
  model: string;
  answer: string;
}
export interface AskRequest {
  query: string;
  chat_id: string;
  document_id: string;
  top_k: number;
}

export interface AskSource {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
}

export interface AskResponse {
  answer: string;
  sources: AskSource[];
}

// FastAPI's default validation error shape (HTTP 422).
export interface FastAPIValidationError {
  detail: Array<{
    loc: (string | number)[];
    msg: string;
    type: string;
  }>;
}

// FastAPI's HTTPException shape (400 / 500 / 503, etc).
export interface FastAPIHTTPError {
  detail: string;
}

// Normalized error shape used throughout the frontend, regardless of
// which of the above shapes (or a network failure) produced it.
export interface APIError {
  message: string;
  status: number | null;
}
