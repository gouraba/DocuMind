from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi import Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
from dotenv import load_dotenv
from io import BytesIO
import os
import uuid
from datetime import datetime
from supabase import create_client, Client
from pypdf import PdfReader
from docx import Document as DocxDocument
from chunk import split_text_into_chunks
from fastapi import Header
from embedding import embedding_manager
import json
# =======================================
# =====================
# ENVIRONMENT
# ============================================================
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
    raise RuntimeError(
        "Supabase environment variables are not set."
    )

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
)

SUPABASE_BUCKET = "documents"
# ============================================================
# GROQ
# ============================================================

try:
    from groq import Groq

    GROQ_AVAILABLE = True

except ImportError:
    GROQ_AVAILABLE = False


# ============================================================
# FASTAPI
# ============================================================

app = FastAPI(
    title="DocuMind – FastAPI Text Chunker",
    description=(
        "DocuMind RAG backend with document chunking, "
        "embeddings, Supabase Storage, pgvector and Groq."
    ),
    version="2.0.0",
)


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# PYDANTIC MODELS
# ============================================================


class ChunkRequest(BaseModel):

    text: str = Field(
        ...,
        min_length=1,
        description="The large text to split into chunks."
    )

    chunk_size: Optional[int] = Field(
        50,
        gt=0,
        description="Maximum size of each chunk."
    )

    chunk_overlap: Optional[int] = Field(
        10,
        ge=0,
        description="Overlap between consecutive chunks."
    )


class LLMQueryRequest(BaseModel):

    query: str = Field(
        ...,
        min_length=1,
        description="Question to send to the LLM."
    )

    model: Optional[str] = Field(
        "llama3-8b-8192",
        description="Groq model name to use."
    )


class ChatCreateRequest(BaseModel):

    chat_id: Optional[str] = None

    title: Optional[str] = "New chat"


# ============================================================
# TEXT EXTRACTION
# ============================================================


def extract_text(
    filename: str,
    contents: bytes
) -> str:

    extension = os.path.splitext(
        filename
    )[1].lower()


    # --------------------------------------------------------
    # PDF
    # --------------------------------------------------------

    if extension == ".pdf":

        reader = PdfReader(
            BytesIO(contents)
        )

        pages = []

        for page in reader.pages:

            text = page.extract_text() or ""

            if text.strip():

                pages.append(text)

        return "\n\n".join(pages)


    # --------------------------------------------------------
    # DOCX
    # --------------------------------------------------------

    if extension == ".docx":

        document = DocxDocument(
            BytesIO(contents)
        )

        paragraphs = []

        for paragraph in document.paragraphs:

            if paragraph.text.strip():

                paragraphs.append(
                    paragraph.text
                )

        return "\n\n".join(paragraphs)


    # --------------------------------------------------------
    # TXT / MD
    # --------------------------------------------------------

    if extension in [".txt", ".md"]:

        return contents.decode(
            "utf-8",
            errors="ignore"
        )


    raise ValueError(
        "Unsupported file type. "
        "Supported types: PDF, DOCX, TXT, MD."
    )


# ============================================================
# GENERAL
# ============================================================


@app.get(
    "/",
    tags=["General"]
)
def welcome():

    return {

        "message": "Welcome to the DocuMind API!",

        "endpoints": {

            "GET  /":
                "Welcome message.",

            "GET  /health":
                "Health check.",

            "POST /chats":
                "Create a chat.",

            "GET  /chats":
                "List chats.",

            "POST /chunk":
                "Split text into chunks.",

            "POST /documents/upload":
                "Upload, chunk and embed a document.",

            "GET  /documents":
                "List documents for a chat.",

            "DELETE /documents/{document_id}":
                "Delete document and its chunks/embeddings.",

            "POST /llm-query":
                "Ask the Groq LLM."
        }
    }


@app.get(
    "/health",
    tags=["General"]
)
def health_check():

    return {

        "status": "ok",

        "embedding_model":
            embedding_manager.MODEL_NAME,

        "embedding_dimension":
            embedding_manager.DIMENSION
    }


