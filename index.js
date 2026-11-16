import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const rules = fs.readFileSync('./rules.txt', 'utf8')
const SYSTEM = fs.readFileSync('./prompt.txt', 'utf8').replace('{rules}', rules)
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim()
const logger = pino({ level: 'silent' })

// Text models: first one is preferred, second one is the fallback.
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b'
]

// Groq model for image understanding.
const VISION_MODEL = 'qwen/qwen3.8-27b'
const TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo'

// Number of previous text messages kept for each WhatsApp chat/group.
const MEMORY_MESSAGES = Math.max(
  2,
  Number.parseInt(process.env.MEMORY_MESSAGES || '12', 10) || 12
)
const MEMORY_FILE = process.env.MEMORY_FILE || path.join(AUTH_DIR, 'memory.json')
const memory = new Map()

const FAIL = 'السيرفر ديال الذكاء الاصطناعي مشغول دابا، عاود المحاولة من بعد شوية.'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return

    const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
    for (const [chatId, messages] of Object.entries(saved)) {
      if (Array.isArray(messages)) {
        memory.set(chatId, messages.slice(-MEMORY_MESSAGES))
      }
    }

    console.log('Memory loaded for chats:', memory.size)
  } catch (e) {
    console.log('MEMORY LOAD ERROR:', e.message)
  }
}

async function saveMemory() {
  try {
    await fs.promises.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
    await fs.promises.writeFile(
      MEMORY_FILE,
      JSON.stringify(Object.fromEntries(memory)),
      'utf8'
    )
  } catch (e) {
    console.log('MEMORY SAVE ERROR:', e.message)
  }
}

function getChatHistory(chatId) {
  return memory.get(chatId)?.slice(-MEMORY_MESSAGES) || []
}

async function remember(chatId, userText, assistantText) {
  const history = getChatHistory(chatId)
  history.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText }
  )
  memory.set(chatId, history.slice(-MEMORY_MESSAGES))
  await saveMemory()
}

function isTemporaryError(status) {
  return [429, 500, 502, 503, 504].includes(status)
}

function retryWaitMs(res, attempt) {
  const retryAfter = Number(res.headers.get('retry-after'))
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : 2000 * attempt
}

async function askGroqText(text, history = []) {
  if (!GROQ_API_KEY) {
    console.log('GROQ ERROR: GROQ_API_KEY is missing')
    return FAIL
  }

  for (const model of GROQ_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM },
              ...history,
              { role: 'user', content: text }
            ],
            temperature: 0.7,
            max_completion_tokens: 1024
          })
        })

        const data = await res.json()

        if (res.ok) {
          const reply = data?.choices?.[0]?.message?.content?.trim()
          if (reply) return reply
          console.log('GROQ EMPTY', model, JSON.stringify(data).slice(0, 300))
          break
        }

        console.log(
          'GROQ ERROR',
          model,
          'try',
          attempt,
          res.status,
          JSON.stringify(data).slice(0, 300)
        )

        if (isTemporaryError(res.status) && attempt < 3) {
          await sleep(retryWaitMs(res, attempt))
          continue
        }

        // Try the fallback text model.
        break
      } catch (e) {
        console.log('GROQ FETCH ERROR', model, 'try', attempt, e.message)
        if (attempt < 3) await sleep(2000 * attempt)
      }
    }
  }

  return FAIL
}

async function askGroqVision(question, imageBuffer, mimetype, history = []) {
  if (!GROQ_API_KEY) {
    console.log('GROQ ERROR: GROQ_API_KEY is missing')
    return FAIL
  }

  if (!imageBuffer || imageBuffer.length > 20 * 1024 * 1024) {
    return 'الصورة كبيرة بزاف. صيفط صورة أقل من 20MB من فضلك.'
  }

  const safeMime = (mimetype || 'image/jpeg').split(';')[0]
  const base64Image = imageBuffer.toString('base64')
  const imageDataUrl = `data:${safeMime};base64,${base64Image}`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          ...history,
          {
            role: 'user',
            content: [
              { type: 'text', text: question || 'شرح ليا شنو كاين فهاد الصورة.' },
              { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
          }
        ],
        temperature: 0.7,
        max_completion_tokens: 1024
      })
    })

    const data = await res.json()
    if (res.ok) {
      const reply = data?.choices?.[0]?.message?.content?.trim()
      if (reply) return reply
    }

    console.log('GROQ VISION ERROR', res.status, JSON.stringify(data).slice(0, 500))
    return FAIL
  } catch (e) {
    console.log('GROQ VISION FETCH ERROR:', e.message)
    return FAIL
  }
}

