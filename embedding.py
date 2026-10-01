from fastembed import TextEmbedding
from typing import List


class EmbeddingManager:
    """
    Generates 384-dimensional embeddings using
    BAAI/bge-small-en-v1.5 through FastEmbed.
    """

    MODEL_NAME = "BAAI/bge-small-en-v1.5"
    DIMENSION = 384

    def __init__(self):
        self.model = None

    def _get_model(self):
        if self.model is None:
            self.model = TextEmbedding(
                model_name=self.MODEL_NAME
            )

        return self.model

    def embed_text(self, text: str) -> List[float]:
        """Generate an embedding for a single text."""

        if not text or not text.strip():
            raise ValueError("Text must be a non-empty string.")

        model = self._get_model()

        embedding = list(
            model.embed([text])
        )[0]

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

        embeddings = list(
            model.embed(
                chunks,
                batch_size=batch_size
            )
        )

        return [embedding.tolist() for embedding in embeddings]


embedding_manager = EmbeddingManager()