// Flags das aprovações. Pura: sem imports do renderer.

export const COLLISION_PREFIX = 'other_chat_touched:'

/** Separa os flags de colisão (`other_chat_touched:<chatId>`) dos demais. */
export function splitApprovalFlags(flags: string[]): { collisions: string[]; others: string[] } {
  const collisions: string[] = []
  const others: string[] = []
  for (const f of flags) {
    if (f.startsWith(COLLISION_PREFIX)) {
      const id = f.slice(COLLISION_PREFIX.length).trim()
      if (id && !collisions.includes(id)) collisions.push(id)
    } else others.push(f)
  }
  return { collisions, others }
}

export const ALWAYS_CONFIRM_PREFIX = 'always_confirm:'

/** Separa os motivos de "sempre confirmar" (`always_confirm:<motivo>`) dos demais flags. */
export function splitAlwaysConfirm(flags: string[]): { reasons: string[]; rest: string[] } {
  const reasons: string[] = []
  const rest: string[] = []
  for (const f of flags) {
    if (f.startsWith(ALWAYS_CONFIRM_PREFIX)) {
      const r = f.slice(ALWAYS_CONFIRM_PREFIX.length).trim()
      if (r && !reasons.includes(r)) reasons.push(r)
    } else rest.push(f)
  }
  return { reasons, rest }
}
