import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'

const rules = fs.readFileSync('./rules.txt', 'utf8')
const SYSTEM = fs.readFileSync('./prompt.txt', 'utf8').replace('{rules}', rules)
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim()

// The first model is preferred. The second one is used as a fallback.
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b'
]

const FAIL = 'السيرفر ديال الذكاء الاصطناعي مشغول دابا، عاود المحاولة من بعد شوية.'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function askGroq(text) {
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

        // Try the same model again for temporary errors and rate limits.
        const temporaryError = [429, 500, 502, 503, 504].includes(res.status)
        if (temporaryError && attempt < 3) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2000 * attempt
          await sleep(waitMs)
          continue
        }

        // Move to the fallback model for model/service availability errors.
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

        const reply = await askGroq(input)
        await sock.sendMessage(m.key.remoteJid, { text: reply }, { quoted: m })
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

start()
