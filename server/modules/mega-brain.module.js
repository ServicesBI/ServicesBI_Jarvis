import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function registerMegaBrainModule(app, deps) {
  const {
    JARVIS_DIR, PROJECTS_DIR, PYTHON_CMD,
    attachments, upload,
    notificationClients, sessionStats, pools
  } = deps;

  // POST /api/config - Save configurations
  app.post('/api/config', (req, res) => {
    try {
      const { key, value } = req.body;
      if (key === 'OPENAI_API_KEY') {
        process.env.OPENAI_API_KEY = value;
        const envPath = path.join(JARVIS_DIR, '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        if (envContent.includes('OPENAI_API_KEY=')) {
          envContent = envContent.replace(/OPENAI_API_KEY=.*/g, `OPENAI_API_KEY=${value}`);
        } else {
          envContent += `\nOPENAI_API_KEY=${value}`;
        }
        fs.writeFileSync(envPath, envContent);
        res.json({ ok: true });
      } else {
        res.status(400).json({ error: 'Only OPENAI_API_KEY can be configured' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/notifications - SSE push channel for build completion pings
  app.get('/api/notifications', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: {"type":"connected"}\n\n');
    notificationClients.add(res);
    console.log(`[JARVIS] SSE client connected (total: ${notificationClients.size})`);
    req.on('close', () => {
      notificationClients.delete(res);
      console.log(`[JARVIS] SSE client disconnected (total: ${notificationClients.size})`);
    });
  });

  // GET /api/stats - Session metrics for cockpit
  app.get('/api/stats', (req, res) => {
    const uptime = Date.now() - sessionStats.startTime;
    res.json({
      uptime,
      tokensIn: sessionStats.tokensIn,
      tokensOut: sessionStats.tokensOut,
      tokens: sessionStats.tokensIn + sessionStats.tokensOut,
      requests: sessionStats.requests,
      plan: process.env.CLAUDE_PLAN || 'Max',
      lastLatency: sessionStats.lastAckLatency || sessionStats.lastLatency,
      pool: {
        opus:   pools.opus.pool.length,
        sonnet: pools.sonnet.pool.length,
        haiku:  pools.haiku.pool.length,
      }
    });
  });

  // POST /api/attach - Upload file attachment (supports text files + PDF extraction)
  app.post('/api/attach', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const textExts = ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.html', '.css', '.xml', '.sql', '.sh', '.bat', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env'];
      const ext = path.extname(req.file.originalname).toLowerCase();
      const attachmentId = `att-${Date.now()}`;

      if (textExts.includes(ext)) {
        const content = req.file.buffer.toString('utf-8');
        attachments.set(attachmentId, content);
        setTimeout(() => { attachments.delete(attachmentId); }, 30 * 60 * 1000);
        res.json({ attachmentId, name: req.file.originalname, type: 'text', preview: content.slice(0, 500) });

      } else if (ext === '.pdf') {
        const tmpPath = path.join(PROJECTS_DIR, `_tmp_${Date.now()}.pdf`);
        fs.writeFileSync(tmpPath, req.file.buffer);

        try {
          const pyScript = `
import sys, pdfplumber
sys.stdout.reconfigure(encoding='utf-8')
with pdfplumber.open(r'${tmpPath.replace(/\\/g, '\\\\')}') as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        if text:
            print(text)
`;
          const pdfText = execSync(`"${PYTHON_CMD}" -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
            encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024
          }).trim();

          try { fs.unlinkSync(tmpPath); } catch {}

          if (pdfText) {
            attachments.set(attachmentId, pdfText);
            console.log(`[JARVIS] PDF extracted: ${req.file.originalname} (${pdfText.length} chars)`);
            res.json({ attachmentId, name: req.file.originalname, type: 'pdf', preview: pdfText.slice(0, 500), chars: pdfText.length });
          } else {
            const filePath = path.join(PROJECTS_DIR, req.file.originalname);
            fs.writeFileSync(filePath, req.file.buffer);
            attachments.set(attachmentId, `[PDF with no extractable text saved: ${filePath}]`);
            res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
          }
        } catch (pyErr) {
          console.error('[JARVIS] PDF extraction error:', pyErr.message);
          const filePath = path.join(PROJECTS_DIR, req.file.originalname);
          fs.writeFileSync(filePath, req.file.buffer);
          attachments.set(attachmentId, `[PDF saved but text extraction failed: ${filePath}]`);
          res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
          try { fs.unlinkSync(tmpPath); } catch {}
        }

      } else if (['.docx', '.doc', '.xlsx', '.xls', '.pptx'].includes(ext)) {
        const filePath = path.join(PROJECTS_DIR, req.file.originalname);
        fs.writeFileSync(filePath, req.file.buffer);
        attachments.set(attachmentId, `[Office file saved: ${filePath}] — Use Claude to read and analyze this file.`);
        res.json({ attachmentId, name: req.file.originalname, type: 'office', path: filePath });

      } else {
        const filePath = path.join(PROJECTS_DIR, req.file.originalname);
        fs.writeFileSync(filePath, req.file.buffer);
        attachments.set(attachmentId, `[Binary file saved: ${filePath}]`);
        res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
