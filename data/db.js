const { MongoClient } = require('mongodb')

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://zackdb:FIdu4Nky5uVDoQKD@ac-jfpvoq9-shard-00-00.ileakho.mongodb.net:27017,ac-jfpvoq9-shard-00-01.ileakho.mongodb.net:27017,ac-jfpvoq9-shard-00-02.ileakho.mongodb.net:27017/?ssl=true&replicaSet=atlas-kkyspd-shard-0&authSource=admin&appName=Cluster0&compressors=zlib'

const DB_NAME = 'blastyuk'
const COLLECTION = 'data'

const defaultSettings = {
  pricePerMessage: 50,
  referralCommission: 10,
  minWithdraw: 25000,
  messageConfig: {
    text: 'wojack',
    imagePath: '',
    footer: 'Rujak99',
    buttonText: 'Daftar Sekarang',
    buttonUrl: 'https://rujak99.my.id'
  }
}

const fallbacks = {
  'users.json': [],
  'customers.json': [],
  'messages.json': [],
  'withdrawals.json': [],
  'settings.json': defaultSettings
}

let client = null
let db = null
let initialized = false

async function connect() {
  if (db) return db
  client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    maxPoolSize: 20
  })
  await client.connect()
  db = client.db(DB_NAME)
  console.log('Terhubung ke MongoDB Atlas')
  return db
}

async function init() {
  if (initialized) return
  const database = await connect()
  const col = database.collection(COLLECTION)
  for (const [key, fallback] of Object.entries(fallbacks)) {
    const doc = await col.findOne({ _id: key })
    if (!doc) {
      await col.insertOne({ _id: key, data: fallback, updatedAt: new Date() })
    }
  }
  initialized = true
}

async function readData(file) {
  await init()
  const database = await connect()
  const col = database.collection(COLLECTION)
  const doc = await col.findOne({ _id: file })
  if (!doc) return fallbacks[file] ? JSON.parse(JSON.stringify(fallbacks[file])) : []
  return doc.data || []
}

async function writeData(file, data) {
  await init()
  const database = await connect()
  const col = database.collection(COLLECTION)
  await col.updateOne(
    { _id: file },
    { $set: { data, updatedAt: new Date() } },
    { upsert: true }
  )
}

async function readSettings() {
  const data = await readData('settings.json')
  const settings = (data && !Array.isArray(data)) ? data : {}
  return {
    ...defaultSettings,
    ...settings,
    messageConfig: {
      ...defaultSettings.messageConfig,
      ...(settings.messageConfig || {})
    }
  }
}

async function writeSettings(settings) {
  const merged = {
    ...defaultSettings,
    ...settings,
    messageConfig: {
      ...defaultSettings.messageConfig,
      ...(settings.messageConfig || {})
    }
  }
  await writeData('settings.json', merged)
}

async function closeConnection() {
  if (client) {
    await client.close()
    client = null
    db = null
    initialized = false
  }
}

module.exports = {
  readData,
  writeData,
  readSettings,
  writeSettings,
  connect,
  closeConnection
}