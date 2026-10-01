from sentence_transformers import SentenceTransformer
from typing import List


class EmbeddingManager:
    """
    Generates 384-dimensional embeddings using
    all-MiniLM-L6-v2.
    """

    MODEL_NAME = "all-MiniLM-L6-v2"
    DIMENSION = 384

    def __init__(self):
        self.model = SentenceTransformer(self.MODEL_NAME)

    def embed_text(self, text: str) -> List[float]:
        """Generate an embedding for a single text."""
        if not text or not text.strip():
            raise ValueError("Text must be a non-empty string.")

        embedding = self.model.encode(
            text,
            normalize_embeddings=True
        )

        return embedding.tolist()

    def embed_chunks(
        self,
        chunks: List[str],
        batch_size: int = 32
    ) -> List[List[float]]:
        """Generate embeddings for multiple chunks."""
        if not chunks:
            return []

        embeddings = self.model.encode(
            chunks,
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=False
        )

        return embeddings.tolist()

    def dimension(self) -> int:
        """Return embedding dimension."""
        return self.DIMENSION


# Create one reusable instance
embedding_manager = EmbeddingManager()