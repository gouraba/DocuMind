"""
DocuMind API
------------
Upload flow (so the UI can always show the real state of a file):

  1. POST /documents/upload   -> validates, stores the file, creates the
                                 `documents` row (status="processing") and
                                 returns 202 immediately.
  2. Background task          -> extract text -> chunk -> embed -> save.
                                 Updates `stage`, `total_chunks`,
                                 `processed_chunks` after every batch.
  3. GET /documents?chat_id=  -> the frontend polls this while any document
                                 is "processing". Because the state lives in
                                 the database, it survives page reloads.

Run docs/migration SQL (see reply) BEFORE deploying this file.
"""
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from io import BytesIO
from typing import Iterable, Literal

from docx import Document as DocxDocument
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pypdf import PdfReader
from supabase import Client, create_client

from chunk import split_text_into_chunks
from embedding import embedding_manager

try:
    from groq import Groq
except ImportError:  # pragma: no cover
    Groq = None

# ============================================================
# CONFIG
# ============================================================

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("documind")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
    raise RuntimeError("Supabase environment variables are not set.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

SUPABASE_BUCKET = "documents"
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
PROCESS_BATCH = 16  # chunks embedded + inserted per round trip
MAX_SUMMARY_CHUNKS = 40  # keeps whole-document summaries inside the LLM context
TOKEN_CACHE_TTL = 60  # seconds


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def batched(items: list, size: int) -> Iterable[list]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ============================================================
# STARTUP: recover documents that were interrupted by a restart
# ============================================================


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Background tasks live in this process. If it restarted (deploy, free-tier
    # sleep, crash), any "processing" row can never finish -> mark it failed so
    # the UI shows the truth instead of an endless spinner.
    try:
        supabase.table("documents").update(
            {
                "status": "error",
                "stage": "failed",
                "error_message": (
                    "Processing was interrupted by a server restart. "
                    "Please upload the file again."
                ),
                "updated_at": utc_now(),
            }
        ).eq("status", "processing").execute()
    except Exception:
        logger.exception("Could not recover interrupted documents")
    yield


app = FastAPI(
    title="DocuMind API",
    description="DocuMind RAG backend: chunking, embeddings, Supabase and Groq.",
    version="3.0.0",
    lifespan=lifespan,
)

extra_origins = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://documind-frontend-5hts.onrender.com",
        *extra_origins,
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# AUTH + OWNERSHIP
# ============================================================

# get_user() is a network call to Supabase. The frontend polls, so cache the
# result briefly instead of validating the same token every 2 seconds.
_token_cache: dict[str, tuple[str, float]] = {}


def get_current_user_id(authorization: str | None = Header(default=None)) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Invalid authorization header")

    now = time.monotonic()
    cached = _token_cache.get(token)
    if cached and cached[1] > now:
        return cached[0]

    try:
        user = supabase.auth.get_user(token).user
    except Exception:
        user = None
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if len(_token_cache) > 1000:
        _token_cache.clear()
    _token_cache[token] = (user.id, now + TOKEN_CACHE_TTL)
    return user.id


def validate_uuid(value: str, name: str = "id") -> None:
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=422, detail=f"{name} must be a valid UUID.")


def require_chat(chat_id: str, user_id: str) -> None:
    """404 unless the chat exists AND belongs to the caller (no IDOR)."""
    validate_uuid(chat_id, "chat_id")
    result = (
        supabase.table("chats")
        .select("chat_id")
        .eq("chat_id", chat_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Chat not found.")


def server_error(message: str, exc: Exception) -> HTTPException:
    """Log full detail internally, return a generic message to the client."""
    logger.exception("%s: %s", message, exc)
    return HTTPException(status_code=500, detail=message)


# ============================================================
# GROQ
# ============================================================

_groq_client = None


def get_groq():
    global _groq_client
    if Groq is None:
        raise HTTPException(status_code=503, detail="Groq library is not installed.")
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="GROQ_API_KEY is not set.")
    if _groq_client is None:
        _groq_client = Groq(api_key=GROQ_API_KEY, timeout=60.0)
    return _groq_client


# ============================================================
# MODELS
# ============================================================


class ChunkRequest(BaseModel):
    text: str = Field(..., min_length=1)
    chunk_size: int = Field(50, gt=0)
    chunk_overlap: int = Field(10, ge=0)


class LLMQueryRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=8000)
    model: str | None = None


class ChatCreateRequest(BaseModel):
    chat_id: str | None = None
    title: str | None = "New chat"


class MessageCreateRequest(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1)


class AskRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)
    chat_id: str
    document_id: str | None = None
    document_ids: list[str] = Field(default_factory=list)
    top_k: int = Field(5, ge=1, le=20)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)
    chat_id: str
    document_id: str
    top_k: int = Field(5, ge=1, le=20)