# ============================================================
# CHATS
# ============================================================

def get_current_user_id(authorization: str = Header(...)):
    try:
        if not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=401,
                detail="Invalid authorization header"
            )

        token = authorization.replace("Bearer ", "", 1).strip()

        response = supabase.auth.get_user(token)

        if not response.user:
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired token"
            )

        return response.user.id

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Authentication failed: {str(exc)}"
        )
@app.post(
    "/chats",
    tags=["Chats"]
)
def create_chat(
    request: ChatCreateRequest,
    user_id: str = Depends(get_current_user_id)
):
    chat_id = (
        request.chat_id
        or str(uuid.uuid4())
    )
    title = (
        request.title
        or "New chat"
    )
    try:
        existing = (
            supabase
            .table("chats")
            .select("chat_id")
            .eq("chat_id", chat_id)
            .eq("user_id", user_id)
            .execute()
        )
        if existing.data:
            return {
                "chat_id": chat_id,
                "title": title,
                "existing": True
            }
        supabase.table(
            "chats"
        ).insert({
            "chat_id": chat_id,
            "title": title,
            "user_id": user_id
        }).execute()
        return {
            "chat_id": chat_id,
            "title": title,
            "existing": False
        }
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to create chat: {str(exc)}"
            )
        )
@app.get(
    "/chats",
    tags=["Chats"]
)
def list_chats(
    user_id: str = Depends(get_current_user_id)
):
    try:
        result = (
            supabase
            .table("chats")
            .select("*")
            .eq("user_id", user_id)
            .order(
                "updated_at",
                desc=True
            )
            .execute()
        )
        return result.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to list chats: {str(exc)}"
            )
        )
class MessageCreateRequest(BaseModel):
    role: str
    content: str


@app.post("/chats/{chat_id}/messages", tags=["Messages"])
def save_message(
    chat_id: str,
    request: MessageCreateRequest,
    user_id: str = Depends(get_current_user_id)
):
    try:
    # Make sure this chat belongs to the logged-in user
        chat = (
            supabase
            .table("chats")
            .select("chat_id")
            .eq("chat_id", chat_id)
            .eq("user_id", user_id)
            .execute()
        )

        if not chat.data:
            raise HTTPException(
                status_code=404,
                detail="Chat not found."
            )

        result = (
            supabase
            .table("chat_messages")
            .insert({
                "chat_id": chat_id,
                "role": request.role,
                "content": request.content
            })
            .execute()
        )
    # Save the first user message as the chat title
        if request.role == "user":
            chat_info = (
                supabase
                .table("chats")
                .select("title")
                .eq("chat_id", chat_id)
                .eq("user_id", user_id)
                .execute()
            )
            if chat_info.data:
                current_title = chat_info.data[0].get("title")
                if not current_title or current_title == "New chat":
                    title = request.content.strip()
                    if len(title) > 35:
                        title = title[:35] + "..."
                    (
                        supabase
                        .table("chats")
                        .update({"title": title})
                        .eq("chat_id", chat_id)
                        .eq("user_id", user_id)
                        .execute()
                    )
        return result.data[0]

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save message: {str(exc)}"
    )
@app.delete("/chats", tags=["Chats"])
def delete_all_chats(
    user_id: str = Depends(get_current_user_id)
):
    try:
        # Get all chats belonging to the logged-in user
        chats = (
            supabase
            .table("chats")
            .select("chat_id")
            .eq("user_id", user_id)
            .execute()
        )

        chat_ids = [chat["chat_id"] for chat in (chats.data or [])]

        deleted_count = 0

        # Delete each chat using the existing delete logic
        for chat_id in chat_ids:
            delete_chat(chat_id)

            deleted_count += 1

        return {
            "message": "All chats and associated data deleted.",
            "deleted_chats": deleted_count
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete all chats: {str(exc)}"
        )
