import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const rules = fs.readFileSync('./rules.txt', 'utf8')
const SYSTEM = fs.readFileSync('./prompt.txt', 'utf8').replace('{rules}', rules)
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim()

// The first model is preferred. The second one is used as a fallback.
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b'
]

// Number of previous chat messages kept per WhatsApp chat/group.
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
    const saved = Object.fromEntries(memory)
    await fs.promises.writeFile(MEMORY_FILE, JSON.stringify(saved), 'utf8')
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

async function askGroq(text, history = []) {
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

        const temporaryError = [429, 500, 502, 503, 504].includes(res.status)
        if (temporaryError && attempt < 3) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2000 * attempt
          await sleep(waitMs)
          continue
        }

        // Move to the fallback model after the current model fails.
        break
      } catch (e) {
        console.log('GROQ FETCH ERROR', model, 'try', attempt, e.message)

        if (attempt < 3) {
          await sleep(2000 * attempt)
        }
      }
    }
  }

  return FAIL
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  loadMemory()

  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

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

        const ext = m.message.extendedTextMessage
        const text = m.message.conversation || ext?.text
        if (!text) continue

        const myIds = [sock.user?.id, sock.user?.lid]
          .filter(Boolean)
          .map(x => x.split(':')[0].split('@')[0])

        const mentioned = (ext?.contextInfo?.mentionedJid || [])
          .some(j => myIds.includes(j.split('@')[0]))

        if (!mentioned) continue

        const clean = text.replace(/@\d+/g, '').trim()
        const quoted = ext?.contextInfo?.quotedMessage
        const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text
        const input = quotedText
          ? `الرسالة المقتبسة: ${quotedText}\n\nالطلب: ${clean}`
          : clean

        // Each WhatsApp chat/group has its own separate memory.
        const chatId = m.key.remoteJid
        const history = getChatHistory(chatId)
        const reply = await askGroq(input, history)

        await sock.sendMessage(chatId, { text: reply }, { quoted: m })

        // Do not save the temporary failure message as real conversation context.
        if (reply !== FAIL) {
          await remember(chatId, input, reply)
        }
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

start()
