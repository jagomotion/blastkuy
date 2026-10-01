const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const { readData, writeData, connect, closeConnection } = require('./data/db')

async function createAdmin() {
  const args = process.argv.slice(2)

  if (args.length < 4) {
    console.log('Cara pakai:')
    console.log('node create-admin.js <nama> <email> <password> <phone>')
    console.log('')
    console.log('Contoh:')
    console.log('node create-admin.js "Admin Utama" admin@blastyuk.com admin123 628123456789')
    process.exit(1)
  }

  const [name, email, password, phone] = args

  try {
    await connect()
    const users = await readData('users.json')

    const existing = users.find(u => u.email === email)
    if (existing) {
      if (existing.role === 'admin') {
        console.log('User ' + email + ' sudah admin')
      } else {
        existing.role = 'admin'
        await writeData('users.json', users)
        console.log('User ' + email + ' diubah jadi admin')
      }
      await closeConnection()
      return
    }

    const hashed = await bcrypt.hash(password, 10)
    const admin = {
      id: uuidv4(),
      name,
      email,
      password: hashed,
      phone,
      role: 'admin',
      balance: 0,
      totalSent: 0,
      referralCode: uuidv4().slice(0, 8),
      referredBy: null,
      referralEarnings: 0,
      theme: 'light',
      accounts: [],
      isSuspended: false,
      createdAt: new Date().toISOString()
    }

    users.push(admin)
    await writeData('users.json', users)

    console.log('Admin berhasil dibuat')
    console.log('Email: ' + email)
    console.log('Password: ' + password)
    console.log('Silakan login di /login')

    await closeConnection()
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

createAdmin()