# Architecture — Voice-First AI Assistant for Field Workers

Companion to [PLAN.md](PLAN.md). System design, data flow, schema, and key
design decisions.

---

## 1. System diagram

```
┌─────────────────────────────────────────────────────────────┐
│  FIELD WORKER CLIENT  (PWA / mobile web)                      │
│  • Mic capture (push-to-talk + VAD)                           │
│  • Local queue (IndexedDB)  ←─ offline buffer                 │
│  • TTS playback / audio cues                                  │
└───────────────┬───────────────────────────┬─────────────────┘
                │ (online)                   │ (sync on reconnect)
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│  BACKEND API  (FastAPI)                                       │
│                                                               │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │  STT    │→ │ Orchestrator │→ │ Intent router (LLM)     │  │
│  │ (faster │  │   / LLM      │  │  • extract  • query     │  │
│  │ -whisper│  └──────────────┘  │  • create/update/close  │  │
│  │  +bias) │         │          └───────────┬─────────────┘  │
│  └─────────┘         │                       │                │
│         ┌────────────┼───────────┐           ▼                │
│         ▼            ▼           ▼      ┌──────────────┐       │
│   Structured    RAG/vector   Tool      │ Work Order DB │       │
│   extraction    search (KB)  calling → │ (Postgres +   │       │
│         │            │           │      │  pgvector)    │       │
│         └────────────┴───────────┘      └──────────────┘       │
│                      ▼                                         │
│              TTS (Piper / browser) → natural speech reply      │
└───────────────────────────────────────────────────────────────┘
                │  WebSocket (live activity / alerts)
                ▼
┌─────────────────────────────────────────────────────────────┐
│  SUPERVISOR DASHBOARD  (React)                                │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Key design decisions

- **Single LLM orchestrator with tool-calling** decides intent (report vs
  query vs work-order command) and routes — cleaner than a separate classifier,
  and the natural fit for tool-use APIs. Use JSON-mode / function calling for
  FR2 so the schema is guaranteed.
- **Domain biasing, two layers:** (a) STT `initial_prompt` seeded with the
  equipment-code glossary; (b) an LLM/normalizer pass that corrects misheard
  codes against the known equipment registry (RAG).
- **Offline = client owns the queue.** Each queued item carries a
  client-generated UUID → backend ingest is idempotent on that UUID → safe replay.
- **3-second query budget:** stream STT partials, kick off retrieval early,
  stream the LLM answer into streaming TTS. Pre-index the KB; keep it small.
- **One Postgres instance** is work-order store + transcript/audit log + vector
  store (pgvector). Simplest to run and grade.

---

## 3. Work-order schema (canonical)

```json
{
  "id": "uuid",
  "client_uuid": "uuid",            // client-generated; idempotency key
  "equipment_code": "PMP-204B",
  "inspection_result": "string",
  "fault_code": "F12 | null",
  "location": "string",
  "severity": "LOW | MEDIUM | HIGH | CRITICAL",
  "action_taken": "string",
  "parts_required": ["string"],
  "status": "OPEN | IN_PROGRESS | ESCALATED | CLOSED",
  "created_by": "worker_id",
  "created_at": "timestamp",
  "updated_at": "timestamp",
  "raw_audio_ref": "string",        // path/key to stored audio
  "transcript": "string"            // STT output, for audit
}
```

Enums:
- `severity`: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- `status`: `OPEN`, `IN_PROGRESS`, `ESCALATED`, `CLOSED`

---

## 4. Core tables (Postgres)

- **work_orders** — the schema above
- **equipment** — `code`, `name`, `specs (jsonb)`, `location` (the registry; also
  source for code normalization)
- **maintenance_history** — `equipment_code`, `date`, `action`, `notes`
- **procedures** — `name`, `equipment_code`, `steps (jsonb)`
- **kb_chunks** — `source`, `text`, `embedding vector(384)` (pgvector; RAG index
  built from equipment/maintenance/procedures)
- **voice_notes** — `client_uuid`, `worker_id`, `audio_ref`, `transcript`,
  `processed_at`, `status` (audit + offline replay tracking)

---

## 5. Key API surface (FastAPI)

| Endpoint | Purpose |
|----------|---------|
| `POST /ingest` | Accept audio + `client_uuid`; idempotent. Runs STT → intent → action. Used live and by offline sync. |
| `POST /query` | Voice/text query → RAG → answer (streams text + TTS audio). |
| `POST /work-orders` | Create WO (tool-call target). |
| `PATCH /work-orders/{id}` | Update / close / escalate. |
| `GET /work-orders` | Dashboard list + filters. |
| `WS /events` | Real-time activity + exception alerts to dashboard. |
| `POST /sync` | Batch replay of queued offline items (each carries `client_uuid`). |

---

## 6. Latency budget for FR3 (< 3 s target)

| Stage | Budget |
|-------|--------|
| STT (short query, streamed) | ~0.5–0.8 s |
| Embed + vector retrieval | ~0.1–0.2 s |
| LLM answer (Groq, streamed) | ~0.6–1.0 s |
| TTS first audio (streamed) | ~0.3–0.5 s |
| **Total to first speech** | **~1.5–2.5 s** |

Stream every stage, never wait for full completion before starting the next.
