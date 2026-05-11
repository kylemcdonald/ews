/* global process */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_ENV_DIR = path.resolve(__dirname, '..')
const REQUIRED_PRODUCTION_DASHBOARD_ENV_VARS = [
  'VITE_DASHBOARD_URL',
  'VITE_MILITARY_DASHBOARD_URL',
  'VITE_UNTRACKED_DASHBOARD_URL',
]

function validateProductionDashboardEnv(command, mode) {
  if (command !== 'build' || mode !== 'production') {
    return
  }

  const env = {
    ...loadEnv(mode, ROOT_ENV_DIR, ''),
    ...process.env,
  }
  const errors = REQUIRED_PRODUCTION_DASHBOARD_ENV_VARS
    .map((name) => validateDashboardEnvUrl(name, env[name]))
    .filter(Boolean)

  if (errors.length) {
    throw new Error(
      [
        'Production dashboard builds require explicit public dashboard JSON URLs.',
        ...errors.map((error) => `- ${error}`),
      ].join('\n'),
    )
  }
}

function validateDashboardEnvUrl(name, value) {
  if (!value) {
    return `${name} is missing.`
  }

  let url
  try {
    url = new URL(value)
  } catch {
    return `${name} must be an absolute URL. Received: ${value}`
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `${name} must use http or https. Received: ${value}`
  }

  if (!url.pathname.endsWith('.json')) {
    return `${name} must point at a JSON snapshot. Received: ${value}`
  }

  return null
}

function inlineEntryBootstrap() {
  return {
    name: 'inline-entry-bootstrap',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlAsset = Object.values(bundle).find(
        (asset) => asset.type === 'asset' && asset.fileName === 'index.html',
      )
      const entryChunks = Object.values(bundle).filter(
        (asset) => asset.type === 'chunk' && asset.isEntry,
      )

      if (!htmlAsset || entryChunks.length === 0) {
        return
      }

      let html = String(htmlAsset.source)

      for (const entryChunk of entryChunks) {
        const preloadDependencies = getPreloadDependencies(entryChunk, bundle)
        let entryCode = entryChunk.code.replaceAll(
          '__VITE_PRELOAD__',
          JSON.stringify(preloadDependencies),
        )

        for (const importedFileName of entryChunk.imports ?? []) {
          const importedBaseName = importedFileName.split('/').at(-1)
          entryCode = rewriteInlinedRelativeImport(entryCode, importedBaseName, `/${importedFileName}`)
        }

        for (const dynamicImport of entryChunk.dynamicImports ?? []) {
          const importedFileName = dynamicImport.split('/').at(-1)

          entryCode = entryCode
            .replaceAll(`import(\`./${importedFileName}\`)`, `import(\`/${dynamicImport}\`)`)
            .replaceAll(`import("./${importedFileName}")`, `import("/${dynamicImport}")`)
            .replaceAll(`import('./${importedFileName}')`, `import('/${dynamicImport}')`)
        }

        const escapedFileName = entryChunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const scriptTagPattern = new RegExp(
          `<script\\b(?=[^>]*\\btype=["']module["'])(?=[^>]*\\bsrc=["']/${escapedFileName}["'])[^>]*></script>`,
        )

        if (scriptTagPattern.test(html)) {
          html = html.replace(scriptTagPattern, `<script type="module">\n${entryCode}\n</script>`)
          delete bundle[entryChunk.fileName]
        }
      }

      htmlAsset.source = html
    },
  }
}

function rewriteInlinedRelativeImport(code, importedBaseName, publicPath) {
  const escapedBaseName = importedBaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const importSpecifierPattern = new RegExp(
    `((?:from|import)\\s*["'\`])\\./${escapedBaseName}(["'\`])`,
    'g',
  )

  return code.replace(importSpecifierPattern, `$1${publicPath}$2`)
}

function getPreloadDependencies(entryChunk, bundle) {
  const dependencies = []
  const seenDependencies = new Set()
  const seenChunks = new Set()

  function addDependency(fileName) {
    if (seenDependencies.has(fileName)) {
      return
    }

    seenDependencies.add(fileName)
    dependencies.push(fileName)
  }

  function addChunk(fileName) {
    if (seenChunks.has(fileName)) {
      return
    }

    seenChunks.add(fileName)
    addDependency(fileName)

    const chunk = bundle[fileName]

    if (!chunk || chunk.type !== 'chunk') {
      return
    }

    for (const importedFileName of chunk.imports ?? []) {
      addChunk(importedFileName)
    }

    for (const cssFileName of chunk.viteMetadata?.importedCss ?? []) {
      addDependency(cssFileName)
    }
  }

  for (const dynamicImport of entryChunk.dynamicImports ?? []) {
    addChunk(dynamicImport)
  }

  return dependencies
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  validateProductionDashboardEnv(command, mode)

  return {
    envDir: ROOT_ENV_DIR,
    plugins: [react(), inlineEntryBootstrap()],
    server: {
      proxy: {
        '/api': 'http://localhost:3030',
      },
    },
  }
})
