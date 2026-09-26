import type { Db } from "../memory/db.ts"
import type { PendingWriter, WriterDeps } from "./writer.ts"
import { runWriter } from "./writer.ts"

export interface CompactionHookDeps extends WriterDeps {
  db: Db
  markCheckpoint: (sessionID: string, ms?: number) => void
  hasPendingIncrement: (sessionID: string) => boolean
}

export function createCompactionHandler(deps: CompactionHookDeps, writerState: Map<string, PendingWriter>) {
  return async (input: { sessionID: string }): Promise<void> => {
    if (deps.blacklist.has(input.sessionID)) return
    if (!deps.hasPendingIncrement(input.sessionID)) return
    runWriter(
      { sessionID: input.sessionID, title: "压缩前自动沉淀", projectDir: deps.projectDir },
      deps,
      writerState,
    )
  }
}
