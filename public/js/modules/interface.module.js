// ═══ INTERFACE MODULE ═══
// Setor 1: Interface visual principal — 3D Brain, Language Toggle

export function initInterfaceModule(deps) {

  // ── Holographic Brain 3D (NeuralTree — Three.js, fallback do cockpit) ──
  class NeuralTree {
    constructor(canvasOrContainer) {
      this.container = canvasOrContainer.parentElement || canvasOrContainer;
      this.state = 'idle';
      this.time = 0;
      this.speedMul = 1;
      this.targetSpeed = 1;
      this.stateSpeeds = { idle: 0.4, listening: 0.8, thinking: 1.5, speaking: 1.0 };
      if (canvasOrContainer.tagName === 'CANVAS') canvasOrContainer.style.display = 'none';
      this._init3D();
      this.animate = this.animate.bind(this);
      this.animate();
    }

    setState(state) { this.state = state; this.targetSpeed = this.stateSpeeds[state] || 0.4; }

    resize() {
      if (!this.renderer || !this.camera) return;
      const w = this.container.clientWidth || this.container.getBoundingClientRect().width || 400;
      const h = this.container.clientHeight || this.container.getBoundingClientRect().height || 400;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    _init3D() {
      if (typeof THREE === 'undefined') return;
      const rect = this.container.getBoundingClientRect();
      const w = rect.width || 500, h = rect.height || 500;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 200);
      this.camera.position.set(0, 0, 7);
      this.camera.lookAt(0, -1.5, 0);

      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;z-index:2;pointer-events:none;';
      this.container.appendChild(this.renderer.domElement);
      window.addEventListener('resize', () => this.resize());

      const holoVertexShader = `
        varying vec3 vNormal; varying vec3 vPosition; varying vec3 vWorldPos;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`;
      const holoFragmentShader = `
        uniform float uTime; uniform float uPulse; uniform float uOpacity;
        uniform vec3 uColor; uniform float uScanY;
        varying vec3 vNormal; varying vec3 vPosition; varying vec3 vWorldPos;
        void main() {
          vec3 viewDir = normalize(-vPosition);
          float fresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 1.8);
          float scanLine = smoothstep(0.4, 0.6, sin(vWorldPos.y * 60.0 + uTime * 3.0) * 0.5 + 0.5) * 0.12;
          float scanBar = (1.0 - smoothstep(0.0, 0.15, abs(vWorldPos.y - uScanY))) * 0.35;
          float alpha = (fresnel * 0.7 + 0.06 + scanLine + scanBar) * uOpacity;
          vec3 color = uColor; color.r += fresnel * 0.08; color.b += fresnel * 0.12;
          gl_FragColor = vec4(color, alpha * uPulse);
        }`;

      this.holoMaterial = new THREE.ShaderMaterial({
        vertexShader: holoVertexShader, fragmentShader: holoFragmentShader,
        uniforms: { uTime: { value: 0 }, uPulse: { value: 1.0 }, uOpacity: { value: 0.85 }, uColor: { value: new THREE.Color(0x00e4ff) }, uScanY: { value: 0 } },
        transparent: true, side: THREE.DoubleSide, depthWrite: false,
      });
      this.wireMaterial = new THREE.MeshBasicMaterial({ color: 0x00e4ff, wireframe: true, transparent: true, opacity: 0.1, depthWrite: false });

      this.brainGroup = new THREE.Group();
      this.scene.add(this.brainGroup);
      this.brainHolo = this.brainWire = this.brainWire2 = this.brainSolid = null;

      const self = this;
      function tryLoadBrain() {
        if (typeof THREE === 'undefined' || typeof THREE.GLTFLoader === 'undefined') { setTimeout(tryLoadBrain, 500); return; }
        const loader = new THREE.GLTFLoader();
        loader.load('brain.glb', (gltf) => {
          const model = gltf.scene;
          const box = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const brainScale = 2.7 / Math.max(size.x, size.y, size.z);
          const brainPivot = new THREE.Group();
          model.position.set(-center.x, -center.y, -center.z);
          brainPivot.add(model);
          brainPivot.scale.setScalar(brainScale);
          model.traverse(c => { if (c.isMesh) { c.material = self.holoMaterial; c.renderOrder = 1; } });
          self.brainHolo = brainPivot; self.brainGroup.add(brainPivot);
          const wirePivot = new THREE.Group();
          const wireModel = model.clone(true);
          wireModel.traverse(c => { if (c.isMesh) c.material = self.wireMaterial.clone(); });
          wireModel.position.set(-center.x, -center.y, -center.z);
          wirePivot.add(wireModel); wirePivot.scale.setScalar(brainScale * 1.003);
          self.brainWire = wirePivot; self.brainGroup.add(wirePivot);
        }, undefined, (err) => {
          const fallbackGeo = new THREE.SphereGeometry(1.5, 48, 32);
          self.brainHolo = new THREE.Mesh(fallbackGeo, self.holoMaterial);
          self.brainGroup.add(self.brainHolo);
          self.brainWire = new THREE.Mesh(fallbackGeo.clone(), self.wireMaterial);
          self.brainGroup.add(self.brainWire);
        });
      }
      tryLoadBrain();

      this.brainGlow = this.brainGlow2 = null;
      this.treeGroup = new THREE.Group();
      this.scene.add(this.treeGroup);

      const branchMat = new THREE.LineBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.4 });
      const secMat = new THREE.LineBasicMaterial({ color: 0x00aacc, transparent: true, opacity: 0.25 });
      const leafMat = new THREE.LineBasicMaterial({ color: 0x007799, transparent: true, opacity: 0.15 });
      const rootMat = new THREE.LineBasicMaterial({ color: 0x005566, transparent: true, opacity: 0.1 });
      const nodeMat = new THREE.MeshBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.6 });
      const goldNodeMat = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.5 });
      const octGeo = new THREE.OctahedronGeometry(0.06, 0);
      this._treeNodes = [];

      const addBranch = (from, to, mat, nodeM, nodeScale) => {
        const midY = from.y + (to.y - from.y) * (0.3 + Math.random() * 0.4);
        const cornerPt = new THREE.Vector3(from.x, midY, from.z);
        const cornerPt2 = new THREE.Vector3(to.x, midY, to.z);
        this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, cornerPt]), mat));
        this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([cornerPt, cornerPt2]), mat));
        this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([cornerPt2, to]), mat));
        const dotGeo = new THREE.SphereGeometry(0.025, 4, 4);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.4 });
        const dot1 = new THREE.Mesh(dotGeo, dotMat); dot1.position.copy(cornerPt); this.treeGroup.add(dot1);
        const dot2 = new THREE.Mesh(dotGeo, dotMat.clone()); dot2.position.copy(cornerPt2); this.treeGroup.add(dot2);
        const n = new THREE.Mesh(octGeo, nodeM.clone()); n.position.copy(to); n.scale.setScalar(nodeScale || 0.7);
        this.treeGroup.add(n); this._treeNodes.push(n);
        return to;
      };

      const stemEnd = new THREE.Vector3(0, -2.5, 0);
      const mainStem = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0,0,0), new THREE.Vector3(0,-1.2,0), stemEnd);
      this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(mainStem.getPoints(25)), new THREE.LineBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.7 })));
      for (let si = 0; si < 5; si++) {
        const angle = (si / 5) * Math.PI * 2;
        const ox = Math.cos(angle) * 0.12, oz = Math.sin(angle) * 0.08;
        const sCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(ox,-0.2,oz), new THREE.Vector3(ox*0.3,-1.3,oz*0.3), new THREE.Vector3(0,-2.5,0));
        this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sCurve.getPoints(18)), new THREE.LineBasicMaterial({ color: 0x00aacc, transparent: true, opacity: 0.25 })));
      }

      const primaries = [
        {x:-3.5,y:-3.5,z:0.7},{x:-2.5,y:-3.8,z:-0.5},{x:-1.2,y:-3.6,z:0.4},{x:-0.4,y:-3.4,z:-0.3},
        {x:0.4,y:-3.4,z:0.3},{x:1.2,y:-3.6,z:-0.4},{x:2.5,y:-3.8,z:0.5},{x:3.5,y:-3.5,z:-0.7},{x:0,y:-3.2,z:0.6}
      ];
      const primEnds = primaries.map(p => addBranch(stemEnd, new THREE.Vector3(p.x,p.y,p.z), branchMat, nodeMat, 0.8));
      const secEnds = [];
      for (const pe of primEnds) {
        for (let j = 0; j < 4 + Math.floor(Math.random()*2); j++) {
          const sx = pe.x+(Math.random()-0.5)*1.8, sy = pe.y-0.4-Math.random()*0.9, sz = pe.z+(Math.random()-0.5)*1.2;
          secEnds.push(addBranch(pe, new THREE.Vector3(Math.max(-5,Math.min(5,sx)),Math.max(-6.5,sy),sz), secMat, j%2===0?goldNodeMat:nodeMat, 0.5));
        }
      }
      for (const se of secEnds) {
        for (let k = 0; k < 2+Math.floor(Math.random()*2); k++) {
          const lx = se.x+(Math.random()-0.5)*1.4, ly = se.y-0.3-Math.random()*0.7, lz = se.z+(Math.random()-0.5)*0.9;
          addBranch(se, new THREE.Vector3(Math.max(-6,Math.min(6,lx)),Math.max(-8,ly),lz), leafMat, goldNodeMat, 0.3);
        }
      }
      for (let i = 0; i < 20; i++) {
        const allEnds = [...primEnds, ...secEnds.slice(0, 20)];
        const a = Math.floor(Math.random()*allEnds.length), b = Math.floor(Math.random()*allEnds.length);
        if (a !== b) {
          const dist = allEnds[a].distanceTo(allEnds[b]);
          if (dist < 2.5 && dist > 0.5) this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([allEnds[a], allEnds[b]]), new THREE.LineBasicMaterial({ color: 0x006688, transparent: true, opacity: 0.08 })));
        }
      }
      for (let i = 0; i < 20; i++) {
        const rx = (Math.random()-0.5)*10, ry = -6.5-Math.random()*2.5, rz = (Math.random()-0.5)*2.5;
        this.treeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(rx+(Math.random()-0.5)*0.5,-5.5-Math.random(),rz), new THREE.Vector3(rx,ry,rz+(Math.random()-0.5)*0.3)]), rootMat));
      }

      this._particles = [];
      const pMat = new THREE.MeshBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.5 });
      for (let i = 0; i < 250; i++) {
        const size = 0.02+Math.random()*0.04;
        const p = new THREE.Mesh(new THREE.SphereGeometry(size,4,4), pMat.clone());
        p.position.set((Math.random()-0.5)*8, 1+Math.random()*-9, (Math.random()-0.5)*3);
        p.userData = { speed: 0.002+Math.random()*0.01, phase: Math.random()*Math.PI*2, baseX: p.position.x, baseZ: p.position.z, drift: 0.15+Math.random()*0.5 };
        this.scene.add(p); this._particles.push(p);
      }
      this._lightningLines = [];
      for (let i = 0; i < 16; i++) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7 }));
        line.visible = false; this.scene.add(line); this._lightningLines.push(line);
      }
      this._pulsePoints = [];
      const pulseMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
      for (let i = 0; i < 25; i++) {
        const pp = new THREE.Mesh(new THREE.SphereGeometry(0.06,6,6), pulseMat.clone());
        const theta = Math.random()*Math.PI*2, phi = Math.random()*Math.PI;
        pp.position.set(Math.sin(phi)*Math.cos(theta)*2.4, Math.cos(phi)*1.7, Math.sin(phi)*Math.sin(theta)*2.0);
        pp.userData = { phase: Math.random()*Math.PI*2, speed: 1.5+Math.random()*4 };
        this.scene.add(pp); this._pulsePoints.push(pp);
      }
    }

    pause() { this._paused = true; }
    resume() { if (this._paused) { this._paused = false; this.animate(); } }

    dispose() {
      this._disposed = true;
      if (this.renderer) { this.renderer.dispose(); this.renderer.domElement?.remove(); }
      if (this.scene) this.scene.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) { if (Array.isArray(child.material)) child.material.forEach(m => m.dispose()); else child.material.dispose(); }
      });
    }

    animate() {
      if (this._disposed || this._paused || typeof THREE === 'undefined') return;
      this.time += 0.016;
      this.speedMul += (this.targetSpeed - this.speedMul) * 0.03;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 1.2);
      const rotSpeed = this.state === 'thinking' ? 0.008 : 0.002;
      if (this.brainGroup) { this.brainGroup.rotation.y += rotSpeed * this.speedMul; this.brainGroup.scale.setScalar(1 + 0.04 * Math.sin(this.time * 1.5)); }
      if (this.holoMaterial) {
        this.holoMaterial.uniforms.uTime.value = this.time;
        this.holoMaterial.uniforms.uPulse.value = 0.7 + 0.3 * pulse;
        this.holoMaterial.uniforms.uScanY.value = (Math.sin(this.time * 0.8) + 1) * 0.5;
        const colorMap = { speaking: 0x00ffaa, thinking: 0x44aaff, listening: 0x00ffcc };
        this.holoMaterial.uniforms.uColor.value.setHex(colorMap[this.state] || 0x00e4ff);
        this.holoMaterial.uniforms.uOpacity.value = this.state === 'idle' ? 0.8 : (this.state === 'listening' ? 0.9 : 1.0);
      }
      if (this.brainWire && this.wireMaterial) {
        const wColors = { speaking: 0x00ffaa, thinking: 0x44aaff, listening: 0x00ffcc };
        this.wireMaterial.opacity = 0.1 + (this.state === 'speaking' ? 0.08 : this.state === 'thinking' ? 0.1 : 0.04) * pulse;
        this.wireMaterial.color.setHex(wColors[this.state] || 0x00e4ff);
      }
      if (this._lightningLines) {
        for (const line of this._lightningLines) {
          if (Math.random() < (this.state === 'thinking' ? 0.15 : 0.03)) {
            const t1 = Math.random()*Math.PI*2, p1 = Math.random()*Math.PI;
            const t2 = t1+(Math.random()-0.5)*2, p2 = p1+(Math.random()-0.5)*1, r = 1.55;
            const start = new THREE.Vector3(Math.sin(p1)*Math.cos(t1)*r, Math.cos(p1)*0.75*r, Math.sin(p1)*Math.sin(t1)*0.85*r);
            const end = new THREE.Vector3(Math.sin(p2)*Math.cos(t2)*r, Math.cos(p2)*0.75*r, Math.sin(p2)*Math.sin(t2)*0.85*r);
            const mid = start.clone().add(end).multiplyScalar(0.5).add(new THREE.Vector3((Math.random()-0.5)*0.3,(Math.random()-0.5)*0.2,(Math.random()-0.5)*0.3));
            line.geometry.setFromPoints([start, mid, end]);
            line.material.opacity = 0.5 + Math.random()*0.5;
            line.material.color.setHex(Math.random()>0.5 ? 0x88ddff : 0xffffff);
            line.visible = true;
            setTimeout(() => { line.visible = false; }, 80+Math.random()*120);
          }
        }
      }
      if (this._pulsePoints) {
        for (const pp of this._pulsePoints) {
          const intensity = 0.5 + 0.5 * Math.sin(this.time * pp.userData.speed + pp.userData.phase);
          pp.material.opacity = intensity * (this.state === 'thinking' ? 1 : 0.5);
          pp.scale.setScalar(0.5 + intensity * (this.state === 'thinking' ? 1.5 : 0.5));
        }
      }
      for (const p of this._particles) {
        const ud = p.userData;
        const speed = ud.speed * this.speedMul * (this.state === 'listening' ? 2 : 1);
        p.position.y += speed * (this.state === 'speaking' ? -1 : 1);
        p.position.x = ud.baseX + Math.sin(this.time * 0.5 + ud.phase) * ud.drift;
        p.position.z = ud.baseZ + Math.cos(this.time * 0.3 + ud.phase) * ud.drift * 0.5;
        if (p.position.y > 2) p.position.y = -8;
        if (p.position.y < -9) p.position.y = 2;
        p.material.opacity = Math.max(0.05, 0.6 - Math.abs(p.position.y) * 0.15) * (0.5 + 0.5 * Math.sin(this.time * 2 + ud.phase));
      }
      for (let i = 0; i < this._treeNodes.length; i++) {
        const n = this._treeNodes[i];
        const nodePulse = 0.7 + 0.3 * Math.sin(this.time * 1.5 + i * 0.5);
        n.material.opacity = nodePulse * (this.state === 'thinking' ? 1 : 0.6);
        if (this.state === 'thinking') n.scale.setScalar(0.5 + (0.5+0.5*Math.sin(this.time*4-i*0.3)) * 0.8);
        else n.scale.setScalar(0.5 + nodePulse * 0.3);
      }
      if (this.brainGroup && Math.random() < 0.01) { this.brainGroup.position.x = (Math.random()-0.5)*0.05; const bg = this.brainGroup; setTimeout(() => { bg.position.x = 0; }, 50); }
      this.camera.position.x = Math.sin(this.time * 0.12) * 0.2;
      this.camera.position.y = Math.sin(this.time * 0.08) * 0.15;
      this.camera.lookAt(0, -1.5, 0);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(this.animate);
    }
  }

  // ── Core 3D Ring Builder ──
  function initJarvisCore3D() {
    const host = document.querySelector('.jarvis-core3d-host');
    const scene = document.getElementById('jarvis-core3d-scene');
    if (!host || !scene) return false;

    const buildOuterTicks = () => {
      const g = document.getElementById('jarvis-core3d-outer-ticks');
      if (!g) return;
      let s = '';
      for (let i = 0; i < 160; i++) {
        const a = (i / 160) * Math.PI * 2;
        const r1 = 232, r2 = i % 8 === 0 ? 248 : (i % 4 === 0 ? 242 : 238);
        const x1 = Math.cos(a)*r1, y1 = Math.sin(a)*r1, x2 = Math.cos(a)*r2, y2 = Math.sin(a)*r2;
        s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" opacity="${i%8===0?'1':'.45'}"/>`;
      }
      g.innerHTML = s;
    };
    const buildLabelRing = () => {
      const g = document.getElementById('jarvis-core3d-label-ring');
      if (!g) return;
      let s = '';
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * 360, lbl = String(i * 30).padStart(3, '0');
        s += `<g transform="rotate(${a}) translate(0 -188)"><text text-anchor="middle" dominant-baseline="middle" font-family="Orbitron, monospace" font-size="9" fill="#9fe6f7" letter-spacing="2" transform="rotate(${-a})">${lbl}</text></g>`;
      }
      g.innerHTML = s;
    };
    const buildBracketRing = () => {
      const g = document.getElementById('jarvis-core3d-bracket-ring');
      if (!g) return;
      const positions = [0, 72, 144, 216, 288, 36, 180];
      let s = '';
      positions.forEach((deg, idx) => {
        const w = idx < 5 ? 22 : 12, r = 188;
        const a1 = (deg-w/2)*Math.PI/180, a2 = (deg+w/2)*Math.PI/180;
        const x1 = Math.cos(a1)*r, y1 = Math.sin(a1)*r, x2 = Math.cos(a2)*r, y2 = Math.sin(a2)*r;
        const t1x = Math.cos(a1)*(r-10), t1y = Math.sin(a1)*(r-10), t2x = Math.cos(a2)*(r-10), t2y = Math.sin(a2)*(r-10);
        s += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="#5fdfff" stroke-width="6" opacity=".9"/>`;
        s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${t1x.toFixed(1)}" y2="${t1y.toFixed(1)}" stroke="#5fdfff" stroke-width="2" opacity=".75"/>`;
        s += `<line x1="${x2.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${t2x.toFixed(1)}" y2="${t2y.toFixed(1)}" stroke="#5fdfff" stroke-width="2" opacity=".75"/>`;
      });
      g.innerHTML = s;
    };

    try {
      buildOuterTicks(); buildLabelRing(); buildBracketRing();
      host.classList.add('is-core3d-ready');
      return true;
    } catch (err) {
      console.warn('[JARVIS] Core 3D reactor fallback:', err.message);
      host.classList.remove('is-core3d-ready');
      return false;
    }
  }

  // ── Initialize 3D Brain after layout settles ──
  requestAnimationFrame(() => {
    const canvas = document.getElementById('particle-orb');
    const coreReady = initJarvisCore3D();
    if (canvas && !coreReady) {
      const particleOrb = new NeuralTree(canvas);
      window.particleOrb = particleOrb;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!window.particleOrb) return;
    if (document.hidden) window.particleOrb.pause();
    else window.particleOrb.resume();
  });

  // ── Language Toggle ──
  function initLangToggle() {
    const enBtn = document.getElementById('lang-en');
    const brBtn = document.getElementById('lang-br');
    const esBtn = document.getElementById('lang-es');
    if (!enBtn || !brBtn) return;

    function applyLang(lang) {
      deps.currentLang = lang;
      localStorage.setItem('jarvis-lang', lang);
      enBtn.classList.toggle('active', lang === 'EN');
      brBtn.classList.toggle('active', lang === 'BR');
      if (esBtn) esBtn.classList.toggle('active', lang === 'ES');
      const placeholders = { BR: 'Fale com o JARVIS...', ES: 'Habla con JARVIS...', EN: 'Talk to JARVIS...' };
      const ci = document.getElementById('chat-input');
      if (ci) ci.placeholder = placeholders[lang] || placeholders.EN;
      const bootMsg = document.getElementById('boot-msg');
      if (bootMsg) {
        const boots = {
          BR: '[system] JARVIS COCKPIT INICIALIZADO. TODO SISTEMA DE INTELIGÊNCIA CARREGADO COM SUCESSO E PRONTO PARA USO.',
          ES: '[system] JARVIS COCKPIT INICIADO. TODO EL SISTEMA DE INTELIGENCIA CARGADO CON ÉXITO Y LISTO PARA USAR.',
          EN: '[system] JARVIS COCKPIT ONLINE. ALL SYSTEMS LOADED AND READY.'
        };
        bootMsg.textContent = boots[lang] || boots.EN;
      }
      document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        const label = btn.getAttribute(`data-lang-${lang.toLowerCase()}`);
        if (label) btn.textContent = label;
      });
      if (deps.realtimeActive) { deps.stopRealtime(); setTimeout(() => deps.startRealtime(), 300); }
    }

    applyLang(deps.currentLang);
    enBtn.addEventListener('click', () => { if (deps.currentLang !== 'EN') applyLang('EN'); });
    brBtn.addEventListener('click', () => { if (deps.currentLang !== 'BR') applyLang('BR'); });
    if (esBtn) esBtn.addEventListener('click', () => { if (deps.currentLang !== 'ES') applyLang('ES'); });
  }

  initLangToggle();
}
