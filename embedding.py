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
        # Don't load the model during application startup.
        self.model = None

    def _get_model(self):
        # Load the model only when an embedding is actually needed.
        if self.model is None:
            self.model = SentenceTransformer(self.MODEL_NAME)

        return self.model

    def embed_text(self, text: str) -> List[float]:
        """Generate an embedding for a single text."""

        if not text or not text.strip():
            raise ValueError("Text must be a non-empty string.")

        model = self._get_model()

        embedding = model.encode(
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

        model = self._get_model()

        embeddings = model.encode(
            chunks,
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=False
        )
        return embeddings.tolist()


embedding_manager = EmbeddingManager()