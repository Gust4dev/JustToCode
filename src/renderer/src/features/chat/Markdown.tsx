import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@renderer/lib/utils'

/** Tira a prop `node` (AST) que o react-markdown passa, para não ir parar no DOM. */
function omitNode<T extends { node?: unknown }>(p: T): Omit<T, 'node'> {
  const r = { ...p }
  delete r.node
  return r
}

const components: Components = {
  p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...omitNode(p)} />,
  a: (p) => (
    <a
      className="text-primary underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...omitNode(p)}
    />
  ),
  ul: (p) => <ul className="my-2 list-disc space-y-0.5 pl-5" {...omitNode(p)} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-0.5 pl-5" {...omitNode(p)} />,
  h1: (p) => <h1 className="mt-4 mb-2 text-base font-semibold" {...omitNode(p)} />,
  h2: (p) => <h2 className="mt-4 mb-2 text-sm font-semibold" {...omitNode(p)} />,
  h3: (p) => <h3 className="mt-3 mb-1.5 text-sm font-semibold" {...omitNode(p)} />,
  blockquote: (p) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...omitNode(p)} />
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: (p) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...omitNode(p)} />
    </div>
  ),
  th: (p) => <th className="border px-2 py-1 text-left font-medium" {...omitNode(p)} />,
  td: (p) => <td className="border px-2 py-1 align-top" {...omitNode(p)} />,
  pre: (p) => (
    <pre
      className="my-2 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0"
      {...omitNode(p)}
    />
  ),
  code: ({ className, ...p }) => (
    <code
      className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', className)}
      {...omitNode(p)}
    />
  )
}

export const Markdown = memo(function Markdown({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('text-sm leading-relaxed break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
