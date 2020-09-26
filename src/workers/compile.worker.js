import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import resolveConfig from 'tailwindcss/resolveConfig'
import extractClasses from './extractClasses'
import { removeFunctions } from '../utils/object'
///////////////
import {
  baseUrl as pageBaseUrl,
  resolveImportMap,
  createBlob,
  resolveUrl,
  resolveAndComposeImportMap,
  hasDocument,
  resolveIfNotPlainOrUrl,
  dynamicImport,
  resolvedPromise,
} from './es-module-shims/common.js'
import { init, parse } from 'es-module-lexer/dist/lexer.js'
const applyComplexClasses = require('tailwindcss/lib/flagged/applyComplexClasses')

// TODO
let _applyComplexClasses = applyComplexClasses.default
applyComplexClasses.default = (...args) => {
  let fn = _applyComplexClasses(...args)
  return (css) => {
    css.walkRules((rule) => {
      rule.selector = rule.selector.replace(/__TWSEP__(.*?)__TWSEP__/g, '$1')
    })
    fn(css)
  }
}

let current

addEventListener('message', async (event) => {
  if (event.data._current) {
    current = event.data._current
    return
  }

  function respond(data) {
    setTimeout(() => {
      if (event.data._id === current) {
        postMessage({ _id: event.data._id, ...data })
      } else {
        postMessage({ _id: event.data._id, canceled: true })
      }
    }, 0)
  }

  let mod = {}

  const before = `(async function(module, self){
    const require = async (m) => {
      if (typeof m !== 'string' || m === '') throw Error('No module')
      const result = await self.importShim('https://cdn.skypack.dev/' + m)
      return result.default || result
    }`
  const after = `})(mod, {})`

  try {
    await eval(
      before +
        '\n' +
        event.data.config.replace(/\brequire\(/g, 'await require(') +
        '\n' +
        after
    )
  } catch (error) {
    let line

    if (typeof error.line !== 'undefined') {
      line = error.line - 1
    } else {
      const lines = error.stack.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const re = /:([0-9]+):([0-9]+)/g
        const matches = []
        let match
        while ((match = re.exec(lines[i])) !== null) {
          matches.push(match)
        }
        if (matches.length > 0) {
          line = parseInt(matches[matches.length - 1][1], 10)
          break
        }
      }
    }

    return respond({
      error: {
        message: error.message,
        file: 'Config',
        line:
          typeof line === 'undefined'
            ? undefined
            : line - before.split('\n').length,
      },
    })
  }

  let state = {}

  try {
    const separator = mod.exports.separator || ':'
    mod.exports.separator = `__TWSEP__${separator}__TWSEP__`
    const { css, root } = await postcss([
      tailwindcss(mod.exports),
    ]).process(event.data.css, { from: undefined })
    mod.exports.separator = separator
    state.classNames = await extractClasses(root)
    state.separator = separator
    state.config = resolveConfig(mod.exports)
    removeFunctions(state.config)
    state.variants = [] // TODO
    state.version = '1.8.5'
    state.editor = {
      userLanguages: {},
      capabilities: {},
      globalSettings: {
        validate: true,
        lint: {
          cssConflict: 'warning',
          invalidApply: 'error',
          invalidScreen: 'error',
          invalidVariant: 'error',
          invalidConfigPath: 'error',
          invalidTailwindDirective: 'error',
        },
      },
    }
    state.featureFlags = { experimental: [], future: [] } // TODO
    const escapedSeparator = separator.replace(/./g, (m) =>
      /[a-z0-9-_]/i.test(m) ? m : `\\${m}`
    )
    respond({
      state,
      css: css.replace(/__TWSEP__.*?__TWSEP__/g, escapedSeparator),
    })
  } catch (error) {
    if (error.toString().startsWith('CssSyntaxError')) {
      const match = error.message.match(
        /^<css input>:([0-9]+):([0-9]+): (.*?)$/
      )
      respond({ error: { message: match[3], file: 'CSS', line: match[1] } })
    } else {
      respond({ error: { message: error.message } })
    }
  }
})

