const baileys = require('@itsliaaa/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const path = require('path')
const fs = require('fs')
const NodeCache = require('node-cache')
const { v4: uuidv4 } = require('uuid')
const { readData, writeData, readSettings } = require('./data/db')

const WAConnection = baileys.default || baileys.makeWASocket || baileys
const { Browsers, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestWaWebVersion } = baileys

const sessionsDir = path.join(__dirname, 'data', 'sessions')
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true })

const sockets = new Map()
const broadcastControl = new Map()
const sseClients = new Map()
const pairingInProgress = new Map()

function addSSEClient(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set())
  sseClients.get(userId).add(res)
  res.on('close', () => {
    const set = sseClients.get(userId)
    if (set) set.delete(res)
  })
}

function emit(userId, data) {
  const clients = sseClients.get(userId)
  if (!clients) return
  const payload = `data: ${JSON.stringify(data)}\n\n`
  clients.forEach(res => {
    try { res.write(payload) } catch (err) {}
  })
}

function normalizePhone(input) {
  return String(input).replace(/[^0-9]/g, '')
}

function getSocket(userId, phone) {
  return sockets.get(userId + '_' + normalizePhone(phone))
}

function clearSession(sessionKey) {
  const sessionDir = path.join(sessionsDir, sessionKey)
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true })
  const sock = sockets.get(sessionKey)
  if (sock) {
    try { sock.end(undefined) } catch (err) {}
  }
  sockets.delete(sessionKey)
  pairingInProgress.delete(sessionKey)
}