@app.get("/chats/{chat_id}/messages", tags=["Messages"])
def list_messages(
    chat_id: str,
    user_id: str = Depends(get_current_user_id)
):
    try:
        # Make sure this chat belongs to the logged-in user
        chat = (
            supabase
            .table("chats")
            .select("chat_id")
            .eq("chat_id", chat_id)
            .eq("user_id", user_id)
            .execute()
        )

        if not chat.data:
            raise HTTPException(
                status_code=404,
                detail="Chat not found."
            )

        result = (
            supabase
            .table("chat_messages")
            .select("*")
            .eq("chat_id", chat_id)
            .order("created_at", desc=False)
            .execute()
        )

        return result.data

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list messages: {str(exc)}"
        )
@app.delete(
    "/chats/{chat_id}",
    tags=["Chats"]
)
def delete_chat(chat_id: str):
    try:
        documents = (
            supabase
            .table("documents")
            .select("document_id, storage_path")
            .eq("chat_id", chat_id)
            .execute()
        )
        if documents.data:
            storage_paths = [
                document["storage_path"]
                for document in documents.data
            ]
            storage_result = (
                supabase
                .storage
                .from_(SUPABASE_BUCKET)
                .remove(storage_paths)
            )

            print(
                "CHAT STORAGE DELETE RESULT:",
                storage_result
            )

        result = (
            supabase
            .table("chats")
            .delete()
            .eq("chat_id", chat_id)
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=404,
                detail="Chat not found."
            )

        return {
            "message": "Chat and all associated data deleted.",
            "chat_id": chat_id,
            "documents_deleted": len(documents.data or [])
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete chat: {str(exc)}"
        )
# ============================================================
# OLD CHUNK ENDPOINT
# ============================================================


@app.post(
    "/chunk",
    tags=["Chunking"]
)
def chunk_text(
    request: ChunkRequest
):

    if request.chunk_overlap >= request.chunk_size:

        raise HTTPException(

            status_code=422,

            detail=(
                "chunk_overlap must be "
                "strictly less than chunk_size."
            )
        )


    try:

        result = split_text_into_chunks(

            text=request.text,

            chunk_size=request.chunk_size,

            chunk_overlap=request.chunk_overlap
        )


    except ValueError as exc:

        raise HTTPException(

            status_code=422,

            detail=str(exc)
        )


    except Exception as exc:

        raise HTTPException(

            status_code=500,

            detail=(
                f"Chunking failed: {str(exc)}"
            )
        )


    return {

        "chunk_size":
            request.chunk_size,

        "chunk_overlap":
            request.chunk_overlap,

        "total_chunks":
            result["total_chunks"],

        "chunks":
            result["chunks"]
    }
class AskRequest(BaseModel):
    query: str
    chat_id: str
    document_id: str | None = None
    top_k: int = 3

