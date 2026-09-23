import { useState } from 'react'
import { PayloadDialog } from './PayloadDialog'

export function PayloadButton({ requestId }: { requestId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-request-id={requestId}
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground/60 underline-offset-2 hover:text-muted-foreground hover:underline"
      >
        Ver payload
      </button>
      {open && <PayloadDialog requestId={requestId} open={open} onOpenChange={setOpen} />}
    </>
  )
}
