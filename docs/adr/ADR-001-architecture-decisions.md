# ADR-001: Drevalis Core Architecture Decisions

**Date:** 2026-03-23
**Status:** Accepted
**Deciders:** Project Lead

## Context

Drevalis is an AI-powered YouTube Shorts creation studio designed as a local-first application for daily content creation. The system automates the full pipeline from script generation through final video assembly: an LLM writes episodic scripts, a TTS engine voices them, ComfyUI generates scene images, and FFmpeg composites everything into 9:16 MP4 Shorts with burned-in captions.

The technology stack is built on FastAPI (async Python 3.11 backend), a React frontend, PostgreSQL (via asyncpg + SQLAlchemy async sessions), and Redis. The entire deployment is orchestrated through Docker Compose. External integrations include LM Studio (local LLM inference), ComfyUI (image generation), Piper TTS (local text-to-speech), and FFmpeg (video assembly).

This ADR captures the five foundational architecture decisions made during the initial design phase. Each decision prioritizes local-first operation, async-native compatibility with the FastAPI stack, and the ability to swap providers without rewriting business logic.

---

## Decision 1: Async Job Queue --- arq over Celery

### Context

The generation pipeline contains multiple long-running operations that cannot execute within an HTTP request/response cycle. A single episode generation involves: LLM script generation (5--30 seconds depending on model), TTS synthesis per scene (2--10 seconds each), ComfyUI image generation per scene (10--60 seconds each), and FFmpeg video assembly (5--20 seconds). The total wall-clock time for one episode can reach several minutes.

The system needs a background job queue that supports:
- Enqueueing multi-step generation jobs from API endpoints.
- Reporting granular progress back to the frontend in real time.
- Retry logic for transient failures (ComfyUI connection drops, OOM during inference).
- Compatibility with the async Python ecosystem already in use.

### Options Considered

**Option A: Celery**

- Pros:
  - Industry standard for Python background task processing with over a decade of production use.
  - Rich ecosystem: Flower dashboard for monitoring, celery-beat for scheduling, extensive documentation.
  - Supports multiple broker backends (Redis, RabbitMQ, Amazon SQS).
  - Large community; most Python task-processing questions have existing answers.
- Cons:
  - Fundamentally synchronous. Workers use prefork (multiprocessing) or eventlet/gevent for concurrency, none of which are native asyncio.
  - Running async code inside Celery tasks requires `asyncio.run()` wrappers or the experimental `celery[asyncio]` support, which is not production-stable.
  - Heavy dependency footprint: pulls in kombu, billiard, vine, amqp, and their transitive dependencies.
  - Broker configuration is non-trivial. RabbitMQ adds an extra service to Docker Compose; Redis-as-broker works but is a second-class citizen in Celery's design.
  - Distributed features (multi-node routing, rate limiting per queue, chord/chain primitives) are unnecessary for a single-machine local-first application.

**Option B: arq**

- Pros:
  - Built from the ground up on asyncio. Worker functions are native `async def` coroutines.
  - Redis-based with minimal configuration: point it at a Redis URL and define worker functions.
  - Lightweight: single dependency (redis/aioredis). No broker abstraction layer.
  - Built-in job result storage and job progress reporting via `ctx['job'].update(progress=...)`.
  - Natural fit with FastAPI, asyncpg, and httpx (ComfyUI client), since all share the same event loop model.
  - Simple API: `await queue.enqueue_job('generate_episode', episode_id)` on the FastAPI side, `async def generate_episode(ctx, episode_id)` on the worker side.
- Cons:
  - Smaller community and fewer tutorials compared to Celery.
  - No built-in monitoring dashboard (no equivalent of Flower).
  - Redis is the only supported broker; no RabbitMQ or SQS option.
  - Fewer battle-tested patterns for complex workflows (chaining, fan-out/fan-in).

**Option C: Dramatiq**

- Pros:
  - Simpler than Celery with a cleaner API.
  - Supports Redis and RabbitMQ brokers.
  - Middleware architecture for cross-cutting concerns.
