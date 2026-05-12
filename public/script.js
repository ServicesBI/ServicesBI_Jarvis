// ========== JARVIS COCKPIT - CLIENT LOGIC ==========

// DOM Elements
const terminal = document.getElementById('terminal-output');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const avatarContainer = document.querySelector('.avatar-container');
const avatarStatus = document.getElementById('avatar-status');

// ========== HOLOGRAPHIC BRAIN 3D — Three.js Iron Man ==========
class NeuralTree {
  constructor(canvasOrContainer) {
    // Three.js takes over the container, not the canvas directly
    this.container = canvasOrContainer.parentElement || canvasOrContainer;
    this.state = 'idle';
    this.time = 0;
    this.speedMul = 1;
    this.targetSpeed = 1;
    this.stateSpeeds = { idle: 0.4, listening: 0.8, thinking: 1.5, speaking: 1.0 };

    // Hide the original canvas (Three.js creates its own)
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
    const rect = this.container.getBoundingClientRect();
    const w = rect.width || 500, h = rect.height || 500;

    // Scene
    this.scene = new THREE.Scene();

    // Camera — positioned to see brain from side (like the reference image)
    // FOV 50 + near 0.01 prevents frustum clipping on the brain model
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 200);
    this.camera.position.set(0, 0, 7);
    this.camera.lookAt(0, -1.5, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.top = '0';
    this.renderer.domElement.style.left = '0';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.overflow = 'visible';
    this.renderer.domElement.style.zIndex = '2';
    this.renderer.domElement.style.pointerEvents = 'none';
    this.container.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => this.resize());

