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