////////////////////////////////////////////////////
///////////////////////////////////////////////////
// https://github.com/guybedford/es-module-shims/blob/master/src/es-module-shims.js

let id = 0
const registry = {}

async function loadAll(load, seen) {
  if (load.b || seen[load.u]) return
  seen[load.u] = 1
  await load.L
  return Promise.all(load.d.map((dep) => loadAll(dep, seen)))
}

let waitingForImportMapsInterval
let firstTopLevelProcess = true
async function topLevelLoad(url, source) {
  if (waitingForImportMapsInterval > 0) {
    clearTimeout(waitingForImportMapsInterval)
    waitingForImportMapsInterval = 0
  }
  await importMapPromise
  await init
  const load = getOrCreateLoad(url, source)
  const seen = {}
  await loadAll(load, seen)
  lastLoad = undefined
  resolveDeps(load, seen)
  const module = await dynamicImport(load.b)
  // if the top-level load is a shell, run its update function
  if (load.s) (await dynamicImport(load.s)).u$_(module)
  return module
}

async function importShim(id, parentUrl) {
  return topLevelLoad(resolve(id, parentUrl || pageBaseUrl))
}

self.importShim = importShim

const meta = {}

const edge = navigator.userAgent.match(/Edge\/\d\d\.\d+$/)

async function importMetaResolve(id, parentUrl = this.url) {
  await importMapPromise
  return resolve(id, `${parentUrl}`)
}

Object.defineProperties(importShim, {
  m: { value: meta },
  l: { value: undefined, writable: true },
  e: { value: undefined, writable: true },
})
importShim.fetch = (url) => fetch(url)
importShim.skip = /^https?:\/\/(cdn\.pika\.dev|dev\.jspm\.io|jspm\.dev)\//
// importShim.load = processScripts;

let lastLoad
function resolveDeps(load, seen) {
  if (load.b || !seen[load.u]) return
  seen[load.u] = 0

  for (const dep of load.d) resolveDeps(dep, seen)

  // "execution"
  const source = load.S
  // edge doesnt execute sibling in order, so we fix this up by ensuring all previous executions are explicit dependencies
  let resolvedSource = edge && lastLoad ? `import '${lastLoad}';` : ''

  const [imports] = load.a

  if (!imports.length) {
    resolvedSource += source
  } else {
    // once all deps have loaded we can inline the dependency resolution blobs
    // and define this blob
    let lastIndex = 0,
      depIndex = 0
    for (const { s: start, e: end, d: dynamicImportIndex } of imports) {
      // dependency source replacements
      if (dynamicImportIndex === -1) {
        const depLoad = load.d[depIndex++]
        let blobUrl = depLoad.b
        if (!blobUrl) {
          // circular shell creation
          if (!(blobUrl = depLoad.s)) {
            blobUrl = depLoad.s = createBlob(
              `export function u$_(m){${depLoad.a[1]
                .map((name) =>
                  name === 'default'
                    ? `$_default=m.default`
                    : `${name}=m.${name}`
                )
                .join(',')}}${depLoad.a[1]
                .map((name) =>
                  name === 'default'
                    ? `let $_default;export{$_default as default}`
                    : `export let ${name}`
                )
                .join(';')}\n//# sourceURL=${depLoad.r}?cycle`
            )
          }
        }
        // circular shell execution
        else if (depLoad.s) {
          resolvedSource +=
            source.slice(lastIndex, start - 1) +
            '/*' +
            source.slice(start - 1, end + 1) +
            '*/' +
            source.slice(start - 1, start) +
            blobUrl +
            source[end] +
            `;import*as m$_${depIndex} from'${depLoad.b}';import{u$_ as u$_${depIndex}}from'${depLoad.s}';u$_${depIndex}(m$_${depIndex})`
          lastIndex = end + 1
          depLoad.s = undefined
          continue
        }
        resolvedSource +=
          source.slice(lastIndex, start - 1) +
          '/*' +
          source.slice(start - 1, end + 1) +
          '*/' +
          source.slice(start - 1, start) +
          blobUrl
        lastIndex = end
      }
      // import.meta
      else if (dynamicImportIndex === -2) {
        meta[load.r] = { url: load.r, resolve: importMetaResolve }
        resolvedSource +=
          source.slice(lastIndex, start) +
          'importShim.m[' +
          JSON.stringify(load.r) +
          ']'
        lastIndex = end
      }
      // dynamic import
      else {
        resolvedSource +=
          source.slice(lastIndex, dynamicImportIndex + 6) +
          'Shim(' +
          source.slice(start, end) +
          ', ' +
          JSON.stringify(load.r)
        lastIndex = end
      }
    }

    resolvedSource += source.slice(lastIndex)
  }

  let sourceMappingResolved = ''
  const sourceMappingIndex = resolvedSource.lastIndexOf('//# sourceMappingURL=')
  if (sourceMappingIndex > -1) {
    const sourceMappingEnd = resolvedSource.indexOf('\n', sourceMappingIndex)
    const sourceMapping = resolvedSource.slice(
      sourceMappingIndex,
      sourceMappingEnd > -1 ? sourceMappingEnd : undefined
    )
    sourceMappingResolved =
      `\n//# sourceMappingURL=` + resolveUrl(sourceMapping.slice(21), load.r)
  }
  load.b = lastLoad = createBlob(
    resolvedSource + sourceMappingResolved + '\n//# sourceURL=' + load.r
  )
  load.S = undefined
}

