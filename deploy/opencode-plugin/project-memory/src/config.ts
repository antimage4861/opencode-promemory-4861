export interface MemoryPluginConfig {
  disableWrite?: boolean
  writerTimeoutMs?: number
  retentionDays?: number
  retentionCleanupIntervalDays?: number
  memoryReconcileOnSearch?: boolean
  searchScoreFloor?: number
  validatorFull?: boolean
  dreamIntervalDays?: number
  distillIntervalDays?: number
}

export interface ResolvedConfig {
  disableWrite: boolean
  writerTimeoutMs: number
  retentionDays: number
  retentionCleanupIntervalMs: number
  memoryReconcileOnSearch: boolean
  searchScoreFloor: number
  validatorFull: boolean
  dreamIntervalDays: number
  distillIntervalDays: number
}

export const DEFAULTS: ResolvedConfig = {
  disableWrite: false,
  writerTimeoutMs: 120_000,
  retentionDays: 0,
  retentionCleanupIntervalMs: 24 * 60 * 60 * 1000,
  memoryReconcileOnSearch: true,
  searchScoreFloor: 0.15,
  validatorFull: false,
  dreamIntervalDays: 7,
  distillIntervalDays: 30,
}

export function resolveConfig(raw: MemoryPluginConfig | undefined): ResolvedConfig {
  const c = raw ?? {}
  const env = (name: string): string | undefined => process.env[`PROJECT_MEMORY_${name}`]
  const envBool = (name: string): boolean | undefined => {
    const v = env(name)
    if (v === undefined) return undefined
    return v === "true" || v === "1"
  }
  const envNum = (name: string): number | undefined => {
    const v = env(name)
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const pick = <K extends keyof ResolvedConfig>(key: K): ResolvedConfig[K] | undefined => {
    const rawVal = c[key]
    if (rawVal !== undefined) return rawVal as ResolvedConfig[K]
    return undefined
  }
  return {
    disableWrite: pick("disableWrite") ?? envBool("DISABLE_WRITE") ?? DEFAULTS.disableWrite,
    writerTimeoutMs: pick("writerTimeoutMs") ?? envNum("WRITER_TIMEOUT_MS") ?? DEFAULTS.writerTimeoutMs,
    retentionDays: pick("retentionDays") ?? envNum("RETENTION_DAYS") ?? DEFAULTS.retentionDays,
    retentionCleanupIntervalMs:
      (pick("retentionCleanupIntervalDays") as number | undefined) ??
      envNum("RETENTION_CLEANUP_INTERVAL_DAYS") ??
      1 * 24 * 60 * 60 * 1000,
    memoryReconcileOnSearch: pick("memoryReconcileOnSearch") ?? envBool("RECONCILE_ON_SEARCH") ?? DEFAULTS.memoryReconcileOnSearch,
    searchScoreFloor: pick("searchScoreFloor") ?? envNum("SEARCH_SCORE_FLOOR") ?? DEFAULTS.searchScoreFloor,
    validatorFull: pick("validatorFull") ?? envBool("VALIDATOR_FULL") ?? DEFAULTS.validatorFull,
    dreamIntervalDays: pick("dreamIntervalDays") ?? envNum("DREAM_INTERVAL_DAYS") ?? DEFAULTS.dreamIntervalDays,
    distillIntervalDays: pick("distillIntervalDays") ?? envNum("DISTILL_INTERVAL_DAYS") ?? DEFAULTS.distillIntervalDays,
  }
}

export function asMemoryPluginOptions(value: unknown): MemoryPluginConfig | undefined {
  if (!value || typeof value !== "object") return undefined
  return value as MemoryPluginConfig
}
