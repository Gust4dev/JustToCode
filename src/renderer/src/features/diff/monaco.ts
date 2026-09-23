// Monaco empacotado localmente: nenhuma requisição a CDN.
// `loader.config({ monaco })` faz o @monaco-editor/react usar esta instância em vez de baixar do jsDelivr;
// os workers saem do bundle via `?worker` do Vite.
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

loader.config({ monaco })

let byExtension: Map<string, string> | null = null

/** Linguagem do Monaco pela extensão (ou nome exato, ex.: `Dockerfile`); `plaintext` se desconhecida. */
export function languageForPath(path: string): string {
  if (!byExtension) {
    byExtension = new Map()
    for (const lang of monaco.languages.getLanguages()) {
      for (const ext of lang.extensions ?? []) byExtension.set(ext.toLowerCase(), lang.id)
      for (const name of lang.filenames ?? []) byExtension.set(name.toLowerCase(), lang.id)
    }
  }
  const base = (path.split('/').pop() ?? path).toLowerCase()
  const byName = byExtension.get(base)
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return byExtension.get(base.slice(dot)) ?? 'plaintext'
}