- Cons:
  - Also synchronous at its core; same asyncio compatibility issues as Celery.
  - Smaller ecosystem than Celery without the async advantages of arq.
  - Adds a third option without meaningfully improving on either A or B.

### Decision

**arq** is the chosen job queue.

The deciding factor is async-native compatibility. The entire backend --- FastAPI route handlers, SQLAlchemy async sessions, asyncpg connection pools, httpx calls to ComfyUI --- operates on asyncio. Introducing a synchronous task queue would create an impedance mismatch: every worker function would need `asyncio.run()` bridges, database sessions would need separate synchronous engines, and the httpx ComfyUI client would need a sync equivalent or wrapper.

arq eliminates this friction entirely. Worker functions share the same async patterns as the rest of the codebase. A single `aioredis` connection pool serves both the arq worker and any other Redis needs (caching, pub/sub for WebSocket progress).

The local-first deployment model (single Docker Compose stack on one machine) means Celery's distributed features provide no value. arq's simplicity is an asset, not a limitation, in this context.

### Consequences

**Positive:**
- Zero impedance mismatch between API code and worker code. Shared async database sessions, HTTP clients, and utilities.
- Minimal configuration. The worker is defined in a single Python module with a `WorkerSettings` class.
- Built-in progress reporting feeds directly into the WebSocket layer for real-time frontend updates.
- Smaller Docker image and faster startup due to fewer dependencies.

**Negative:**
- No off-the-shelf monitoring dashboard. Mitigated by building a custom `/api/jobs` endpoint that queries arq's Redis keys and by pushing progress events over WebSocket to the React frontend.
- Fewer community resources for troubleshooting. Mitigated by arq's small codebase (readable in an afternoon) and good official documentation.
- If the project ever needs multi-node distributed processing, arq would need to be replaced. Accepted risk: the local-first premise makes this unlikely, and the worker interface is thin enough that migration would be bounded.

**Risks:**
- arq is maintained primarily by Samuel Colvin (pydantic author). Bus-factor risk exists. Mitigated by the project's permissive MIT license and small codebase that could be forked if necessary.

---

## Decision 2: FFmpeg via Direct subprocess over moviepy and ffmpeg-python

### Context

The video assembly engine is responsible for combining per-scene PNG images with a single voiceover WAV file and burned-in ASS/SRT captions into a final 9:16 (1080x1920) MP4 file. The FFmpeg command is non-trivial: it involves multiple inputs, complex filtergraph construction (scale, pad, overlay, subtitles filter, audio mixing), and precise timing control to synchronize scene images with voiceover segments based on timestamp data from TTS.

The assembly module must:
- Construct FFmpeg filtergraphs dynamically based on the number of scenes and their durations.
- Handle variable input formats gracefully (different image resolutions, WAV sample rates).
- Provide clear error diagnostics when FFmpeg fails (missing codec, invalid filter syntax).
- Run as an async operation within arq worker jobs.

### Options Considered

**Option A: moviepy**

- Pros:
  - Pure Python API for video editing. Conceptually simple: `clip.write_videofile(...)`.
  - No need to understand FFmpeg CLI syntax.
- Cons:
  - Pulls in heavy dependencies: NumPy, imageio, imageio-ffmpeg, decorator. Adds 50+ MB to the Docker image.
  - Processes video frames in Python (NumPy arrays), which is orders of magnitude slower than letting FFmpeg handle everything natively in C.
  - Limited control over encoding parameters, filtergraph construction, and hardware acceleration.
  - Maintenance has been inconsistent. The 1.x to 2.x migration broke APIs, and release cadence is irregular.
  - Poor error messages: failures surface as Python tracebacks deep in NumPy/imageio, not as FFmpeg diagnostics.

**Option B: ffmpeg-python**

- Pros:
  - Pythonic API that generates FFmpeg CLI commands. Exposes most FFmpeg options.
  - Filtergraph construction via method chaining is readable for simple cases.
- Cons:
  - Adds an abstraction layer that obscures the actual FFmpeg command being executed. When something goes wrong, debugging requires extracting the generated command and running it manually.
  - Complex filtergraphs (multi-input overlay with timing, subtitle burn-in, audio concatenation) become harder to express through the wrapper than through raw FFmpeg arguments.
  - The library has not been updated frequently; open issues and PRs accumulate.
  - Still calls subprocess internally; the wrapper just builds the argument list.

