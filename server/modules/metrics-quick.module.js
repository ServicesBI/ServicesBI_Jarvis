import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

let lhmProcess = null;
let lhmReady = false;

function startLibreHardwareMonitor(JARVIS_DIR) {
  const lhmDir = path.join(JARVIS_DIR, 'sensors');
  const lhmExe = path.join(lhmDir, 'LibreHardwareMonitor.exe');

  if (!fs.existsSync(lhmExe)) {
    console.log('[JARVIS] LibreHardwareMonitor nao encontrado — temperaturas limitadas');
    return;
  }

  try {
    const check = execSync('tasklist /FI "IMAGENAME eq LibreHardwareMonitor.exe"', { encoding: 'utf-8' });
    if (check.includes('LibreHardwareMonitor.exe')) {
      console.log('[JARVIS] LibreHardwareMonitor ja rodando');
      lhmReady = true;
      return;
    }
  } catch {}

  try {
    lhmProcess = spawn(lhmExe, [], {
      cwd: lhmDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    lhmProcess.unref();
    console.log('[JARVIS] LibreHardwareMonitor iniciado');
    setTimeout(() => { lhmReady = true; }, 2000);
  } catch (err) {
    console.log('[JARVIS] Erro ao iniciar LHM:', err.message);
  }
}

function extractLHMSensors(node, results = { cpuTemps: [], gpuTemps: [], cpuLoad: [], gpuLoad: [] }) {
  if (!node) return results;

  if (node.Value && node.Type) {
    const val = parseFloat(node.Value);
    if (!isNaN(val)) {
      const textLower = (node.Text || '').toLowerCase();
      const imageLower = (node.ImageURL || '').toLowerCase();
      const isCpu = imageLower.includes('cpu') || textLower.includes('cpu');
      const isGpu = imageLower.includes('gpu') || textLower.includes('gpu');

      if (node.Value.includes('°C')) {
        if (isCpu) results.cpuTemps.push(val);
        else if (isGpu) results.gpuTemps.push(val);
      } else if (node.Value.includes('%') && textLower.includes('total')) {
        if (isCpu) results.cpuLoad.push(val);
        else if (isGpu) results.gpuLoad.push(val);
      }
    }
  }

  if (Array.isArray(node.Children)) {
    for (const child of node.Children) {
      extractLHMSensors(child, results);
    }
  }
  return results;
}

async function fetchLHMStats() {
  if (!lhmReady) return null;
  try {
    return new Promise((resolve) => {
      const req = http.get('http://localhost:8085/data.json', { timeout: 2000 }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const sensors = extractLHMSensors(parsed);
            resolve({
              cpuTemp: sensors.cpuTemps.length ? Math.round(Math.max(...sensors.cpuTemps)) : null,
              gpuTemp: sensors.gpuTemps.length ? Math.round(Math.max(...sensors.gpuTemps)) : null,
              cpuLoad: sensors.cpuLoad.length ? Math.round(sensors.cpuLoad[0]) : null,
              gpuLoad: sensors.gpuLoad.length ? Math.round(sensors.gpuLoad[0]) : null,
            });
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  } catch {
    return null;
  }
}

export function registerMetricsQuickModule(app, deps) {
  const { JARVIS_DIR, PYTHON_CMD } = deps;

  startLibreHardwareMonitor(JARVIS_DIR);

  // GET /api/system-stats - CPU/GPU/RAM via Python psutil+wmi (mais confiavel)
  app.get('/api/system-stats', async (req, res) => {
    try {
      const lhm = await fetchLHMStats();
      if (lhm && (lhm.cpuTemp || lhm.gpuTemp)) {
        return res.json({
          cpu: { usage: lhm.cpuLoad ?? Math.round(100 - (os.cpus().reduce((a,c)=>a+c.times.idle,0)/os.cpus().reduce((a,c)=>a+c.times.user+c.times.nice+c.times.sys+c.times.idle+c.times.irq,0)*100)), temp: lhm.cpuTemp, cores: os.cpus().length },
          gpu: { name: null, usage: lhm.gpuLoad, temp: lhm.gpuTemp },
          ram: { usage: Math.round(((os.totalmem()-os.freemem())/os.totalmem())*100), total: Math.round(os.totalmem()/(1024**3)), free: Math.round(os.freemem()/(1024**3)) },
          source: 'LibreHardwareMonitor'
        });
      }

      const pyScript = `
import json, sys
sys.stdout.reconfigure(encoding='utf-8')
result = {"cpu":{"name":None,"usage":None,"temp":None,"cores":0},"gpu":{"name":None,"temp":None,"vram":None,"usage":None},"ram":{"usage":None,"total":0,"free":0,"type":None}}
try:
    import psutil
    result["cpu"]["usage"] = round(psutil.cpu_percent(interval=0.5))
    result["cpu"]["cores"] = psutil.cpu_count(logical=True)
    mem = psutil.virtual_memory()
    result["ram"]["usage"] = round(mem.percent)
    raw_gb = mem.total / (1024**3)
    result["ram"]["total"] = int(round(raw_gb / 8) * 8) or round(raw_gb)
    result["ram"]["free"] = round(mem.available / (1024**3))
    temps = psutil.sensors_temperatures()
    if temps:
        for name, entries in temps.items():
            if entries:
                result["cpu"]["temp"] = round(entries[0].current)
                break
except: pass
try:
    import wmi
    w = wmi.WMI()
    cpus = w.Win32_Processor()
    if cpus:
        result["cpu"]["name"] = cpus[0].Name.strip()
    gpus = w.Win32_VideoController()
    dedicated = [g for g in gpus if g.Name and 'Microsoft' not in g.Name and 'Radeon(TM) Graphics' not in g.Name and 'Intel' not in g.Name and 'UHD' not in g.Name]
    gpu = None
    if dedicated:
        gpu = dedicated[0]
    elif gpus:
        real = [g for g in gpus if g.Name and 'Microsoft' not in g.Name]
        if real: gpu = real[0]
    if gpu:
        result["gpu"]["name"] = gpu.Name.strip()
        try:
            vram_bytes = int(gpu.AdapterRAM or 0)
            if vram_bytes > 0:
                result["gpu"]["vram"] = round(vram_bytes / (1024**3))
            else:
                import winreg
                reg_path = "SYSTEM\\\\CurrentControlSet\\\\Control\\\\Class\\\\{4d36e968-e325-11ce-bfc1-08002be10318}"
                for i in range(20):
                    try:
                        sub = reg_path + "\\\\%04d" % i
                        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, sub)
                        try:
                            desc = winreg.QueryValueEx(key, "DriverDesc")[0]
                        except:
                            desc = ""
                        if gpu.Name.strip().lower() in desc.lower():
                            try:
                                qw = winreg.QueryValueEx(key, "HardwareInformation.qwMemorySize")[0]
                                result["gpu"]["vram"] = round(int(qw) / (1024**3))
                            except:
                                try:
                                    ms = winreg.QueryValueEx(key, "HardwareInformation.MemorySize")[0]
                                    result["gpu"]["vram"] = round(int(ms) / (1024**3))
                                except: pass
                            break
                        winreg.CloseKey(key)
                    except: pass
        except:
            result["gpu"]["vram"] = None
    try:
        rams = w.Win32_PhysicalMemory()
        if rams:
            speed = rams[0].Speed or ""
            mem_type_map = {20:"DDR",21:"DDR2",24:"DDR3",26:"DDR4",34:"DDR5"}
            smbios_type = getattr(rams[0], 'SMBIOSMemoryType', None)
            if smbios_type and int(smbios_type) in mem_type_map:
                result["ram"]["type"] = mem_type_map[int(smbios_type)]
            elif speed:
                spd = int(speed)
                if spd >= 4800: result["ram"]["type"] = "DDR5"
                elif spd >= 2133: result["ram"]["type"] = "DDR4"
                elif spd >= 1066: result["ram"]["type"] = "DDR3"
                else: result["ram"]["type"] = "DDR"
            if speed:
                result["ram"]["type"] = (result["ram"]["type"] or "DDR") + " " + str(speed) + "MHz"
    except: pass
except: pass
try:
    import subprocess
    r = subprocess.run(['nvidia-smi','--query-gpu=temperature.gpu','--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3)
    if r.returncode == 0:
        result["gpu"]["temp"] = int(r.stdout.strip())
except: pass
print(json.dumps(result))
`;
      const tmpScript = path.join(os.tmpdir(), 'jarvis_stats.py');
      fs.writeFileSync(tmpScript, pyScript);

      const { execFile } = await import('child_process');
      execFile(PYTHON_CMD, [tmpScript], { timeout: 8000 }, (err, stdout) => {
        try { fs.unlinkSync(tmpScript); } catch {}
        if (err) {
          return res.json({
            cpu: { usage: null, temp: null, cores: os.cpus().length },
            gpu: { name: null, temp: null },
            ram: { usage: Math.round(((os.totalmem()-os.freemem())/os.totalmem())*100), total: Math.round(os.totalmem()/(1024**3)), free: Math.round(os.freemem()/(1024**3)) },
            source: 'node-only'
          });
        }
        try {
          const data = JSON.parse(stdout.trim());
          data.source = 'psutil';
          res.json(data);
        } catch {
          res.json({ cpu:{usage:null,temp:null,cores:os.cpus().length}, gpu:{name:null,temp:null}, ram:{usage:null,total:0,free:0}, source:'error' });
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
