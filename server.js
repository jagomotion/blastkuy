const express = require('express')
const session = require('express-session')
const cookieParser = require('cookie-parser')
const expressLayouts = require('express-ejs-layouts')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const { readData, writeData, readSettings, writeSettings, connect } = require('./data/db')
const apiRouter = require('./routes/api')

const app = express()
const PORT = process.env.PORT || 3000

const uploadDir = path.join(__dirname, 'public', 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase()
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, 'promo-' + unique + ext)
  }
})

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Hanya file gambar (JPG, PNG, WEBP) yang diizinkan'))
  }
})

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.use(expressLayouts)
app.set('layout', 'layout')
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(cookieParser())

app.use(session({
  secret: 'blastyuk-persistent-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}))

app.use(async (req, res, next) => {
  try {
    if (req.session.userId) {
      const users = await readData('users.json')
      res.locals.user = users.find(u => u.id === req.session.userId) || null
    } else {
      res.locals.user = null
    }
    next()
  } catch (err) {
    console.error('Session middleware error:', err)
    res.locals.user = null
    next()
  }
})

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login')
  if (res.locals.user && res.locals.user.isSuspended) {
    req.session.destroy()
    return res.redirect('/login')
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!res.locals.user || res.locals.user.role !== 'admin') {
    return res.redirect('/dashboard')
  }
  next()
}

app.use('/api', apiRouter)

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard')
  res.redirect('/login')
})

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard')
  res.render('login', { layout: false, error: null })
})

app.post('/login', async (req, res) => {
  const { email, password } = req.body
  const users = await readData('users.json')
  const user = users.find(u => u.email === email)
  if (!user) return res.render('login', { layout: false, error: 'Email tidak ditemukan' })
  const ok = await bcrypt.compare(password, user.password)
  if (!ok) return res.render('login', { layout: false, error: 'Password salah' })
  if (user.isSuspended) return res.render('login', { layout: false, error: 'Akun kamu sedang ditangguhkan' })
  user.lastLogin = new Date().toISOString()
  await writeData('users.json', users)
  req.session.userId = user.id
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard')
})

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard')
  res.render('register', { layout: false, error: null })
})

app.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body
  const users = await readData('users.json')
  if (users.find(u => u.email === email)) {
    return res.render('register', { layout: false, error: 'Email sudah terdaftar' })
  }
  const hashed = await bcrypt.hash(password, 10)
  const newUser = {
    id: uuidv4(),
    name,
    email,
    password: hashed,
    phone,
    role: 'user',
    balance: 0,
    totalSent: 0,
    referralCode: uuidv4().slice(0, 8),
    referredBy: req.query.ref || null,
    referralEarnings: 0,
    theme: 'light',
    accounts: [],
    isSuspended: false,
    createdAt: new Date().toISOString()
  }
  users.push(newUser)
  await writeData('users.json', users)
  req.session.userId = newUser.id
  res.redirect('/dashboard')
})

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'))
})

app.get('/dashboard', requireAuth, async (req, res) => {
  const messages = (await readData('messages.json')).filter(m => m.userId === res.locals.user.id)
  const sent = messages.filter(m => m.status === 'sent').length
  const failed = messages.filter(m => m.status === 'failed').length
  const totalCustomers = (await readData('customers.json')).filter(c => c.active && !c.sent).length
  const settings = await readSettings()
  const earnings = sent * settings.pricePerMessage
  res.render('dashboard', { sent, failed, totalCustomers, earnings })
})

app.get('/accounts', requireAuth, (req, res) => {
  res.render('accounts')
})

app.get('/broadcast', requireAuth, (req, res) => {
  const accounts = (res.locals.user.accounts || []).filter(a => a.status === 'connected')
  res.render('broadcast', { accounts })
})

app.get('/profile', requireAuth, async (req, res) => {
  const messages = (await readData('messages.json')).filter(m => m.userId === res.locals.user.id)
  const sent = messages.filter(m => m.status === 'sent').length
  res.render('profile', { sent })
})

app.get('/withdraw', requireAuth, async (req, res) => {
  const withdrawals = (await readData('withdrawals.json'))
    .filter(w => w.userId === res.locals.user.id)
    .reverse()
  const settings = await readSettings()
  res.render('withdraw', { withdrawals, settings })
})

app.post('/withdraw', requireAuth, async (req, res) => {
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.session.userId)
  const settings = await readSettings()
  const amount = parseInt(req.body.amount)
  if (!amount || amount < settings.minWithdraw) return res.redirect('/withdraw')
  if (amount > user.balance) return res.redirect('/withdraw')
  const withdrawals = await readData('withdrawals.json')
  withdrawals.push({
    id: uuidv4(),
    userId: user.id,
    userName: user.name,
    amount,
    method: req.body.method,
    accountNumber: req.body.accountNumber,
    accountName: req.body.accountName,
    status: 'pending',
    createdAt: new Date().toISOString()
  })
  user.balance -= amount
  await writeData('users.json', users)
  await writeData('withdrawals.json', withdrawals)
  res.redirect('/withdraw')
})