    // ── HOLOGRAPHIC SHADER — Fresnel + scan lines + chromatic aberration ──
    const holoVertexShader = `
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec3 vWorldPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const holoFragmentShader = `
      uniform float uTime;
      uniform float uPulse;
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uScanY;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec3 vWorldPos;
      void main() {
        vec3 viewDir = normalize(-vPosition);
        float fresnel = 1.0 - abs(dot(viewDir, vNormal));
        fresnel = pow(fresnel, 1.8);
        float scanLine = sin(vWorldPos.y * 60.0 + uTime * 3.0) * 0.5 + 0.5;
        scanLine = smoothstep(0.4, 0.6, scanLine) * 0.12;
        float scanBar = 1.0 - smoothstep(0.0, 0.15, abs(vWorldPos.y - uScanY));
        scanBar *= 0.35;
        float alpha = (fresnel * 0.7 + 0.06 + scanLine + scanBar) * uOpacity;
        vec3 color = uColor;
        color.r += fresnel * 0.08;
        color.b += fresnel * 0.12;
        gl_FragColor = vec4(color, alpha * uPulse);
      }
    `;

    this.holoMaterial = new THREE.ShaderMaterial({
      vertexShader: holoVertexShader,
      fragmentShader: holoFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: 1.0 },
        uOpacity: { value: 0.85 },
        uColor: { value: new THREE.Color(0x00e4ff) },
        uScanY: { value: 0 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Wireframe material
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x00e4ff, wireframe: true, transparent: true, opacity: 0.1, depthWrite: false,
    });

    // ── Load real brain model (GLB) ──
    this.brainGroup = new THREE.Group();
    this.scene.add(this.brainGroup);

    // Placeholder meshes (used before model loads + as fallback)
    this.brainHolo = null;
    this.brainWire = null;
    this.brainWire2 = null;
    this.brainSolid = null;

    // Load brain model (with retry if GLTFLoader not ready yet)
    const self = this;
    function tryLoadBrain() {
      if (typeof THREE === 'undefined' || typeof THREE.GLTFLoader === 'undefined') {
        console.log('[JARVIS] GLTFLoader not ready, retrying in 500ms...');
        setTimeout(tryLoadBrain, 500);
        return;
      }
      const loader = new THREE.GLTFLoader();
      console.log('[JARVIS] Loading brain.glb...');
      loader.load('brain.glb', (gltf) => {
      const model = gltf.scene;
      console.log('[JARVIS] Brain model loaded!');

      // Center and scale — model is ~214 units, need to fit in ~3 units
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const brainScale = 2.7 / maxDim;

      // Wrap in a group for clean transform
      const brainPivot = new THREE.Group();
      model.position.set(-center.x, -center.y, -center.z); // center it
      brainPivot.add(model);
      brainPivot.scale.setScalar(brainScale);

      // Apply holographic material to all meshes
      model.traverse(function(child) {
        if (child.isMesh) {
          child.material = self.holoMaterial;
          child.renderOrder = 1;
        }
      });
      self.brainHolo = brainPivot;
      self.brainGroup.add(brainPivot);

      // Wireframe clone
      const wireModel = model.clone(true);
      wireModel.traverse(function(child) {
        if (child.isMesh) {
          child.material = self.wireMaterial.clone();
          child.renderOrder = 0;
        }
      });
      const wirePivot = new THREE.Group();
      wireModel.position.set(-center.x, -center.y, -center.z);
      wirePivot.add(wireModel);
      wirePivot.scale.setScalar(brainScale * 1.003);
      self.brainWire = wirePivot;
      self.brainGroup.add(wirePivot);

      // Second wireframe (outer glow layer)
      const wire2Model = model.clone(true);
      wire2Model.traverse(function(child) {
        if (child.isMesh) {
          child.material = new THREE.MeshBasicMaterial({
            color: 0x3366cc, wireframe: true, transparent: true, opacity: 0.04, depthWrite: false,
          });
        }
      });
      const wire2Pivot = new THREE.Group();
      wire2Model.position.set(-center.x, -center.y, -center.z);
      wire2Pivot.add(wire2Model);
      wire2Pivot.scale.setScalar(brainScale * 1.02);
      self.brainWire2 = wire2Pivot;
      self.brainGroup.add(wire2Pivot);

      // Inner volume glow
      const solidModel = model.clone(true);
      solidModel.traverse(function(child) {
        if (child.isMesh) {
          child.material = new THREE.MeshBasicMaterial({
            color: 0x003355, transparent: true, opacity: 0.04, side: THREE.BackSide, depthWrite: false,
          });
        }
      });
      const solidPivot = new THREE.Group();
      solidModel.position.set(-center.x, -center.y, -center.z);
      solidPivot.add(solidModel);
      solidPivot.scale.setScalar(brainScale * 0.98);
      self.brainSolid = solidPivot;
      self.brainGroup.add(solidPivot);

      console.log('[JARVIS] Brain 3D model loaded successfully');
    }, undefined, (err) => {
      console.warn('[JARVIS] Failed to load brain.glb:', err);
      // Fallback: deformed sphere
      const fallbackGeo = new THREE.SphereGeometry(1.5, 48, 32);
      self.brainHolo = new THREE.Mesh(fallbackGeo, self.holoMaterial);
      self.brainGroup.add(self.brainHolo);
      self.brainWire = new THREE.Mesh(fallbackGeo.clone(), self.wireMaterial);
      self.brainGroup.add(self.brainWire);
    });
    }
    tryLoadBrain();

    // Glow shells removidos — cerebro limpo sem esferas ao redor
    this.brainGlow = null;
    this.brainGlow2 = null;

    // ── NEURAL TREE — Full width root system below brain ──
    this.treeGroup = new THREE.Group();
    this.scene.add(this.treeGroup);

    const branchMat = new THREE.LineBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.4 });
    const secMat = new THREE.LineBasicMaterial({ color: 0x00aacc, transparent: true, opacity: 0.25 });
    const leafMat = new THREE.LineBasicMaterial({ color: 0x007799, transparent: true, opacity: 0.15 });
    const rootMat = new THREE.LineBasicMaterial({ color: 0x005566, transparent: true, opacity: 0.1 });
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.6 });
    const nodeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const goldNodeMat = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.5 });
    this._treeNodes = [];

    // Helper: add circuit-board style branch (L-shaped lines) + octahedron node
    const octGeo = new THREE.OctahedronGeometry(0.06, 0);
    const addBranch = (from, to, mat, nodeM, nodeScale) => {
      // Circuit board style: go down first, then horizontal (L-shape)
      const midY = from.y + (to.y - from.y) * (0.3 + Math.random() * 0.4);
      const cornerPt = new THREE.Vector3(from.x, midY, from.z);
      const cornerPt2 = new THREE.Vector3(to.x, midY, to.z);

      // Vertical segment (down from parent)
      this.treeGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([from, cornerPt]),
        mat
      ));
      // Horizontal segment (to the side)
      this.treeGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([cornerPt, cornerPt2]),
        mat
      ));
      // Vertical segment (down to target)
      this.treeGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([cornerPt2, to]),
        mat
      ));

      // Corner dots (circuit junction points)
      const dotGeo = new THREE.SphereGeometry(0.025, 4, 4);
      const dotMat = new THREE.MeshBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.4 });
      const dot1 = new THREE.Mesh(dotGeo, dotMat);
      dot1.position.copy(cornerPt);
      this.treeGroup.add(dot1);
      const dot2 = new THREE.Mesh(dotGeo, dotMat.clone());
      dot2.position.copy(cornerPt2);
      this.treeGroup.add(dot2);

      // Octahedron node (sci-fi diamond shape)
      const n = new THREE.Mesh(octGeo, nodeM.clone());
      n.position.copy(to);
      n.scale.setScalar(nodeScale || 0.7);
      this.treeGroup.add(n);
      this._treeNodes.push(n);
      return to;
    };

    // Brain stem — connects from brain CENTER (0,0,0) down to tree
    const stemOrigin = new THREE.Vector3(0, 0, 0);  // centro do cerebro
    const stemEnd = new THREE.Vector3(0, -2.5, 0);
    // Main stem (thick, bright)
    const mainStem = new THREE.QuadraticBezierCurve3(stemOrigin, new THREE.Vector3(0, -1.2, 0), stemEnd);
    this.treeGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(mainStem.getPoints(25)),
      new THREE.LineBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.7 })
    ));
    // Spinal cord effect (5 secondary lines from brain center)
    for (let si = 0; si < 5; si++) {
      const angle = (si / 5) * Math.PI * 2;
      const ox = Math.cos(angle) * 0.12;
      const oz = Math.sin(angle) * 0.08;
      const sCurve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(ox, -0.2, oz),
        new THREE.Vector3(ox * 0.3, -1.3, oz * 0.3),
        new THREE.Vector3(0, -2.5, 0)
      );
      this.treeGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(sCurve.getPoints(18)),
        new THREE.LineBasicMaterial({ color: 0x00aacc, transparent: true, opacity: 0.25 })
      ));
    }

    // 9 primary branches — spread wide from stem base
    const primaries = [
      { x: -3.5, y: -3.5, z: 0.7 }, { x: -2.5, y: -3.8, z: -0.5 },
      { x: -1.2, y: -3.6, z: 0.4 }, { x: -0.4, y: -3.4, z: -0.3 },
      { x: 0.4, y: -3.4, z: 0.3 },
      { x: 1.2, y: -3.6, z: -0.4 }, { x: 2.5, y: -3.8, z: 0.5 },
      { x: 3.5, y: -3.5, z: -0.7 },
      { x: 0, y: -3.2, z: 0.6 }
    ];
    const primEnds = [];
    for (const p of primaries) {
      const end = addBranch(stemEnd, new THREE.Vector3(p.x, p.y, p.z), branchMat, nodeMat, 0.8);
      primEnds.push(end);
    }

    // Secondary branches (4-5 per primary)
    const secEnds = [];
    for (const pe of primEnds) {
      const count = 4 + Math.floor(Math.random() * 2);
      for (let j = 0; j < count; j++) {
        const sx = pe.x + (Math.random() - 0.5) * 1.8;
        const sy = pe.y - 0.4 - Math.random() * 0.9;
        const sz = pe.z + (Math.random() - 0.5) * 1.2;
        const end = addBranch(pe, new THREE.Vector3(
          Math.max(-5, Math.min(5, sx)), Math.max(-6.5, sy), sz
        ), secMat, j % 2 === 0 ? goldNodeMat : nodeMat, 0.5);
        secEnds.push(end);
      }
    }

    // Tertiary/leaf nodes (2-3 per secondary)
    const leafEnds = [];
    for (const se of secEnds) {
      const count = 2 + Math.floor(Math.random() * 2);
      for (let k = 0; k < count; k++) {
        const lx = se.x + (Math.random() - 0.5) * 1.4;
        const ly = se.y - 0.3 - Math.random() * 0.7;
        const lz = se.z + (Math.random() - 0.5) * 0.9;
        const end = addBranch(se, new THREE.Vector3(
          Math.max(-6, Math.min(6, lx)), Math.max(-8, ly), lz
        ), leafMat, goldNodeMat, 0.3);
        leafEnds.push(end);
      }
    }

    // Cross-connections between nearby nodes (neural web effect)
    for (let i = 0; i < 20; i++) {
      const allEnds = [...primEnds, ...secEnds.slice(0, 20)];
      const a = Math.floor(Math.random() * allEnds.length);
      const b = Math.floor(Math.random() * allEnds.length);
      if (a !== b) {
        const dist = allEnds[a].distanceTo(allEnds[b]);
        if (dist < 2.5 && dist > 0.5) {
          this.treeGroup.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([allEnds[a], allEnds[b]]),
            new THREE.LineBasicMaterial({ color: 0x006688, transparent: true, opacity: 0.08 })
          ));
        }
      }
    }

    // Bottom root tendrils (fade into void)
    for (let i = 0; i < 20; i++) {
      const rx = (Math.random() - 0.5) * 10;
      const ry = -6.5 - Math.random() * 2.5;
      const rz = (Math.random() - 0.5) * 2.5;
      const startY = -5.5 - Math.random();
      this.treeGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(rx + (Math.random()-0.5)*0.5, startY, rz),
          new THREE.Vector3(rx, ry, rz + (Math.random()-0.5)*0.3)
        ]), rootMat
      ));
    }

    // ── Floating particles (more, bigger, spread across entire tree area) ──
    this._particles = [];
    const pMat = new THREE.MeshBasicMaterial({ color: 0x00e4ff, transparent: true, opacity: 0.5 });
    for (let i = 0; i < 250; i++) {
      const size = 0.02 + Math.random() * 0.04;
      const pGeo = new THREE.SphereGeometry(size, 4, 4);
      const p = new THREE.Mesh(pGeo, pMat.clone());
      p.position.set((Math.random()-0.5)*8, 1+Math.random()*-9, (Math.random()-0.5)*3);
      p.userData = {
        speed: 0.002+Math.random()*0.01,
        phase: Math.random()*Math.PI*2,
        baseX: p.position.x,
        baseZ: p.position.z,
        drift: 0.15+Math.random()*0.5
      };
      this.scene.add(p);
      this._particles.push(p);
    }

    // ── Lightning bolts (more, brighter) ──
    this._lightningLines = [];
    for (let i = 0; i < 16; i++) {
      const pts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7 }));
      line.visible = false;
      this.scene.add(line);
      this._lightningLines.push(line);
    }

    // Scan ring removido — cerebro limpo sem anel

    // ── Electric pulse points ──
    this._pulsePoints = [];
    const pulseMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 25; i++) {
      const pp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), pulseMat.clone());
      const theta = Math.random()*Math.PI*2, phi = Math.random()*Math.PI;
      pp.position.set(Math.sin(phi)*Math.cos(theta)*2.4, Math.cos(phi)*1.7, Math.sin(phi)*Math.sin(theta)*2.0);
      pp.userData = { phase: Math.random()*Math.PI*2, speed: 1.5+Math.random()*4 };
      this.scene.add(pp);
      this._pulsePoints.push(pp);
    }
  }

  pause() {
    this._paused = true;
  }

  resume() {
    if (this._paused) {
      this._paused = false;
      this.animate();
    }
  }

  dispose() {
    this._disposed = true;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement?.remove();
    }
    if (this.scene) {
      this.scene.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
    }
  }

  animate() {
    if (this._disposed) return;
    if (this._paused) return;

    this.time += 0.016;
    this.speedMul += (this.targetSpeed - this.speedMul) * 0.03;
    const t = this.time * this.speedMul;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 1.2);

    // ── Brain rotation (rotate entire group) ──
    const rotSpeed = this.state === 'thinking' ? 0.008 : 0.002;
    if (this.brainGroup) {
      this.brainGroup.rotation.y += rotSpeed * this.speedMul;
    }

    // Brain subtle breathing
    const breathe = 1 + 0.04 * Math.sin(this.time * 1.5);
    if (this.brainGroup) {
      this.brainGroup.scale.setScalar(breathe);
    }

    // ── Update holographic shader uniforms ──
    if (this.holoMaterial) {
      this.holoMaterial.uniforms.uTime.value = this.time;
      this.holoMaterial.uniforms.uPulse.value = 0.7 + 0.3 * pulse;
      this.holoMaterial.uniforms.uScanY.value = (Math.sin(this.time * 0.8) + 1) * 0.5;

      // Color shift by state
      if (this.state === 'speaking') {
        this.holoMaterial.uniforms.uColor.value.setHex(0x00ffaa);
        this.holoMaterial.uniforms.uOpacity.value = 1.0;
      } else if (this.state === 'thinking') {
        this.holoMaterial.uniforms.uColor.value.setHex(0x44aaff);
        this.holoMaterial.uniforms.uOpacity.value = 1.0;
      } else if (this.state === 'listening') {
        this.holoMaterial.uniforms.uColor.value.setHex(0x00ffcc);
        this.holoMaterial.uniforms.uOpacity.value = 0.9;
      } else {
        this.holoMaterial.uniforms.uColor.value.setHex(0x00e4ff);
        this.holoMaterial.uniforms.uOpacity.value = 0.8;
      }
    }

    // ── Wireframe opacity by state ──
    if (this.brainWire && this.wireMaterial) {
      if (this.state === 'speaking') {
        this.wireMaterial.opacity = 0.18 + 0.08 * pulse;
        this.wireMaterial.color.setHex(0x00ffaa);
      } else if (this.state === 'thinking') {
        this.wireMaterial.opacity = 0.15 + 0.1 * pulse;
        this.wireMaterial.color.setHex(0x44aaff);
      } else if (this.state === 'listening') {
        this.wireMaterial.opacity = 0.1 + 0.05 * pulse;
        this.wireMaterial.color.setHex(0x00ffcc);
      } else {
        this.wireMaterial.opacity = 0.1 + 0.04 * pulse;
        this.wireMaterial.color.setHex(0x00e4ff);
      }
    }

    // Glow + scan ring removidos

    // ── Lightning bolts (random arcs between brain surface points) ──
    for (let i = 0; i < this._lightningLines.length; i++) {
      const line = this._lightningLines[i];
      if (Math.random() < (this.state === 'thinking' ? 0.15 : 0.03)) {
        // Create new lightning
        const t1 = Math.random() * Math.PI * 2, p1 = Math.random() * Math.PI;
        const t2 = t1 + (Math.random() - 0.5) * 2, p2 = p1 + (Math.random() - 0.5) * 1;
        const r = 1.55;
        const start = new THREE.Vector3(Math.sin(p1)*Math.cos(t1)*r, Math.cos(p1)*0.75*r, Math.sin(p1)*Math.sin(t1)*0.85*r);
        const end = new THREE.Vector3(Math.sin(p2)*Math.cos(t2)*r, Math.cos(p2)*0.75*r, Math.sin(p2)*Math.sin(t2)*0.85*r);
        const mid = start.clone().add(end).multiplyScalar(0.5).add(new THREE.Vector3((Math.random()-0.5)*0.3, (Math.random()-0.5)*0.2, (Math.random()-0.5)*0.3));
        const pts = [start, mid, end];
        line.geometry.setFromPoints(pts);
        line.material.opacity = 0.5 + Math.random() * 0.5;
        line.material.color.setHex(Math.random() > 0.5 ? 0x88ddff : 0xffffff);
        line.visible = true;
        setTimeout(() => { line.visible = false; }, 80 + Math.random() * 120);
      }
    }

    // ── Electric pulses on brain surface ──
    if (this._pulsePoints) {
      for (const pp of this._pulsePoints) {
        const intensity = 0.5 + 0.5 * Math.sin(this.time * pp.userData.speed + pp.userData.phase);
        pp.material.opacity = intensity * (this.state === 'thinking' ? 1 : 0.5);
        pp.scale.setScalar(0.5 + intensity * (this.state === 'thinking' ? 1.5 : 0.5));
      }
    }

    // ── Particles flowing upward ──
    for (const p of this._particles) {
      const ud = p.userData;
      const speed = ud.speed * this.speedMul * (this.state === 'listening' ? 2 : 1);
      p.position.y += speed * (this.state === 'speaking' ? -1 : 1);

      // Drift sideways
      p.position.x = ud.baseX + Math.sin(this.time * 0.5 + ud.phase) * ud.drift;
      p.position.z = ud.baseZ + Math.cos(this.time * 0.3 + ud.phase) * ud.drift * 0.5;

      // Wrap around
      if (p.position.y > 2) { p.position.y = -8; }
      if (p.position.y < -9) { p.position.y = 2; }

      // Fade based on distance from brain
      const distY = Math.abs(p.position.y);
      p.material.opacity = Math.max(0.05, 0.6 - distY * 0.15) * (0.5 + 0.5 * Math.sin(this.time * 2 + ud.phase));
    }

    // ── Tree nodes pulse ──
    for (let i = 0; i < this._treeNodes.length; i++) {
      const n = this._treeNodes[i];
      const nodePulse = 0.7 + 0.3 * Math.sin(this.time * 1.5 + i * 0.5);
      n.material.opacity = nodePulse * (this.state === 'thinking' ? 1 : 0.6);

      if (this.state === 'thinking') {
        const cascade = 0.5 + 0.5 * Math.sin(this.time * 4 - i * 0.3);
        n.scale.setScalar(0.5 + cascade * 0.8);
      } else {
        n.scale.setScalar(0.5 + nodePulse * 0.3);
      }
    }

    // ── Glitch effect (occasional) ──
    if (this.brainGroup && Math.random() < 0.01) {
      this.brainGroup.position.x = (Math.random() - 0.5) * 0.05;
      const bg = this.brainGroup;
      setTimeout(() => { bg.position.x = 0; }, 50);
    }

    // ── Camera subtle sway ──
    this.camera.position.x = Math.sin(this.time * 0.12) * 0.2;
    this.camera.position.y = Math.sin(this.time * 0.08) * 0.15;
    this.camera.lookAt(0, -1.5, 0);

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  }
}

// Initialize Neural Tree (after layout settles)
let particleOrb = null;
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
      const r1 = 232;
      const r2 = i % 8 === 0 ? 248 : (i % 4 === 0 ? 242 : 238);
      const x1 = Math.cos(a) * r1;
      const y1 = Math.sin(a) * r1;
      const x2 = Math.cos(a) * r2;
      const y2 = Math.sin(a) * r2;
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" opacity="${i % 8 === 0 ? '1' : '.45'}"/>`;
    }
    g.innerHTML = s;
  };

  const buildLabelRing = () => {
    const g = document.getElementById('jarvis-core3d-label-ring');
    if (!g) return;
    let s = '';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 360;
      const lbl = String(i * 30).padStart(3, '0');
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
      const w = idx < 5 ? 22 : 12;
      const r = 188;
      const a1 = (deg - w / 2) * Math.PI / 180;
      const a2 = (deg + w / 2) * Math.PI / 180;
      const x1 = Math.cos(a1) * r;
      const y1 = Math.sin(a1) * r;
      const x2 = Math.cos(a2) * r;
      const y2 = Math.sin(a2) * r;
      const t1x = Math.cos(a1) * (r - 10);
      const t1y = Math.sin(a1) * (r - 10);
      const t2x = Math.cos(a2) * (r - 10);
      const t2y = Math.sin(a2) * (r - 10);
      s += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="#5fdfff" stroke-width="6" opacity=".9"/>`;
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${t1x.toFixed(1)}" y2="${t1y.toFixed(1)}" stroke="#5fdfff" stroke-width="2" opacity=".75"/>`;
      s += `<line x1="${x2.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${t2x.toFixed(1)}" y2="${t2y.toFixed(1)}" stroke="#5fdfff" stroke-width="2" opacity=".75"/>`;
    });
    g.innerHTML = s;
  };

  try {
    buildOuterTicks();
    buildLabelRing();
    buildBracketRing();
    host.classList.add('is-core3d-ready');
    return true;
  } catch (err) {
    console.warn('[JARVIS] Core 3D reactor fallback:', err.message);
    host.classList.remove('is-core3d-ready');
    return false;
  }
}

requestAnimationFrame(() => {
  const canvas = document.getElementById('particle-orb');
  const coreReady = initJarvisCore3D();
  if (canvas && !coreReady) {
    particleOrb = new NeuralTree(canvas);
    window.particleOrb = particleOrb;
  }
});

// Pause 3D animation when tab is not visible (saves GPU)
document.addEventListener('visibilitychange', () => {
  if (!particleOrb) return;
  if (document.hidden) {
    particleOrb.pause();
  } else {
    particleOrb.resume();
  }
});

// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let voiceEnabled = true;
let ttsVoice = localStorage.getItem('ttsVoice') || 'ash';
let isRealtimeActive = false;
let isJarvisSpeaking = false;
let isVoiceRequestInFlight = false;
let currentTtsAudio = null;
let lastVoiceCommandAt = 0;
const VOICE_COMMAND_COOLDOWN_MS = 1000;

let wakeWordEnabled = false;
let wakeWordRecognition = null;
let ttsQueue = [];
let ttsPlaying = false;
let userGestureReceived = false;
let webSpeechRec = null;
const canWebSpeech = window.JarvisVoiceSTT.canUseWebSpeech();

// ========== CONCLAVE TOGGLE ==========
let conclaveEnabled = localStorage.getItem('jarvis-conclave') !== 'false';

function syncConclaveVisual() {
  const cb = document.getElementById('conclave-checkbox');
  const chip = cb?.closest('.mega-chip');
  if (!cb) return;

  cb.checked = conclaveEnabled;
  if (conclaveEnabled) chip?.classList.remove('conclave-off');
  else chip?.classList.add('conclave-off');
}

function setConclaveEnabled(enabled) {
  conclaveEnabled = !!enabled;
  localStorage.setItem('jarvis-conclave', conclaveEnabled);
  syncConclaveVisual();
  return conclaveEnabled;
}

// ========== LANGUAGE STATE ==========
let currentLang = localStorage.getItem('jarvis-lang') || 'BR';

function initLangToggle() {
  const enBtn = document.getElementById('lang-en');
  const brBtn = document.getElementById('lang-br');
  const esBtn = document.getElementById('lang-es');
  if (!enBtn || !brBtn) return;

  function applyLang(lang) {
    currentLang = lang;
    localStorage.setItem('jarvis-lang', lang);
    enBtn.classList.toggle('active', lang === 'EN');
    brBtn.classList.toggle('active', lang === 'BR');
    if (esBtn) esBtn.classList.toggle('active', lang === 'ES');
    const placeholders = {
      BR: 'Fale com o JARVIS...',
      ES: 'Habla con JARVIS...',
      EN: 'Talk to JARVIS...'
    };
    document.getElementById('chat-input').placeholder = placeholders[lang] || placeholders.EN;
    const bootMsg = document.getElementById('boot-msg');
    if (bootMsg) {
      const boots = {
        BR: '[system] JARVIS COCKPIT INICIALIZADO. TODO SISTEMA DE INTELIGÊNCIA CARREGADO COM SUCESSO E PRONTO PARA USO.',
        ES: '[system] JARVIS COCKPIT INICIADO. TODO EL SISTEMA DE INTELIGENCIA CARGADO CON ÉXITO Y LISTO PARA USAR.',
        EN: '[system] JARVIS COCKPIT ONLINE. ALL SYSTEMS LOADED AND READY.'
      };
      bootMsg.textContent = boots[lang] || boots.EN;
    }
    // Update tab labels based on language
    const langKey = `data-lang-${lang.toLowerCase()}`;
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      const label = btn.getAttribute(langKey);
      if (label) btn.textContent = label;
    });

    // If Realtime is active, reconnect to pick up new language instructions
    if (realtimeActive) { stopRealtime(); setTimeout(() => startRealtime(), 300); }
  }

  applyLang(currentLang);

  enBtn.addEventListener('click', () => { if (currentLang !== 'EN') applyLang('EN'); });
  brBtn.addEventListener('click', () => { if (currentLang !== 'BR') applyLang('BR'); });
  if (esBtn) esBtn.addEventListener('click', () => { if (currentLang !== 'ES') applyLang('ES'); });
}

// ========== AUDIO CONTEXT (SOUND FEEDBACK) ==========
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration = 80, vol = 0.1) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {}
}

function playSendSound() { playTone(880, 60); setTimeout(() => playTone(1100, 60), 70); }
function playReceiveSound() { playTone(660, 80); }
function playErrorSound() { playTone(440, 100); setTimeout(() => playTone(330, 150), 120); }

// ========== TERMINAL RENDERING ==========
// Terminal render helpers moved to public/js/terminal-chat.js.

let pendingAckTTS = null; // Track ACK that needs TTS

// ========== MODEL CARD HIGHLIGHTING ==========
function setActiveModel(model) {
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
  const id = model === 'opus' ? 'model-opus' : model === 'sonnet' ? 'model-sonnet' : 'model-haiku';
  document.getElementById(id)?.classList.add('active-model');
}

// ========== AGENT CHIP HIGHLIGHTING ==========
function highlightAgents(text) {
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active-agent'));
  const agentMap = {
    'dev': 'dev', 'architect': 'architect', 'qa': 'qa', 'pm': 'pm',
    'po': 'po', 'devops': 'devops', 'analyst': 'analyst', 'ux': 'ux',
    'sm': 'sm', 'data-eng': 'data-eng', 'data-engineer': 'data-eng',
    'aios-master': 'aios-master', 'orion': 'aios-master',
    'conclave': 'conclave', 'crítico': 'conclave', 'advogado': 'conclave', 'sintetizador': 'conclave',
  };
  const lower = text.toLowerCase();
  for (const [keyword, dataAgent] of Object.entries(agentMap)) {
    if (lower.includes(`@${keyword}`) || lower.includes(keyword)) {
      document.querySelector(`.agent-chip[data-agent="${dataAgent}"]`)?.classList.add('active-agent');
    }
  }
}

// Show which model is active based on agent chip selection
function setModelFromAgent(agentEl) {
  if (!agentEl) return;
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
  if (agentEl.classList.contains('model-opus'))   document.getElementById('model-opus')?.classList.add('active-model');
  if (agentEl.classList.contains('model-sonnet')) document.getElementById('model-sonnet')?.classList.add('active-model');
  if (agentEl.classList.contains('model-haiku'))  document.getElementById('model-haiku')?.classList.add('active-model');
}