# ============================================================
# TEXT EXTRACTION
# ============================================================


def extract_text(filename: str, contents: bytes) -> str:
    extension = os.path.splitext(filename)[1].lower()

    try:
        if extension == ".pdf":
            reader = PdfReader(BytesIO(contents))
            pages = (page.extract_text() or "" for page in reader.pages)
            return "\n\n".join(p for p in pages if p.strip())

        if extension == ".docx":
            document = DocxDocument(BytesIO(contents))
            return "\n\n".join(p.text for p in document.paragraphs if p.text.strip())

        if extension in (".txt", ".md"):
            return contents.decode("utf-8", errors="ignore")
    except Exception as exc:
        logger.warning("Text extraction failed for %s: %s", filename, exc)
        raise ValueError(
            "Could not read this file. It may be corrupted or password-protected."
        )

    raise ValueError("Unsupported file type. Supported types: PDF, DOCX, TXT, MD.")


# ============================================================
# GENERAL
# ============================================================


@app.get("/", tags=["General"])
def welcome():
    return {"message": "Welcome to the DocuMind API!", "docs": "/docs"}


@app.get("/health", tags=["General"])
def health_check():
    return {
        "status": "ok",
        "embedding_model": embedding_manager.MODEL_NAME,
        "embedding_dimension": embedding_manager.DIMENSION,
    }


# ============================================================
# CHATS
# ============================================================