app.get('/admin', requireAdmin, async (req, res) => {
  const users = (await readData('users.json')).filter(u => u.role !== 'admin')
  const messages = await readData('messages.json')
  const customers = await readData('customers.json')
  const withdrawals = await readData('withdrawals.json')

  const totalSent = messages.filter(m => m.status === 'sent').length
  const totalFailed = messages.filter(m => m.status === 'failed').length
  const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0)
  const usedCustomers = customers.filter(c => c.sent).length
  const availableCustomers = customers.filter(c => c.active && !c.sent).length
  const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending')
  const pendingAmount = pendingWithdrawals.reduce((s, w) => s + w.amount, 0)

  let totalAccounts = 0
  let connectedAccounts = 0
  users.forEach(u => {
    (u.accounts || []).forEach(a => {
      totalAccounts++
      if (a.status === 'connected') connectedAccounts++
    })
  })

  const now = Date.now()
  const activeUsers = users.filter(u => u.lastLogin && (now - new Date(u.lastLogin).getTime()) < 86400000).length

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todaySent = messages.filter(m => m.status === 'sent' && new Date(m.sentAt) >= todayStart).length
  const todayFailed = messages.filter(m => m.status === 'failed' && new Date(m.sentAt) >= todayStart).length

  const topUsers = [...users].sort((a, b) => (b.totalSent || 0) - (a.totalSent || 0)).slice(0, 5)
  const recentMessages = messages.slice(-10).reverse().map(m => ({
    ...m,
    userName: users.find(u => u.id === m.userId)?.name || 'Unknown'
  }))

  res.render('admin/dashboard', {
    users,
    totalSent,
    totalFailed,
    totalBalance,
    totalCustomers: customers.length,
    usedCustomers,
    availableCustomers,
    pendingWithdrawals: pendingWithdrawals.length,
    pendingAmount,
    totalAccounts,
    connectedAccounts,
    activeUsers,
    todaySent,
    todayFailed,
    topUsers,
    recentMessages
  })
})

app.get('/admin/users', requireAdmin, async (req, res) => {
  const users = (await readData('users.json')).filter(u => u.role !== 'admin')
  const messages = await readData('messages.json')
  const enriched = users.map(u => {
    const userMessages = messages.filter(m => m.userId === u.id)
    const accounts = u.accounts || []
    return {
      ...u,
      messageSent: userMessages.filter(m => m.status === 'sent').length,
      messageFailed: userMessages.filter(m => m.status === 'failed').length,
      accountCount: accounts.length,
      connectedCount: accounts.filter(a => a.status === 'connected').length
    }
  })
  res.render('admin/users', { users: enriched })
})

app.post('/admin/users/:id/balance', requireAdmin, async (req, res) => {
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.params.id)
  if (user) {
    const amount = parseInt(req.body.amount) || 0
    const action = req.body.action
    if (action === 'add') user.balance = (user.balance || 0) + amount
    else if (action === 'subtract') user.balance = Math.max(0, (user.balance || 0) - amount)
    else if (action === 'set') user.balance = Math.max(0, amount)
    await writeData('users.json', users)
  }
  res.redirect('/admin/users')
})

app.post('/admin/users/:id/toggle-suspend', requireAdmin, async (req, res) => {
  const users = await readData('users.json')
  const user = users.find(u => u.id === req.params.id)
  if (user) {
    user.isSuspended = !user.isSuspended
    await writeData('users.json', users)
  }
  res.redirect('/admin/users')
})

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  let users = await readData('users.json')
  users = users.filter(u => u.id !== req.params.id)
  await writeData('users.json', users)
  res.redirect('/admin/users')
})

app.get('/admin/accounts', requireAdmin, async (req, res) => {
  const users = (await readData('users.json')).filter(u => u.role !== 'admin')
  const accounts = []
  users.forEach(u => {
    (u.accounts || []).forEach(a => {
      accounts.push({ ...a, userName: u.name, userId: u.id, userEmail: u.email })
    })
  })
  res.render('admin/accounts', { accounts })
})

app.get('/admin/activity', requireAdmin, async (req, res) => {
  const messages = (await readData('messages.json')).slice(-500).reverse()
  const users = await readData('users.json')
  const enriched = messages.map(m => ({
    ...m,
    userName: users.find(u => u.id === m.userId)?.name || 'Unknown',
    userEmail: users.find(u => u.id === m.userId)?.email || '-'
  }))
  res.render('admin/activity', { messages: enriched })
})

