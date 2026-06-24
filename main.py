
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
import os
import re
 
from chunk import split_text_into_chunks
 
# ── Optional: Groq LLM support ──────────────────────────────────────────────
try:
    from groq import Groq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False
 
app = FastAPI(
    title="Assignment 3 – FastAPI Text Chunker",
    description=(
        "A FastAPI application that splits large texts into chunks using "
        "RecursiveCharacterTextSplitter, with optional LLM query support via Groq."
    ),
    version="1.0.0",
)
 
 
# ── Pydantic models ──────────────────────────────────────────────────────────
 
class ChunkRequest(BaseModel):
    text: str = Field(..., min_length=1, description="The large text to split into chunks.")
    chunk_size: Optional[int] = Field(50, gt=0, description="Maximum size of each chunk.")
    chunk_overlap: Optional[int] = Field(10, ge=0, description="Overlap between consecutive chunks.")
 
 
class LLMQueryRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Question to send to the LLM.")
    model: Optional[str] = Field("llama3-8b-8192", description="Groq model name to use.")
 
 
# ── Endpoints ────────────────────────────────────────────────────────────────
 
@app.get("/", tags=["General"])
def welcome():
    """Welcome endpoint – GET /"""
    return {
        "message": "Welcome to the FastAPI Text Chunker API!",
        "endpoints": {
            "GET  /": "This welcome message.",
            "POST /chunk": "Split a large text into chunks.",
            "POST /llm-query": "Ask a question answered by Groq LLM.",
            "GET  /health": "Health check.",
        },
    }
 
 
@app.get("/health", tags=["General"])
def health_check():
    """Simple health check endpoint."""
    return {"status": "ok"}
 
 
@app.post("/chunk", tags=["Chunking"])
def chunk_text(request: ChunkRequest):
    """
    Accepts a large text and optional chunk_size / chunk_overlap parameters.
    Returns the generated chunks and the total number of chunks.
    """
    # Extra validation: overlap must be < chunk_size
    if request.chunk_overlap >= request.chunk_size:
        raise HTTPException(
            status_code=422,
            detail="chunk_overlap must be strictly less than chunk_size.",
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
        raise HTTPException(status_code=500, detail=f"Chunking failed: {str(exc)}")
 
    return {
        "chunk_size": request.chunk_size,
        "chunk_overlap": request.chunk_overlap,
        "total_chunks": result["total_chunks"],
        "chunks": result["chunks"],
    }
 
 
@app.post("/llm-query", tags=["LLM"])
def llm_query(request: LLMQueryRequest):
    """
    Accepts a query string and returns an answer from the Groq LLM.
    Requires the GROQ_API_KEY environment variable to be set.
    """
    if not GROQ_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Groq library is not installed. Add 'groq' to requirements.txt.",
        )
 
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY environment variable is not set.",
        )
 
    try:
        client = Groq(api_key=api_key)
        completion = client.chat.completions.create(
            model=request.model,
            messages=[{"role": "user", "content": request.query}],
        )
        answer = completion.choices[0].message.content
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"LLM call failed: {str(exc)}")
 
    return {
        "query": request.query,
        "model": request.model,
        "answer": answer,
    }
 