@app.post("/ask")
def ask_question(request: AskRequest):
    import re
    query_lower = request.query.lower()
    is_summary_request = "summar" in query_lower
    if is_summary_request:
        word_match = re.search(
            r"(\d+)\s*words?",
            query_lower
        )
        requested_words = None
        if word_match:
            requested_words = int(word_match.group(1))
        scope_query = re.sub(
            r"\b(summarize|summarise|summary|summarization)\b",
            "",
            query_lower
        )
        scope_query = re.sub(
            r"\bin\s+\d+\s*words?\b",
            "",
            scope_query
        )
        scope_query = re.sub(
            r"\b(this|the|whole|entire|document|book|file)\b",
            "",
            scope_query
        )

        scope_query = scope_query.strip()
        if not scope_query:

            response = (
                supabase
                .table("document_chunks")
                .select("chunk_index, content")
                .eq("chat_id", request.chat_id)
                .eq("document_id", request.document_id)
                .order("chunk_index")
                .execute()
            )

            results = response.data or []

            print("SUMMARY MODE: WHOLE DOCUMENT")
            print("TOTAL CHUNKS:", len(results))
        else:

            results = search_similar_chunks(
                query=scope_query,
                chat_id=request.chat_id,
                document_id=request.document_id,
                top_k=8
            )

            print("SUMMARY MODE: SPECIFIC PART")
            print("TARGET:", scope_query)
            print("RESULTS FOUND:", len(results))

    else:
        results = search_similar_chunks(
            query=request.query,
            chat_id=request.chat_id,
            document_id=request.document_id,
            top_k=request.top_k
        )

        print("NORMAL RAG MODE")
        print("RESULTS FOUND:", len(results))

    print("QUERY:", request.query)
    print("CHAT ID:", request.chat_id)
    print("DOCUMENT ID:", request.document_id)

    if not results:
        return {
            "answer": "I could not find relevant information in the document.",
            "sources": []
        }
    # --------------------------------------------------------
    # 2. BUILD CONTEXT FROM RETRIEVED CHUNKS
    # --------------------------------------------------------

    context = "\n\n".join(
        [
            f"[Chunk {item['chunk_index']}]\n{item['content']}"
            for item in results
        ]
    )

    # --------------------------------------------------------
    # 3. CHECK GROQ
    # --------------------------------------------------------

    if not GROQ_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Groq library is not installed."
        )

    api_key = os.getenv("GROQ_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is not set."
        )

    # --------------------------------------------------------
    # 4. SEND CONTEXT + QUESTION TO LLM
    # --------------------------------------------------------

    prompt = f"""
Answer the user's question using ONLY the context provided below.

If the answer is not present in the context, say:
"I could not find that information in the uploaded document."

Do not invent information.

CONTEXT:
{context}

USER QUESTION:
{request.query}
"""

    try:

        client = Groq(api_key=api_key)

        completion = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a document question-answering assistant. "
                        "Answer only from the provided document context."
                    )
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            temperature=0
        )

        answer = completion.choices[0].message.content

    except Exception as exc:

        raise HTTPException(
            status_code=500,
            detail=f"LLM call failed: {str(exc)}"
        )
    return {
        "answer": answer,
        "sources": results
    }