function getOrCreateLoad(url, source) {
  let load = registry[url]
  if (load) return load

  load = registry[url] = {
    // url
    u: url,
    // response url
    r: undefined,
    // fetchPromise
    f: undefined,
    // source
    S: undefined,
    // linkPromise
    L: undefined,
    // analysis
    a: undefined,
    // deps
    d: undefined,
    // blobUrl
    b: undefined,
    // shellUrl
    s: undefined,
  }

  const depcache = importMap.depcache[url]
  if (depcache)
    depcache.forEach((depUrl) => getOrCreateLoad(resolve(depUrl, url)))

  load.f = (async () => {
    if (!source) {
      const res = await importShim.fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${res.url}`)
      load.r = res.url
      const contentType = res.headers.get('content-type')
      if (contentType.match(/^(text|application)\/(x-)?javascript(;|$)/))
        source = await res.text()
      else throw new Error(`Unknown Content-Type "${contentType}"`)
    }
    try {
      load.a = parse(source, load.u)
    } catch (e) {
      console.warn(e)
      load.a = [[], []]
    }
    load.S = source
    return load.a[0]
      .filter((d) => d.d === -1)
      .map((d) => source.slice(d.s, d.e))
  })()

  load.L = load.f.then(async (deps) => {
    load.d = await Promise.all(
      deps.map(async (depId) => {
        let resolved = resolve(depId, load.r || load.u)
        // https://cdn.skypack.dev/-/tailwindcss@v1.7.6-TG1T56mU2GyYfzeRbPoh/dist=es2020,mode=raw/resolveConfig
        const match = resolved.match(
          /https:\/\/cdn\.skypack\.dev\/-\/tailwindcss@.*?mode=raw\/(.*?)$/
        )
        if (match !== null) {
          resolved = `/api/package?file=${match[1]}`
        }
        if (importShim.skip.test(resolved)) return { b: resolved }
        const depLoad = getOrCreateLoad(resolved)
        await depLoad.f
        return depLoad
      })
    )
  })

  return load
}

const importMap = { imports: {}, scopes: {}, depcache: {} }
let importMapPromise = resolvedPromise

function resolve(id, parentUrl) {
  return (
    resolveImportMap(
      importMap,
      resolveIfNotPlainOrUrl(id, parentUrl) || id,
      parentUrl
    ) || throwUnresolved(id, parentUrl)
  )
}

function throwUnresolved(id, parentUrl) {
  throw Error(
    "Unable to resolve specifier '" +
      id +
      (parentUrl ? "' from " + parentUrl : "'")
  )
}
