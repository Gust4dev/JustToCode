import { useEffect, useRef } from 'react'

/** Lugares onde o foco/teclado pertence a outro controle: não redirecionar para o compositor. */
const OWNED =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .monaco-editor'

function busyElsewhere(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(OWNED)) return true
  const active = document.activeElement
  if (active instanceof Element && active.closest(OWNED)) return true
  // Dialog aberto em qualquer lugar (o foco pode estar no overlay).
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

/** Tecla que produz um caractere, sem atalho (Ctrl/Alt/Meta). */
function isLooseTyping(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing
}

/**
 * Mantém o compositor como destino padrão do teclado: foca ao ganhar foco a janela,
 * captura digitação "solta" e Ctrl+V/paste feitos fora de campos, dialogs e do Monaco.
 */
export function useComposerFocus(
  areaRef: React.RefObject<HTMLTextAreaElement | null>,
  onFiles: (files: File[]) => void
): void {
  const filesRef = useRef(onFiles)
  useEffect(() => {
    filesRef.current = onFiles
  })

  useEffect(() => {
    const focusArea = (): HTMLTextAreaElement | null => {
      const el = areaRef.current
      if (!el || el.disabled) return null
      if (document.activeElement !== el) el.focus()
      return el
    }

    // O navegador restaura o foco anterior depois do evento; decide no quadro seguinte.
    let raf = 0
    const onWindowFocus = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!busyElsewhere(document.activeElement)) focusArea()
      })
    }

    // Foca já no keydown: o caractere/paste que vem em seguida cai no textarea.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || busyElsewhere(e.target)) return
      const pasteKey = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V')
      if (pasteKey) {
        focusArea()
        return
      }
      if (!isLooseTyping(e)) return
      // Espaço num botão/checkbox focado é ativação, não digitação.
      const active = document.activeElement
      if (e.key === ' ' && active && active !== document.body) return
      focusArea()
    }

    // Plano B do paste (ex.: menu Editar): repassa ao compositor.
    const onPaste = (e: ClipboardEvent): void => {
      if (e.target === areaRef.current || busyElsewhere(e.target) || !e.clipboardData) return
      const el = focusArea()
      if (!el) return
      e.preventDefault()
      const files = [...e.clipboardData.files]
      if (files.length > 0) {
        filesRef.current(files)
        return
      }
      const text = e.clipboardData.getData('text/plain')
      // insertText mantém o desfazer e dispara o onChange do React.
      if (text) document.execCommand('insertText', false, text)
    }

    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('paste', onPaste)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('paste', onPaste)
    }
  }, [areaRef])
}
