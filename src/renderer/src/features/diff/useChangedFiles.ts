import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangedFileSummary } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { errorMessage } from '@renderer/features/projects/store'

const DEBOUNCE_MS = 300

/**
 * Mudanças não revisadas do projeto (`changes.list`), opcionalmente filtradas por chat.
 * Recarrega com `file_touched` (debounce) e descarta respostas antigas.
 */
export function useChangedFiles(
  projectId: string,
  filterChatId: string | null
): {
  files: ChangedFileSummary[] | null
  loadError: string | null
  version: number
  refresh(): Promise<void>
} {
  const [files, setFiles] = useState<ChangedFileSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reqSeq = useRef(0)

  const refresh = useCallback((): Promise<void> => {
    const seq = ++reqSeq.current
    return call('changes.list', {
      projectId,
      ...(filterChatId ? { chatId: filterChatId } : {})
    }).then(
      (list) => {
        if (seq !== reqSeq.current) return
        setFiles(list)
        setLoadError(null)
        setVersion((v) => v + 1)
      },
      (e) => {
        if (seq === reqSeq.current) setLoadError(errorMessage(e))
      }
    )
  }, [projectId, filterChatId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  useEngineEvent((e) => {
    if (e.type !== 'file_touched' || e.projectId !== projectId) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void refresh()
    }, DEBOUNCE_MS)
  })

  return { files, loadError, version, refresh }
}
