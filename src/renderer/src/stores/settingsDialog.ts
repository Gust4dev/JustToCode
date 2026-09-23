import { create } from 'zustand'

/** Abertura do diálogo de configurações, para qualquer parte da UI poder pedir (ex.: erro AUTH no chat). */
export interface SettingsDialogState {
  open: boolean
  setOpen(open: boolean): void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

export const openSettings = (): void => useSettingsDialog.getState().setOpen(true)
