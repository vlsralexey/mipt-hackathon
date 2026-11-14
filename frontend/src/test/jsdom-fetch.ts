import { builtinEnvironments, type Environment } from 'vitest/runtime'

export default {
  name: 'jsdom-fetch',
  viteEnvironment: 'client',
  async setup(global, options) {
    // fetch в jsdom работает через Node. Его multipart должен использовать те же
    // File/Blob/FormData: адаптер jsdom в Vitest превращает File в безымянный Blob.
    const fetchTypes = {
      Blob: global.Blob,
      File: global.File,
      FormData: global.FormData,
      Request: global.Request,
    }
    const environment = await builtinEnvironments.jsdom.setup(global, options)
    Object.assign(global, fetchTypes)
    return environment
  },
} satisfies Environment
