from langchain_text_splitters import RecursiveCharacterTextSplitter


def split_text_into_chunks(text: str, chunk_size: int = 50, chunk_overlap: int = 10) -> dict:
    if not text or not text.strip():
        raise ValueError("Input text must be a non-empty string.")

    if chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer.")

    if chunk_overlap < 0:
        raise ValueError("chunk_overlap must be a non-negative integer.")

    if chunk_overlap >= chunk_size:
        raise ValueError("chunk_overlap must be less than chunk_size.")

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )

    chunks = splitter.split_text(text)

    return {
        "chunks": chunks,
        "total_chunks": len(chunks),
    }