**Option C: Direct subprocess calls**

- Pros:
  - Full, unrestricted control over every FFmpeg argument and filter.
  - The exact command is visible in logs, directly copy-pasteable to a terminal for debugging.
  - No additional Python dependencies beyond the standard library `subprocess` module.
  - Transparent error handling: stderr from FFmpeg is captured and logged verbatim.
  - Async-compatible via `asyncio.create_subprocess_exec` for non-blocking execution within arq workers.
  - Enables hardware acceleration flags (`-hwaccel cuda`, `-c:v h264_nvenc`) without fighting a wrapper's abstraction.
- Cons:
  - FFmpeg argument construction is string-based and must be carefully validated.
  - Developers must understand FFmpeg CLI syntax; no Pythonic abstraction to ease the learning curve.
  - Filtergraph strings for complex pipelines are dense and easy to get wrong without careful unit testing.

### Decision

**Direct subprocess calls** via a thin Python assembly module (`app/services/ffmpeg.py` or similar).

The module exposes functions like `assemble_episode(episode_dir, scenes, voice_path, output_path)` that construct an FFmpeg argument list from structured Python data (scene image paths, durations, caption file path) and execute it via `asyncio.create_subprocess_exec`. The full command is logged at DEBUG level before execution. Stderr is captured, and non-zero exit codes raise a typed `FFmpegError` with the full stderr output.

This approach was chosen because:
1. The filtergraph for Drevalis is complex enough that wrappers become liabilities rather than aids. A typical assembly involves: concat demuxer for timed image sequences, audio overlay, ASS subtitle burn-in, and scaling/padding to exact 1080x1920.
2. Debugging FFmpeg issues requires seeing and tweaking the exact command. A wrapper hides this.
3. The standard library `subprocess` module (and its asyncio equivalent) has zero additional dependencies.

### Consequences

**Positive:**
- Full transparency. Every FFmpeg invocation is logged as a runnable shell command. Debugging is copy-paste-into-terminal straightforward.
- No dependency on third-party FFmpeg wrappers that may lag behind FFmpeg releases or have unpatched bugs.
- Enables future optimizations (GPU encoding, segment-level parallelism) without fighting wrapper limitations.
- The async subprocess integration means video assembly does not block the arq worker's event loop.

**Negative:**
- Developers must be comfortable with FFmpeg CLI syntax. Mitigated by thorough inline documentation in the assembly module and by keeping the filtergraph construction logic in well-named helper functions.
- Argument construction is error-prone without type safety. Mitigated by Pydantic models for scene/episode data that validate inputs before they reach the FFmpeg argument builder.

**Risks:**
- FFmpeg CLI behavior can vary between versions. Mitigated by pinning the FFmpeg version in the Docker image and documenting the minimum required version.

---

## Decision 3: Local Filesystem Storage with Database Path References over Cloud Storage and Database BLOBs

### Context

A single episode generation produces multiple binary artifacts:
- 1 voiceover WAV file (typically 1--5 MB).
- 5--15 scene PNG images (each 0.5--3 MB, depending on ComfyUI output resolution).
- 1 assembled MP4 video (typically 10--50 MB).
- 1 subtitle file (SRT or ASS, a few KB).

Over weeks of daily operation, storage accumulates significantly. A user generating 2 episodes per day with 10 scenes each produces roughly 1--2 GB per week of raw artifacts before any cleanup.

The storage system must:
- Organize files predictably so that cleanup, export, and debugging are straightforward.
- Allow the API to serve files efficiently (static file serving or sendfile).
- Store file references in the database for relational queries (find all scenes for episode X).
- Be configurable so users can point storage at a different drive or NAS mount.

### Options Considered

**Option A: Cloud object storage (S3 / MinIO)**

- Pros:
  - Scalable, durable, battle-tested.
  - Pre-signed URLs for direct client access without proxying through the backend.
  - MinIO provides S3-compatible API for self-hosted deployments.
