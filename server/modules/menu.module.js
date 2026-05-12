import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export function registerMenuModule(app, deps) {
  const {
    JARVIS_DIR, PROJECTS_DIR, PYTHON_CMD,
    htmlToPdf, upload
  } = deps;

  // GET /api/files - List files in Documents and Projects
  app.get('/api/files', (req, res) => {
    try {
      if (!fs.existsSync(PROJECTS_DIR)) {
        fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        return res.json({ files: [] });
      }

      const deliverableExts = new Set([
        '.pdf', '.html', '.md', '.txt',
        '.xlsx', '.xls', '.pptx', '.ppt', '.doc', '.docx', '.ods', '.odp', '.csv',
        '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
        '.zip', '.mp3', '.mp4', '.wav'
      ]);

      const files = [];
      const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      for (const project of projects) {
        const projectDir = path.join(PROJECTS_DIR, project);
        function walk(dir) {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (deliverableExts.has(path.extname(entry.name).toLowerCase())) {
                const stat = fs.statSync(full);
                files.push({
                  name: entry.name,
                  project,
                  path: full,
                  size: stat.size,
                  ext: path.extname(entry.name).toLowerCase(),
                  createdAt: stat.birthtime,
                  downloadUrl: `/api/files/download?path=${encodeURIComponent(full)}`
                });
              }
            }
          } catch {}
        }
        walk(projectDir);
      }

      try {
        for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith('.')) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!deliverableExts.has(ext)) continue;
          const full = path.join(PROJECTS_DIR, entry.name);
          const stat = fs.statSync(full);
          files.push({
            name: entry.name,
            project: '(raiz)',
            path: full,
            size: stat.size,
            ext,
            createdAt: stat.birthtime,
            downloadUrl: `/api/files/download?path=${encodeURIComponent(full)}`
          });
        }
      } catch {}

      files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/files/download - File Download
  app.get('/api/files/download', (req, res) => {
    try {
      let raw = req.query.path || '';
      if (!raw) return res.status(400).json({ error: 'path required' });

      let candidates = [];
      if (path.isAbsolute(raw)) {
        candidates.push(path.normalize(raw));
      } else {
        candidates.push(path.resolve(PROJECTS_DIR, raw));
        candidates.push(path.resolve(JARVIS_DIR, raw));
      }

      const filePath = candidates.find(p => fs.existsSync(p));
      if (!filePath) return res.status(404).json({ error: 'File not found', tried: candidates });

      const norm = path.normalize(filePath).toLowerCase();
      const safeRoot = path.normalize(JARVIS_DIR).toLowerCase();
      if (!norm.startsWith(safeRoot)) return res.status(403).json({ error: 'Access denied' });

      res.download(filePath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/read-file - Read file text content (restricted to safe directories)
  app.get('/api/read-file', (req, res) => {
    try {
      const filePath = path.resolve(path.normalize(req.query.path));
      const allowedPrefixes = [JARVIS_DIR, os.homedir()].map(p => p.toLowerCase());
      if (!allowedPrefixes.some(prefix => filePath.toLowerCase().startsWith(prefix))) {
        return res.status(403).json({ error: 'Access denied — path outside allowed directories' });
      }
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

      const textExts = new Set(['.txt', '.md', '.json', '.js', '.ts', '.py', '.html', '.css', '.csv', '.xml', '.sql', '.sh', '.bat']);
      const ext = path.extname(filePath).toLowerCase();

      if (!textExts.has(ext)) return res.json({ binary: true, path: filePath });

      const content = fs.readFileSync(filePath, 'utf-8');
      res.json({ content, size: content.length, lines: content.split('\n').length, path: filePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/find-file - Search for a file by name across common user locations
  app.get('/api/find-file', (req, res) => {
    try {
      const { name } = req.query;
      if (!name) return res.status(400).json({ error: 'name required' });

      const home = os.homedir();
      const searchDirs = [
        path.join(home, 'Desktop'),
        path.join(home, 'Downloads'),
        path.join(home, 'Documents'),
        path.join(home, 'OneDrive'),
        path.join(home, 'OneDrive', 'Desktop'),
        path.join(home, 'OneDrive', 'Documents'),
        PROJECTS_DIR,
      ];

      const found = [];
      const nameLower = name.toLowerCase();

      function search(dir, depth = 0) {
        if (depth > 3) return;
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) search(full, depth + 1);
            else if (entry.name.toLowerCase().includes(nameLower)) found.push(full);
          }
        } catch {}
      }

      for (const dir of searchDirs) search(dir);
      res.json({ found: found.slice(0, 10) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/excel-live - Read or write Excel workbook
  app.post('/api/excel-live', async (req, res) => {
    try {
      const { action = 'read', path: filePath, sheet, operations } = req.body;

      let script = '';

      if (action === 'list') {
        script = `
import json, subprocess
r = subprocess.run(['tasklist'], capture_output=True, text=True)
excel_running = 'EXCEL.EXE' in r.stdout
print(json.dumps({"excel_running": excel_running}))
`;
      } else if (action === 'read') {
        script = `
import json, sys
fp = sys.argv[1]
try:
    from openpyxl import load_workbook
    wb = load_workbook(fp, data_only=True)
    ws = wb[${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}]
    rows = [[cell.value for cell in row] for row in ws.iter_rows()]
    print(json.dumps({"sheet": ws.title, "rows": rows}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
      } else if (action === 'write') {
        const ops = JSON.stringify(operations || []);
        script = `
import json, subprocess, os, time, ctypes, sys

fp = sys.argv[1]
ops = json.loads(sys.argv[2])
reopen = ${req.body.reopen !== false ? 'True' : 'False'}

user32 = ctypes.windll.user32
WM_CLOSE = 0x0010
WINFUNC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))

def close_excel():
    check = subprocess.run(['tasklist'], capture_output=True, text=True)
    if 'EXCEL.EXE' not in check.stdout:
        return True

    def cb(hwnd, lParam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            if 'Excel' in buff.value and user32.IsWindowVisible(hwnd):
                user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        return True
    user32.EnumWindows(WINFUNC(cb), 0)

    for i in range(10):
        time.sleep(0.5)
        check = subprocess.run(['tasklist'], capture_output=True, text=True)
        if 'EXCEL.EXE' not in check.stdout:
            return True

    try:
        import pyautogui
        pyautogui.press('n')
        time.sleep(1)
    except: pass

    check = subprocess.run(['tasklist'], capture_output=True, text=True)
    if 'EXCEL.EXE' not in check.stdout:
        return True

    subprocess.run(['taskkill', '/F', '/IM', 'EXCEL.EXE'], capture_output=True)
    time.sleep(1)
    lock = os.path.join(os.path.dirname(fp), '~$' + os.path.basename(fp))
    if os.path.exists(lock):
        try: os.remove(lock)
        except: pass
    subprocess.run(['reg', 'delete', r'HKCU\\Software\\Microsoft\\Office\\16.0\\Excel\\Resiliency', '/f'], capture_output=True)
    return True

closed = close_excel()
if not closed:
    print(json.dumps({"ok": False, "error": "Could not close Excel"}))
else:
    from openpyxl import load_workbook
    wb = load_workbook(fp)
    ws = wb[${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}]
    for op in ops:
        ws[op['cell']] = op['value']
    wb.save(fp)

    if reopen:
        subprocess.Popen(['cmd', '/c', 'start', '', fp], shell=True)

    print(json.dumps({"ok": True, "updated": len(ops), "reopened": reopen}))
`;
      }

      const tmpScript = path.join(os.tmpdir(), 'jarvis_excel_live.py');
      fs.writeFileSync(tmpScript, script);

      const scriptArgs = [tmpScript];
      if (filePath) scriptArgs.push(filePath);
      if (action === 'write') scriptArgs.push(JSON.stringify(operations || []));

      const { execFile } = await import('child_process');
      execFile(PYTHON_CMD, scriptArgs, { timeout: 30000 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpScript); } catch {}
        if (err) return res.status(500).json({ error: err.message, stderr });
        try { res.json(JSON.parse(stdout.trim())); }
        catch { res.status(500).json({ error: 'Parse error', raw: stdout }); }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/read-excel - Read .xlsx file and return as JSON rows
  app.post('/api/read-excel', async (req, res) => {
    try {
      const { path: filePath, sheet } = req.body;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

      const script = `
import json, sys
import openpyxl
wb = openpyxl.load_workbook(r"""${filePath}""", data_only=True)
sheet_name = ${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}
ws = wb[sheet_name]
rows = []
for row in ws.iter_rows(values_only=True):
    rows.append(list(row))
print(json.dumps({"sheet": sheet_name, "sheets": wb.sheetnames, "rows": rows}))
`;
      const tmpScript = path.join(os.tmpdir(), 'jarvis_excel_read.py');
      fs.writeFileSync(tmpScript, script);

      const { execFile } = await import('child_process');
      execFile(PYTHON_CMD, [tmpScript], { timeout: 15000 }, (err, stdout) => {
        fs.unlinkSync(tmpScript);
        if (err) return res.status(500).json({ error: err.message });
        try { res.json(JSON.parse(stdout)); }
        catch { res.status(500).json({ error: 'Parse error', raw: stdout }); }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/files/view - Serve file inline for preview
  app.get('/api/files/view', (req, res) => {
    try {
      const filePath = path.normalize(req.query.path);
      if (!filePath.startsWith(PROJECTS_DIR)) return res.status(403).json({ error: 'Access denied' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.html': 'text/html', '.txt': 'text/plain',
        '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css'
      };
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', 'inline');
      res.sendFile(filePath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pdf - HTML to PDF via Puppeteer
  app.post('/api/pdf', async (req, res) => {
    try {
      const { htmlPath, pdfPath } = req.body;
      const normHtml = path.normalize(htmlPath);
      const normPdf = path.normalize(pdfPath);

      if (!normHtml.startsWith(PROJECTS_DIR) || !normPdf.startsWith(PROJECTS_DIR)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (!fs.existsSync(normHtml)) return res.status(404).json({ error: 'HTML file not found' });

      await htmlToPdf(normHtml, normPdf);
      const stat = fs.statSync(normPdf);
      res.json({
        ok: true, path: normPdf, size: stat.size,
        downloadUrl: `/api/files/download?path=${encodeURIComponent(normPdf)}`
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/files/search — File Intelligence search
  app.post('/api/files/search', (req, res) => {
    (async () => {
      try {
        const { query, cmd = 'search' } = req.body;
        const script = path.join(JARVIS_DIR, 'system', 'file-index.py');
        const args = cmd === 'search' ? [script, 'search', query || '']
                   : cmd === 'recent' ? [script, 'recent', String(req.body.days || 7)]
                   : cmd === 'large'  ? [script, 'large', String(req.body.mb || 100)]
                   : cmd === 'organize' ? [script, 'organize', req.body.path || '']
                   : [script, 'search', query || ''];

        const result = execSync(`"${PYTHON_CMD}" ${args.map(a => `"${a}"`).join(' ')}`, {
          encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024
        });
        res.json(JSON.parse(result.trim()));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })();
  });
}
