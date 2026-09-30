export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const REQUIRED_SECTIONS = [
  "# Checkpoint",
  "## Summary",
  "## Decisions",
  "## Facts",
  "## Open",
  "## Files",
  "## Notes",
]

/**
 * Hard ceiling on the whole checkpoint. Exceeding it is a rejection, so a
 * checkpoint that trips this is lost along with its watermark advance.
 *
 * Raised from 10KB after a real run: a 131,544-byte increment (the full
 * INCREMENT_BUDGET) distilled to 16,067 bytes, over the old 10,240 limit by 56%.
 * The batch was rejected, the watermark stayed put, and the host loop stopped
 * after one batch — a full-size increment became unprocessable.
 *
 * 24KB clears the observed worst case with room to spare, and stays a real bound:
 * the section budgets below sum to 7400, and a checkpoint three times that is
 * still worth rejecting rather than truncating silently.
 *
 * Known weakness, unchanged here: the child does not respect the per-section
 * budgets — the 16KB output overshot every one of them by roughly 10x. Until the
 * prompt or the model holds to them, this ceiling is the only gate, so it has to
 * sit above what the model actually produces for a full-budget input. The real
 * fix is making the sections obey their budgets; this only moves the cliff.
 */
const MAX_CHECKPOINT_BYTES = 24 * 1024

/**
 * Per-section byte budgets. Overshooting one is reported as a warning, never a
 * rejection: a rejected checkpoint is silently lost, which is the failure mode
 * this whole check exists to make visible. Budgets sum to 7400.
 */
export const SECTION_BUDGET_BYTES: Record<string, number> = {
  "## Summary": 800,
  "## Decisions": 1500,
  "## Facts": 2000,
  "## Open": 800,
  "## Files": 1500,
  "## Notes": 800,
}

const GARBAGE_PATTERNS: Array<RegExp> = [
  /lorem ipsum/i,
]

export function checkSectionBudgets(body: string): string[] {
  const warnings: string[] = []
  let current = ""
  let bytes = 0
  const flush = () => {
    if (!current) return
    const cap = SECTION_BUDGET_BYTES[current]
    if (cap !== undefined && bytes > cap) {
      warnings.push(`section ${current} is ${bytes} bytes, over its ${cap} byte budget`)
    }
  }
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      flush()
      current = line.trim()
      bytes = 0
    }
    if (current) bytes += Buffer.byteLength(line, "utf8") + 1
  }
  flush()
  return warnings
}

export function validateCheckpoint(body: string): ValidationResult {
  const errors: string[] = []
  if (Buffer.byteLength(body, "utf8") > MAX_CHECKPOINT_BYTES) {
    errors.push(`size exceeds ${MAX_CHECKPOINT_BYTES} bytes`)
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) errors.push(`missing section: ${section}`)
  }
  const lines = body.split("\n")
  const blankCount = lines.filter((l) => l.trim() === "").length
  if (lines.length > 0 && blankCount / lines.length > 0.5) {
    errors.push("too many blank lines")
  }
  for (const g of GARBAGE_PATTERNS) {
    if (g.test(body)) {
      errors.push(`garbage pattern: ${g}`)
      break
    }
  }
  return { ok: errors.length === 0, errors, warnings: checkSectionBudgets(body) }
}