async function startSession(userId, phone, method) {
  const cleanPhone = normalizePhone(phone)
  if (!cleanPhone || cleanPhone.length < 8) {
    throw new Error('Nomor tidak valid. Gunakan format 628xxxxxxxxxx')
  }

  const sessionKey = userId + '_' + cleanPhone
  const sessionDir = path.join(sessionsDir, sessionKey)

  if (pairingInProgress.get(sessionKey)) {
    throw new Error('Sedang dalam proses koneksi, tunggu sebentar')
  }

  const isNewPairing = method === 'pairing' || method === 'qr'
  if (isNewPairing && fs.existsSync(sessionDir)) {
    const credsFile = path.join(sessionDir, 'creds.json')
    if (!fs.existsSync(credsFile)) {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  }

  pairingInProgress.set(sessionKey, true)

  const logger = pino({ level: 'silent' })

  let version
  try {
    version = (await fetchLatestWaWebVersion()).version
  } catch (err) {
    version = [2, 3000, 1023223821]
  }

  const msgRetryCounterCache = new NodeCache({ stdTTL: 3600, useClones: false })
  const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir)

  const getMessage = async (key) => undefined

  const sock = WAConnection({
    version,
    logger,
    getMessage,
    syncFullHistory: false,
    maxMsgRetryCount: 15,
    msgRetryCounterCache,
    retryRequestDelayMs: 10,
    defaultQueryTimeoutMs: 0,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: false,
    transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
    appStateMacVerification: { patch: true, snapshot: true },
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    }
  })

  sockets.set(sessionKey, sock)
  sock.ev.on('creds.update', saveCreds)

  return new Promise((resolve, reject) => {
    let resolved = false
    let pairingStarted = false

    const finish = (result) => {
      if (resolved) return
      resolved = true
      pairingInProgress.delete(sessionKey)
      resolve(result)
    }

    const fail = (err) => {
      if (resolved) return
      resolved = true
      pairingInProgress.delete(sessionKey)
      reject(err)
    }

    const timeout = setTimeout(() => {
      fail(new Error('Timeout koneksi. Hapus akun lalu coba lagi'))
    }, 120000)

    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect, isNewLogin } = update

      const readyForPairing = (connection === 'connecting' || !!qr) &&
        !sock.authState.creds.registered && !pairingStarted

      if (readyForPairing && method === 'pairing') {
        pairingStarted = true
        setTimeout(async () => {
          try {
            const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase()
            const customCode = 'BLSY' + randomPart
            const code = await sock.requestPairingCode(cleanPhone, customCode)
            const formatted = code && code.match(/.{1,4}/g) ? code.match(/.{1,4}/g).join('-') : code
            clearTimeout(timeout)
            finish({ type: 'pairing', code: formatted })
          } catch (err) {
            pairingStarted = false
            clearTimeout(timeout)
            clearSession(sessionKey)
            fail(new Error('Gagal membuat pairing code: ' + err.message))
          }
        }, 3000)
      }

      if (qr && !sock.authState.creds.registered && method === 'qr' && !pairingStarted) {
        pairingStarted = true
        clearTimeout(timeout)
        finish({ type: 'qr', qr })
      }

      if (connection === 'open') {
        clearTimeout(timeout)
        try {
          const users = await readData('users.json')
          const user = users.find(u => u.id === userId)
          if (user) {
            if (!user.accounts) user.accounts = []
            const existing = user.accounts.find(a => a.phone === cleanPhone)
            if (existing) {
              existing.status = 'connected'
              existing.method = method
            } else {
              user.accounts.push({
                id: uuidv4(),
                phone: cleanPhone,
                status: 'connected',
                method,
                createdAt: new Date().toISOString()
              })
            }
            await writeData('users.json', users)
          }
        } catch (err) {
          console.error('Gagal update status akun:', err)
        }
        emit(userId, { type: 'connection', phone: cleanPhone, status: 'connected' })
        finish({ type: 'connected' })
      }

      if (isNewLogin) {
        emit(userId, { type: 'log', message: 'Perangkat baru berhasil login' })
      }

      if (connection === 'close') {
        pairingStarted = false
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode

        const updateStatus = async (status) => {
          try {
            const users = await readData('users.json')
            const user = users.find(u => u.id === userId)
            if (user && user.accounts) {
              const account = user.accounts.find(a => a.phone === cleanPhone)
              if (account) account.status = status
              await writeData('users.json', users)
            }
          } catch (err) {
            console.error('Gagal update status:', err)
          }
          emit(userId, { type: 'connection', phone: cleanPhone, status })
        }

        const reconnectLater = (ms) => {
          pairingInProgress.delete(sessionKey)
          setTimeout(() => {
            startSession(userId, cleanPhone, method).catch(() => {})
          }, ms)
        }

        if (reason === DisconnectReason.connectionLost) {
          await updateStatus('reconnecting')
          reconnectLater(3000)
        } else if (reason === DisconnectReason.connectionClosed) {
          await updateStatus('reconnecting')
          reconnectLater(3000)
        } else if (reason === DisconnectReason.restartRequired) {
          await updateStatus('reconnecting')
          reconnectLater(1000)
        } else if (reason === DisconnectReason.timedOut) {
          await updateStatus('reconnecting')
          reconnectLater(3000)
        } else if (
          reason === DisconnectReason.badSession ||
          reason === DisconnectReason.connectionReplaced ||
          reason === DisconnectReason.loggedOut ||
          reason === DisconnectReason.forbidden ||
          reason === DisconnectReason.multideviceMismatch
        ) {
          await updateStatus('disconnected')
          clearSession(sessionKey)
          emit(userId, { type: 'session_cleared', phone: cleanPhone })
        } else {
          await updateStatus('reconnecting')
          reconnectLater(5000)
        }

        if (!sock.authState.creds.registered && !resolved) {
          clearTimeout(timeout)
          clearSession(sessionKey)
          fail(new Error('Koneksi ditutup sebelum pairing selesai'))
        }
      }
    })
  })
}

function buildMessageContent(settings) {
  const cfg = settings.messageConfig || {}
  const content = {}

  if (cfg.imagePath && cfg.imagePath.trim()) {
    const fullPath = path.join(__dirname, 'public', cfg.imagePath)
    if (fs.existsSync(fullPath)) {
      content.image = fs.readFileSync(fullPath)
      content.caption = cfg.text || ''
    } else {
      content.text = cfg.text || ''
    }
  } else {
    content.text = cfg.text || ''
  }

  if (cfg.footer && cfg.footer.trim()) content.footer = cfg.footer.trim()

  if (cfg.buttonText && cfg.buttonUrl && cfg.buttonText.trim() && cfg.buttonUrl.trim()) {
    content.nativeFlow = [{
      text: cfg.buttonText.trim(),
      url: cfg.buttonUrl.trim(),
      useWebview: false
    }]
  }

  return content
}

