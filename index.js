import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  downloadMediaMessage, normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import ffmpegPath from 'ffmpeg-static'

const run = promisify(execFile)
const logger = pino({ level: 'silent' })
const rules = fs.readFileSync('./rules.txt', 'utf8')
const SYSTEM = fs.readFileSync('./prompt.txt', 'utf8').replace('{rules}', rules)
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const API_KEY = (process.env.GROQ_API_KEY || '').trim()
const TEXT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']
const VISION_MODEL = (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b').trim()
const MAX_IMAGES = 3
const MAX_VIDEO_MB = 60
const ADMIN_GROUP = (process.env.ADMIN_GROUP || '').trim() // جروب الإدارة (للاستئناف)
// اختياري: إلا بغيتي تحصر البوت فجروبات معينة. خليه فارغ باش يخدم فكل الجروبات.
const ALLOWED = (process.env.ALLOWED_GROUPS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const FAIL = 'السيرفر مشغول دابا، عاود المحاولة من بعد شوية.'
const FAIL_IMG = 'ما قدرتش نقرا الصورة دابا، عاود صيفطها ولا كتب شنو فيها.'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- رسالة الترحيب (بدلها كيف بغيتي) ----------
const WELCOME = tags =>
  `👋 مرحبا ${tags} فـ EMC LIGA V6!\n\n` +
  `أهم القوانين:\n` +
  `⏱️ الجولة 48 ساعة، وإدخال اللائحة وتحديد الموعد داخل 12 ساعة\n` +
  `🎥 الريكورد خاصو يبان فيه: ID Room، Chat، ID Compte، اسم الهاتف\n` +
  `🚫 السب والاستفزاز ممنوعين\n` +
  `⚖️ عندك مشكل فالماتش؟ تاغ البوت وكتب المشكل\n` +
  `📣 ما عجبكش القرار؟ تاغ البوت وكتب: استئناف\n\n` +
  `الانضباط • الاحترام • المنافسة الشريفة`

// ---------- فلتر السب ----------
function norm(s) {
  return ' ' + s
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim() + ' '
}
// زيد هنا أي كلمة بغيتي (كلمة وحدة ولا جوج كلمات)
const BAD = [
  'زب', 'زبي', 'قلوة', 'قود', 'تحوا',
  'قحبة', 'ولد القحبة', 'ولاد القحبة'
].map(w => norm(w))
const isBad = text => {
  const t = norm(text)
  return BAD.some(w => t.includes(w))
}

// ---------- ذاكرة صغيرة لكل جروب ----------
const history = new Map()
const lastRuling = new Map()
function remember(jid, name, text) {
  const arr = history.get(jid) || []
  arr.push(`${name}: ${text}`)
  if (arr.length > 20) arr.shift()
  history.set(jid, arr)
}

// ---------- استخراج صور من فيديو ----------
async function videoFrames(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-'))
  const file = path.join(dir, 'in.mp4')
  fs.writeFileSync(file, buf)
  try {
    let dur = 0
    try {
      await run(ffmpegPath, ['-i', file])
    } catch (e) {
      const mt = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(e.stderr || '')
      if (mt) dur = +mt[1] * 3600 + +mt[2] * 60 + +mt[3]
    }
    const points = dur > 0 ? [0.1, 0.5, 0.9] : [0]
    const frames = []
    for (const [i, p] of points.entries()) {
      const out = path.join(dir, `f${i}.jpg`)
      try {
        await run(ffmpegPath, [
          '-y', '-ss', String(Math.max(0, dur * p)), '-i', file,
          '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', out
        ])
        if (fs.existsSync(out)) frames.push(fs.readFileSync(out))
      } catch (e) {
        console.log('frame failed:', e.message)
      }
    }
    return frames
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- Groq ----------
async function callGroq(model, content) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content }
          ]
        })
      })
      const data = await res.json()
      if (res.ok) {
        const out = data?.choices?.[0]?.message?.content?.trim()
        if (out) return out
      }
      console.log('GROQ ERROR', model, res.status, JSON.stringify(data).slice(0, 300))
      if (![429, 500, 502, 503].includes(res.status)) break
    } catch (e) {
      console.log('GROQ FETCH ERROR', model, e.message)
    }
    await sleep(2000 * attempt)
  }
  return null
}

