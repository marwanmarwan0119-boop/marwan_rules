import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'

const rules = fs.readFileSync('./rules.txt', 'utf8')
const SYSTEM = fs.readFileSync('./prompt.txt', 'utf8').replace('{rules}', rules)
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const API_KEY = (process.env.GEMINI_API_KEY || '').trim()
const MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash'
].filter(Boolean)

const FAIL = 'وقع مشكل تقني، عاود المحاولة.'

async function askGemini(text) {
  if (!API_KEY) {
    console.log('GEMINI ERROR: GEMINI_API_KEY is missing')
    return FAIL
  }
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text }] }]
        })
      })
      const data = await res.json()
      if (!res.ok) {
        console.log('GEMINI ERROR', model, res.status, JSON.stringify(data).slice(0, 400))
        continue
      }
      const out = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim()
      if (out) return out
      console.log('GEMINI EMPTY', model, JSON.stringify(data).slice(0, 400))
    } catch (e) {
      console.log('GEMINI FETCH ERROR', model, e.message)
    }
  }
  return FAIL
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }) })

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
          .filter(Boolean).map(x => x.split(':')[0].split('@')[0])
        const mentioned = (ext?.contextInfo?.mentionedJid || [])
          .some(j => myIds.includes(j.split('@')[0]))
        if (!mentioned) continue

        const clean = text.replace(/@\d+/g, '').trim()
        const quoted = ext?.contextInfo?.quotedMessage
        const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text
        const input = quotedText
          ? `الرسالة المقتبسة: ${quotedText}\n\nالطلب: ${clean}`
          : clean

        const reply = await askGemini(input)
        await sock.sendMessage(m.key.remoteJid, { text: reply }, { quoted: m })
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

start()
