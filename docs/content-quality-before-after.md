# Content quality — before/after diff template

Phase 3 verification asks for side-by-side script diffs of three
representative episodes (one shorts, one long-form, one with
``tone_profile`` set) regenerated under the new prompts.

This file is a **template** — the regeneration step requires a live
LLM call against your local LM Studio / Anthropic / OpenAI provider.
Running it produces the actual diffs that should land in this file.

## How to populate this file

```bash
# 1. Pick three representative episodes from the dev DB.
psql $DATABASE_URL -c "
  SELECT e.id, s.name AS series, e.title, s.content_format,
         (s.tone_profile ?? '{}'::jsonb)::text AS tone_profile
  FROM episodes e
  JOIN series s ON s.id = e.series_id
  WHERE e.script IS NOT NULL
    AND e.status IN ('exported', 'review')
  ORDER BY e.created_at DESC
  LIMIT 50;"
```

Pick three: one short (`content_format='shorts'`, no tone profile),
one long-form (`content_format='longform'`, no tone profile), one with
a populated ``tone_profile``.

```bash
# 2. Run the new gate against the existing scripts to baseline failures.
for ID in <id1> <id2> <id3>; do
  curl -X POST http://localhost:8000/api/v1/episodes/$ID/quality-report \
    -H "X-API-Key: $API_AUTH_TOKEN" | jq -c '{id:"'$ID'", passed, issues}'
done
```

Capture each ``QualityReport`` under "Existing script (pre-overhaul)"
sections below — these are the rules-violations the LLM under the old
prompt let through.

```bash
# 3. Reset each episode to draft and regenerate via the worker.
for ID in <id1> <id2> <id3>; do
  curl -X POST http://localhost:8000/api/v1/episodes/$ID/regenerate \
    -H "X-API-Key: $API_AUTH_TOKEN" -d '{"step":"script"}'
done
# Wait for the worker to flip status back to "review", then:
for ID in <id1> <id2> <id3>; do
  curl -X POST http://localhost:8000/api/v1/episodes/$ID/quality-report \
    -H "X-API-Key: $API_AUTH_TOKEN" | jq -c '{id:"'$ID'", passed, issues}'
done
```

Capture the new ``QualityReport`` under "Regenerated script (Phase 2.3+)".

```bash
# 4. Diff the persisted scripts.
psql $DATABASE_URL -c "
  SELECT id, title, script->'scenes' AS scenes,
         script->>'description' AS description,
         script->>'thumbnail_prompt' AS thumbnail_prompt,
         script->'hashtags' AS hashtags
  FROM episodes WHERE id = '<id>';"
```

For the diff, render scene-by-scene narration + visual_prompt as
sub-tables.

## Episode 1 — Shorts (no tone profile)

**Series:** _<series name>_
**Episode:** _<episode title>_
**Topic:** _<original topic>_

### Existing script (pre-overhaul)

```json
{
  "title": "...",
  "scenes": [],
  "description": "",
  "hashtags": []
}
```

`POST /quality-report` →

```json
{
  "passed": false,
  "issues": [
    "scene N: banned word 'X'",
    "scene M: no concrete fact (no digit, year, or proper noun detected)",
    "..."
  ]
}
```

### Regenerated script (Phase 2.3+)

```json
{
  "title": "...",
  "scenes": [],
  "description": "...",
  "hashtags": []
}
```

`POST /quality-report` →

```json
{
  "passed": true,
  "issues": []
}
```

### Diff highlights

* Scene 1 narration before / after — capture the opening line specifically; the new prompt forbids "Have you ever wondered" / "In a world where" etc.
* Scene 1 visual_prompt before / after — confirm framing + lighting language replaces "8k masterpiece" tokens.
* Description field — was empty pre-overhaul (shorts); should now carry a ≤300-char hook-mirroring blurb.
* Hashtags — was empty pre-overhaul; should now carry ≤8 long-tail items.

---

## Episode 2 — Long-form (no tone profile)

**Series:** _<series name>_
**Episode:** _<episode title>_

### Existing script (pre-overhaul)

…same shape, expect ``check_script_content`` to flag many specificity
gaps and at least a handful of banned-vocab hits across N scenes.

### Regenerated script (Phase 2.6)

…the new outline + chapter prompts include the banned-vocab block;
phase 3 (``_quality_review``) rewrites any narration the gate still
flags after the chapter pass. Most failures should be self-healed
before the script is persisted.

### Diff highlights

* Outline-phase ``description`` and ``hashtags`` — pre-overhaul they
  were rule-free; post-overhaul they obey the long-tail / no-CTA rules.
* Per-chapter narration — sample 2-3 scenes from each chapter and show
  the rewrite.
* Watch for ``_quality_rewrite_done`` log lines: ``applied=N`` indicates
  how many scenes phase 3 actually rewrote.

---

## Episode 3 — Series with `tone_profile` set

Pick (or create) a series whose ``tone_profile`` carries:

```json
{
  "persona": "wry historian",
  "forbidden_words": ["literally", "vibes"],
  "required_moves": [
    "always cite a primary source",
    "always end on a contrarian observation"
  ],
  "reading_level": 8,
  "max_sentence_words": 16,
  "style_sample": "<paste a 200-word voice sample here>",
  "signature_phrases": ["the receipts show", "what's actually true is"],
  "allow_listicle": false,
  "cta_boilerplate": false
}
```

### Existing script (pre-overhaul)

The pre-2.1 row has no ``tone_profile`` column at all — this episode's
existing script was generated against the neutral baseline. Run
``POST /quality-report`` with the **new** ``tone_profile`` (now that
Phase 2.1 has migrated the column) — every banned word from
``forbidden_words`` will surface as an issue if it ever appeared in
the old narration. ``max_sentence_words=16`` will be tighter than the
default 18, so prior sentences may now exceed the cap.

### Regenerated script (Phase 2.3+)

After regen, the prompt's ``{tone_profile_block}`` carries the persona,
forbidden words, required moves, and the style sample verbatim. The
gate re-runs with the same profile.

### Diff highlights

* Persona consistency — narration tone should visibly shift toward the
  ``persona`` description.
* Required moves — count their occurrence (e.g. "primary source" /
  "contrarian observation" should appear at least once in every
  episode).
* Forbidden_words — should be zero.
* Style sample — open the script and confirm the lexical / cadence
  fingerprint matches.

---

## Roll-up — five random existing episodes

```bash
for ID in $(psql $DATABASE_URL -tAc "
  SELECT id FROM episodes WHERE script IS NOT NULL ORDER BY random() LIMIT 5"); do
  curl -X POST http://localhost:8000/api/v1/episodes/$ID/quality-report \
    -H "X-API-Key: $API_AUTH_TOKEN" | jq '.issues | length'
done
```

Record the histogram here:

| Episode | passed | issue count | dominant rule |
|---|---|---|---|
| _<id>_ | _<bool>_ | _<int>_ | _e.g. banned-word (delve) ×3, specificity ×4_ |

---

## Notes for whoever runs this

* Run after `alembic upgrade head` so migrations 041–043 are applied.
* The SEO subsystem also grew banned-vocab + specificity rules in the
  follow-up commit — uploads triggered after regeneration should
  produce cleaner descriptions even on episodes with stale
  ``script.description`` strings, because both sources now obey the
  same rules.
* If phase 3 rewrites apply on a long-form episode, the worker logs
  emit ``longform_script.quality_rewrite_done applied=N``. Capture
  that figure under the long-form section so we can track how often
  the safety net fires.
* This file lives in version control — keep diffs trimmed to a few
  representative scenes per episode; full scripts go in commit
  attachments or a private gist if needed.
