// Tiny local receiver: the browser posts drawn page textures here as PNG.
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
const out = new URL('./textures/', import.meta.url);
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method !== 'POST') { res.end('ok'); return; }
  const name = new URL(req.url, 'http://x').searchParams.get('name').replace(/[^a-z0-9_.-]/gi, '');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  await writeFile(new URL(name, out), Buffer.concat(chunks));
  console.log('saved', name);
  res.end('saved');
}).listen(5175, '127.0.0.1', () => console.log('listening'));