- Cons:
  - Adds operational complexity: another service in Docker Compose, access key management, bucket policies.
  - Network latency for every file read/write, even on localhost with MinIO.
  - Overkill for a single-user local application. The durability and scalability guarantees of object storage solve problems this application does not have.
  - FFmpeg and Piper TTS operate on local file paths. Using S3 would require downloading files to a temp directory before processing and uploading results afterward, adding complexity and latency to every pipeline step.

**Option B: Database BLOBs (PostgreSQL large objects or BYTEA columns)**

- Pros:
  - Transactional consistency: file data and metadata are committed atomically.
  - No separate storage system to manage.
- Cons:
  - PostgreSQL performance degrades significantly with large BYTEA columns. A 50 MB video in a BYTEA column bloats WAL, makes `pg_dump` slow, and consumes shared buffers inefficiently.
  - Streaming large files from the database to an HTTP response is more complex than serving from the filesystem.
  - Database backups become enormous and slow.
  - FFmpeg and TTS tools cannot read from database BLOBs; files would need to be extracted to temp paths anyway.

**Option C: Local filesystem with configurable base path and database path references**

- Pros:
  - Simplest possible approach. Files are regular files on disk.
  - FFmpeg, Piper TTS, and ComfyUI all operate natively on filesystem paths. No download/upload ceremony.
  - FastAPI's `FileResponse` and static file mounts serve files efficiently, leveraging OS-level sendfile where available.
  - Users control storage location via a single `STORAGE_BASE_PATH` environment variable. Can point to an external drive, NAS mount, or fast NVMe.
  - Database stores only relative paths (e.g., `episodes/abc123/scenes/001.png`), keeping rows small and queries fast.
  - Cleanup is trivial: delete the episode directory.
- Cons:
  - No transactional atomicity between database writes and filesystem writes. A crash between creating the DB record and writing the file leaves an orphan reference.
  - No built-in redundancy or replication.
  - File serving must go through FastAPI or a reverse proxy; no pre-signed URL pattern.

### Decision

**Local filesystem with configurable base path.** The database stores relative paths; the application resolves them against a `STORAGE_BASE_PATH` setting managed by pydantic-settings (environment variable or `.env` file).

The directory structure follows a predictable convention:

```
$STORAGE_BASE_PATH/
  episodes/
    {episode_id}/
      voice/
        narration.wav
      scenes/
        001.png
        002.png
        ...
      captions/
        subtitles.ass
      output/
        final.mp4
  models/
    piper/
      {voice_name}.onnx
      {voice_name}.onnx.json
```

This was chosen because every tool in the pipeline (FFmpeg, Piper, ComfyUI) operates on filesystem paths. Introducing an abstraction layer (S3 API, DB BLOB extraction) would add complexity to every pipeline step without providing value to a single-user local application.

### Consequences

**Positive:**
- Zero additional infrastructure. No MinIO container, no bucket configuration, no access keys.
- Pipeline steps pass file paths directly. `ffmpeg -i /storage/episodes/abc/voice/narration.wav` works without any download step.
- Users can browse, back up, or move generated content with standard file management tools.
- The `STORAGE_BASE_PATH` setting makes it trivial to relocate storage (e.g., to a larger drive) by changing one environment variable and moving the directory.

**Negative:**
- No atomicity guarantee between database state and filesystem state. Mitigated by: (a) writing files before creating/updating DB records (file-first pattern), and (b) a periodic cleanup task that reconciles orphaned files against DB records.
- Single-machine storage has no built-in redundancy. Accepted risk for a local-first application. Users who need redundancy can point `STORAGE_BASE_PATH` at a RAID array or synced directory.

**Risks:**
- Disk space exhaustion if cleanup is neglected. Mitigated by a storage usage endpoint in the API and configurable retention policies (delete episodes older than N days).
- Path traversal vulnerabilities if episode IDs or filenames are not sanitized. Mitigated by using UUID-based episode IDs (no user-supplied path components) and validating all paths resolve within `STORAGE_BASE_PATH`.

---

