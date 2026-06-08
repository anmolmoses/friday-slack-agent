# Vision Memory — making Friday remember what she sees

Status: **design / not built.** This doc records the lay of the land (verified 2026-06-04)
and the two build paths. Code is untouched until a path is chosen.

## Where we are today

Vision lives entirely in the voice route (opt-in behind `FRIDAY_VOICE_CAMERA=true`). See
[voice-route.md](voice-route.md). The capture/store plumbing exists, but only for **people**,
and what engram actually remembers is **text**, never pixels.

| Piece | File | What it does |
|---|---|---|
| `camera_see` | `src/voice/tools.ts:1040` | Captures one frame, attaches it to the live Realtime turn for in-the-moment Q&A. **Persists nothing.** No card, no reindex. The observation is gone the moment she answers. |
| `camera_snapshot` | `src/voice/tools.ts:1020` | Saves a frame to `memory/vision/camera/*.jpg` and returns the path. Inert — see below. |
| `visual_person_remember` | `src/memory/vision.ts:309` | Copies the frame to `memory/vision/people/<id>/`, writes `profile.json` + a `profile.md` card, calls `reindexIncremental()`. **This is the only path that creates a durable, recallable memory.** |
| `visual_person_lookup` | `src/memory/vision.ts:353` | "Have I seen this face?" via a 64-bit dHash Hamming-distance compare (`imageFingerprint`, `vision.ts:200`). Lives outside engram, not in the graph. |

### The three hard limits

1. **Engram is text-only by design.** Embedder is `text-embedding-3-small` (1536-dim, text)
   per `engram/engram.config.json`. Zero references to image/vision/pixel in the 567-line
   engine (`engram/src/engram.ts`). The ingest walker only accepts `.md/.markdown/.mdx/.txt`
   (`engram/src/ingest/markdown.ts:21`). So every `.jpg` under `memory/vision/` is **inert** —
   never indexed, never recalled. Only the markdown cards are.

2. **`camera_see` is "look now," not "remember."** No capture path exists for ambient scenes,
   objects, whiteboards — only confirmed people get a card. Everything else evaporates.

3. **Visual matching isn't associative.** dHash + Hamming is brittle (lighting/angle-sensitive)
   and sits entirely outside engram's spreading-activation recall.

What "she remembers what she sees" means today: a model-written *description* + a perceptual
hash get stored as a person card; engram indexes that text like any other note. The pixels
never enter associative memory.

## Path A — Scene memory via text cards (small, no engram change)

Engram already does the hard part (chunk → embed → graph → spreading-activation recall). It
just needs text. The vision model already produces a description on every `camera_see` — today
we throw it away. Capture it instead.

**Touches:**
- New `rememberScene({ imagePath, description, tags, importance })` in `src/memory/vision.ts`,
  mirroring `rememberVisualPerson` (`vision.ts:309`). Writes to `memory/vision/scenes/<date>/`:
  the frame (durable reference) + a `scene-<ts>.md` card with frontmatter `type: visual_scene`,
  `tier: episodic` (scenes are moments, not stable facts — unlike the `semantic` person cards),
  the description, detected entities as `people`/`topic`, and the relative image path. Calls
  `reindexIncremental()`.
- `cameraSee` (`src/voice/tools.ts:1040`) persists the model's description after the turn.
  Recommended: explicit `remember_scene` tool she calls when it matters (clean, low-noise),
  plus an optional faint implicit episodic log she can promote later.

**Get:** "What was on my desk yesterday?" / "Where did I leave my keys?" → engram recalls the
scene card by meaning, returns the description + image path she can re-attach. Episodic tier
means scenes fade unless reinforced — engram's existing dreaming/promotion machinery
(`src/memory/dreaming.ts`, `promote.ts`) already handles that.

**Effort:** ~half a day. **Zero engram-engine changes.** Honest framing: she remembers a
*textual recollection*, not the image — same as how humans mostly recall scenes as descriptions.
Cost: one extra vision call per look (fine for opt-in voice).

## Path B — True visual associative memory (engram gets eyes)

The "engram should support that as well" version. A real engine change.

Core problem: engram is hard-wired to one text embedder. `Engram` builds a single
`EmbeddingProvider` (`engram/src/engram.ts:106`); every chunk gets one vector in one space;
recall does cosine kNN in that one space; ingest only sees `.md/.txt`. Images are invisible at
every layer.

**In dependency order:**
1. **Multimodal embedder.** Add a CLIP-class provider (SigLIP/CLIP endpoint, or Voyage/Cohere
   multimodal) behind the existing `createEmbeddingProvider` seam
   (`engram/src/embeddings/provider.js`). Key property: image and text embed into the **same**
   space, so a text query retrieves an image and vice-versa.
2. **Image ingest path.** Teach `walk()` to accept `.jpg/.png`; add an image branch that embeds
   pixels (+ optional caption) instead of chunking text. Store already carries
   `embeddingModel`/`embeddingDim` per row, so mixed modalities can coexist — *if* recall filters
   to compatible spaces.
3. **Cross-modal recall.** `hybridRecall` (`engram/src/engram.ts:325`) assumes query and corpus
   share a space (already guards `v.dim !== this.embedding.dim` at `:352`). With a shared
   image+text space this mostly just works.
4. **Visual similarity edges.** Replace dHash (`vision.ts:200`) with embedding cosine; let the
   graph builder add `visual_similar` edges (it already builds kNN `semantic_similar` edges at
   `engram.ts:215`). Now "have I seen this?" is robust and *associative* — a face can
   spread-activate the meeting it happened in.

**Effort:** a few days + a cost/latency decision (image embeddings aren't free; local-CLIP vs
API matters). Forks engram from its clean single-space design — deserves its own milestone and
the dashboard neuron-viz treatment (every build gets live-activation visualization).

## Recommendation

**A now, B deliberately.** A is reversible, ships this week, and makes "remember what she sees"
true for ~80% of real asks (where/what/who) because human visual recall is mostly textual. B is
the genuinely novel capability (image *is* the memory, cross-modal recall, visual spreading
activation) and is worth doing as a real engram milestone — but it's an engine fork, not an
afternoon.