@app.post("/chats", tags=["Chats"])
def create_chat(
    request: ChatCreateRequest, user_id: str = Depends(get_current_user_id)
):
    chat_id = request.chat_id or str(uuid.uuid4())
    validate_uuid(chat_id, "chat_id")
    title = (request.title or "New chat").strip()[:100] or "New chat"

    try:
        existing = (
            supabase.table("chats")
            .select("chat_id")
            .eq("chat_id", chat_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            return {"chat_id": chat_id, "title": title, "existing": True}

        supabase.table("chats").insert(
            {"chat_id": chat_id, "title": title, "user_id": user_id}
        ).execute()
        return {"chat_id": chat_id, "title": title, "existing": False}
    except Exception as exc:
        raise server_error("Failed to create chat.", exc)


@app.get("/chats", tags=["Chats"])
def list_chats(user_id: str = Depends(get_current_user_id)):
    try:
        result = (
            supabase.table("chats")
            .select("*")
            .eq("user_id", user_id)
            .order("updated_at", desc=True)
            .execute()
        )
        return result.data
    except Exception as exc:
        raise server_error("Failed to list chats.", exc)


def delete_chats_for_user(user_id: str, chat_ids: list[str] | None = None) -> int:
    """Deletes chats (+ storage files). DB cascades remove messages/docs/chunks."""
    query = supabase.table("chats").select("chat_id").eq("user_id", user_id)
    if chat_ids is not None:
        query = query.in_("chat_id", chat_ids)
    ids = [row["chat_id"] for row in (query.execute().data or [])]

    for group in batched(ids, 50):
        docs = (
            supabase.table("documents")
            .select("storage_path")
            .in_("chat_id", group)
            .execute()
            .data
            or []
        )
        paths = [d["storage_path"] for d in docs if d.get("storage_path")]
        for path_group in batched(paths, 100):
            try:
                supabase.storage.from_(SUPABASE_BUCKET).remove(path_group)
            except Exception:
                logger.warning("Storage cleanup failed for %d files", len(path_group))

        (
            supabase.table("chats")
            .delete()
            .eq("user_id", user_id)
            .in_("chat_id", group)
            .execute()
        )
    return len(ids)


@app.delete("/chats", tags=["Chats"])
def delete_all_chats(user_id: str = Depends(get_current_user_id)):
    try:
        deleted = delete_chats_for_user(user_id)
        return {"message": "All chats deleted.", "deleted_chats": deleted}
    except Exception as exc:
        raise server_error("Failed to delete all chats.", exc)


@app.delete("/chats/{chat_id}", tags=["Chats"])
def delete_chat(chat_id: str, user_id: str = Depends(get_current_user_id)):
    validate_uuid(chat_id, "chat_id")
    try:
        deleted = delete_chats_for_user(user_id, [chat_id])
    except Exception as exc:
        raise server_error("Failed to delete chat.", exc)
    if not deleted:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return {"message": "Chat and all associated data deleted.", "chat_id": chat_id}


# ============================================================
# MESSAGES
# ============================================================


@app.post("/chats/{chat_id}/messages", tags=["Messages"])
def save_message(
    chat_id: str,
    request: MessageCreateRequest,
    user_id: str = Depends(get_current_user_id),
):
    require_chat(chat_id, user_id)
    try:
        result = (
            supabase.table("chat_messages")
            .insert(
                {
                    "chat_id": chat_id,
                    "role": request.role,
                    "content": request.content,
                }
            )
            .execute()
        )

        # First user message becomes the chat title (single conditional update).
        if request.role == "user":
            title = request.content.strip()
            if len(title) > 35:
                title = title[:35] + "..."
            (
                supabase.table("chats")
                .update({"title": title})
                .eq("chat_id", chat_id)
                .eq("user_id", user_id)
                .eq("title", "New chat")
                .execute()
            )
        return result.data[0]
    except Exception as exc:
        raise server_error("Failed to save message.", exc)


@app.get("/chats/{chat_id}/messages", tags=["Messages"])
def list_messages(chat_id: str, user_id: str = Depends(get_current_user_id)):
    require_chat(chat_id, user_id)
    try:
        return (
            supabase.table("chat_messages")
            .select("*")
            .eq("chat_id", chat_id)
            .order("created_at", desc=False)
            .execute()
            .data
        )
    except Exception as exc:
        raise server_error("Failed to list messages.", exc)


# ============================================================
# DOCUMENTS: UPLOAD (fast) + BACKGROUND PROCESSING (slow)
# ============================================================


def set_document(document_id: str, **fields) -> None:
    fields["updated_at"] = utc_now()
    supabase.table("documents").update(fields).eq("document_id", document_id).execute()


PROCESS_STALL_SECONDS = 10 * 60
STALLED_MESSAGE = "Processing stopped responding. Please delete this file and upload it again."


def is_stalled(updated_at: str | None) -> bool:
    if not updated_at:
        return False
    try:
        last = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    except ValueError:
        return False  # unparsable timestamp: never guess "failed"
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - last).total_seconds() > PROCESS_STALL_SECONDS


def safe_storage_name(filename: str) -> str:
    """Supabase storage keys reject many characters (spaces, unicode, ...)."""
    stem, ext = os.path.splitext(filename)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._") or "document"
    return f"{stem[:80]}{ext.lower()}"


def process_document(
    document_id: str, chat_id: str,filename: str,storage_path: str,contents: bytes,
) -> None:
    """Runs in a worker thread AFTER the upload response was sent."""
    try:
        set_document(document_id, stage="extracting")
        text = extract_text(filename, contents)
        if not text.strip():
            raise ValueError(
                "No readable text found. Scanned/image-only files are not supported."
            )

        chunks = split_text_into_chunks(
            text=text, chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP
        )["chunks"]
        if not chunks:
            raise ValueError("The document produced no text chunks.")

        total = len(chunks)
        set_document(document_id, stage="indexing", total_chunks=total, processed_chunks=0)

        for start in range(0, total, PROCESS_BATCH):
            batch = chunks[start : start + PROCESS_BATCH]
            vectors = embedding_manager.embed_chunks(batch, batch_size=8)
            if len(vectors) != len(batch):
                raise RuntimeError("Chunk count and embedding count do not match.")

            chunk_rows, embedding_rows = [], []
            for offset, (content, vector) in enumerate(zip(batch, vectors)):
                vector = [float(v) for v in vector]
                if len(vector) != embedding_manager.DIMENSION:
                    raise RuntimeError(
                        f"Invalid embedding dimension: expected "
                        f"{embedding_manager.DIMENSION}, got {len(vector)}"
                    )
                chunk_id = str(uuid.uuid4())
                chunk_rows.append(
                    {
                        "chunk_id": chunk_id,
                        "chat_id": chat_id,
                        "document_id": document_id,
                        "chunk_index": start + offset,
                        "content": content,
                    }
                )
                embedding_rows.append(
                    {
                        "pgvector_id": str(uuid.uuid4()),
                        "chat_id": chat_id,
                        "document_id": document_id,
                        "chunk_id": chunk_id,
                        "embedding": vector,
                    }
                )

            # one round trip per table per batch (was 2 per chunk)
            supabase.table("document_chunks").insert(chunk_rows).execute()
            supabase.table("document_embeddings").insert(embedding_rows).execute()
            set_document(document_id, processed_chunks=start + len(batch))

        set_document(document_id, status="ready", stage="done", processed_chunks=total)
        logger.info("Document %s ready (%d chunks)", document_id, total)

    except Exception as exc:
        logger.exception("Processing failed for document %s", document_id)
                # Remove the original file from Storage when processing fails.
        try:
            supabase.storage.from_(SUPABASE_BUCKET).remove([storage_path])
        except Exception:
            logger.warning(
                "Storage cleanup failed for document %s",
                document_id,
            )
        message = (
            str(exc)
            if isinstance(exc, ValueError)
            else "Processing failed unexpectedly. Please try again."
        )
        # remove partial data so a failed file never pollutes retrieval
        for table in ("document_embeddings", "document_chunks"):
            try:
                supabase.table(table).delete().eq("document_id", document_id).execute()
            except Exception:
                pass
        try:
            set_document(
                document_id,
                status="error",
                stage="failed",
                error_message=message[:300],
            )
        except Exception:
            logger.exception("Could not mark document %s as failed", document_id)


# NOTE: plain `def` (not async) -> FastAPI runs it in a worker thread, so the
# blocking Supabase/storage calls no longer freeze the event loop.
@app.post("/documents/upload", status_code=202, tags=["Documents"])
def upload_document(
    background_tasks: BackgroundTasks,
    chat_id: str | None = Form(None),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
):
    # A document always belongs to an EXISTING chat of the caller. Check that
    # first (cheap) so a bad request never makes us read a 25MB body.
    if not chat_id:
        raise HTTPException(
            status_code=400,
            detail="chat_id is required. Select a chat before uploading a document.",
        )
    require_chat(chat_id, user_id)

    filename = os.path.basename(file.filename or "document")
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Supported types: PDF, DOCX, TXT, MD.",
        )

    contents = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)}MB.",
        )

    document_id = str(uuid.uuid4())
    storage_path = f"{chat_id}/{document_id}/{safe_storage_name(filename)}"
    stored = False

    try:
        supabase.storage.from_(SUPABASE_BUCKET).upload(
            path=storage_path,
            file=contents,
            file_options={
                "content-type": file.content_type or "application/octet-stream",
                "upsert": "false",
            },
        )
        stored = True

        supabase.table("documents").insert(
            {
                "document_id": document_id,
                "chat_id": chat_id,
                "filename": filename,
                "storage_path": storage_path,
                "file_size": len(contents),
                "status": "processing",
                "stage": "queued",
                "processed_chunks": 0,
            }
        ).execute()
    except Exception as exc:
        if stored:
            try:
                supabase.storage.from_(SUPABASE_BUCKET).remove([storage_path])
            except Exception:
                pass
        raise server_error("Failed to store the document.", exc)

    background_tasks.add_task(
        process_document, document_id, chat_id, filename, storage_path, contents
    )

    # 202 = "accepted, processing has started". NOT ready: the UI must keep
    # polling GET /documents until status == "ready".
    return {
        "status": "processing",
        "chat_id": chat_id,
        "document_id": document_id,
        "filename": filename,
        "file_size": len(contents),
    }