## Decision 4: TTS Abstraction --- Protocol-Based Interface with Piper TTS Primary and ElevenLabs Fallback

### Context

Each series in Drevalis has a consistent voice identity. The narrator voice is a core part of the brand for a YouTube Shorts series. The TTS system must:
- Produce natural-sounding speech from episode scripts.
- Support multiple distinct voices (one per series).
- Return timing/alignment data so that scene images can be synchronized with narration segments.
- Run locally for zero-cost daily operation, with an optional cloud fallback for higher quality when needed.
- Be swappable without changing the generation pipeline code.

### Options Considered

**Option A: Coqui TTS**

- Pros:
  - Open-source with a wide range of pre-trained models (Tacotron2, VITS, YourTTS).
  - Supported voice cloning for custom voices.
- Cons:
  - Coqui (the company) shut down in late 2023. The open-source repository receives sporadic community maintenance but no funded development.
  - Heavy Python dependencies (PyTorch, librosa, unidecode). Adds 2+ GB to the Docker image.
  - Inference speed on CPU is slow for production use without GPU acceleration.
  - Uncertain long-term viability. Model format and API may drift without active stewardship.

**Option B: Piper TTS**

- Pros:
  - Actively maintained by the Rhasspy / Home Assistant voice assistant community. Regular releases and growing voice library.
  - ONNX-based inference: fast on CPU (real-time factor well below 1.0 on modern hardware), no PyTorch dependency.
  - Small footprint: the `piper-tts` Python package and ONNX runtime are the only dependencies. Voice models are 15--60 MB each.
  - Apache 2.0 license. No usage restrictions.
  - Supports phoneme-level timing output, which can be used for word-level caption synchronization.
  - Large and growing multilingual voice library with consistent quality.
- Cons:
  - Voice quality, while good for a local model, does not match top-tier cloud TTS services.
  - Voice cloning is not natively supported (must train custom VITS models separately).
  - Limited SSML support compared to cloud services.

**Option C: ElevenLabs API**

- Pros:
  - State-of-the-art voice quality. Highly natural prosody, emotion, and pacing.
  - Voice cloning from short audio samples.
  - Rich API with streaming support, SSML-like controls, and multiple output formats.
- Cons:
  - Costs money. Free tier is limited (10,000 characters/month). Paid plans start at $5/month for 30,000 characters. Daily episode generation can consume 50,000--100,000 characters per month.
  - Requires internet connectivity. Fails if the network is down or the API has an outage.
  - Latency: network round-trip adds 1--5 seconds per request on top of generation time.
  - Vendor lock-in: voice IDs, cloned voices, and generation parameters are ElevenLabs-specific.

**Option D: Direct integration with a single provider (no abstraction)**

- Pros:
  - Simpler initial implementation. No interface to design.
- Cons:
  - Switching providers requires modifying the generation pipeline code.
  - Cannot offer users a choice between local (free) and cloud (premium) TTS.

### Decision

**Protocol-based TTS abstraction** with Piper TTS as the local primary provider and ElevenLabs as an optional cloud fallback.

A Python `Protocol` (PEP 544 structural subtyping) defines the TTS interface:

```python
class TTSProvider(Protocol):
    async def synthesize(
        self,
        text: str,
        voice_id: str,
        output_path: Path,
    ) -> TTSResult:
        """Synthesize speech and write audio to output_path.

        Returns TTSResult containing the audio duration
        and word-level timestamps for caption sync.
        """
        ...

    async def list_voices(self) -> list[VoiceInfo]:
        ...
```

`PiperTTSProvider` implements this protocol using the `piper-tts` Python package, running ONNX inference locally. `ElevenLabsTTSProvider` implements the same protocol using the ElevenLabs REST API via httpx.

The series configuration in the database specifies which TTS provider and voice to use. The generation pipeline resolves the provider at runtime via a factory function, making the choice transparent to the rest of the code.

Piper was chosen as the primary provider because:
1. It is free and runs entirely locally, aligning with the local-first philosophy.
2. ONNX inference is fast enough for production use on CPU.
3. The Rhasspy community provides active maintenance and a growing voice library.
4. It avoids the cost and connectivity dependencies of cloud TTS for daily operation.