async function transcribeAudio(audioBuffer, mimetype) {
  if (!GROQ_API_KEY) {
    console.log('GROQ ERROR: GROQ_API_KEY is missing')
    return null
  }

  if (!audioBuffer || audioBuffer.length > 25 * 1024 * 1024) {
    console.log('AUDIO ERROR: file is larger than 25MB')
    return null
  }

  try {
    const safeMime = (mimetype || 'audio/ogg').split(';')[0]
    const extension = safeMime.includes('mpeg') || safeMime.includes('mp3')
      ? 'mp3'
      : safeMime.includes('wav')
        ? 'wav'
        : safeMime.includes('webm')
          ? 'webm'
          : 'ogg'

    const form = new FormData()
    form.append(
      'file',
      new Blob([audioBuffer], { type: safeMime }),
      `whatsapp-audio.${extension}`
    )
    form.append('model', TRANSCRIPTION_MODEL)
    form.append('response_format', 'json')
    form.append('prompt', 'الرسالة قد تكون بالدارجة المغربية أو العربية.')

    const res = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form
      }
    )

    const data = await res.json()
    if (res.ok && data?.text?.trim()) return data.text.trim()

    console.log('GROQ TRANSCRIPTION ERROR', res.status, JSON.stringify(data).slice(0, 500))
    return null
  } catch (e) {
    console.log('GROQ TRANSCRIPTION FETCH ERROR:', e.message)
    return null
  }
}

function getContextInfo(message) {
  return message?.extendedTextMessage?.contextInfo
    || message?.imageMessage?.contextInfo
    || message?.audioMessage?.contextInfo
    || message?.videoMessage?.contextInfo
    || message?.documentMessage?.contextInfo
}

function getMessageText(message) {
  return message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || message?.videoMessage?.caption
    || message?.documentMessage?.caption
    || ''
}

function getQuotedText(contextInfo) {
  const quoted = contextInfo?.quotedMessage
  return quoted?.conversation
    || quoted?.extendedTextMessage?.text
    || quoted?.imageMessage?.caption
    || quoted?.videoMessage?.caption
    || quoted?.documentMessage?.caption
    || ''
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  loadMemory()

  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })
  let asked = false

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !asked && !sock.authState.creds.registered && process.env.PHONE) {
      asked = true
      try {
        const code = await sock.requestPairingCode(process.env.PHONE)
        console.log('PAIRING CODE:', code)
      } catch (e) {
        console.log('pairing error:', e.message)
        asked = false
      }
    }

    if (connection === 'open') console.log('Bot connected')

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('connection closed, code:', code)
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(start, 3000)
      } else {
        console.log('logged out, change AUTH_DIR and relink')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue

        const chatId = m.key.remoteJid
        const message = m.message
        const image = message.imageMessage
        const audio = message.audioMessage
        const contextInfo = getContextInfo(message)
        const text = getMessageText(message).trim()

        const myIds = [sock.user?.id, sock.user?.lid]
          .filter(Boolean)
          .map(x => x.split(':')[0].split('@')[0])

        const mentioned = (contextInfo?.mentionedJid || [])
          .some(j => myIds.includes(j.split('@')[0]))

        const isPrivateChat = !chatId.endsWith('@g.us')
        const quotedParticipant = contextInfo?.participant || ''
        const isReplyToBot = myIds.includes(quotedParticipant.split(':')[0].split('@')[0])

        // In groups, process only mentions/replies. In private chats, process every text/media message.
        if (!mentioned && !isPrivateChat && !isReplyToBot) continue

        const quotedText = getQuotedText(contextInfo)
        const clean = text.replace(/@\d+/g, '').trim()
        const question = quotedText
          ? `الرسالة المقتبسة: ${quotedText}\n\nالطلب: ${clean}`
          : clean
        const history = getChatHistory(chatId)

        let reply
        let memoryInput

        if (image) {
          const imageBuffer = await downloadMediaMessage(
            m,
            'buffer',
            {},
            { logger }
          )
          const imageQuestion = question || 'شرح ليا شنو كاين فهاد الصورة.'
          reply = await askGroqVision(
            imageQuestion,
            imageBuffer,
            image.mimetype,
            history
          )
          memoryInput = `[صورة] ${imageQuestion}`
        } else if (audio) {
          const audioBuffer = await downloadMediaMessage(
            m,
            'buffer',
            {},
            { logger }
          )
          const transcript = await transcribeAudio(audioBuffer, audio.mimetype)

          if (!transcript) {
            reply = 'ماقدرتش نقرا الرسالة الصوتية. عاود صيفطها أو جرب تسجيل آخر.'
            memoryInput = '[رسالة صوتية غير مقروءة]'
          } else {
            memoryInput = `[رسالة صوتية محولة إلى نص]: ${transcript}`
            reply = await askGroqText(memoryInput, history)
          }
        } else {
          if (!question) continue
          memoryInput = question
          reply = await askGroqText(question, history)
        }

        await sock.sendMessage(chatId, { text: reply }, { quoted: m })

        if (reply !== FAIL && !reply.startsWith('ماقدرتش نقرا')) {
          await remember(chatId, memoryInput, reply)
        }
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

start()