window.JarvisTerminalChat.configureStreamHandlers({
  replaceLastUserLine(text) {
    const userLines = terminal.querySelectorAll('.user-line');
    if (userLines.length > 0) {
      const last = userLines[userLines.length - 1];
      last.querySelector('.msg').textContent = text;
    }
  },
  addTerminalLine,
  addDownloadCard,
  handleAck(ackText) {
    if (voiceEnabled && userGestureReceived && !(realtimeActive || isRealtimeActive)) {
      pendingAckTTS = speakResponse(ackText);
    }
  }
});
// ========== CHAT - SEND MESSAGE ==========
async function sendMessage(text, fromVoice = false) {
  const currentAttachment = window.JarvisAttachments?.get();
  const hasImageAttachment = window.JarvisAttachments?.isImage(currentAttachment);
  const hasScreenCapture = window.JarvisScreenCapture?.hasCapture();
  if (!text.trim() && !hasScreenCapture && !hasImageAttachment) return;

  if (fromVoice) {
    if (isRealtimeActive || realtimeActive) {
      console.log('[VOICE] Fluxo legado bloqueado porque Realtime está ativo');
      return;
    }
    if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
      console.log('[VOICE] Ignorado: Jarvis estava falando');
      return;
    }
    if (isVoiceRequestInFlight) {
      console.log('[VOICE] Ignorado: requisição de voz já em andamento');
      return;
    }
    isVoiceRequestInFlight = true;
    lastVoiceCommandAt = Date.now();
  }

  userGestureReceived = true;
  pendingAckTTS = null;
  const displayText = text.trim() || (currentLang === 'BR' ? '[análise de tela]' : '[screen analysis]');
  addTerminalLine(`> ${displayText}`, 'user-line');
  chatInput.value = '';
  playSendSound();
  setAvatarState('thinking');

  // Imagem anexada tem prioridade absoluta sobre data/hora e captura de tela.
  if (hasImageAttachment && !text.trim()) text = 'Analise a imagem anexada.';

  const localDateTimeAnswer = getLocalDateTimeAnswer(text);
  if (!hasImageAttachment && localDateTimeAnswer) {
    addTerminalLine(localDateTimeAnswer, 'jarvis-line');
    playReceiveSound();
    if (voiceEnabled && userGestureReceived) speakResponse(localDateTimeAnswer);
    setAvatarState('idle');
    scheduleNextListen(1200);
    if (fromVoice) isVoiceRequestInFlight = false;
    return;
  }

  // If screen is captured + Q&A → GPT-4o-mini vision (fast, real-time)
  // If screen is captured + build task → fall through to normal chat (Claude gets context via /api/chat)
  const isBuildTask = window.JarvisTerminalChat.isBuildTaskRequest(text);
  if (hasScreenCapture && !hasImageAttachment && !isBuildTask) {
    const screenResponse = await window.JarvisScreenCapture?.analyze(text.trim());
    if (screenResponse) {
      addTerminalLine(screenResponse, 'jarvis-line');
      playReceiveSound();
      highlightAgents(screenResponse);
      if (voiceEnabled && userGestureReceived) {
        const brief = window.JarvisTerminalChat.prepareSpeechBrief(screenResponse);
        if (brief) await speakResponse(brief);
      }
      setAvatarState('idle');
      scheduleNextListen(1200); // continuous voice mode restart after vision
      if (fromVoice) isVoiceRequestInFlight = false;
      return;
    }
    setAvatarState('idle');
    scheduleNextListen(1500);
    if (fromVoice) isVoiceRequestInFlight = false;
    return;
  }

  if (!text.trim()) {
    if (fromVoice) isVoiceRequestInFlight = false;
    return;
  }

  if (fromVoice) {
    const routed = await routeVoiceCommand(text, { speak: true, announceRealtime: false });
    if (routed?.handled) {
      isVoiceRequestInFlight = false;
      return;
    }
  }

  // Highlight active model based on complexity
  const { opusMatch, sonnetMatch, model: activeModel } = window.JarvisTerminalChat.classifyModelRequest(text);
  const isVoiceTask = fromVoice && (opusMatch || sonnetMatch);
  setActiveModel(activeModel);

  // ACK is now handled by GPT-mini response (Phase 1 of /api/chat)
  let ackPromise = null;

  try {
    const body = window.JarvisTerminalChat.buildChatRequestBody({
      text,
      fromVoice,
      language: currentLang,
      conclaveEnabled,
      attachment: currentAttachment
    });
    if (currentAttachment) {
      window.JarvisAttachments?.clear();
    }

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let claudeSilent = false;   // true after [build-start] — Claude output is terminal-only
    let gptResponse = '';       // GPT-mini portion (before [build-start]) — this gets spoken
    let streamTtsBuffer = '';
    let streamTtsFired = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      fullResponse += chunk;

      // Extract GPT portion (before [build-start]) for TTS — before mutating claudeSilent
      const ackPortion = chunk.split('[build-start]')[0];
      const hadBuildStart = chunk.includes('[build-start]');

      const splitBuffer = window.JarvisTerminalChat.splitStreamBuffer(buffer);
      const lines = splitBuffer.lines;
      buffer = splitBuffer.remainder;

      for (const line of lines) {
        if (window.JarvisTerminalChat.isBuildStartLine(line)) { claudeSilent = true; continue; }
        processStreamLine(line);
        if (!claudeSilent) gptResponse += line + '\n';
      }

      // Streaming TTS: fire on ACK portion regardless of claudeSilent state
      if (!streamTtsFired && voiceEnabled && userGestureReceived && ackPortion.trim()) {
        const cleanAck = ackPortion.split('\n')
          .filter(l => !l.match(/^\[(system|file|error|warn|info|ack|build-start|translated)\]/))
          .join(' ').trim();
        if (cleanAck) {
          streamTtsBuffer += cleanAck + ' ';
          // Fire TTS as soon as possible: first clause ending with .!?,: OR 18+ chars accumulated
          const sentMatch = streamTtsBuffer.match(/^(.{6,}?[.!?,:])\s/);
          const bufTrim = streamTtsBuffer.trim();
          if (sentMatch || (hadBuildStart && bufTrim.length > 6) || bufTrim.length >= 18) {
            streamTtsFired = true;
            speakResponse((sentMatch ? sentMatch[1] : bufTrim).trim());
          }
        }
      }
    }

    if (window.JarvisTerminalChat.shouldProcessFinalBuffer(buffer)) {
      const handled = processStreamLine(buffer);
      if (!handled && !claudeSilent) gptResponse += buffer + '\n';
    }

    // GPT-mini response → render + speak (if not already fired by streaming)
    const cleanGpt = window.JarvisTerminalChat.stripStreamMetaLines(gptResponse);


    // Claude output (after [build-start]) → render to terminal, NO TTS
    const claudeOutput = fullResponse.split('[build-start]')[1] || '';
    const cleanClaude = window.JarvisTerminalChat.stripStreamMetaLines(claudeOutput);


    if (cleanGpt) {
      addTerminalLine(cleanGpt, 'jarvis-line');
      playReceiveSound();
      highlightAgents(cleanGpt);
      // Speak GPT-mini response if streaming TTS didn't already fire
      if (voiceEnabled && userGestureReceived && !streamTtsFired) {
        const brief = window.JarvisTerminalChat.prepareSpeechBrief(cleanGpt, { minSentenceLength: 5 });
        if (brief) await speakResponse(brief);
      }
    }

    if (cleanClaude) {
      addTerminalLine(cleanClaude, 'jarvis-line');
      if (!cleanGpt) { playReceiveSound(); highlightAgents(cleanClaude); }
      // NO TTS — completion will come via push notification (GPT-mini SSE)
    }

    if (true) { // keep block structure
    }

    setAvatarState('idle');
    scheduleNextListen(1500); // continuous mode restart
  } catch (err) {
    addTerminalLine(`[error] ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
    scheduleNextListen(2000);
  } finally {
    if (fromVoice) isVoiceRequestInFlight = false;
  }
}

window.sendMessage = sendMessage;
window.JarvisTerminalChat?.bindSendHandlers(sendMessage);

// ========== AVATAR STATES ==========
function setAvatarState(state) {
  if (avatarContainer) {
    avatarContainer.classList.remove('listening', 'thinking', 'speaking');
    if (state === 'listening' || state === 'thinking' || state === 'speaking') {
      avatarContainer.classList.add(state);
    }
  }
  switch (state) {
    case 'listening': setVoiceStatus('listening'); if (avatarStatus) avatarStatus.textContent = 'LISTENING'; break;
    case 'thinking':  setVoiceStatus('thinking'); if (avatarStatus) avatarStatus.textContent = 'THINKING'; break;
    case 'speaking':  setVoiceStatus('speaking'); if (avatarStatus) avatarStatus.textContent = 'SPEAKING'; break;
    default:          setVoiceStatus('auto'); if (avatarStatus) avatarStatus.textContent = '';
  }
  // Update particle orb
  if (particleOrb) particleOrb.setState(state);
}

// ========== VOICE CAPTURE (MEDIARECORDER + WHISPER) ==========
let recordingStartTime = 0;
let audioAnalyser = null;
let peakVolume = 0;
let vadTimer = null;         // silence auto-stop timer
let continuousMode = false;  // hands-free loop
let continuousTimer = null;

const VAD_SILENCE_MS = 1100; // fastest: stop after 1.1s of silence

// Continuous mode toggle button (injected into input bar)
function initContinuousBtn() {
  const btn = document.createElement('button');
  btn.id = 'continuous-btn';
  btn.className = 'screen-btn';
  btn.title = 'Continuous voice mode';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a4 4 0 0 0-4 4v7a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <circle cx="12" cy="22" r="1.5" fill="currentColor"/>
  </svg>`;
  btn.addEventListener('click', async () => {
    if (realtimeConnecting) {
      addTerminalLine(
        currentLang === 'BR' ? '[status] Conectando, aguarde...' : '[status] Connecting, please wait...',
        'info-line'
      );
      // Wait for current connection attempt to finish, then report final status
      while (realtimeConnecting) await new Promise(r => setTimeout(r, 200));
      btn.style.color = realtimeActive ? 'var(--cyan)' : '';
      btn.style.background = realtimeActive ? 'rgba(0,212,255,0.1)' : '';
      addTerminalLine(
        realtimeActive
          ? (currentLang === 'BR' ? '[status] Modo contínuo: ATIVADO' : '[status] Continuous mode: ON')
          : (currentLang === 'BR' ? '[status] Modo contínuo: DESATIVADO' : '[status] Continuous mode: OFF'),
        'info-line'
      );
      return;
    }
    await startRealtime();
    btn.style.color = realtimeActive ? 'var(--cyan)' : '';
    btn.style.background = realtimeActive ? 'rgba(0,212,255,0.1)' : '';
    addTerminalLine(
      realtimeActive
        ? (currentLang === 'BR' ? '[status] Modo contínuo: ATIVADO' : '[status] Continuous mode: ON')
        : (currentLang === 'BR' ? '[status] Modo contínuo: DESATIVADO' : '[status] Continuous mode: OFF'),
      'info-line'
    );
  });
  const sendBtn = document.getElementById('send-btn');
  sendBtn.parentNode.insertBefore(btn, sendBtn);
}

// ========== REALTIME VOICE MODE (OpenAI WebRTC — ~300ms latency) ==========
let realtimePC = null;
let realtimeStream = null;
let realtimeAudio = null;
let realtimeDC = null;
let realtimeActive = false;
let realtimeConnecting = false;
let realtimeUserDisabled = false;

window.JarvisVoiceUI?.configure({
  getRestStatus() {
    if (!voiceEnabled) return 'mute';
    if (isRecording || isRealtimeActive || realtimeActive) return 'listening';
    return 'mute';
  }
});

async function startRealtime() {
  if (realtimeActive) { realtimeUserDisabled = true; return stopRealtime(); }
  if (realtimeConnecting) return; // guard against parallel connects
  realtimeConnecting = true;
  realtimeUserDisabled = false;
  setVoiceStatus('listening');
  try {
    userGestureReceived = true;
    const tokenRes = await fetch('/api/realtime/session', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      // Realtime API only supports: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
      // TTS voices like onyx, nova, fable are NOT supported — always map to a valid Realtime voice
      body: JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeSessionRequest(
        currentLang,
        window.JarvisVoiceTTS.getRealtimeVoice(ttsVoice)
      ))
    });
    const sess = await tokenRes.json();
    const realtimeSession = window.JarvisVoiceRealtime.parseRealtimeSessionResponse(sess);
    if (!realtimeSession.ok) throw new Error(realtimeSession.error || 'No ephemeral token');

    const pc = new RTCPeerConnection();
    realtimePC = pc;

    // Remote audio sink
    realtimeAudio = new Audio();
    realtimeAudio.autoplay = true;
    pc.ontrack = (e) => { realtimeAudio.srcObject = e.streams[0]; setAvatarState('speaking'); };

    // Mic input
    realtimeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    realtimeStream.getTracks().forEach(t => pc.addTrack(t, realtimeStream));

    // Data channel for events
    const dc = pc.createDataChannel('oai-events');
    realtimeDC = dc;
    dc.addEventListener('message', (e) => {
      try {
        const ev = window.JarvisVoiceRealtime.parseRealtimeEvent(e.data);
        if (!ev) return;
        const evType = window.JarvisVoiceRealtime.getRealtimeEventType(ev);
        if (evType === 'input_audio_buffer.speech_started') setAvatarState('listening');
        if (evType === 'input_audio_buffer.speech_stopped' || evType === 'input_audio_buffer.committed') setVoiceStatus('thinking');
        if (evType.startsWith('response.audio.') && evType !== 'response.audio.done') {
          isJarvisSpeaking = true;
          setAvatarState('speaking');
        }
        if (evType === 'response.audio.done') {
          isJarvisSpeaking = false;
          lastVoiceCommandAt = Date.now();
          setAvatarState('idle');
        }
        if (evType === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
          setVoiceStatus('thinking');
          // Translate user transcript to match the active language toggle
          (async () => {
            try {
              const r = await fetch('/api/translate', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ text: ev.transcript, targetLang: currentLang })
              });
              const d = await r.json();
              addTerminalLine('> ' + (d.translated || ev.transcript), 'user-line');
            } catch {
              addTerminalLine('> ' + ev.transcript, 'user-line');
            }
          })();
          // PATCH 10 v8.0: fallback de 2s se GPT-realtime nao chamar execute_task
          window._pendingTranscript = ev.transcript;
          window._dispatchedThisTurn = false; // novo turno
          clearTimeout(window._pendingTranscriptTimer);
          window._pendingTranscriptTimer = setTimeout(() => {
            if (window._dispatchedThisTurn) return; // GPT-realtime cuidou
            const t = window._pendingTranscript;
            if (!t) return;
            window._pendingTranscript = null;
            window._dispatchedThisTurn = true;
            handleRealtimeTask(null, JSON.stringify({ request: t }));
          }, 2000);
        }
        if (evType === 'response.audio_transcript.done' && ev.transcript) {
          addTerminalLine(ev.transcript, 'jarvis-line');
        }
        // Handle function call: GPT-realtime asks us to dispatch to Claude
        if (evType === 'response.function_call_arguments.done' && ev.name === 'execute_task') {
          // PATCH 10 v8.0: dedup — cancelar fallback timer e bloquear se ja despachou
          window._pendingTranscript = null;
          clearTimeout(window._pendingTranscriptTimer);
          if (window._dispatchedThisTurn) return; // dedup: fallback ja disparou
          window._dispatchedThisTurn = true;
          handleRealtimeTask(ev.call_id, ev.arguments);
        }
      } catch {}
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      method: 'POST',
      body: offer.sdp,
      headers: { 'Authorization': `Bearer ${realtimeSession.clientSecret}`, 'Content-Type': 'application/sdp' }
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    realtimeActive = true;
    isRealtimeActive = true;
    realtimeConnecting = false;
    // Stop wake word listener (Realtime owns the mic now)
    try { if (wakeWordRecognition) { wakeWordRecognition.onend = null; wakeWordRecognition.stop(); } } catch {}
    const btn = document.getElementById('realtime-btn');
    if (btn) { btn.style.color = 'var(--cyan)'; btn.style.background = 'rgba(0,212,255,0.15)'; }
    const cbtn = document.getElementById('continuous-btn');
    if (cbtn) { cbtn.style.color = 'var(--cyan)'; cbtn.style.background = 'rgba(0,212,255,0.1)'; }
    micBtn.classList.add('recording');
    setVoiceStatus('listening');
  } catch (err) {
    addTerminalLine('[error] Realtime: ' + err.message, 'error-line');
    realtimeConnecting = false;
    stopRealtime();
  }
}

function stopRealtime() {
  realtimeActive = false;
  isRealtimeActive = false;
  isJarvisSpeaking = false;
  realtimeConnecting = false;
  try { realtimeDC?.close(); } catch {}
  try { realtimePC?.close(); } catch {}
  try { realtimeStream?.getTracks().forEach(t => t.stop()); } catch {}
  if (realtimeAudio) { realtimeAudio.srcObject = null; realtimeAudio = null; }
  realtimePC = null; realtimeStream = null; realtimeDC = null;
  const btn = document.getElementById('realtime-btn');
  if (btn) { btn.style.color = ''; btn.style.background = ''; }
  const cbtn = document.getElementById('continuous-btn');
  if (cbtn) { cbtn.style.color = ''; cbtn.style.background = ''; }
  micBtn.classList.remove('recording');
  setAvatarState('idle');
  // Resume wake word listening so "jarvis" can reactivate later
  if (wakeWordEnabled) { try { startWakeWord(); } catch {} }
}

async function routeVoiceCommand(text, { speak = true, announceRealtime = false } = {}) {
  try {
    setVoiceStatus('thinking');
    const res = await fetch('/api/voice-command-router', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, language: currentLang })
    });
    const data = await res.json();
    if (!data.handled) return data;

    if (data.output && !processStreamLine(data.output)) {
      addTerminalLine(data.output, 'system-line');
    }
    if (data.summary) {
      addTerminalLine(`[info] ${data.summary}`, 'info-line');
      if (announceRealtime) announceToRealtime(data.summary);
      else if (speak && voiceEnabled && userGestureReceived) await speakResponse(data.summary);
    }
    setAvatarState('idle');
    scheduleNextListen(1000);
    return data;
  } catch (err) {
    console.warn('[JARVIS] Voice router failed:', err.message);
    return { handled: false, error: err.message };
  }
}