### Consequences

**Positive:**
- Zero marginal cost for daily TTS generation. A user producing 2 episodes per day pays nothing for voice synthesis.
- No internet dependency for the primary TTS path. Generation works offline.
- The Protocol-based interface makes adding new providers (Azure TTS, Google Cloud TTS, Bark, etc.) a matter of implementing one class with two methods.
- Users can choose per-series: free local voices for experimental series, premium cloud voices for flagship content.

**Negative:**
- Piper voice quality is noticeably below ElevenLabs. For some content niches, this may be a dealbreaker. Mitigated by making ElevenLabs available as a configurable fallback.
- Maintaining two provider implementations means testing and debugging two code paths. Mitigated by the shared Protocol ensuring behavioral consistency and by integration tests that run against both providers.
- Word-level timestamp formats differ between Piper (phoneme-level JSON) and ElevenLabs (word-level alignment in API response). The abstraction layer must normalize these into a common `TTSResult` format.

**Risks:**
- Piper's voice library, while growing, may not cover all languages or accents a user needs. Mitigated by the ElevenLabs fallback and by the ability to add custom-trained Piper voices.
- ElevenLabs API changes or pricing changes could break or cost-inflate the fallback path. Mitigated by the abstraction: swapping to a different cloud provider requires only a new implementation class.

---

## Decision 5: LLM Provider Abstraction --- OpenAI-Compatible Interface with LM Studio Primary and Claude Fallback

### Context

Script generation is the first step in the episode pipeline. The LLM receives a series bible (tone, characters, themes, format rules), episode history (to avoid repetition), and a generation prompt, then produces a structured script (JSON with scene descriptions, narration text, and caption text).