@app.get("/documents", tags=["Documents"])
def list_documents(chat_id: str, user_id: str = Depends(get_current_user_id)):
    require_chat(chat_id, user_id)
    try:
        rows = (
            supabase.table("documents")
            .select(
                "document_id, chat_id, filename, file_size, status, stage, "
                "total_chunks, processed_chunks, error_message, created_at, updated_at"
            )
            .eq("chat_id", chat_id)
            .order("created_at", desc=True)
            .execute()
            .data
            or []
        )
    except Exception as exc:
        raise server_error("Failed to list documents.", exc)

    documents = []
    for row in rows:
        # Watchdog: a worker that died without reporting (hung model, killed
        # thread) must not leave a spinner forever. Progress updates every few
        # seconds, so no update for PROCESS_STALL_SECONDS means it is dead.
        if row["status"] == "processing" and is_stalled(row.get("updated_at")):
            try:
                # only if it is STILL processing: a worker that finished a moment
                # ago must not have its "ready" overwritten with "failed"
                changed = (
                    supabase.table("documents")
                    .update(
                        {
                            "status": "error",
                            "stage": "failed",
                            "error_message": STALLED_MESSAGE,
                            "updated_at": utc_now(),
                        }
                    )
                    .eq("document_id", row["document_id"])
                    .eq("status", "processing")
                    .execute()
                    .data
                )
            except Exception:
                logger.exception("Could not persist stalled state for %s", row["document_id"])
                changed = True  # cannot save it, but still report the failure
            if changed:
                row["status"], row["stage"] = "error", "failed"
                row["error_message"] = STALLED_MESSAGE

        total = row.get("total_chunks") or 0
        done = row.get("processed_chunks") or 0
        if row["status"] == "ready":
            progress = 100
        elif total:
            progress = min(99, int(done * 100 / total))
        else:
            progress = 0
        documents.append(
            {
                "id": row["document_id"],
                "chat_id": row["chat_id"],
                "name": row["filename"],
                "filename": row["filename"],
                "size": row["file_size"],
                "status": row["status"],
                "stage": row.get("stage"),
                "progress": progress,
                "total_chunks": total,
                "processed_chunks": done,
                "error": row.get("error_message"),
                "uploaded_at": row["created_at"],
            }
        )
    return documents