@app.post("/ask/stream")
def ask_question_stream(request: AskRequest):
    import re

    query_lower = request.query.lower()
    is_summary_request = "summar" in query_lower
    if is_summary_request:

        word_match = re.search(
            r"(\d+)\s*words?",
            query_lower
        )
        requested_words = None
        if word_match:
            requested_words = int(word_match.group(1))

        scope_query = re.sub(
            r"\b(summarize|summarise|summary|summarization)\b",
            "",
            query_lower
        )

        scope_query = re.sub(
            r"\bin\s+\d+\s*words?\b",
            "",
            scope_query
        )

        scope_query = re.sub(
            r"\b(this|the|whole|entire|document|book|file)\b",
            "",
            scope_query
        )

        scope_query = scope_query.strip()

        if not scope_query:

            response = (
                supabase
                .table("document_chunks")
                .select("chunk_index, content")
                .eq("chat_id", request.chat_id)
                .eq("document_id", request.document_id)
                .order("chunk_index")
                .execute()
            )

            results = response.data or []

            print("SUMMARY MODE: WHOLE DOCUMENT")
            print("TOTAL CHUNKS:", len(results))

        else:

            results = search_similar_chunks(
                query=scope_query,
                chat_id=request.chat_id,
                document_id=request.document_id,
                top_k=8
            )

            print("SUMMARY MODE: SPECIFIC PART")
            print("TARGET:", scope_query)
            print("RESULTS FOUND:", len(results))

    else:
        if request.document_id:
            results = search_similar_chunks(
                query=request.query,
                chat_id=request.chat_id,
                document_id=request.document_id,
                top_k=request.top_k
            )

            print("NORMAL RAG MODE")
            print("RESULTS FOUND:", len(results))
        else:
            results = []

            print("NORMAL CHAT MODE")
            print("NO DOCUMENT SELECTED")

    print("QUERY:", request.query)
    print("CHAT ID:", request.chat_id)
    print("DOCUMENT ID:", request.document_id)

    if not results and request.document_id:

        def empty_response():
            yield f"data: {json.dumps('I could not find relevant information in the document.')}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            empty_response(),
            media_type="text/event-stream"
        )

    # --------------------------------------------------------
    # 2. BUILD CONTEXT
    # --------------------------------------------------------

    context = "\n\n".join(
        [
            f"[Chunk {item['chunk_index']}]\n{item['content']}"
            for item in results
        ]
    )

    # --------------------------------------------------------
    # 3. CHECK GROQ
    # --------------------------------------------------------

    if not GROQ_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Groq library is not installed."
        )

    api_key = os.getenv("GROQ_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is not set."
        )

    # --------------------------------------------------------
    # 4. BUILD PROMPT
    # --------------------------------------------------------

    if request.document_id:
        prompt = f"""
    You are DocuMind, an AI document question-answering assistant.

    Answer the user's question using ONLY the document context provided below.

    Rules:
    1. Use only information supported by the document context.
    2. Do not invent, assume, or add information that is not present in the context.
    3. If the answer cannot be found in the context, say:
    "I could not find that information in the uploaded document."
    4. Answer clearly and directly.
    5. If the user asks for a summary, summarize only the provided document context.
    6. If the user specifies a word limit, stay within that limit.
    7. If the user asks a follow-up question, use the available context to answer it.

    DOCUMENT CONTEXT:
    {context}

    USER QUESTION:
    {request.query}
    """
    else:
        prompt = f"""
    You are DocuMind, an AI document assistant.

    No document is currently selected.

    Your job is to help the user with their question while staying within
    the capabilities of DocuMind.

    Rules:
    1. Do not pretend that you searched or accessed the internet.
    2. Do not claim to have searched LinkedIn, Google, websites, databases,
    or other external sources.
    3. If the user asks you to search the internet or a specific website,
    clearly say that web search is not currently available in DocuMind.
    4. Do not invent search results, profiles, links, or external information.
    5. If the user asks a general conceptual question that can be answered
    without external browsing, answer it clearly and briefly.
    6. If the question is about an uploaded document but no document is
    selected, ask the user to select or upload the relevant document.
    7. If the user asks for a document-related task, prioritize the document
    workflow rather than acting like a general-purpose chatbot.
    8. If the user specifies a word limit, stay within that limit.
    9. Be concise and helpful.

    USER QUESTION:
    {request.query}
    """
    # --------------------------------------------------------
    # 5. STREAM GROQ RESPONSE
    # --------------------------------------------------------

    def generate():

        try:

            client = Groq(api_key=api_key)

            completion = client.chat.completions.create(
                model="openai/gpt-oss-20b",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a document question-answering assistant. "
                            "Answer only from the provided document context."
                        )
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0,
                stream=True
            )

            for chunk in completion:

                text = chunk.choices[0].delta.content

                if text:
                    yield f"data: {json.dumps(text)}\n\n"

            # Send sources after the answer
            yield f"event: sources\n"
            yield f"data: {json.dumps(results)}\n\n"

            # Tell frontend streaming is finished
            yield "data: [DONE]\n\n"

        except Exception as exc:

            error_message = f"LLM call failed: {str(exc)}"

            yield f"event: error\n"
            yield f"data: {json.dumps(error_message)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
def search_similar_chunks(
    query: str,
    chat_id: str,
    document_id: str,
    top_k: int = 5
):
    query_embedding = embedding_manager.embed_chunks(
        [query]
    )[0]

    query_embedding = [
        float(value)
        for value in query_embedding
    ]
    response = supabase.rpc(
        "match_document_chunks",
        {
            "query_embedding": query_embedding,
            "match_chat_id": chat_id,
            "match_document_id": document_id,
            "match_count": top_k
        }
    ).execute()

    return response.data
class SearchRequest(BaseModel):
    query: str
    chat_id: str
    document_id: str
    top_k: int = 5


@app.post("/search")
def search_documents(request: SearchRequest):

    is_summary_request = "summar" in request.query.lower()

    if is_summary_request:
        response = (
            supabase
            .table("document_chunks")
            .select("chunk_index, content")
            .eq("chat_id", request.chat_id)
            .eq("document_id", request.document_id)
            .order("chunk_index")
            .execute()
        )

        results = response.data or []

        print("SUMMARY REQUEST")
        print("TOTAL DOCUMENT CHUNKS:", len(results))

    else:
        results = search_similar_chunks(
            query=request.query,
            chat_id=request.chat_id,
            document_id=request.document_id,
            top_k=request.top_k
        )

        return {
            "query": request.query,
            "chat_id": request.chat_id,
            "document_id": request.document_id,
        "results": results
    }
