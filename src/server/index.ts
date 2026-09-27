import { createServer } from 'node:http'

type DemoTask = { id: string; status: 'queued' | 'running' | 'delivered'; cost: number; mode: 'demo' }
const tasks = new Map<string, DemoTask>()

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'GET' && req.url === '/api/health') {
    res.end(JSON.stringify({ ok: true, mode: 'demo', livePayments: false, aiProvider: 'scripted-demo' }))
    return
  }
  if (req.method === 'POST' && req.url === '/api/tasks') {
    const id = `demo_${Date.now()}`
    const task: DemoTask = { id, status: 'queued', cost: 2, mode: 'demo' }
    tasks.set(id, task)
    setTimeout(() => task.status = 'running', 800)
    setTimeout(() => task.status = 'delivered', 2500)
    res.statusCode = 201
    res.end(JSON.stringify(task))
    return
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/tasks/')) {
    const task = tasks.get(req.url.split('/').pop() ?? '')
    if (!task) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' })); return }
    res.end(JSON.stringify(task))
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(8787, () => console.log('Wally World demo API listening on http://localhost:8787'))