async function sendBroadcast(userId, speed, accountIds) {
  const users = await readData('users.json')
  const user = users.find(u => u.id === userId)
  if (!user) return

  const settings = await readSettings()
  const allCustomers = await readData('customers.json')
  const customers = allCustomers.filter(c => c.active && !c.sent)

  if (customers.length === 0) {
    emit(userId, { type: 'error', message: 'Tidak ada customer tersisa yang belum dikirimi pesan' })
    return
  }

  const messages = await readData('messages.json')
  const delays = { low: 10000, medium: 5000, fast: 2000 }
  const delayMs = delays[speed] || 5000

  const accounts = (user.accounts || []).filter(a => accountIds.includes(a.id))
  const activeSockets = []
  for (const acc of accounts) {
    const sock = getSocket(userId, acc.phone)
    if (sock && sock.user) activeSockets.push({ sock, phone: acc.phone })
  }

  if (activeSockets.length === 0) {
    emit(userId, { type: 'error', message: 'Tidak ada akun terhubung' })
    return
  }

  broadcastControl.set(userId, { stop: false })

  let sent = 0
  let failed = 0
  let accountIndex = 0

  for (const customer of customers) {
    if (broadcastControl.get(userId)?.stop) break

    const target = activeSockets[accountIndex % activeSockets.length]
    accountIndex++
    const customerInDb = allCustomers.find(c => c.id === customer.id)

    try {
      const jid = normalizePhone(customer.phone) + '@s.whatsapp.net'
      const content = buildMessageContent(settings)
      await target.sock.sendMessage(jid, content)

      messages.push({
        id: uuidv4(),
        userId,
        customerPhone: customer.phone,
        accountPhone: target.phone,
        status: 'sent',
        sentAt: new Date().toISOString()
      })

      if (customerInDb) {
        customerInDb.sent = true
        customerInDb.sentAt = new Date().toISOString()
        customerInDb.sentBy = userId
        customerInDb.sentByName = user.name
        customerInDb.sentByPhone = target.phone
      }

      sent++
      user.balance = (user.balance || 0) + settings.pricePerMessage
      user.totalSent = (user.totalSent || 0) + 1

      if (user.referredBy) {
        const referrer = users.find(u => u.referralCode === user.referredBy)
        if (referrer) {
          referrer.referralEarnings = (referrer.referralEarnings || 0) + settings.referralCommission
          referrer.balance = (referrer.balance || 0) + settings.referralCommission
        }
      }

      emit(userId, {
        type: 'progress',
        sent,
        failed,
        total: customers.length,
        message: { phone: customer.phone, status: 'sent' }
      })
    } catch (err) {
      messages.push({
        id: uuidv4(),
        userId,
        customerPhone: customer.phone,
        accountPhone: target.phone,
        status: 'failed',
        error: err.message,
        sentAt: new Date().toISOString()
      })
      failed++

      emit(userId, {
        type: 'progress',
        sent,
        failed,
        total: customers.length,
        message: { phone: customer.phone, status: 'failed' }
      })
    }

    await writeData('messages.json', messages)
    await writeData('users.json', users)
    await writeData('customers.json', allCustomers)

    if (broadcastControl.get(userId)?.stop) break
    await new Promise(r => setTimeout(r, delayMs))
  }

  broadcastControl.delete(userId)
  await writeData('messages.json', messages)
  await writeData('users.json', users)
  await writeData('customers.json', allCustomers)

  emit(userId, { type: 'complete', sent, failed, total: customers.length })
}

function stopBroadcast(userId) {
  const ctrl = broadcastControl.get(userId)
  if (ctrl) ctrl.stop = true
}

module.exports = {
  startSession,
  getSocket,
  sendBroadcast,
  stopBroadcast,
  addSSEClient,
  emit
}