@app.delete("/documents/{document_id}", tags=["Documents"])
def delete_document(
    document_id: str, chat_id: str, user_id: str = Depends(get_current_user_id)
):
    require_chat(chat_id, user_id)
    validate_uuid(document_id, "document_id")
    try:
        found = (
            supabase.table("documents")
            .select("document_id, storage_path")
            .eq("document_id", document_id)
            .eq("chat_id", chat_id)
            .limit(1)
            .execute()
            .data
        )
        if not found:
            raise HTTPException(status_code=404, detail="Document not found in this chat.")

        # DB cascade removes chunks + embeddings
        (
            supabase.table("documents")
            .delete()
            .eq("document_id", document_id)
            .eq("chat_id", chat_id)
            .execute()
        )
        if found[0].get("storage_path"):
            try:
                supabase.storage.from_(SUPABASE_BUCKET).remove([found[0]["storage_path"]])
            except Exception:
                logger.warning("Storage cleanup failed for document %s", document_id)

        return {"message": "Document deleted.", "document_id": document_id, "chat_id": chat_id}
    except HTTPException:
        raise
    except Exception as exc:
        raise server_error("Failed to delete document.", exc)


# ============================================================
# RETRIEVAL (shared by /ask, /ask/stream, /search)
# ============================================================

_SUMMARY_NOISE = re.compile(
    r"\b(summar\w*|in\s+\d+\s*words?|this|the|whole|entire|document|book|file|pdf|"
    r"please|can|could|you|give|me|a|an|of|about|short|brief|briefly|my|to|in|for)\b"
)