# ============================================================
# DOCUMENT UPLOAD
# ============================================================


@app.post(
    "/documents/upload",
    tags=["Documents"]
)
async def upload_document(

    chat_id: str = Form(...),

    file: UploadFile = File(...)
):
    document_id = str(
        uuid.uuid4()
    )

    storage_path = None
    try:

        chat_result = (

            supabase
            .table("chats")
            .select("chat_id")
            .eq("chat_id", chat_id)
            .execute()
        )
        if not chat_result.data:
            raise HTTPException(
                 status_code=404,
                detail=(
                    "Chat not found. "
                    "Create the chat first."
                )
            )
        filename = (
            file.filename
            or "document"
        )
        contents = await file.read()
        if not contents:
            raise HTTPException(
                status_code=400,
                detail="Uploaded file is empty."
            )
        storage_path = (
            f"{chat_id}/"
            f"{document_id}/"
            f"{filename}"
        )
        supabase.storage.from_(
            SUPABASE_BUCKET
        ).upload(
            path=storage_path,
            file=contents,
            file_options={
                "content-type": (
                    file.content_type
                    or "application/octet-stream"
                ),
                "upsert": "false"
            }
        )
        supabase.table(
            "documents"
        ).insert({

            "document_id":
                document_id,

            "chat_id":
                chat_id,

            "filename":
                filename,

            "storage_path":
                storage_path,

            "file_size":
                len(contents),

            "status":
                "processing"

        }).execute()
        text = extract_text(
            filename,
            contents
        )
        if not text.strip():
            raise Exception(
                "No readable text could be extracted."
            )
        chunk_result = split_text_into_chunks(
            text=text,
            chunk_size=1000,
            chunk_overlap=150
        )
        chunks = chunk_result[
            "chunks"
        ]
        if not chunks:
            raise Exception(
                "No chunks were generated."
            )
        embeddings = (
            embedding_manager
            .embed_chunks(
                chunks,
                batch_size=32
            )
        )
        print("TOTAL CHUNKS:", len(chunks))
        print("TOTAL EMBEDDINGS:", len(embeddings))
        if len(chunks) != len(embeddings):
             raise Exception(
                "Chunk count and embedding count "
                "do not match."
            )
        for index, (chunk_content, vector) in enumerate(
            zip(chunks, embeddings)
        ):
            print("PROCESSING CHUNK:", index)
            chunk_id = str(uuid.uuid4())
            supabase.table("document_chunks").insert({
                "chunk_id": chunk_id,
                "chat_id": chat_id,
                "document_id": document_id,
                "chunk_index": index,
                "content": chunk_content
            }).execute()
            pgvector_id = str(uuid.uuid4())
            vector = [
                float(value)
                for value in vector
            ]
            if len(vector) != embedding_manager.DIMENSION:
                raise Exception(
                    f"Invalid embedding dimension: "
                    f"expected {embedding_manager.DIMENSION}, "
                    f"got {len(vector)}"
                )
            response = supabase.table(
                "document_embeddings"
            ).insert({
                "pgvector_id": pgvector_id,
                "chat_id": chat_id,
                "document_id": document_id,
                "chunk_id": chunk_id,
                "embedding": vector
            }).execute()

            print(
                "EMBEDDING SAVED FOR CHUNK:",
                index
            ) 
        supabase.table(
            "documents"
        ).update({

            "status":
                "ready"

        }).eq(
            "document_id",
            document_id
        ).execute()
        return {

            "status":
                "ready",

            "chat_id":
                chat_id,

            "document_id":
                document_id,

            "filename":
                filename,

            "file_size":
                len(contents),

            "storage_path":
                storage_path,

            "total_chunks":
                len(chunks),

            "embedding_model":
                embedding_manager.MODEL_NAME,

            "embedding_dimension":
                embedding_manager.DIMENSION,

            "message":
                "Document uploaded, chunked and embedded successfully."
        }
    except HTTPException:
        raise
    except Exception as exc:
        if storage_path:

            try:

                supabase.storage.from_(
                    SUPABASE_BUCKET
                ).remove([
                    storage_path
                ])

            except Exception:

                pass

        try:

            supabase.table(
                "documents"
            ).delete().eq(
                "document_id",
                document_id
            ).execute()

        except Exception:

            pass


        raise HTTPException(

            status_code=500,

            detail=(
                f"Document processing failed: "
                f"{str(exc)}"
            )
        )

