import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'

const rules = fs.readFileSync('./rules.txt', 'utf8')
const SYSTEM = fs.readFileSync('./prompt.txt', 'utf8').replace('{rules}', rules)
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

async function askGemini(text) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text }] }]
      })
    })
    const data = await res.json()
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'وقع مشكل تقني، عاود المحاولة.'
  } catch (e) {
    console.log('gemini error:', e.message)
    return 'وقع مشكل تقني، عاود المحاولة.'
  }
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
        console.log('logged out, delete the auth folder and relink')
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
