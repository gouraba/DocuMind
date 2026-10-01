# AI Text Chunker — Frontend

A Next.js frontend for your existing FastAPI backend (`/chunk`, `/llm-query`, `/health`, `/`).
This project does not touch your backend — it only calls it over HTTP.

## 1. Project structure

```
frontend/
  app/
    layout.tsx        # fonts, metadata, ToastProvider
    page.tsx           # dashboard: renders Chunker + LLMQuery side by side
    globals.css         # design tokens, Tailwind directives
  components/
    Header.tsx          # app name, subtitle, BackendStatus
    BackendStatus.tsx    # polls /health every 15s
    Chunker.tsx          # Text Chunker section (calls /chunk)
    ChunkResults.tsx      # chunk cards, copy / copy-all, empty state
    LLMQuery.tsx          # AI Query section (calls /llm-query)
    Loading.tsx           # spinner + skeleton
    ErrorMessage.tsx       # inline error banner
    Toast.tsx              # toast notifications (no external library)
  lib/
    api.ts                  # the ONLY place that calls fetch() against your backend
  types/
    api.ts                   # ChunkRequest/Response, LLMQueryRequest/Response, APIError
  .env.example
```

## 2. Create the project

From the directory that contains this README's sibling files (or wherever you want the project to live):

```bash
npx create-next-app@latest frontend --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*"
```

Answer "No" to Turbopack-specific prompts if asked, defaults are fine otherwise.

Then, from inside the generated `frontend/` folder, copy every file from this deliverable into place,
overwriting the generated `app/layout.tsx`, `app/page.tsx`, and `app/globals.css`, and adding the
`components/`, `lib/`, and `types/` folders alongside them.

Install the one extra dependency this project needs (icons):

```bash
npm install lucide-react
```

Everything else (`next`, `react`, `typescript`, `tailwindcss`) already came from `create-next-app`.

## 3. Configure the API URL

```bash
cp .env.example .env.local
```

Edit `.env.local` if your backend isn't on `http://localhost:8000`.

`NEXT_PUBLIC_API_URL` is read once, in `lib/api.ts`, which is the single place in the app that builds
request URLs. No component ever hardcodes a host.

## 4. Run it

```bash
npm install
npm run dev
```

Visit `http://localhost:3000`. The header's status pill will read backend online/offline based on
`GET /health`.

## 5. How the frontend talks to FastAPI

- `lib/api.ts` exports three functions — `checkHealth()`, `chunkText()`, `queryLLM()` — that wrap
  `fetch()` calls to `${NEXT_PUBLIC_API_URL}/health`, `/chunk`, and `/llm-query` respectively.
- Every component (`BackendStatus`, `Chunker`, `LLMQuery`) calls these functions instead of calling
  `fetch` directly, so there's one place to change if your API contract ever does.
- Responses are typed against `types/api.ts`, which mirrors your documented request/response shapes
  exactly — nothing is invented or renamed.
- Errors are normalized in `lib/api.ts`: FastAPI's 422 validation-error array is turned into a
  readable "field: message" string, `HTTPException(detail=...)` strings are passed through as-is,
  and network failures (backend down, DNS failure, CORS block) get a plain-language message. No raw
  stack traces ever reach the UI.
- The LLM call goes `Frontend → your FastAPI backend → Groq`. The frontend never calls Groq directly
  and has no Groq credentials.

## 6. CORS

Since the frontend (`http://localhost:3000`) and backend (`http://localhost:8000`) are different
origins, your FastAPI backend needs CORS enabled for the browser to be allowed to call it. This is a
backend change — apply it yourself; nothing here modifies your backend.

Minimal config to add to your FastAPI app (typically in `main.py`, right after you create the `app`):

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # add your deployed frontend origin(s) too
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

If you deploy the frontend later (e.g. to Vercel), add that origin to `allow_origins` as well.

## 7. Testing checklist

- [ ] `GET /health` reachable → header shows "Backend online"
- [ ] Stop the backend → header flips to "Backend offline" within ~15s, no crash
- [ ] Chunker: empty text → "Split Text" shows a validation message, no request sent
- [ ] Chunker: `chunk_overlap >= chunk_size` → blocked client-side with an inline message
- [ ] Chunker: valid input → chunks render as numbered cards; total/size/overlap match the response
- [ ] Chunker: copy button on a single chunk → toast confirms; clipboard has that chunk's text
- [ ] Chunker: "Copy all" → clipboard has every chunk, double-newline separated
- [ ] Chunker: "Clear" → text, results, and any error reset
- [ ] Chunker: backend returns HTTP 422 (e.g. force it by bypassing client validation) → readable
      field-level error shown, not a stack trace
- [ ] Chunker: backend returns HTTP 500/503 → readable message shown
- [ ] AI Query: empty question → blocked with inline message
- [ ] AI Query: default model is `llama3-8b-8192`; switching to "Custom…" reveals a text field
- [ ] AI Query: valid question → query, model, and answer render; "Copy answer" works
- [ ] AI Query: backend/Groq unavailable → readable error, not a raw exception
- [ ] Resize to a mobile width → both sections stack, remain usable, no horizontal scroll
- [ ] Keyboard-only navigation reaches every input and button in a sensible order