def resolve_document_ids(request: AskRequest, user_id: str) -> list[str]:
    """Ownership check + keep only READY documents that belong to this chat."""
    require_chat(request.chat_id, user_id)
    wanted = list(
        dict.fromkeys(request.document_ids or ([request.document_id] if request.document_id else []))
    )
    if not wanted:
        return []
    rows = (
        supabase.table("documents")
        .select("document_id")
        .eq("chat_id", request.chat_id)
        .eq("status", "ready")
        .in_("document_id", wanted)
        .execute()
        .data
        or []
    )
    ready = {r["document_id"] for r in rows}
    return [d for d in wanted if d in ready]


def load_all_chunks(chat_id: str, document_ids: list[str]) -> list[dict]:
    rows: list[dict] = []
    for document_id in document_ids:
        rows.extend(
            supabase.table("document_chunks")
            .select("chunk_index, content")
            .eq("chat_id", chat_id)
            .eq("document_id", document_id)
            .order("chunk_index")
            .execute()
            .data
            or []
        )
    # very long documents: sample evenly so the prompt stays within context
    if len(rows) > MAX_SUMMARY_CHUNKS:
        step = len(rows) / MAX_SUMMARY_CHUNKS
        rows = [rows[int(i * step)] for i in range(MAX_SUMMARY_CHUNKS)]
    return rows


def search_similar_chunks(
    query: str, chat_id: str, document_ids: list[str], top_k: int = 5
) -> list[dict]:
    embedding = [float(v) for v in embedding_manager.embed_chunks([query])[0]]
    results: list[dict] = []
    for document_id in document_ids:
        response = supabase.rpc(
            "match_document_chunks",
            {
                "query_embedding": embedding,
                "match_chat_id": chat_id,
                "match_document_id": document_id,
                "match_count": top_k,
            },
        ).execute()
        results.extend(response.data or [])
    if len(document_ids) > 1:
        results.sort(key=lambda r: r.get("similarity", 0), reverse=True)
        results = results[:top_k]
    return results


def retrieve_chunks(
    query: str, chat_id: str, document_ids: list[str], top_k: int
) -> list[dict]:
    if not document_ids:
        return []

    lowered = query.lower()
    if "summar" in lowered:
        scope = _SUMMARY_NOISE.sub(" ", lowered)
        scope = " ".join(re.sub(r"[^\w\s]", " ", scope).split())
        if not scope:
            return load_all_chunks(chat_id, document_ids)  # whole document
        return search_similar_chunks(scope, chat_id, document_ids, top_k=8)

    return search_similar_chunks(query, chat_id, document_ids, top_k=top_k)


DOC_SYSTEM = (
    "You are DocuMind, a document question-answering assistant. "
    "Answer only from the provided document context."
)

CHAT_SYSTEM = (
    "You are DocuMind, an AI document assistant. No document is currently selected. "
    "Never claim to have searched the internet, websites, LinkedIn or databases; "
    "if asked to, say web search is not available in DocuMind. "
    "Never invent links, profiles or search results. "
    "If the question is about an uploaded document, ask the user to select or "
    "upload it. Respect any word limit. Be concise and helpful."
)


def build_messages(query: str, results: list[dict], has_documents: bool) -> list[dict]:
    if not has_documents:
        return [
            {"role": "system", "content": CHAT_SYSTEM},
            {"role": "user", "content": query},
        ]

    context = "\n\n".join(f"[Chunk {r['chunk_index']}]\n{r['content']}" for r in results)
    prompt = f"""Answer the user's question using ONLY the document context below.

Rules:
1. Use only information supported by the context. Do not invent or assume.
2. If the answer is not in the context, say: "I could not find that information in the uploaded document."
3. Answer clearly and directly.
4. For summaries, summarize only the provided context.
5. If the user gives a word limit, stay within it.

DOCUMENT CONTEXT:
{context}

USER QUESTION:
{query}"""
    return [
        {"role": "system", "content": DOC_SYSTEM},
        {"role": "user", "content": prompt},
    ]


