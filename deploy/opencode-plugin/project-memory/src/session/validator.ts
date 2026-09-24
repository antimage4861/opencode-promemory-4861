export interface ValidationResult {
  ok: boolean
  errors: string[]
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

const MAX_CHECKPOINT_BYTES = 10 * 1024

const GARBAGE_PATTERNS: Array<RegExp> = [
  /lorem ipsum/i,
]

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
  return { ok: errors.length === 0, errors }
}
