import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { call } from '@renderer/lib/host'
import { errorMessage } from '@renderer/features/projects/store'
import { languageForPath } from './monaco'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const subscribeDark = (cb: () => void): (() => void) => {
  darkQuery.addEventListener('change', cb)
  return () => darkQuery.removeEventListener('change', cb)
}
const useSystemDark = (): boolean => useSyncExternalStore(subscribeDark, () => darkQuery.matches)

type DiffData = { before: string | null; after: string | null; binary: boolean }

const OPTIONS: editor.IDiffEditorConstructionOptions = {
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  fontSize: 12,
  lineNumbersMinChars: 3,
  wordWrap: 'off'
}

/** Diff lado a lado, somente leitura. `version` muda quando a lista é recarregada (conteúdo pode ter mudado). */
export function DiffView({
  projectId,
  path,
  chatId,
  version
}: {
  projectId: string
  path: string
  chatId: string | null
  version: number
}): React.JSX.Element {
  const dark = useSystemDark()
  const [state, setState] = useState<{
    key: string
    path: string
    data: DiffData | null
    error: string | null
  } | null>(null)
  const key = `${projectId}|${path}|${chatId ?? ''}|${version}`

  useEffect(() => {
    let alive = true
    call('changes.fileDiff', { projectId, path, ...(chatId ? { chatId } : {}) })
      .then((data) => alive && setState({ key, path, data, error: null }))
      .catch((e) => alive && setState({ key, path, data: null, error: errorMessage(e) }))
    return () => {
      alive = false
    }
  }, [projectId, path, chatId, key])

  // Enquanto recarrega o mesmo arquivo, mantém o diff anterior na tela (sem piscar).
  const current = state && (state.key === key || state.path === path) ? state : null
  if (!current) return <Message text="Carregando diff…" />
  if (current.error) return <Message text={`Não foi possível carregar o diff: ${current.error}`} />
  const data = current.data!
  if (data.binary) return <Message text="Arquivo binário — não é possível mostrar o diff." />

  return (
    <MonacoDiff
      before={data.before ?? ''}
      after={data.after ?? ''}
      language={languageForPath(path)}
      dark={dark}
    />
  )
}

function MonacoDiff({
  before,
  after,
  language,
  dark
}: {
  before: string
  after: string
  language: string
  dark: boolean
}): React.JSX.Element {
  const models = useRef<editor.ITextModel[]>([])

  // O DiffEditor mantém os modelos (keepCurrent*) para evitar o erro "TextModel got disposed";
  // descartamos depois que o editor já foi desmontado.
  useEffect(
    () => () => {
      const toDispose = models.current
      models.current = []
      setTimeout(() => toDispose.forEach((m) => m.isDisposed() || m.dispose()), 0)
    },
    []
  )

  return (
    <DiffEditor
      height="100%"
      original={before}
      modified={after}
      language={language}
      theme={dark ? 'vs-dark' : 'light'}
      options={OPTIONS}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      loading={<Message text="Carregando editor…" />}
      onMount={(ed) => {
        const m = ed.getModel()
        if (m) models.current.push(m.original, m.modified)
      }}
    />
  )
}

function Message({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}