app.get('/admin/customers', requireAdmin, async (req, res) => {
  const customers = (await readData('customers.json')).reverse()
  const total = customers.length
  const available = customers.filter(c => c.active && !c.sent).length
  const used = customers.filter(c => c.sent).length
  const inactive = customers.filter(c => !c.active).length
  res.render('admin/customers', { customers, stats: { total, available, used, inactive } })
})

app.post('/admin/customers', requireAdmin, async (req, res) => {
  const { numbers } = req.body
  const customers = await readData('customers.json')
  const lines = numbers.split('\n').map(n => n.trim()).filter(Boolean)
  for (const num of lines) {
    const clean = num.replace(/[^0-9+]/g, '')
    if (clean.length < 8) continue
    if (customers.find(c => c.phone === clean)) continue
    customers.push({
      id: uuidv4(),
      phone: clean,
      active: true,
      sent: false,
      createdAt: new Date().toISOString()
    })
  }
  await writeData('customers.json', customers)
  res.redirect('/admin/customers')
})

app.post('/admin/customers/reset-sent', requireAdmin, async (req, res) => {
  const customers = await readData('customers.json')
  customers.forEach(c => {
    c.sent = false
    c.sentAt = null
    c.sentBy = null
    c.sentByName = null
    c.sentByPhone = null
  })
  await writeData('customers.json', customers)
  res.redirect('/admin/customers')
})

app.post('/admin/customers/:id/toggle', requireAdmin, async (req, res) => {
  const customers = await readData('customers.json')
  const c = customers.find(x => x.id === req.params.id)
  if (c) c.active = !c.active
  await writeData('customers.json', customers)
  res.redirect('/admin/customers')
})

app.post('/admin/customers/:id/delete', requireAdmin, async (req, res) => {
  let customers = await readData('customers.json')
  customers = customers.filter(x => x.id !== req.params.id)
  await writeData('customers.json', customers)
  res.redirect('/admin/customers')
})

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const settings = await readSettings()
  res.render('admin/settings', { settings })
})

app.post('/admin/settings', requireAdmin, upload.single('imageFile'), async (req, res) => {
  const settings = await readSettings()
  settings.pricePerMessage = parseInt(req.body.pricePerMessage) || 0
  settings.referralCommission = parseInt(req.body.referralCommission) || 0
  settings.minWithdraw = parseInt(req.body.minWithdraw) || 25000

  let imagePath = settings.messageConfig.imagePath || ''

  if (req.body.removeImage === 'true') {
    if (imagePath) {
      const oldFile = path.join(__dirname, 'public', imagePath)
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile)
    }
    imagePath = ''
  }

  if (req.file) {
    if (imagePath) {
      const oldFile = path.join(__dirname, 'public', imagePath)
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile)
    }
    imagePath = '/uploads/' + req.file.filename
  }

  settings.messageConfig = {
    text: req.body.text || '',
    imagePath,
    footer: req.body.footer || '',
    buttonText: req.body.buttonText || '',
    buttonUrl: req.body.buttonUrl || ''
  }

  await writeSettings(settings)
  res.redirect('/admin/settings')
})

app.get('/admin/withdrawals', requireAdmin, async (req, res) => {
  const withdrawals = (await readData('withdrawals.json')).reverse()
  res.render('admin/withdrawals', { withdrawals })
})

app.post('/admin/withdrawals/:id', requireAdmin, async (req, res) => {
  const withdrawals = await readData('withdrawals.json')
  const w = withdrawals.find(x => x.id === req.params.id)
  if (w) {
    const status = req.body.status
    if (status === 'approved' && w.status !== 'approved') {
      w.status = 'approved'
      w.processedAt = new Date().toISOString()
    } else if (status === 'rejected' && w.status !== 'rejected') {
      w.status = 'rejected'
      w.processedAt = new Date().toISOString()
      const users = await readData('users.json')
      const user = users.find(u => u.id === w.userId)
      if (user) {
        user.balance += w.amount
        await writeData('users.json', users)
      }
    }
    await writeData('withdrawals.json', withdrawals)
  }
  res.redirect('/admin/withdrawals')
})

app.get('/admin/messages', requireAdmin, async (req, res) => {
  const messages = (await readData('messages.json')).slice(-200).reverse()
  const users = await readData('users.json')
  const enriched = messages.map(m => ({
    ...m,
    userName: users.find(u => u.id === m.userId)?.name || 'Unknown'
  }))
  res.render('admin/messages', { messages: enriched })
})

connect().then(() => {
  app.listen(PORT, () => {
    console.log(`web redy in port${PORT}`)
  })
}).catch(err => {
  console.error('Gagal koneksi MongoDB:', err)
  process.exit(1)
})