def sse(data: str) -> str:
    return f"data: {json.dumps(data)}\n\n"


@app.post("/ask", tags=["Ask"])
def ask_question(request: AskRequest, user_id: str = Depends(get_current_user_id)):
    document_ids = resolve_document_ids(request, user_id)
    try:
        results = retrieve_chunks(request.query, request.chat_id, document_ids, request.top_k)
    except Exception as exc:
        raise server_error("Retrieval failed.", exc)

    if document_ids and not results:
        return {"answer": "I could not find relevant information in the document.", "sources": []}

    client = get_groq()
    try:
        completion = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=build_messages(request.query, results, bool(document_ids)),
            temperature=0,
        )
        return {"answer": completion.choices[0].message.content, "sources": results}
    except Exception as exc:
        raise server_error("LLM call failed.", exc)


@app.post("/ask/stream", tags=["Ask"])
def ask_question_stream(
    request: AskRequest, user_id: str = Depends(get_current_user_id)
):
    document_ids = resolve_document_ids(request, user_id)
    try:
        results = retrieve_chunks(request.query, request.chat_id, document_ids, request.top_k)
    except Exception as exc:
        raise server_error("Retrieval failed.", exc)

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }

    if document_ids and not results:

        def empty():
            yield sse("I could not find relevant information in the document.")
            yield "data: [DONE]\n\n"

        return StreamingResponse(empty(), media_type="text/event-stream", headers=headers)

    client = get_groq()
    messages = build_messages(request.query, results, bool(document_ids))

    def generate():
        try:
            completion = client.chat.completions.create(
                model=GROQ_MODEL, messages=messages, temperature=0, stream=True
            )
            for part in completion:
                if not part.choices:
                    continue
                text = part.choices[0].delta.content
                if text:
                    yield sse(text)

            yield f"event: sources\ndata: {json.dumps(results)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception:
            logger.exception("LLM streaming failed")
            yield f"event: error\ndata: {json.dumps('The AI service failed to answer. Please try again.')}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream", headers=headers)


@app.post("/search", tags=["Ask"])
def search_documents(
    request: SearchRequest, user_id: str = Depends(get_current_user_id)
):
    ask = AskRequest(
        query=request.query,
        chat_id=request.chat_id,
        document_ids=[request.document_id],
        top_k=request.top_k,
    )
    document_ids = resolve_document_ids(ask, user_id)
    try:
        results = retrieve_chunks(request.query, request.chat_id, document_ids, request.top_k)
    except Exception as exc:
        raise server_error("Search failed.", exc)
    return {
        "query": request.query,
        "chat_id": request.chat_id,
        "document_id": request.document_id,
        "results": results,
    }


# ============================================================
# UTILITIES
# ============================================================


@app.post("/chunk", tags=["Chunking"])
def chunk_text(request: ChunkRequest, user_id: str = Depends(get_current_user_id)):
    if request.chunk_overlap >= request.chunk_size:
        raise HTTPException(
            status_code=422, detail="chunk_overlap must be strictly less than chunk_size."
        )
    try:
        result = split_text_into_chunks(
            text=request.text,
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise server_error("Chunking failed.", exc)

    return {
        "chunk_size": request.chunk_size,
        "chunk_overlap": request.chunk_overlap,
        "total_chunks": result["total_chunks"],
        "chunks": result["chunks"],
    }


@app.post("/llm-query", tags=["LLM"])
def llm_query(request: LLMQueryRequest, user_id: str = Depends(get_current_user_id)):
    client = get_groq()
    try:
        completion = client.chat.completions.create(
            model=request.model or GROQ_MODEL,
            messages=[{"role": "user", "content": request.query}],
        )
        return {
            "query": request.query,
            "model": request.model or GROQ_MODEL,
            "answer": completion.choices[0].message.content,
        }
    except Exception as exc:
        raise server_error("LLM call failed.", exc)