The LLM integration must:
- Support local inference via LM Studio (user's primary workflow, free, private, no data leaving the machine).
- Support cloud LLM fallback for higher quality or when local hardware is insufficient.
- Handle structured output (JSON mode) reliably.
- Be configurable per series (different series may use different models or providers).
- Not over-abstract the integration to the point where provider-specific features (system prompts, temperature, JSON mode) are lost.

### Options Considered

**Option A: Direct httpx calls to each provider's API**

- Pros:
  - No SDK dependencies. Full control over request/response handling.
- Cons:
  - Must implement authentication, retry logic, streaming, error handling, and response parsing separately for each provider.
  - Duplicated boilerplate across providers.

**Option B: LangChain**

- Pros:
  - Unified interface across dozens of LLM providers.
  - Built-in chains, memory, and agent patterns.
  - Large community and ecosystem.
- Cons:
  - Extremely heavy dependency tree. Pulls in hundreds of transitive dependencies.
  - Over-engineered for this use case. Drevalis sends a prompt and receives a JSON response. It does not need chains, agents, vector stores, or document loaders.
  - Abstraction layers make debugging prompt/response issues difficult.
  - Rapid release cadence with frequent breaking changes.
  - Adds significant complexity for minimal value when the application only needs two providers.

**Option C: OpenAI Python SDK with configurable `base_url`**

- Pros:
  - LM Studio natively exposes an OpenAI-compatible API (`/v1/chat/completions`). The OpenAI SDK works against LM Studio with zero modification --- just change the `base_url`.
  - Well-maintained, typed SDK with async support (`AsyncOpenAI`).
  - Handles authentication, retries, streaming, and error parsing.
  - JSON mode (`response_format={"type": "json_object"}`) works with both OpenAI and LM Studio.
  - Lightweight: single dependency (`openai` package, which depends on `httpx` and `pydantic` --- both already in the stack).
- Cons:
  - Does not natively support Anthropic's Claude API (different request/response format).
  - Ties the "interface shape" to OpenAI's API design, which may not map cleanly to all providers.

### Decision

**OpenAI Python SDK with configurable `base_url`** as the primary interface, targeting LM Studio for local inference. A separate `AnthropicLLMProvider` using the Anthropic SDK sits behind the same Python `Protocol` for Claude fallback.

The Protocol interface:

```python
class LLMProvider(Protocol):
    async def generate_script(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> ScriptResult:
        """Generate an episode script.

        Returns ScriptResult containing the parsed script
        JSON and token usage metadata.
        """
        ...
```

`OpenAICompatibleLLMProvider` wraps `AsyncOpenAI(base_url=settings.lm_studio_url)` and works with any OpenAI-compatible endpoint (LM Studio, ollama, vLLM, text-generation-webui, or actual OpenAI).

`AnthropicLLMProvider` wraps `AsyncAnthropic()` and translates the Protocol's interface to Anthropic's messages API (mapping system prompt to the `system` parameter, etc.).

The series configuration stores the provider name and model identifier. The generation pipeline resolves the provider at runtime.

LM Studio was chosen as the primary because:
1. It runs locally with no API costs and no data leaving the machine.
2. Its OpenAI-compatible API means the widely-used `openai` SDK works without modification.
3. Users can swap models (Mistral, Llama, Qwen, etc.) in LM Studio's UI without any code changes.
4. JSON mode support in LM Studio enables reliable structured output.

### Consequences

**Positive:**
- Zero cost for daily script generation when using LM Studio with local models.
- Complete privacy: prompts, series bibles, and generated scripts never leave the user's machine in the default configuration.
- The OpenAI SDK's `base_url` parameter means the same code works against LM Studio, ollama, vLLM, text-generation-webui, and OpenAI's actual API. Maximum provider flexibility with minimal code.
- Adding Claude as a fallback provides access to state-of-the-art reasoning for complex scripts when local model quality is insufficient.
- The Protocol-based abstraction keeps the generation pipeline provider-agnostic. Business logic calls `provider.generate_script(...)` without knowing or caring which LLM is behind it.

**Negative:**
- Two SDK dependencies (`openai` + `anthropic`) instead of one unified client. Mitigated by both being well-maintained, async-native, and lightweight.
- Local model quality varies significantly. A 7B parameter model on LM Studio will produce noticeably worse scripts than Claude or GPT-4. Mitigated by: (a) prompt engineering tailored to smaller models, (b) the ability to switch to Claude for premium series, and (c) the user's freedom to run larger models if their hardware supports it.
- JSON mode reliability differs across local models. Some models produce malformed JSON despite the `response_format` parameter. Mitigated by a validation and retry layer in the provider implementation: parse the response with Pydantic, and if it fails, retry with an explicit "fix this JSON" follow-up prompt (up to 2 retries).

**Risks:**
- LM Studio's OpenAI-compatible API may have subtle incompatibilities with the OpenAI SDK for edge cases (function calling, tool use, vision). Mitigated by using only the `chat.completions` endpoint with text-only messages and JSON mode, which is the most stable and widely-tested compatibility surface.
- Anthropic SDK breaking changes could require updates to the Claude provider. Mitigated by pinning the SDK version and the thin adapter layer that isolates Anthropic-specific code.

---

## Summary of Decisions

| # | Decision | Chosen | Runner-Up | Key Driver |
|---|----------|--------|-----------|------------|
| 1 | Async Job Queue | arq | Celery | Async-native compatibility with FastAPI stack |
| 2 | Video Assembly | Direct subprocess (FFmpeg) | ffmpeg-python | Full control, transparent debugging, no wrapper overhead |
| 3 | File Storage | Local filesystem + DB paths | MinIO (S3-compatible) | Local-first simplicity, native tool compatibility |
| 4 | Text-to-Speech | Piper TTS + ElevenLabs fallback | Coqui TTS | Active maintenance, fast ONNX inference, zero cost |
| 5 | LLM Integration | OpenAI SDK (LM Studio) + Anthropic SDK (Claude) | LangChain | Minimal abstraction, local-first, SDK reuse |

## Review Schedule

These decisions should be revisited if any of the following conditions change:
- The application moves from single-user local deployment to multi-user or cloud-hosted.
- arq development stalls or a critical bug is discovered without a fix.
- A new local TTS engine emerges that significantly outperforms Piper (e.g., a production-ready Bark or MetaVoice successor).
- LM Studio drops OpenAI API compatibility or a clearly superior local inference server emerges.
