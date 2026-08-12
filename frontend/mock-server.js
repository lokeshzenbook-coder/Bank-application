// Minimal in-memory mock of the banking API so the SPA runs standalone.
// Zero dependencies — plain Node http. Start it with:  npm run mock
// It serves the same endpoints the frontend expects, all under /api/v1.

import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 8081)
const BASE = '/api/v1'

const USERS = new Map()
const ACCOUNTS = []
const BALANCES = new Map()
const CARDS = []
const LOANS = []
let seq = 1

function id() {
  return `id-${String(seq++).padStart(6, '0')}`
}

function makeToken(email) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  const header = enc({ alg: 'HS256', typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const body = enc({ sub: email, email, roles: ['customer'], iat: now, exp: now + 3600 })
  return `${header}.${body}.mock-signature`
}

function tokens(email) {
  return { access_token: makeToken(email), refresh_token: makeToken(email) }
}

function accountNumber() {
  return `1000-${String(Math.floor(1000 + Math.random() * 9000))}-${String(Math.floor(100000 + Math.random() * 900000))}`
}

function openAccount(body) {
  const a = {
    id: id(),
    account_number: accountNumber(),
    type: body.type || 'SAVINGS',
    currency: body.currency || 'USD',
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
  }
  ACCOUNTS.push(a)
  BALANCES.set(a.id, 0)
  return a
}

function openCard(body) {
  const c = {
    id: id(),
    account_id: body.account_id,
    type: body.type || 'DEBIT',
    network: body.type === 'CREDIT' ? 'VISA' : 'MASTERCARD',
    masked_number: `•••• •••• •••• ${String(Math.floor(1000 + Math.random() * 9000))}`,
    expiry_month: String(1 + Math.floor(Math.random() * 12)).padStart(2, '0'),
    expiry_year: String(new Date().getFullYear() + 3),
    status: 'ACTIVE',
  }
  CARDS.push(c)
  return c
}

function emi(principal, annualRatePct, tenureMonths) {
  const monthly = annualRatePct / 100 / 12
  if (monthly === 0) return +(principal / tenureMonths).toFixed(2)
  const f = Math.pow(1 + monthly, tenureMonths)
  return +((principal * monthly * f) / (f - 1)).toFixed(2)
}

function applyLoan(body) {
  const principal = Number(body.principal || 0)
  const tenureMonths = Number(body.tenure_months || 12)
  const l = {
    id: id(),
    account_id: body.account_id,
    principal,
    currency: body.currency || 'USD',
    annual_rate_pct: Number(body.annual_rate_pct || 12),
    tenure_months: tenureMonths,
    emi_amount: emi(principal, Number(body.annual_rate_pct || 12), tenureMonths),
    status: 'APPROVED',
  }
  LOANS.push(l)
  return l
}

function send(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method.toUpperCase()

  if (path !== `${BASE}/auth/register` && path !== `${BASE}/auth/login`) {
    const auth = req.headers.authorization || ''
    if (!auth.startsWith('Bearer ')) {
      return send(res, 401, { message: 'unauthorized' })
    }
  }

  if (method === 'POST' && path === `${BASE}/auth/register`) {
    const body = await readBody(req)
    USERS.set(body.email, body.password)
    return send(res, 201, { id: id(), email: body.email, full_name: body.full_name, tokens: tokens(body.email) })
  }

  if (method === 'POST' && path === `${BASE}/auth/login`) {
    const body = await readBody(req)
    if (USERS.has(body.email) && USERS.get(body.email) !== body.password) {
      return send(res, 401, { message: 'invalid email or password' })
    }
    return send(res, 200, tokens(body.email))
  }

  if (path === `${BASE}/accounts`) {
    if (method === 'GET') return send(res, 200, { items: ACCOUNTS })
    if (method === 'POST') return send(res, 201, openAccount(await readBody(req)))
  }

  const balanceMatch = path.match(new RegExp(`^${BASE}/accounts/([^/]+)/balance$`))
  if (balanceMatch && method === 'GET') {
    const account = ACCOUNTS.find((a) => a.id === balanceMatch[1])
    if (!account) return send(res, 404, { message: 'account not found' })
    return send(res, 200, { balance: BALANCES.get(account.id) || 0, currency: account.currency })
  }

  if (path === `${BASE}/transactions/deposit` && method === 'POST') {
    const body = await readBody(req)
    const amount = Number(body.amount || 0)
    const account = ACCOUNTS.find((a) => a.id === body.account_id)
    if (!account) return send(res, 404, { message: 'account not found' })
    BALANCES.set(account.id, (BALANCES.get(account.id) || 0) + amount)
    return send(res, 201, { status: 'COMPLETED', amount, currency: body.currency || account.currency, reference: body.reference })
  }

  if (path === `${BASE}/transactions/transfer` && method === 'POST') {
    const body = await readBody(req)
    const amount = Number(body.amount || 0)
    const from = ACCOUNTS.find((a) => a.id === body.from_account_id)
    if (from) BALANCES.set(from.id, (BALANCES.get(from.id) || 0) - amount)
    return send(res, 201, { status: 'COMPLETED', amount, currency: body.currency || from?.currency || 'USD', reference: body.reference })
  }

  if (path === `${BASE}/cards`) {
    if (method === 'GET') return send(res, 200, { items: CARDS })
    if (method === 'POST') return send(res, 201, openCard(await readBody(req)))
  }

  const cardMatch = path.match(new RegExp(`^${BASE}/cards/([^/]+)/(block|unblock)$`))
  if (cardMatch && method === 'POST') {
    const card = CARDS.find((c) => c.id === cardMatch[1])
    if (!card) return send(res, 404, { message: 'card not found' })
    card.status = cardMatch[2] === 'block' ? 'BLOCKED' : 'ACTIVE'
    return send(res, 200, card)
  }

  if (path === `${BASE}/loans`) {
    if (method === 'GET') return send(res, 200, { items: LOANS })
    if (method === 'POST') return send(res, 201, applyLoan(await readBody(req)))
  }

  send(res, 404, { message: `no mock route: ${method} ${path}` })
}

http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    send(res, 500, { message: err.message })
  })
}).listen(PORT, () => {
  console.log(`mock banking API listening on http://localhost:${PORT}`)
})
