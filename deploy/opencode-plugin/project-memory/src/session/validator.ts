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

const MAX_CHECKPOINT_BYTES = 10 * 1024

/**
 * Per-section byte budgets. Overshooting one is reported as a warning, never a
 * rejection: a rejected checkpoint is silently lost, which is the failure mode
 * this whole check exists to make visible. Budgets sum to 7400, comfortably
 * inside MAX_CHECKPOINT_BYTES, so hitting a section budget normally trips the
 * total-size error first and the writer surfaces a real reason.
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
