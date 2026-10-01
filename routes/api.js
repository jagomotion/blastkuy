const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { readData, writeData } = require('../data/db')
const { startSession, sendBroadcast, stopBroadcast, addSSEClient } = require('../whatsapp')

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

router.get('/theme', async (req, res) => {
  if (!req.session.userId) return res.json({ theme: 'light' })
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.session.userId)
  res.json({ theme: user && user.theme ? user.theme : 'light' })
})

router.post('/theme', requireAuth, async (req, res) => {
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.session.userId)
  if (user) {
    user.theme = req.body.theme === 'dark' ? 'dark' : 'light'
    await writeData('users.json', users)
  }
  res.json({ success: true })
})

router.post('/connect-whatsapp', requireAuth, async (req, res) => {
  try {
    const { phone, method } = req.body
    const result = await startSession(req.session.userId, phone, method)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/accounts', requireAuth, async (req, res) => {
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.session.userId)
  res.json({ accounts: user && user.accounts ? user.accounts : [] })
})

router.post('/accounts/:id/delete', requireAuth, async (req, res) => {
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.session.userId)
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })

  const account = user.accounts.find(a => a.id === req.params.id)
  if (!account) return res.status(404).json({ error: 'Akun tidak ditemukan' })

  const sessionKey = req.session.userId + '_' + account.phone.replace(/[^0-9]/g, '')
  const sessionDir = path.join(__dirname, '..', 'data', 'sessions', sessionKey)
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true })

  user.accounts = user.accounts.filter(a => a.id !== req.params.id)
  await writeData('users.json', users)
  res.json({ success: true })
})

router.post('/broadcast/start', requireAuth, (req, res) => {
  const { speed, accounts } = req.body
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal satu akun' })
  }
  res.json({ success: true })
  sendBroadcast(req.session.userId, speed, accounts).catch(err => {
    console.error('Broadcast error:', err)
  })
})

router.post('/broadcast/stop', requireAuth, (req, res) => {
  stopBroadcast(req.session.userId)
  res.json({ success: true })
})

router.get('/broadcast/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  addSSEClient(req.session.userId, res)
  res.write(':connected\n\n')
})

router.get('/messages/live', requireAuth, async (req, res) => {
  const messages = (await readData('messages.json'))
    .filter(m => m.userId === req.session.userId)
    .slice(-50)
    .reverse()
  res.json({ messages })
})

module.exports = router