// Dispatch Realtime function call to Claude via existing /api/chat, then feed result back
async function handleRealtimeTask(callId, argsJson) {
  const { request } = window.JarvisVoiceRealtime.parseRealtimeTaskPayload(argsJson);
  if (!request) return;

  if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
    console.log('[VOICE] Ignorado: Jarvis estava falando');
    return;
  }
  if (isVoiceRequestInFlight) {
    console.log('[VOICE] Ignorado: requisição de voz já em andamento');
    return;
  }

  isVoiceRequestInFlight = true;
  lastVoiceCommandAt = Date.now();
  setVoiceStatus('thinking');

  try {
    const routed = await routeVoiceCommand(request, { speak: !realtimeActive, announceRealtime: realtimeActive });
    if (routed?.handled) {
      if (callId && window.JarvisVoiceRealtime.isRealtimeDataChannelOpen(realtimeDC)) {
        realtimeDC.send(JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeFunctionOutputEvent(
          callId,
          { status: 'handled', route: routed.route, message: routed.summary }
        )));
      }
      return;
    }

    if (callId && window.JarvisVoiceRealtime.isRealtimeDataChannelOpen(realtimeDC)) {
      realtimeDC.send(JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeFunctionOutputEvent(
        callId,
        { status: 'dispatched', message: 'Task is executing in background' }
      )));
      realtimeDC.send(JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeResponseCreateEvent()));
    }

    // Fire Claude in background via /api/chat (non-blocking)
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeChatRequestBody(request, currentLang, conclaveEnabled))
    });
    // Stream & render to terminal; completion announcement comes via SSE notification channel
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line && !line.startsWith('[build-start]')) processStreamLine(line);
      }
    }
  } catch (err) {
    addTerminalLine('[error] Claude dispatch: ' + err.message, 'error-line');
  } finally {
    isVoiceRequestInFlight = false;
  }
}

// When Claude finishes (SSE push), inject completion announcement into Realtime session.
// The message is ALREADY the final sentence to speak — just tell the model to say it verbatim.
// Falls back to TTS if Realtime data channel is dead.
function announceToRealtime(message) {
  // If Realtime DC is alive, inject the message for GPT to speak
  if (realtimeActive && window.JarvisVoiceRealtime.isRealtimeDataChannelOpen(realtimeDC)) {
    try {
      realtimeDC.send(JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeAnnouncementEvent(message, currentLang)));
      realtimeDC.send(JSON.stringify(window.JarvisVoiceRealtime.buildRealtimeResponseCreateEvent()));
      return;
    } catch (e) {
      console.warn('[JARVIS] Realtime DC send failed, falling back to TTS:', e.message);
    }
  }
  // Fallback: Realtime is supposed to be active but DC is dead — use TTS directly
  if (userGestureReceived) {
    speakResponse(message);
  }
}

window.JarvisVoiceRealtime.configureRealtimeHandlers({
  getState() {
    return {
      realtimeActive,
      isRealtimeActive,
      realtimeConnecting,
      realtimeUserDisabled,
      hasPeerConnection: !!realtimePC,
      hasStream: !!realtimeStream,
      hasAudio: !!realtimeAudio,
      dataChannelReadyState: realtimeDC?.readyState || '',
      dataChannelOpen: window.JarvisVoiceRealtime.isRealtimeDataChannelOpen(realtimeDC)
    };
  },
  startRealtime,
  stopRealtime,
  routeVoiceCommand,
  handleRealtimeTask,
  announceToRealtime,
  addTerminalLine,
  setVoiceStatus,
  setAvatarState
});

function initRealtimeBtn() {
  // Push-to-talk: Realtime only starts when user explicitly clicks mic button.
  // No auto-start, no auto-reconnect. User is in full control.
  // Wake word ("Jarvis") can also activate if enabled in settings.
}

async function startRecording() {
  try {
    if (isRealtimeActive || realtimeActive) {
      console.log('[VOICE] Fluxo legado bloqueado porque Realtime está ativo');
      return;
    }
    if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
      console.log('[VOICE] Ignorado: Jarvis estava falando');
      return;
    }
    if (isVoiceRequestInFlight) {
      console.log('[VOICE] Ignorado: requisição de voz já em andamento');
      return;
    }

    userGestureReceived = true;

    // Fast path: Web Speech API — zero latency, no server round-trip
    if (canWebSpeech) {
      const SpeechRec = window.JarvisVoiceSTT.getSpeechRecognitionCtor();
      webSpeechRec = new SpeechRec();
      // Language follows the BR/EN toggle
      webSpeechRec.lang = ({ BR: 'pt-BR', ES: 'es-ES', EN: 'en-US' }[currentLang]) || 'en-US';
      webSpeechRec.interimResults = true;
      webSpeechRec.maxAlternatives = 1;
      webSpeechRec.continuous = false;

      let finalSent = false;
      webSpeechRec.onresult = (event) => {
        let interim = '', final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) final += event.results[i][0].transcript;
          else interim += event.results[i][0].transcript;
        }
        if (interim) chatInput.value = interim;
        if (final && !finalSent) {
          finalSent = true;
          chatInput.value = final;
          stopRecording();
          sendMessage(final.trim(), true);
        }
      };

      webSpeechRec.onerror = (e) => {
        console.warn('[JARVIS] Web Speech error:', e.error, '— falling back to Whisper');
        isRecording = false;
        micBtn.classList.remove('recording');
        setAvatarState('idle');
        webSpeechRec = null;
      };

      webSpeechRec.onend = () => {
        if (!finalSent) {
          isRecording = false;
          micBtn.classList.remove('recording');
          setAvatarState('idle');
          webSpeechRec = null;
          // Continuous mode: restart after brief pause
          if (continuousMode) {
            continuousTimer = setTimeout(() => startRecording(), 800);
          }
        }
      };

      webSpeechRec.start();
      isRecording = true;
      micBtn.classList.add('recording');
      setAvatarState('listening');
      playTone(1200, 40);
      addTerminalLine('[system] Listening (real-time)...', 'system-line');
      return;
    }

    // Fallback: MediaRecorder + Whisper
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      }
    });

    // Set up audio level monitoring
    try {
      const actx = getAudioCtx();
      const source = actx.createMediaStreamSource(stream);
      audioAnalyser = actx.createAnalyser();
      audioAnalyser.fftSize = 512;
      source.connect(audioAnalyser);
      peakVolume = 0;

      const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
      const monitorVolume = () => {
        if (!isRecording) return;
        audioAnalyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > peakVolume) peakVolume = avg;

        // VAD: auto-stop on sustained silence (after user has spoken)
        const elapsed = Date.now() - recordingStartTime;
        if (elapsed > 1200 && peakVolume > 8) {
          // User spoke at least once — now detect silence
          if (avg < 3) {
            if (!vadTimer) {
              vadTimer = setTimeout(() => {
                if (isRecording) {
                  addTerminalLine('[system] Silence detected — processing...', 'system-line');
                  stopRecording();
                }
              }, VAD_SILENCE_MS);
            }
          } else {
            // Sound detected — reset silence timer
            clearTimeout(vadTimer);
            vadTimer = null;
          }
        }

        requestAnimationFrame(monitorVolume);
      };
      requestAnimationFrame(monitorVolume);
    } catch {}

    // 64kbps: half upload size = ~40% faster Whisper round-trip, quality still excellent for STT
    const recorderOpts = { audioBitsPerSecond: 64000 };
    const supportedMimeType = window.JarvisVoiceSTT.getSupportedAudioMimeType();
    if (supportedMimeType) {
      recorderOpts.mimeType = supportedMimeType;
    }

    mediaRecorder = new MediaRecorder(stream, recorderOpts);
    console.log('MediaRecorder:', mediaRecorder.mimeType, recorderOpts.audioBitsPerSecond + 'bps');

    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());

      const duration = Date.now() - recordingStartTime;
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const audioValidation = window.JarvisVoiceSTT.validateCapturedAudio({ duration, blob, peakVolume });
      if (!audioValidation.ok) {
        addTerminalLine(audioValidation.message, 'warn-line');
        setAvatarState('idle');
        return;
      }

      addTerminalLine(`[system] Audio captured: ${(blob.size / 1024).toFixed(1)}KB, ${(duration / 1000).toFixed(1)}s, peak vol: ${peakVolume.toFixed(0)}`, 'system-line');
      await transcribeAndSend(blob);
    };

    // Single chunk — timeslice fragments corrupt WebM for Whisper
    mediaRecorder.start();
    recordingStartTime = Date.now();
    isRecording = true;
    micBtn.classList.add('recording');
    setAvatarState('listening');
    playTone(1200, 40);
    addTerminalLine('[system] Listening... Click mic again when done speaking.', 'system-line');
  } catch (err) {
    addTerminalLine(`[error] Microphone access denied: ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
  }
}

function stopRecording() {
  clearTimeout(vadTimer); vadTimer = null;
  if (webSpeechRec && isRecording) {
    webSpeechRec.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    setAvatarState('thinking');
    playTone(800, 40);
    return;
  }
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    setAvatarState('thinking');
    playTone(800, 40);
  }
}

// After JARVIS finishes responding in continuous mode — restart listening
function scheduleNextListen(delayMs = 1200) {
  if (!continuousMode) return;
  clearTimeout(continuousTimer);
  continuousTimer = setTimeout(() => {
    if (!isRecording && continuousMode) startRecording();
  }, delayMs);
}

async function transcribeAndSend(audioBlob) {
  try {
    if (isRealtimeActive || realtimeActive) {
      console.log('[VOICE] Fluxo legado bloqueado porque Realtime está ativo');
      setAvatarState('idle');
      return;
    }
    if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
      console.log('[VOICE] Ignorado: Jarvis estava falando');
      setAvatarState('idle');
      return;
    }
    if (isVoiceRequestInFlight) {
      console.log('[VOICE] Ignorado: requisição de voz já em andamento');
      setAvatarState('idle');
      return;
    }

    setAvatarState('thinking');
    addTerminalLine('[system] Transcribing voice...', 'system-line');

    const formData = window.JarvisVoiceSTT.buildSttFormData(audioBlob);

    const sttRes = await fetch('/api/stt', { method: 'POST', body: formData });
    if (!sttRes.ok) {
      const err = await sttRes.json().catch(() => ({ error: 'STT failed' }));
      throw new Error(window.JarvisVoiceSTT.getSttErrorMessage(err));
    }
    const sttData = await sttRes.json();
    const parsedStt = window.JarvisVoiceSTT.parseSttResponse(sttData);

    // Handle filtered hallucinations
    if (!parsedStt.ok) {
      addTerminalLine(parsedStt.message, 'warn-line');
      setAvatarState('idle');
      return;
    }

    // Use sendMessage with fromVoice=true for the optimized pipeline
    await sendMessage(parsedStt.text, true);
  } catch (err) {
    addTerminalLine(`[error] Voice processing failed: ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
  }
}

// ========== TTS PIPELINE (SERIAL QUEUE — prevents double-voice overlap) ==========
window.JarvisVoiceSTT.configureRecordingHandlers({
  getState() {
    return {
      isRecording,
      hasMediaRecorder: !!mediaRecorder,
      audioChunks: audioChunks.length,
      hasWebSpeechRec: !!webSpeechRec,
      recordingStartTime,
      hasAudioAnalyser: !!audioAnalyser,
      peakVolume,
      hasVadTimer: !!vadTimer,
      continuousMode,
      hasContinuousTimer: !!continuousTimer,
      canWebSpeech
    };
  },
  startRecording,
  stopRecording,
  transcribeAndSend,
  sendVoiceMessage(text) {
    return sendMessage(text, true);
  },
  setVoiceStatus,
  setAvatarState,
  addTerminalLine,
  playTone,
  playErrorSound
});

let _ttsQueue = Promise.resolve();
let _currentAudio = null;
let _currentTtsAbortController = null;
let _ttsPlaybackId = 0;

function speakResponse(text) {
  if (_currentAudio || currentTtsAudio) {
    try { (_currentAudio || currentTtsAudio).pause(); } catch {}
    try { (_currentAudio || currentTtsAudio).src = ''; } catch {}
    _currentAudio = null;
    currentTtsAudio = null;
    console.log('[VOICE] TTS anterior cancelado');
  }
  if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
    window.speechSynthesis.cancel();
    console.log('[VOICE] TTS anterior cancelado');
  }
  if (_currentTtsAbortController) {
    try { _currentTtsAbortController.abort(); } catch {}
    _currentTtsAbortController = null;
    console.log('[VOICE] TTS anterior cancelado');
  }

  const playbackId = ++_ttsPlaybackId;
  _ttsQueue = Promise.resolve().then(() => _ttsPlay(text, playbackId)).catch(() => _ttsPlay(text, playbackId));
  return _ttsQueue;
}

