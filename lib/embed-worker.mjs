/* 在独立进程运行向量模型，避免原生模块故障退出宿主。stdin/stdout 使用逐行 JSON。 */
import { createInterface } from 'node:readline'

const MODEL = process.env.LTM_EMBEDDING_MODEL ?? 'Xenova/bge-small-zh-v1.5'
const MIRROR = process.env.LTM_HF_MIRROR ?? ''
const CACHE_DIR = process.env.LTM_CACHE_DIR ?? ''

let extractor = null
let loading = null

async function load() {
  if (extractor !== null) return extractor
  if (loading !== null) return loading
  loading = (async () => {
    const tf = await import('@huggingface/transformers')
    if (MIRROR !== '') tf.env.remoteHost = MIRROR
    if (CACHE_DIR !== '') tf.env.cacheDir = CACHE_DIR
    extractor = await tf.pipeline('feature-extraction', MODEL, { dtype: 'q8' })
    return extractor
  })()
  return loading
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const text = line.trim()
  if (text === '') return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    return
  }
  try {
    const model = await load()
    // BGE 的句向量使用首个 CLS token；平均所有 token 会放大相同句式的干扰。
    // 其他通过环境变量指定的模型保留原策略，避免猜测它们的池化约定。
    const pooling = /^(?:Xenova|BAAI)\/bge-small-zh-v1\.5$/.test(MODEL) ? 'cls' : 'mean'
    const output = await model(request.texts, { pooling, normalize: true })
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, vectors: output.tolist() })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: String(error?.message ?? error) })}\n`)
  }
})

process.on('SIGTERM', () => process.exit(0))
