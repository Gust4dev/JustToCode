import { join } from 'node:path'
import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import { InstructionRepo } from '../repo/instructions'
import { createGithubClient, type GithubClientOptions } from '../library/github'
import { createLibrary } from '../library/install'

export interface LibraryHandlerOptions extends GithubClientOptions {
  /** Padrão: `<JTC_USER_DATA>/library`. */
  libraryRoot?: string
}

/** Handlers `library.*` (instalação via GitHub). `fetch`/bases da API são injetáveis nos testes. */
export const libraryHandlers =
  (opts: LibraryHandlerOptions = {}): HandlerModule =>
  (ctx) => {
    const library = createLibrary({
      github: createGithubClient(opts),
      instructions: new InstructionRepo(ctx.db),
      libraryRoot: opts.libraryRoot ?? join(process.env.JTC_USER_DATA ?? process.cwd(), 'library')
    })
    return {
      'library.previewGithub': ({
        url
      }: HostParams<'library.previewGithub'>): Promise<HostResult<'library.previewGithub'>> =>
        library.preview(url),
      'library.installGithub': (
        p: HostParams<'library.installGithub'>
      ): Promise<HostResult<'library.installGithub'>> => library.install(p),
      'library.checkUpdate': ({
        id
      }: HostParams<'library.checkUpdate'>): Promise<HostResult<'library.checkUpdate'>> =>
        library.checkUpdate(id)
    }
  }
