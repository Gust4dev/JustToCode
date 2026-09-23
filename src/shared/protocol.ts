import { z } from 'zod'

export const ReqMsg = z.object({
  kind: z.literal('req'),
  id: z.string(),
  method: z.string(),
  params: z.unknown()
})
export const ResMsg = z.union([
  z.object({ kind: z.literal('res'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    kind: z.literal('res'),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() })
  })
])
export const EventMsg = z.object({
  kind: z.literal('event'),
  name: z.string(),
  payload: z.unknown()
})
export const Envelope = z.union([ReqMsg, ResMsg, EventMsg])

export type ReqMsg = z.infer<typeof ReqMsg>
export type ResMsg = z.infer<typeof ResMsg>
export type EventMsg = z.infer<typeof EventMsg>
export type Envelope = z.infer<typeof Envelope>