async function _ttsPlay(text, playbackId = _ttsPlaybackId) {
  // Clean text for TTS — remove code blocks, markdown, bracket prefixes
  const sentences = window.JarvisVoiceTTS.getSpeechSentences(text);

  if (sentences.length === 0) return;
  if (playbackId !== _ttsPlaybackId) return;

  // Combine into one TTS call for speed (avoid multiple round-trips)
  const ttsText = window.JarvisVoiceTTS.prepareTtsText(text);

  setAvatarState('speaking');
  isJarvisSpeaking = true;

  try {
    const controller = new AbortController();
    _currentTtsAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ttsText, language: currentLang, voice: ttsVoice }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (playbackId !== _ttsPlaybackId) return;

    if (!res.ok) {
      console.error('TTS failed:', res.status);
      isJarvisSpeaking = false;
      setAvatarState('idle');
      return;
    }

    const blob = await res.blob();
    if (playbackId !== _ttsPlaybackId) return;
    const url = URL.createObjectURL(blob);

    await new Promise((resolve) => {
      const audio = new Audio(url);
      _currentAudio = audio;
      currentTtsAudio = audio;
      audio.onended = () => { if (playbackId === _ttsPlaybackId) { _currentAudio = null; currentTtsAudio = null; } URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { if (playbackId === _ttsPlaybackId) { _currentAudio = null; currentTtsAudio = null; } URL.revokeObjectURL(url); resolve(); };
      audio.play().catch((e) => {
        console.warn('Audio autoplay blocked:', e.message);
        if (playbackId === _ttsPlaybackId) {
          _currentAudio = null;
          currentTtsAudio = null;
        }
        URL.revokeObjectURL(url);
        resolve();
      });
    });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('TTS error:', err.message);
  }

  if (playbackId === _ttsPlaybackId) {
    _currentTtsAbortController = null;
    isJarvisSpeaking = false;
    lastVoiceCommandAt = Date.now();
    setAvatarState('idle');
  }
}

// ========== WAKE WORD DETECTION ==========
function startWakeWord() {
  if (!window.JarvisVoiceSTT.canUseWebSpeech()) return;

  const SpeechRec = window.JarvisVoiceSTT.getSpeechRecognitionCtor();
  wakeWordRecognition = new SpeechRec();
  wakeWordRecognition.continuous = true;
  wakeWordRecognition.interimResults = true;
  wakeWordRecognition.lang = currentLang === 'BR' ? 'pt-BR' : currentLang === 'ES' ? 'es-ES' : 'en-US';

  wakeWordRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = window.JarvisVoiceSTT.normalizeVoiceCommandText(event.results[i][0].transcript);
      // Detect "jarvis" in any pronunciation (jarvis, járvis, jarvís)
      if (window.JarvisVoiceSTT.isWakeWordMatch(transcript)) {
        if (!realtimeActive && !realtimeConnecting) {
          addTerminalLine('[info] 🎤 JARVIS ativado por voz — modo escuta + cowork ON', 'info-line');
          // Activate voice
          startRealtime();
          // Activate cowork mode (screen awareness)
          fetch('/api/cowork/start', { method: 'POST' }).catch(() => {});
        }
        break;
      }
    }
  };

  wakeWordRecognition.onend = () => {
    if (wakeWordEnabled) wakeWordRecognition.start();
  };

  wakeWordRecognition.start();
}

function stopWakeWord() {
  if (wakeWordRecognition) {
    wakeWordEnabled = false;
    wakeWordRecognition.stop();
    wakeWordRecognition = null;
  }
}

window.JarvisVoiceSTT.configureWakeWordHandlers({
  getState() {
    return {
      wakeWordEnabled,
      hasWakeWordRecognition: !!wakeWordRecognition,
      canWebSpeech,
      wakeWordDisabled: window.JarvisVoiceSTT.readWakeWordDisabledFromStorage(),
      realtimeActive,
      realtimeConnecting
    };
  },
  startWakeWord,
  stopWakeWord,
  startRealtime,
  addTerminalLine
});

function initBottomPanelsToggle() {
  const toggleBtn = document.getElementById('toggle-bottom-panels');
  const cockpit = document.querySelector('.cockpit-iron');
  if (!toggleBtn || !cockpit) return;

  const setCollapsed = (collapsed) => {
    cockpit.classList.toggle('bottom-panels-collapsed', collapsed);
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleBtn.setAttribute('aria-label', collapsed ? 'Expandir paineis inferiores' : 'Recolher paineis inferiores');
    toggleBtn.title = collapsed ? 'Expandir paineis inferiores' : 'Recolher paineis inferiores';
    localStorage.setItem('jarvis-bottom-panels-collapsed', collapsed ? '1' : '0');
  };

  setCollapsed(localStorage.getItem('jarvis-bottom-panels-collapsed') === '1');
  toggleBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setCollapsed(!cockpit.classList.contains('bottom-panels-collapsed'));
  });
}

// ========== TAB NAVIGATION ==========
// Floating "Back to Cockpit" button
var backToCockpitBtn = document.createElement('button');
backToCockpitBtn.id = 'back-to-cockpit';
backToCockpitBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;vertical-align:middle;margin-right:4px;"><polyline points="15 18 9 12 15 6"/></svg>COCKPIT';
backToCockpitBtn.style.cssText = 'display:none;position:fixed;top:12px;left:12px;z-index:9999;padding:8px 16px;background:rgba(0,20,40,0.9);border:1px solid var(--cyan);border-radius:6px;color:var(--cyan);font-family:Orbitron,sans-serif;font-size:10px;letter-spacing:1px;cursor:pointer;transition:all 0.3s;backdrop-filter:blur(10px);box-shadow:0 0 15px rgba(0,228,255,0.2);';
backToCockpitBtn.onmouseenter = function() { this.style.background = 'rgba(0,228,255,0.15)'; this.style.boxShadow = '0 0 20px rgba(0,228,255,0.4)'; };
backToCockpitBtn.onmouseleave = function() { this.style.background = 'rgba(0,20,40,0.9)'; this.style.boxShadow = '0 0 15px rgba(0,228,255,0.2)'; };
backToCockpitBtn.onclick = function() {
  var cockpitTab = document.querySelector('.tab-btn[data-tab="principal"]');
  if (cockpitTab) cockpitTab.click();
};
document.body.appendChild(backToCockpitBtn);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

    // Show/hide back button
    backToCockpitBtn.style.display = btn.dataset.tab === 'principal' ? 'none' : 'block';

    if (btn.dataset.tab === 'file') loadFiles();
  });
});