@app.get(
    "/documents",
    tags=["Documents"]
)
def list_documents(
    chat_id: str
):
    try:
        result = (
            supabase
            .table("documents")
            .select("*")
            .eq(
                "chat_id",
                chat_id
            )
            .order(
                "created_at",
                desc=True
            )
            .execute()
        )
        documents = []
        for document in result.data:
            documents.append({
                "id":
                    document["document_id"],
                "name":
                    document["filename"],
                "filename":
                    document["filename"],
                "size":
                    document["file_size"],
                "status":
                    document["status"],
                "uploaded_at":
                    document["created_at"],
                "storage_path":
                    document["storage_path"],
                "chat_id":
                    document["chat_id"]
            })
        return documents
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to list documents: "
                f"{str(exc)}"
            )
        )


# ============================================================
# DELETE DOCUMENT — CHAT ISOLATED
# ============================================================


@app.delete(
    "/documents/{document_id}",
    tags=["Documents"]
)
def delete_document(

    document_id: str,

    chat_id: str
):

    try:

        result = (

            supabase
            .table("documents")
            .select("*")
            .eq(
                "document_id",
                document_id
            )
            .eq(
                "chat_id",
                chat_id
            )
            .execute()
        )


        if not result.data:

            raise HTTPException(

                status_code=404,

                detail=(
                    "Document not found "
                    "in this chat."
                )
            )


        document = result.data[0]


        # ====================================================
        # DELETE FILE FROM STORAGE
        # ====================================================

        storage_result = (
            supabase.storage
            .from_(SUPABASE_BUCKET)
            .remove([document["storage_path"]])
        )

        print("STORAGE DELETE RESULT:", storage_result)
        supabase.table(
            "documents"
        ).delete().eq(
            "document_id",
            document_id
        ).eq(
            "chat_id",
            chat_id
        ).execute()

        return {
            "message":
                "Document and its chunks/embeddings deleted.",
            "document_id":
                document_id,
            "chat_id":
                chat_id
        }
    except HTTPException:
        raise
    except Exception as exc:

        raise HTTPException(

            status_code=500,

            detail=(
                f"Failed to delete document: "
                f"{str(exc)}"
            )
        )


# ============================================================
# GROQ LLM
# ============================================================


@app.post(
    "/llm-query",
    tags=["LLM"]
)
def llm_query(
    request: LLMQueryRequest
):

    if not GROQ_AVAILABLE:

        raise HTTPException(

            status_code=503,

            detail=(
                "Groq library is not installed."
            )
        )


    if not GROQ_API_KEY:

        raise HTTPException(

            status_code=503,

            detail=(
                "GROQ_API_KEY environment variable "
                "is not set."
            )
        )


    try:

        client = Groq(
            api_key=GROQ_API_KEY
        )


        completion = (
            client
            .chat
            .completions
            .create(

                model=request.model,

                messages=[

                    {
                        "role":
                            "user",

                        "content":
                            request.query
                    }

                ]
            )
        )


        answer = (
            completion
            .choices[0]
            .message
            .content
        )


        return {

            "query":
                request.query,

            "model":
                request.model,

            "answer":
                answer
        }


    except Exception as exc:

        raise HTTPException(

            status_code=500,

            detail=(
                f"LLM call failed: "
                f"{str(exc)}"
            )
        )