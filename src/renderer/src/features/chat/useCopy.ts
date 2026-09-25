import { useEffect, useRef, useState } from 'react'

/** Copia `text` para a área de transferência; mostra "copiado" por ~1,5 s. */
export function useCopy(): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      },
      () => undefined
    )
  }
  return { copied, copy }
}