// ========== FILE BROWSER ==========
async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    const fileList = document.getElementById('file-list');

    if (!data.files || data.files.length === 0) {
      fileList.innerHTML = '<div class="file-empty">No files yet. Ask JARVIS to create something.</div>';
      return;
    }

    const icons = {
      '.pdf': '📕', '.md': '📝', '.txt': '📄', '.html': '🌐', '.css': '🎨',
      '.js': '⚡', '.ts': '💠', '.py': '🐍', '.json': '📋', '.png': '🖼️',
      '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
      '.xlsx': '📊', '.pptx': '📽️', '.docx': '📃', '.zip': '📦',
      '.mp3': '🎵', '.mp4': '🎬', '.wav': '🎵'
    };

    // Group by project
    const byProject = {};
    for (const f of data.files) {
      const proj = f.project || 'General';
      if (!byProject[proj]) byProject[proj] = [];
      byProject[proj].push(f);
    }

    fileList.innerHTML = Object.entries(byProject).map(([project, files]) => {
      const items = files.map(f => {
        const icon = icons[f.ext] || '📄';
        const size = f.size > 1024 * 1024
          ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
          : `${(f.size / 1024).toFixed(1)} KB`;
        const date = new Date(f.createdAt).toLocaleDateString();
        return `<div class="file-item">
          <span class="file-item-icon">${icon}</span>
          <div class="file-item-info">
            <div class="file-item-name">${f.name}</div>
            <div class="file-item-meta">${size} · ${date}</div>
          </div>
          <div class="file-item-actions">
            <a href="/api/files/view?path=${encodeURIComponent(f.path)}" target="_blank">Preview</a>
            <a href="${f.downloadUrl}" download>Download</a>
          </div>
        </div>`;
      }).join('');
      return `<div class="file-project-group">
        <div class="file-project-header">${project}</div>
        ${items}
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('file-list').innerHTML = '<div class="file-empty">Error loading files.</div>';
  }
}

// ========== CLOCK ==========
function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ========== CONFIG ==========
async function saveApiKeyConfig(key) {
  if (!key) return;
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OPENAI_API_KEY', value: key })
    });
    addTerminalLine('[system] API key updated. Restart server for changes to take effect.', 'system-line');
  } catch (err) {
    addTerminalLine(`[error] Failed to save config: ${err.message}`, 'error-line');
  }
}

function setConfigVoiceEnabled(enabled) {
  voiceEnabled = !!enabled;
  setVoiceStatus('auto');
  addTerminalLine(`[system] Voice ${voiceEnabled ? 'enabled' : 'disabled'}`, 'system-line');
  return voiceEnabled;
}

function setConfigWakeWordEnabled(enabled) {
  const desired = !!enabled;
  if (desired && wakeWordEnabled) {
    window.JarvisVoiceSTT.writeWakeWordDisabledToStorage(false);
    return wakeWordEnabled;
  }
  wakeWordEnabled = desired;
  window.JarvisVoiceSTT.writeWakeWordDisabledToStorage(!wakeWordEnabled);
  if (wakeWordEnabled) {
    try {
      startWakeWord();
      addTerminalLine('[system] Wake word "Jarvis" activated', 'system-line');
    } catch (err) {
      wakeWordEnabled = false;
      addTerminalLine(`[error] Wake word failed: ${err.message || err}`, 'error-line');
    }
  } else {
    stopWakeWord();
    addTerminalLine('[system] Wake word deactivated', 'system-line');
  }
  return wakeWordEnabled;
}

function setConfigTtsVoice(value) {
  ttsVoice = value;
  localStorage.setItem('ttsVoice', ttsVoice);
  addTerminalLine(`[info] TTS voice set to: ${ttsVoice}`, 'info-line');
  return ttsVoice;
}

window.JarvisConfigBridge = {
  saveApiKey: saveApiKeyConfig,
  setVoiceEnabled: setConfigVoiceEnabled,
  getVoiceEnabled: () => voiceEnabled,
  setWakeWordEnabled: setConfigWakeWordEnabled,
  getWakeWordEnabled: () => wakeWordEnabled,
  setTtsVoice: setConfigTtsVoice,
  getTtsVoice: () => ttsVoice,
  setConclaveEnabled,
  getConclaveEnabled: () => conclaveEnabled,
  syncConclaveVisual
};

// ========== AUTO-START WAKE WORD ==========
// JARVIS listens for his name — only if user hasn't explicitly disabled it
setTimeout(() => {
  const userDisabled = window.JarvisVoiceSTT.readWakeWordDisabledFromStorage();
  if (canWebSpeech && !wakeWordEnabled && !userDisabled) {
    try {
      wakeWordEnabled = true;
      startWakeWord();
      console.log('[JARVIS] Wake word "JARVIS" auto-activated');
      // Sync checkbox if exists
      const wakeChk = document.getElementById('config-wakeword');
      if (wakeChk) wakeChk.checked = true;
    } catch (err) {
      console.warn('[JARVIS] Wake word auto-start failed (mic denied?):', err.message || err);
      wakeWordEnabled = false;
    }
  }
}, 2000);

// ========== EVENT LISTENERS ==========
// Terminal send/focus listeners moved to public/js/terminal-chat.js.

if (micBtn) micBtn.addEventListener('click', () => {
  userGestureReceived = true;
  // Feedback visual imediato
  micBtn.classList.toggle('recording');
  setVoiceStatus(micBtn.classList.contains('recording') ? 'listening' : 'ready');
  addTerminalLine(realtimeActive ? '[system] Desconectando voz...' : '[system] Conectando voz...', 'system-line');
  startRealtime().then(() => {
    if (realtimeActive) {
      micBtn.classList.add('recording');
      setVoiceStatus('listening');
    } else {
      micBtn.classList.remove('recording');
      setVoiceStatus('auto');
    }
  }).catch((err) => {
    micBtn.classList.remove('recording');
    setVoiceStatus('auto');
    addTerminalLine(`[error] Voz: ${err.message || err}`, 'error-line');
  });
});

setVoiceStatus('ready');

// Terminal direct input
// Agent chip click → insert @mention + highlight model
document.querySelectorAll('.agent-chip[data-agent]').forEach(chip => {
  chip.style.cursor = 'pointer';
  chip.addEventListener('click', () => {
    const agent = chip.dataset.agent;
    const mention = `@${agent} `;
    const input = document.getElementById('chat-input');
    if (!input.value.startsWith('@')) {
      input.value = mention + input.value;
    } else {
      input.value = mention;
    }
    input.focus();
    setModelFromAgent(chip);
    // Visual feedback
    document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active-agent'));
    chip.classList.add('active-agent');
  });
});

// ========== INIT ==========
updateClock();
setInterval(updateClock, 1000);
initLangToggle();
initContinuousBtn();
initRealtimeBtn();
initBottomPanelsToggle();

// Realtime connects when user clicks mic — no auto-connect to save API calls


// ── PUSH NOTIFICATION CHANNEL ──────────────────────────────────────────────
// Listens for Claude build completions. GPT-mini generates the message server-side
// and pushes it here — frontend speaks it automatically via TTS.
(function initNotifications() {
  const es = new EventSource('/api/notifications');
  es.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      // PATCH 2 v8.0: switch SSE com case 'pet-mic' (botao PET liga/desliga mic)
      switch (payload.type) {
        case 'build-complete':
          if (payload.message) {
            addTerminalLine(`[info] ✓ ${payload.message}`, 'info-line');
            console.log('[JARVIS] Build complete notification received:', payload.message);
            // PATCH 13 v8.1: ALWAYS use TTS for build-complete — Realtime parafraseia
            if (userGestureReceived) {
              if (realtimeActive || isRealtimeActive) announceToRealtime(payload.message);
              else speakResponse(payload.message);
            }
          }
          break;
        case 'pet-mic':
          if (payload.active === true || payload.on === true) {
            try { startRealtime(); } catch (err) { console.error('[JARVIS] pet-mic startRealtime falhou', err); }
          } else {
            try { stopRealtime(); } catch (err) { console.error('[JARVIS] pet-mic stopRealtime falhou', err); }
          }
          break;
      }
    } catch {}
  };
  es.onerror = () => { /* silent reconnect handled by browser */ };
})();

// ── PRE-FLIGHT VERIFICATION ──────────────────────────────────────────────
// Runs on first visit (or if user cleared localStorage). Tests all systems.
(async function runPreflight() {
  const PREFLIGHT_KEY = 'jarvis_preflight_passed';
  const overlay = document.getElementById('preflight-overlay');
  if (!overlay) return;

  // Skip if already passed (unless Shift held during load for re-check)
  if (localStorage.getItem(PREFLIGHT_KEY) && !window._forcePreflightRecheck) {
    overlay.style.display = 'none';
    return;
  }

  overlay.style.display = 'flex';

  try {
    const res = await fetch('/api/health/preflight', { method: 'POST' });
    const data = await res.json();

    // Update each check item
    for (const [key, result] of Object.entries(data.results)) {
      const el = document.querySelector(`.pf-item[data-key="${key}"]`);
      if (!el) continue;
      const icon = el.querySelector('.pf-icon');
      if (result.status === 'ok') {
        icon.textContent = '✅';
        el.classList.add('pf-ok');
      } else {
        icon.textContent = '❌';
        el.classList.add('pf-err');
        el.setAttribute('data-detail', result.detail || 'Unknown error');
      }
    }

    // Collect failed issues for auto-fix
    const failedIssues = [];
    for (const [key, result] of Object.entries(data.results)) {
      if (result.status !== 'ok') {
        failedIssues.push({ key, detail: result.detail || 'Unknown error' });
      }
    }

    // Show result
    const resultDiv = document.getElementById('preflight-result');
    const msgEl = document.getElementById('preflight-msg');
    const okBtn = document.getElementById('preflight-ok');
    const retryBtn = document.getElementById('preflight-retry');
    resultDiv.style.display = 'block';

    // Ensure autofix button exists
    let fixBtn = document.getElementById('preflight-autofix');
    if (!fixBtn) {
      fixBtn = document.createElement('button');
      fixBtn.id = 'preflight-autofix';
      fixBtn.style.cssText = 'background:linear-gradient(135deg,#00d4ff,#00ff88);color:#000;border:none;padding:10px 28px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;margin-left:8px;';
      fixBtn.textContent = 'Corrigir Automaticamente';
      retryBtn.parentElement.appendChild(fixBtn);
    }

    // Ensure autofix log area exists
    let fixLog = document.getElementById('preflight-fixlog');
    if (!fixLog) {
      fixLog = document.createElement('div');
      fixLog.id = 'preflight-fixlog';
      fixLog.style.cssText = 'display:none;margin-top:14px;background:#060a1a;border:1px solid #1a3a5c;border-radius:8px;padding:12px;max-height:180px;overflow-y:auto;font-family:"JetBrains Mono",monospace;font-size:10px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;';
      resultDiv.appendChild(fixLog);
    }

    if (data.status === 'ready') {
      msgEl.textContent = 'Todos os sistemas operacionais. JARVIS esta pronto.';
      msgEl.style.color = '#00ff88';
      okBtn.textContent = 'Iniciar JARVIS';
      okBtn.style.background = '#00d4ff';
      okBtn.style.display = 'inline-block';
      retryBtn.style.display = 'none';
      fixBtn.style.display = 'none';
    } else {
      msgEl.textContent = 'Problemas detectados. JARVIS pode funcionar com recursos limitados.';
      msgEl.style.color = '#ffaa00';
      okBtn.textContent = 'Continuar Assim';
      okBtn.style.background = '#555';
      okBtn.style.display = 'inline-block';
      retryBtn.style.display = 'inline-block';
      // Show auto-fix only if Claude CLI is available
      const claudeOk = data.results.claude_cli?.status === 'ok';
      fixBtn.style.display = claudeOk ? 'inline-block' : 'none';
    }

    okBtn.onclick = () => {
      localStorage.setItem(PREFLIGHT_KEY, Date.now().toString());
      overlay.style.display = 'none';
    };

    retryBtn.onclick = () => {
      document.querySelectorAll('.pf-item').forEach(el => {
        el.classList.remove('pf-ok', 'pf-err');
        el.removeAttribute('data-detail');
        el.querySelector('.pf-icon').textContent = '⏳';
      });
      resultDiv.style.display = 'none';
      fixLog.style.display = 'none';
      fixLog.textContent = '';
      window._forcePreflightRecheck = true;
      runPreflight();
    };

    fixBtn.onclick = async () => {
      // Disable buttons during fix
      fixBtn.disabled = true;
      fixBtn.textContent = 'Corrigindo...';
      fixBtn.style.opacity = '0.6';
      retryBtn.disabled = true;
      okBtn.disabled = true;
      fixLog.style.display = 'block';
      fixLog.textContent = '[JARVIS] Acionando sistema para corrigir problemas...\n\n';

      try {
        const fixRes = await fetch('/api/health/autofix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issues: failedIssues })
        });

        const reader = fixRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          fixLog.textContent += chunk;
          fixLog.scrollTop = fixLog.scrollHeight;
        }

        fixLog.textContent += '\n\n[JARVIS] Correcao concluida. Executando verificacao novamente...\n';

        // Wait 2s then re-run preflight
        await new Promise(r => setTimeout(r, 2000));
        document.querySelectorAll('.pf-item').forEach(el => {
          el.classList.remove('pf-ok', 'pf-err');
          el.removeAttribute('data-detail');
          el.querySelector('.pf-icon').textContent = '⏳';
        });
        resultDiv.style.display = 'none';
        fixLog.style.display = 'none';
        fixLog.textContent = '';
        window._forcePreflightRecheck = true;
        runPreflight();

      } catch (err) {
        fixLog.textContent += `\n[ERRO] ${err.message}\n`;
        fixBtn.disabled = false;
        fixBtn.textContent = 'Corrigir Automaticamente';
        fixBtn.style.opacity = '1';
        retryBtn.disabled = false;
        okBtn.disabled = false;
      }
    };
  } catch (e) {
    // Server not reachable
    const resultDiv = document.getElementById('preflight-result');
    const msgEl = document.getElementById('preflight-msg');
    resultDiv.style.display = 'block';
    msgEl.textContent = '❌ Cannot reach JARVIS server. Is it running?';
    msgEl.style.color = '#ff4444';
  }
})();



// ═══════════════════════════════════════════════
// COCKPIT HUD LOGIC — Iron Man Edition
// ═══════════════════════════════════════════════

(function() {
  // ── Quick Access Buttons (HUD esquerdo) ──
  document.querySelectorAll('.hud-qbtn[data-quick-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.quickTab;
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${targetTab}"]`);
      if (tabBtn) tabBtn.click();
    });
  });

  // Weather logic moved to public/js/weather.js.

  // ── System Health Bars ──
  // ── Active Model Display ──
  function updateModel(model, status) {
    const modelEl = document.getElementById('active-model');
    const statusEl = document.getElementById('model-status');
    if (!modelEl) return;

    const modelMap = {
      'claude-opus-4-6': 'Opus 4.6',
      'claude-sonnet-4-6': 'Sonnet 4.6',
      'claude-haiku-4-5': 'Haiku 4.5',
      'opus': 'Opus 4.6',
      'sonnet': 'Sonnet 4.6',
      'haiku': 'Haiku 4.5',
    };

    modelEl.textContent = modelMap[model] || model || 'Sonnet 4.6';
    statusEl.textContent = status || 'standby';
  }

  // Listen to server-log events for model detection
  window.addEventListener('jarvis-log', (e) => {
    const msg = e.detail || '';
    if (msg.includes('opus')) updateModel('opus', 'executing');
    else if (msg.includes('sonnet')) updateModel('sonnet', 'executing');
    else if (msg.includes('haiku')) updateModel('haiku', 'executing');
  });

  // ── Active Agents ──
  const agentsList = document.getElementById('agents-list');
  const activeAgents = new Set();

  function addAgent(name) {
    activeAgents.add(name);
    renderAgents();
  }
  function removeAgent(name) {
    activeAgents.delete(name);
    renderAgents();
  }
  function renderAgents() {
    if (!agentsList) return;
    if (activeAgents.size === 0) {
      agentsList.innerHTML = '<span class="agent-pill idle">nenhum</span>';
      return;
    }
    agentsList.innerHTML = [...activeAgents]
      .map(a => `<span class="agent-pill active">${a}</span>`)
      .join('');
  }

  // Expose for external calls
  window.jarvisHUD = {
    addAgent, removeAgent, updateModel,
    detectAgent: (text) => {
      const agents = ['architect', 'dev', 'qa', 'pm', 'po', 'analyst', 'ux', 'devops', 'conclave'];
      agents.forEach(a => {
        if (text?.toLowerCase().includes(`@${a}`) || text?.toLowerCase().includes(a)) {
          addAgent(a);
          setTimeout(() => removeAgent(a), 30000);
        }
      });
    }
  };

})();

// ═══════════════════════════════════════════════
// PREFLIGHT AUTO-SKIP (se server offline)
// ═══════════════════════════════════════════════
(function() {
  const overlay = document.getElementById('preflight-overlay');
  if (!overlay) return;

  // Auto-fechar preflight depois de 5s independente do resultado
  setTimeout(() => {
    if (overlay.style.display !== 'none') {
      console.log('[JARVIS] Preflight timeout — fechando modal');
      overlay.style.display = 'none';
    }
  }, 5000);

  // Também fecha se clicar em qualquer botão do preflight
  const okBtn = document.getElementById('preflight-ok');
  const retryBtn = document.getElementById('preflight-retry');
  if (okBtn) okBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  if (retryBtn) retryBtn.addEventListener('click', () => { location.reload(); });
})();


// ═══════════════════════════════════════════════


// ═══════════════════════════════════════════════
// HUD FUNCTIONAL — Entity activation, Obsidian, Ingest, Brain Viewer
// ═══════════════════════════════════════════════