async function askGroq(text, images = []) {
  if (!API_KEY) {
    console.log('GROQ ERROR: GROQ_API_KEY is missing')
    return FAIL
  }
  if (images.length) {
    const content = [
      { type: 'text', text },
      ...images.slice(0, MAX_IMAGES).map(b => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` }
      }))
    ]
    return (await callGroq(VISION_MODEL, content)) || FAIL_IMG
  }
  for (const model of TEXT_MODELS) {
    const out = await callGroq(model, text)
    if (out) return out
  }
  return FAIL
}

// ---------- البوت ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })
  let asked = false

  const myIds = () => [sock.user?.id, sock.user?.lid]
    .filter(Boolean).map(x => x.split(':')[0].split('@')[0])

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
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000)
      else console.log('logged out, change AUTH_DIR and relink')
    }
  })

  // ---------- ترحيب باللاعبين الجداد ----------
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (action !== 'add') return
      if (id === ADMIN_GROUP) return
      if (ALLOWED.length && !ALLOWED.includes(id)) return
      const me = myIds()
      const jids = (participants || [])
        .map(p => (typeof p === 'string' ? p : p?.id))
        .filter(Boolean)
        .filter(j => !me.includes(j.split(':')[0].split('@')[0]))
      if (!jids.length) return
      const tags = jids.map(j => '@' + j.split('@')[0]).join(' ')
      await sock.sendMessage(id, { text: WELCOME(tags), mentions: jids })
    } catch (e) {
      console.log('welcome error:', e.message)
    }
  })

  // ---------- طرد اللي كيسب ----------
  async function punish(m, jid, sender) {
    try {
      const meta = await sock.groupMetadata(jid)
      const p = meta.participants.find(
        x => x.id === sender || x.lid === sender || x.phoneNumber === sender
      )
      if (p?.admin) return console.log('insult from admin, skipped')
      try { await sock.sendMessage(jid, { delete: m.key }) } catch (e) { console.log('delete failed:', e.message) }
      await sock.groupParticipantsUpdate(jid, [sender], 'remove')
      await sock.sendMessage(jid, {
        text: `🚫 تم طرد @${sender.split('@')[0]} بسبب السب والشتم (المادة 11).`,
        mentions: [sender]
      })
    } catch (e) {
      console.log('kick failed (is the bot admin?):', e.message)
    }
  }

  // ---------- الاستئناف ----------
  async function handleAppeal(m, jid, name) {
    if (!ADMIN_GROUP) {
      await sock.sendMessage(jid, {
        text: 'جروب الإدارة ما تربطش بعد. عاود من بعد.'
      }, { quoted: m })
      return
    }
    let subject = jid
    try { subject = (await sock.groupMetadata(jid)).subject } catch (e) { /* ignore */ }
    const rec = lastRuling.get(jid)
    const recent = (history.get(jid) || []).slice(-10).join('\n')
    const body =
      `📣 استئناف جديد\n\n` +
      `👥 الجروب: ${subject}\n` +
      `🙋 المستأنف: ${name}\n\n` +
      `⚖️ آخر قرار ديال البوت:\n${rec?.text || '(ما كاينش)'}\n\n` +
      `💬 آخر الرسائل:\n${recent || '(ما كاينش)'}`
    try {
      await sock.sendMessage(ADMIN_GROUP, { text: body.slice(0, 3500) })
      await sock.sendMessage(jid, {
        text: '✅ تم تحويل استئنافك للإدارة، غادي يراجعو القرار.'
      }, { quoted: m })
    } catch (e) {
      console.log('appeal failed:', e.message)
      await sock.sendMessage(jid, {
        text: 'ما قدرتش نصيفط الاستئناف دابا. عاود المحاولة.'
      }, { quoted: m })
    }
  }

  const getMedia = (msgObj, key) =>
    downloadMediaMessage(
      { key, message: msgObj }, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue
        const jid = m.key.remoteJid
        if (!jid || !jid.endsWith('@g.us')) continue // ما كيجاوبش فالخاص
        if (ALLOWED.length && !ALLOWED.includes(jid)) continue

        const msg = normalizeMessageContent(m.message)
        if (!msg) continue
        const ext = msg.extendedTextMessage
        const img = msg.imageMessage
        const vid = msg.videoMessage
        const text = msg.conversation || ext?.text || img?.caption || vid?.caption || ''
        const ctx = ext?.contextInfo || img?.contextInfo || vid?.contextInfo
        const sender = m.key.participant
        const name = m.pushName || sender?.split('@')[0] || 'لاعب'

        // طرد اللي كيسب
        if (text && sender && isBad(text)) {
          await punish(m, jid, sender)
          continue
        }

        if (text) remember(jid, name, text.slice(0, 300))

        const me = myIds()
        const mentioned = (ctx?.mentionedJid || [])
          .some(j => me.includes(j.split('@')[0]))
        if (!mentioned) continue

        const clean = text.replace(/@\d+/g, '').trim()

        // أوامر خاصة
        if (clean.includes('/id')) {
          await sock.sendMessage(jid, { text: `ID ديال هاد الجروب:\n${jid}` }, { quoted: m })
          continue
        }
        if (/استئناف|استيناف|استانف|استأنف|استئنف/.test(clean)) {
          await handleAppeal(m, jid, name)
          continue
        }

        // الصور والفيديوات (من الرسالة نفسها أو من الرسالة المقتبسة)
        const q = ctx?.quotedMessage
        const qKey = ctx?.stanzaId
          ? { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }
          : null

        const images = []
        let fromVideo = false
        try {
          if (img) images.push(await getMedia(msg, m.key))
          if (q?.imageMessage && qKey) images.push(await getMedia(q, qKey))

          const videoSrc = vid ? { obj: msg, key: m.key, size: vid.fileLength }
            : q?.videoMessage && qKey ? { obj: q, key: qKey, size: q.videoMessage.fileLength }
            : null
          if (videoSrc && !images.length) {
            if (Number(videoSrc.size || 0) > MAX_VIDEO_MB * 1024 * 1024) {
              await sock.sendMessage(jid, {
                text: 'الفيديو كبير بزاف. صيفط سكرين من الريكورد ولا فيديو أقصر.'
              }, { quoted: m })
              continue
            }
            const buf = await getMedia(videoSrc.obj, videoSrc.key)
            images.push(...(await videoFrames(buf)))
            fromVideo = true
          }
        } catch (e) {
          console.log('media failed:', e.message)
        }

        if (fromVideo && !images.length) {
          await sock.sendMessage(jid, {
            text: 'ما قدرتش نقرا الفيديو. صيفط سكرين من الريكورد.'
          }, { quoted: m })
          continue
        }

        const quotedText = q?.conversation || q?.extendedTextMessage?.text
        const recent = (history.get(jid) || []).join('\n')
        const mediaNote = images.length
          ? fromVideo
            ? `\n(مرفقة ${images.length} صور مأخوذة من فيديو ريكورد: بداية، وسط، نهاية. ما شفتيش باقي الفيديو.)`
            : `\n(مرفقة ${images.length} صورة)`
          : ''
        const input =
          `آخر الرسائل فالجروب:\n${recent}\n\n` +
          (quotedText ? `الرسالة المقتبسة: ${quotedText}\n\n` : '') +
          `الطلب من ${name}: ${clean || '(بلا نص)'}` + mediaNote

        const reply = await askGroq(input, images)
        if (reply !== FAIL && reply !== FAIL_IMG) {
          lastRuling.set(jid, { text: reply, time: Date.now() })
        }
        await sock.sendMessage(jid, { text: reply }, { quoted: m })
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

start()
