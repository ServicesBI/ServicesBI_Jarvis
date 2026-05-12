import fs from 'fs';
import path from 'path';

export function registerObsidianModule(app, deps) {
  const { SYSTEM_DIR, openai, fetchWeather } = deps;

  const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || 'C:\\Jrleles_Obsidian';

  // GET /api/obsidian/stats — count notes, folders, links
  app.get('/api/obsidian/stats', (req, res) => {
    try {
      if (!fs.existsSync(OBSIDIAN_VAULT)) {
        return res.json({ connected: false, error: 'Vault not found' });
      }
      let notes = 0, folders = 0, links = 0;
      function walk(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (item.startsWith('.')) continue;
          const full = path.join(dir, item);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            folders++;
            walk(full);
          } else if (item.endsWith('.md')) {
            notes++;
            const content = fs.readFileSync(full, 'utf-8');
            const matches = content.match(/\[\[[^\]]+\]\]/g);
            if (matches) links += matches.length;
          }
        }
      }
      walk(OBSIDIAN_VAULT);
      res.json({ connected: true, notes, folders, links });
    } catch (err) {
      res.json({ connected: false, error: err.message });
    }
  });

  // GET /api/obsidian/tree — full vault tree
  app.get('/api/obsidian/tree', (req, res) => {
    try {
      if (!fs.existsSync(OBSIDIAN_VAULT)) return res.json({ tree: [] });
      function buildTree(dir) {
        const items = fs.readdirSync(dir).filter(i => !i.startsWith('.'));
        const result = [];
        const folders = items.filter(i => fs.statSync(path.join(dir, i)).isDirectory());
        const files = items.filter(i => i.endsWith('.md') && fs.statSync(path.join(dir, i)).isFile());
        for (const f of folders.sort()) {
          result.push({
            type: 'folder',
            name: f,
            children: buildTree(path.join(dir, f))
          });
        }
        for (const f of files.sort()) {
          result.push({
            type: 'note',
            name: f.replace('.md', ''),
            path: path.relative(OBSIDIAN_VAULT, path.join(dir, f)).replace(/\\/g, '/')
          });
        }
        return result;
      }
      res.json({ tree: buildTree(OBSIDIAN_VAULT) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/obsidian/note?path=... — read a note
  app.get('/api/obsidian/note', (req, res) => {
    try {
      const notePath = req.query.path;
      if (!notePath) return res.status(400).json({ error: 'path required' });
      const fullPath = path.join(OBSIDIAN_VAULT, notePath);
      if (!fullPath.startsWith(OBSIDIAN_VAULT)) return res.status(403).json({ error: 'forbidden' });
      if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'not found' });
      const content = fs.readFileSync(fullPath, 'utf-8');
      res.json({ path: notePath, content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/obsidian/ingest — create note from text, file content, or session
  app.post('/api/obsidian/ingest', (req, res) => {
    (async () => {
      try {
        const { type, text, category, fileName, fileContent, folderPath } = req.body;

        if (type === 'text' && text) {
          let title = 'Novo Conhecimento';
          let noteContent = text;
          let folder = category || 'auto';

          if (openai && folder === 'auto') {
            try {
              const aiRes = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: 'Organize this knowledge into an Obsidian note. Return JSON: {"title":"short title","folder":"best folder (Projetos|Negócios & Finanças|Marketing Digital|Programação & IA|Tecnologias)","content":"organized markdown with [[links]] to related concepts"}' },
                  { role: 'user', content: text }
                ],
                response_format: { type: 'json_object' },
                max_tokens: 2000
              });
              const parsed = JSON.parse(aiRes.choices[0].message.content);
              title = parsed.title || title;
              folder = parsed.folder || 'geral';
              noteContent = parsed.content || text;
            } catch {}
          }

          const folderMap = {
            projeto: 'Projetos', decisao: 'Decisões Técnicas',
            pessoa: '', aprendizado: '', preferencia: '',
            negocio: 'Negócios & Finanças', auto: folder
          };
          const targetFolder = folderMap[category] || folder;
          const targetDir = targetFolder ? path.join(OBSIDIAN_VAULT, targetFolder) : OBSIDIAN_VAULT;
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

          const safeName = title.replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
          const filePath = path.join(targetDir, `${safeName}.md`);
          fs.writeFileSync(filePath, noteContent, 'utf-8');

          return res.json({ ok: true, path: path.relative(OBSIDIAN_VAULT, filePath).replace(/\\/g, '/'), title });
        }

        if (type === 'file' && fileContent) {
          const name = (fileName || 'Imported').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]/g, '');
          const filePath = path.join(OBSIDIAN_VAULT, `${name}.md`);

          let content = fileContent;
          if (fileContent.startsWith('data:')) {
            content = `# ${name}\n\n> Arquivo importado\n\n\`\`\`\n${fileContent.substring(0, 500)}...\n\`\`\``;
          }

          fs.writeFileSync(filePath, content, 'utf-8');
          return res.json({ ok: true, path: `${name}.md`, title: name });
        }

        if (type === 'folder' && folderPath) {
          if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'Folder not found' });
          let count = 0;
          const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
          for (const f of files) {
            const content = fs.readFileSync(path.join(folderPath, f), 'utf-8');
            const name = f.replace(/\.[^.]+$/, '');
            fs.writeFileSync(path.join(OBSIDIAN_VAULT, `${name}.md`), content, 'utf-8');
            count++;
          }
          return res.json({ ok: true, count, message: `${count} files ingested` });
        }

        if (type === 'session') {
          const historyFile = path.join(SYSTEM_DIR, 'JARVIS-HISTORY.json');
          let sessionData = '';

          if (fs.existsSync(historyFile)) {
            try {
              const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
              const last10 = history.slice(-10);
              sessionData = last10.map(h => `[${h.role}] ${h.content}`).join('\n\n');
            } catch {}
          }

          if (!sessionData) {
            return res.json({ ok: false, error: 'No session data found' });
          }

          if (openai) {
            try {
              const aiRes = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: 'Extract valuable knowledge from this session. Create 1-3 Obsidian notes. Return JSON array: [{"title":"...","content":"markdown with [[links]]","folder":"best folder name"}]. Only extract decisions, learnings, preferences, projects created. Skip trivial chat.' },
                  { role: 'user', content: sessionData }
                ],
                response_format: { type: 'json_object' },
                max_tokens: 3000
              });
              const parsed = JSON.parse(aiRes.choices[0].message.content);
              const notes = Array.isArray(parsed) ? parsed : (parsed.notes || [parsed]);
              let created = 0;
              for (const note of notes) {
                if (!note.title) continue;
                const dir = note.folder ? path.join(OBSIDIAN_VAULT, note.folder) : OBSIDIAN_VAULT;
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const safeName = note.title.replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
                fs.writeFileSync(path.join(dir, `${safeName}.md`), note.content || '', 'utf-8');
                created++;
              }
              return res.json({ ok: true, count: created, notes: notes.map(n => n.title) });
            } catch (err) {
              return res.json({ ok: false, error: err.message });
            }
          }
          return res.json({ ok: false, error: 'OpenAI not configured for session analysis' });
        }

        res.status(400).json({ error: 'Invalid type. Use: text, file, folder, or session' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })();
  });

  // GET /api/weather - Free weather data (no API key needed)
  app.get('/api/weather', async (req, res) => {
    const city = req.query.city || req.query.c || '';
    const lang = req.query.lang || 'BR';
    const data = await fetchWeather(city, lang);
    if (data) res.json(data);
    else res.status(404).json({ error: 'Weather not found' });
  });
}