(function() {
  // ── Entity Activation (modelos/agentes/conclave) ──
  function setEntityActive(name, active) {
    const row = document.querySelector('[data-entity="' + name + '"]');
    if (!row) return;
    if (active) { row.classList.add('active'); row.classList.remove('idle'); }
    else { row.classList.remove('active'); row.classList.add('idle'); }
  }
  function pulseEntity(name, ms) {
    setEntityActive(name, true);
    setTimeout(function() { setEntityActive(name, false); }, ms || 15000);
  }

  // Detection rules
  var rules = [
    { p: /opus/i, e: 'opus' }, { p: /sonnet/i, e: 'sonnet' }, { p: /haiku/i, e: 'haiku' },
    { p: /realtime|gpt-4o-rt/i, e: 'gpt-realtime' }, { p: /gpt-4o-mini/i, e: 'gpt-mini' },
    { p: /@architect|aria/i, e: 'architect' }, { p: /@dev\b|dex/i, e: 'dev' },
    { p: /@qa|quinn/i, e: 'qa' }, { p: /@pm|morgan/i, e: 'pm' },
    { p: /@po\b|pax/i, e: 'po' }, { p: /@analyst|atlas/i, e: 'analyst' },
    { p: /@ux|uma/i, e: 'ux' }, { p: /@devops|gage/i, e: 'devops' },
    { p: /@sm\b|river/i, e: 'sm' }, { p: /data.engineer|dara/i, e: 'data-engineer' },
    { p: /aios.master|orion/i, e: 'aios-master' }, { p: /squad.creator|craft/i, e: 'squad-creator' },
    { p: /conclave.critico|critico/i, e: 'conclave-critico' },
    { p: /conclave.advogado|advogado/i, e: 'conclave-advogado' },
    { p: /conclave.sintetizador|sintetizador/i, e: 'conclave-sintetizador' },
  ];
  window.jarvisHUD = window.jarvisHUD || {};
  window.jarvisHUD.setEntityActive = setEntityActive;
  window.jarvisHUD.pulseEntity = pulseEntity;
  window.jarvisHUD.analyzeText = function(text) {
    if (!text) return;
    rules.forEach(function(r) { if (r.p.test(text)) pulseEntity(r.e, 20000); });
  };

  // ── Obsidian Stats ──
  function _setObs(id, val){ var e=document.getElementById(id); if(e) e.textContent=val; }
  async function loadObsidianStats() {
    try {
      var r = await fetch('/api/obsidian/stats');
      if (!r.ok) throw new Error('offline');
      var data = await r.json();
      if (data.connected) {
        // legacy IDs (backup script.js)
        _setObs('obsidian-notes', data.notes + ' notas');
        _setObs('obsidian-status', 'conectado');
        _setObs('obs-folders', data.folders);
        _setObs('obs-links', data.links);
        // new HUD IDs (current index.html)
        _setObs('obs-name', data.name || 'Obsidian');
        _setObs('obs-status', 'Conectado');
        _setObs('obs-val-folders', data.folders ?? '?');
        _setObs('obs-val-links', data.links ?? '?');
        _setObs('obs-val-brain', data.brain ?? '?');
        _setObs('obs-val-agents', data.agents ?? '15');
      } else {
        _setObs('obsidian-notes', 'N/A');
        _setObs('obsidian-status', 'vault nao instalado');
        _setObs('obs-name', 'N/A');
        _setObs('obs-status', 'Offline');
      }
    } catch(e) {
      _setObs('obsidian-notes', 'N/A');
      _setObs('obsidian-status', 'offline');
      _setObs('obs-name', 'N/A');
      _setObs('obs-status', 'Offline');
    }
  }
  loadObsidianStats();
  setInterval(loadObsidianStats, 60000);

  // ── Quick Access Buttons ──
  document.querySelectorAll('.hud-qbtn[data-quick-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tabBtn = document.querySelector('.tab-btn[data-tab="' + btn.dataset.quickTab + '"]');
      if (tabBtn) tabBtn.click();
    });
  });

  // ── Desktop Pet Launcher (toggle) ──
  var petBtn = document.getElementById('btn-launch-pet');
  var petActive = false;
  if (petBtn) {
    petBtn.addEventListener('click', async function() {
      petBtn.style.opacity = '0.5';
      try {
        var r = await fetch('/api/pet/launch', { method: 'POST' });
        var data = await r.json();
        if (data.ok) {
          petActive = data.action === 'opened';
          petBtn.querySelector('span').textContent = petActive ? '✅ ON' : 'Pet';
          petBtn.style.borderColor = petActive ? 'rgba(0,255,100,0.5)' : 'rgba(255,215,0,0.3)';
        }
      } catch(e) {
        petBtn.querySelector('span').textContent = '❌ Erro';
        setTimeout(function() { petBtn.querySelector('span').textContent = 'Pet'; }, 2000);
      }
      petBtn.style.opacity = '1';
    });
  }

  // ── Ingest Modal ──
  var ingestModal = document.getElementById('ingest-modal');
  var ingestSubmit = document.getElementById('ingest-submit');
  var ingestStatus = document.getElementById('ingest-status');

  // Ingest tabs
  document.querySelectorAll('.ingest-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.ingest-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.ingest-panel').forEach(function(p) { p.classList.remove('active'); });
      tab.classList.add('active');
      var panel = document.getElementById('ingest-' + tab.dataset.ingest);
      if (panel) panel.classList.add('active');
    });
  });

  // File dropzone
  var dropzone = document.getElementById('ingest-dropzone');
  var fileInput = document.getElementById('ingest-file-input');
  var fileNameEl = document.getElementById('ingest-file-name');
  var selectedFile = null;

  if (dropzone) {
    dropzone.addEventListener('click', function() { fileInput.click(); });
    dropzone.addEventListener('dragover', function(e) { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', function() { dropzone.classList.remove('dragover'); });
    dropzone.addEventListener('drop', function(e) {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        selectedFile = e.dataTransfer.files[0];
        fileNameEl.textContent = '\u2705 ' + selectedFile.name + ' (' + Math.round(selectedFile.size/1024) + 'KB)';
      }
    });
    fileInput.addEventListener('change', function() {
      if (fileInput.files.length) {
        selectedFile = fileInput.files[0];
        fileNameEl.textContent = '\u2705 ' + selectedFile.name + ' (' + Math.round(selectedFile.size/1024) + 'KB)';
      }
    });
  }

  // Submit ingest
  if (ingestSubmit) {
    ingestSubmit.addEventListener('click', async function() {
      var activeTab = document.querySelector('.ingest-tab.active');
      var tabType = activeTab ? activeTab.dataset.ingest : 'text';
      ingestStatus.textContent = '\u23F3 Processando...';
      ingestSubmit.disabled = true;

      try {
        var body = {};

        if (tabType === 'text') {
          var text = document.getElementById('ingest-text-input').value.trim();
          var cat = document.getElementById('ingest-text-category').value;
          if (!text) { ingestStatus.textContent = '\u274C Digite algo primeiro'; ingestSubmit.disabled = false; return; }
          body = { type: 'text', text: text, category: cat };
        }

        if (tabType === 'file') {
          if (!selectedFile) { ingestStatus.textContent = '\u274C Selecione um arquivo'; ingestSubmit.disabled = false; return; }
          var reader = new FileReader();
          var content = await new Promise(function(resolve) {
            reader.onload = function() { resolve(reader.result); };
            reader.readAsText(selectedFile);
          });
          body = { type: 'file', fileName: selectedFile.name, fileContent: content };
        }

        if (tabType === 'session') {
          body = { type: 'session' };
        }

        var r = await fetch('/api/obsidian/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var data = await r.json();

        if (data.ok) {
          ingestStatus.textContent = '\u2705 Salvo no Obsidian: ' + (data.title || data.count + ' notas');
          loadObsidianStats();
          setTimeout(function() { ingestModal.style.display = 'none'; ingestStatus.textContent = ''; }, 2000);
        } else {
          ingestStatus.textContent = '\u274C ' + (data.error || 'Erro desconhecido');
        }
      } catch(err) {
        ingestStatus.textContent = '\u274C ' + err.message;
      }
      ingestSubmit.disabled = false;
    });
  }

  // ── Brain Viewer Modal ──
  var brainModal = document.getElementById('brain-modal');
  var btnBrain = document.getElementById('btn-brain');
  var brainTree = document.getElementById('brain-tree');
  var brainPreview = document.getElementById('brain-preview');
  var brainSearch = document.getElementById('brain-search');

  if (btnBrain) {
    btnBrain.addEventListener('click', function() {
      if (brainModal) {
        brainModal.style.display = 'flex';
        loadBrainTree();
      }
    });
  }

  // Load brain tree
  async function loadBrainTree() {
    if (!brainTree) return;
    brainTree.innerHTML = '<div class="brain-loading">Carregando vault...</div>';
    try {
      var r = await fetch('/api/obsidian/tree');
      var data = await r.json();
      if (!data.tree || !data.tree.length) {
        brainTree.innerHTML = '<div class="brain-loading">Vault vazio ou nao encontrado</div>';
        return;
      }
      brainTree.innerHTML = '';
      renderTree(data.tree, brainTree);
    } catch(err) {
      brainTree.innerHTML = '<div class="brain-loading">Erro: ' + err.message + '</div>';
    }
  }

  function renderTree(items, parent) {
    items.forEach(function(item) {
      if (item.type === 'folder') {
        var folder = document.createElement('div');
        folder.className = 'brain-folder';
        var header = document.createElement('div');
        header.className = 'brain-folder-header';
        header.innerHTML = '<span class="folder-icon">\uD83D\uDCC1</span><span class="folder-name">' + item.name + '</span><span class="folder-count">' + (item.children ? item.children.length : 0) + '</span>';
        var items_div = document.createElement('div');
        items_div.className = 'brain-folder-items';
        items_div.style.display = 'none';
        header.addEventListener('click', function() {
          items_div.style.display = items_div.style.display === 'none' ? 'block' : 'none';
          header.querySelector('.folder-icon').textContent = items_div.style.display === 'none' ? '\uD83D\uDCC1' : '\uD83D\uDCC2';
        });
        folder.appendChild(header);
        folder.appendChild(items_div);
        if (item.children) renderTree(item.children, items_div);
        parent.appendChild(folder);
      } else {
        var note = document.createElement('div');
        note.className = 'brain-note';
        note.innerHTML = '<span class="note-icon">\uD83D\uDCC4</span> ' + item.name;
        note.addEventListener('click', function() {
          document.querySelectorAll('.brain-note').forEach(function(n) { n.classList.remove('active'); });
          note.classList.add('active');
          loadNote(item.path);
        });
        parent.appendChild(note);
      }
    });
  }

  // Load note content
  async function loadNote(notePath) {
    if (!brainPreview) return;
    brainPreview.innerHTML = '<div class="brain-loading">Carregando...</div>';
    try {
      var r = await fetch('/api/obsidian/note?path=' + encodeURIComponent(notePath));
      var data = await r.json();
      if (data.content) {
        // Render markdown
        var html = marked.parse(data.content);
        // Convert [[links]] to clickable elements
        html = html.replace(/\[\[([^\]|#]+)\]\]/g, '<span class="brain-link" data-link="$1">$1</span>');
        brainPreview.innerHTML = html;
        // Make [[links]] clickable
        brainPreview.querySelectorAll('.brain-link').forEach(function(link) {
          link.addEventListener('click', function() {
            var target = link.dataset.link;
            // Find note in tree by name
            var noteEl = null;
            document.querySelectorAll('.brain-note').forEach(function(n) {
              if (n.textContent.trim().includes(target)) noteEl = n;
            });
            if (noteEl) noteEl.click();
          });
        });
      } else {
        brainPreview.innerHTML = '<div class="brain-empty"><p>Nota nao encontrada</p></div>';
      }
    } catch(err) {
      brainPreview.innerHTML = '<div class="brain-empty"><p>Erro: ' + err.message + '</p></div>';
    }
  }

  // Brain search
  if (brainSearch) {
    brainSearch.addEventListener('input', function() {
      var q = brainSearch.value.toLowerCase();
      document.querySelectorAll('.brain-note').forEach(function(n) {
        n.style.display = n.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
      // Show all parent folders
      document.querySelectorAll('.brain-folder-items').forEach(function(fi) {
        var hasVisible = fi.querySelector('.brain-note:not([style*="display: none"])');
        fi.style.display = q && hasVisible ? 'block' : (q ? 'none' : '');
      });
    });
  }

  // ── RAM metric ──
  // RAM atualizado via updateSystemStats() — removida funcao duplicada
})();


// ═══ CLAUDE ACTIVITY TRACKER ═══
(function() {
  var actEl = document.getElementById("metric-activity");
  if (!actEl) return;

  window.jarvisHUD = window.jarvisHUD || {};
  window.jarvisHUD.setActivity = function(text, isActive) {
    actEl.textContent = text || "idle";
    if (isActive) actEl.classList.add("active");
    else actEl.classList.remove("active");
  };

  // Listen for terminal output to detect Claude activity
  var origAddTerminal = window.addTerminalLine;
  if (typeof origAddTerminal === "function") {
    window.addTerminalLine = function(msg, cls) {
      origAddTerminal(msg, cls);
      if (!msg) return;
      var m = String(msg).toLowerCase();
      if (m.includes("[build-start]") || m.includes("creating") || m.includes("generating")) {
        window.jarvisHUD.setActivity("criando...", true);
      } else if (m.includes("[file]")) {
        var fname = msg.match(/\[file\]\s*(.+?)\s*\|/);
        window.jarvisHUD.setActivity(fname ? fname[1] : "arquivo criado", true);
      } else if (m.includes("[system] done") || m.includes("concluido") || m.includes("pronto")) {
        window.jarvisHUD.setActivity("concluido", false);
        setTimeout(function() { window.jarvisHUD.setActivity("idle", false); }, 5000);
      }
    };
  }
})();
