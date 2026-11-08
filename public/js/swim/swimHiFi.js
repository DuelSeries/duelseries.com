/* ─── Swim: the realistic look (Owen 2026-11-08: "as close to the CGI car renders as a browser can") ─────────
   What swimScene.js adds on top of its own road when the look is on, kept here so the road file stays the road:

     high   desktops: the glTF supercar with clearcoat paint, chrome and glass, PBR traffic and asphalt, all
            reflecting the road's own sky (swimScene.js draws it into a PMREM), a real sun shadow round the
            followed car, bloom on every lamp and the sun, an edge-only speed blur, ACES.
     lite   phones (and Settings > Graphics > Low): the same car at a lighter detail, the same reflections and
            ACES, no post passes and no shadow map (a phone pays for every full-screen pass).
     off    the look Swim always had (?gfx=off, or opts.quality 'off').

   Everything heavy is fetched only once the race page has drawn its first frame, and only by the Swim pages:
   the three.js add-ons (one 95 KB module, ~24 KB Brotli) and the car (~0.75 MB, ~0.4 MB on a phone). Until they
   land the road is drawn as before with the procedural car, so a slow line never holds the race up.

   ASSETS AND CREDIT (also in public/vendor/models/swim/CREDITS.txt):
     car-gt*.glb   "Car Concept" by Eric Chadwick, Darmstadt Graphics Group, CC-BY 4.0 (Khronos glTF Sample Assets),
                   itself from a CC0 model by Unity Fan; every logo and its textures removed, the cabin thinned,
                   simplified. No maker's design, no badge. */
import * as THREE from 'three';

export const ADDONS_URL = '/vendor/three/addons/swim-addons.min.js';
export const ASSETS = {
  /* one car: /vendor/models/swim/cars/<id>.glb (desktop) or <id>-lo.glb (phones) */
  car: (id, lite) => '/vendor/models/swim/cars/' + id + (lite ? '-lo' : '') + '.glb',
  /* one traffic type (shared/swimSim.js TYPES id): /vendor/models/swim/traffic/<type>.glb */
  traffic: (type) => '/vendor/models/swim/traffic/' + type + '.glb',
};

/* Which look this screen gets: an explicit opts.quality, then ?gfx= (so the live page can be compared), then
   lite on a phone or with Settings > Graphics > Low, else high. */
export function pickTier(opts, phone) {
  const ok = (v) => v === 'off' || v === 'lite' || v === 'high';
  if (ok(opts.quality)) return opts.quality;
  try {
    const q = new URLSearchParams(location.search).get('gfx');
    if (ok(q)) return q;
  } catch (_) { /* no location */ }
  const low = typeof window !== 'undefined' && window.DSQuality && window.DSQuality.low && window.DSQuality.low();
  return phone || low ? 'lite' : 'high';
}

/* ── per-vertex PBR for the procedural models (traffic, scenery details, the muscle car and the hatch) ──────
   Each vertex carries `glow` (lamps keep their colour and shine past 1 for the bloom) and `pbr` (roughness,
   metalness), so glass, tyres, trim and chrome on one mesh each look like what they are. */
const PBR_BY_HEX = new Map([
  [0x1b2532, [0.04, 0.0]],     // glass
  [0x141518, [0.88, 0.0]],     // tyre
  [0x202228, [0.45, 0.35]],    // trim
  [0x2b2b30, [0.3, 0.9]],      // exhaust pipes
  [0x8d929b, [0.18, 1.0]],     // hubs
  [0xdcd9d0, [0.55, 0.0]],     // plates
  [0xd9d5cc, [0.6, 0.0]],      // a truck's box
  [0xc9c6bf, [0.55, 0.0]],
  [0x9a978f, [0.6, 0.0]],
]);
export function pbrOfHex(hex, glow) {
  if (glow > 0) return [0.25, 0.0];
  return PBR_BY_HEX.get(hex) || [0.55, 0.0];
}

/* A standard (or physical) material reading the two vertex attributes. `glowGain` lifts a lamp's colour past 1
   so the bloom catches it (1 when there is no bloom: the lamp is then simply drawn at its colour). */
export function pbrMaterial(params, { physical = false, perVertex = true, glowGain = 1 } = {}) {
  const M = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const m = new M(Object.assign({ vertexColors: true }, params));
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;' + (perVertex ? '\nattribute vec2 pbr;\nvarying vec2 vPbr;' : ''))
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tvGlow = glow;' + (perVertex ? '\n\tvPbr = pbr;' : ''));
    let fs = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;' + (perVertex ? '\nvarying vec2 vPbr;' : ''))
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * vGlow * ' + glowGain.toFixed(2) + ';');
    if (perVertex) {
      fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = vPbr.x;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = vPbr.y;');
    }
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => 'swimPbr' + (physical ? 'P' : 'S') + (perVertex ? 'v' : '') + glowGain;
  return m;
}

/* ── the cars ──────────────────────────────────────────────────────────────────────────────────────────────
   Each car is its own glb (scripts/swimCarBuild.mjs made them from the licensed downloads): nose to -z, centred,
   wheels on y = 0, scaled to Swim's 4.3 m length (proportions kept), every material named '<role>|<original>' so
   this file maps any model the same way: paint (takes the seat's colour, clearcoat over it), glass, tail (the rear
   lamps: always lit, brighter when braking), head (always lit), and the rest (chrome, rims, tyres, trim, cabin) as
   the model made them. */
const ROLES = new Set(['paint', 'accent', 'glass', 'tail', 'head', 'chrome', 'tyre', 'rim', 'plate', 'other']);
const GHOST_ROLES = new Set(['paint', 'accent', 'glass', 'tyre', 'rim', 'tail', 'head', 'plate', 'chrome']);

function floatGeo(src, m) {
  const g = new THREE.BufferGeometry(), p = src.attributes.position, n = src.attributes.normal;
  const pos = new Float32Array(p.count * 3), nor = new Float32Array(p.count * 3), v = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(m); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    if (n) {
      v.fromBufferAttribute(n, i).applyMatrix3(nm);
      if (!(v.lengthSq() > 1e-12)) v.set(0, 1, 0);   // a zero or NaN normal is NaN in the lighting, and bloom spreads it to black
      v.normalize(); nor[i * 3] = v.x; nor[i * 3 + 1] = v.y; nor[i * 3 + 2] = v.z;
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (src.index) g.setIndex(Array.from(src.index.array));
  if (!n) g.computeVertexNormals();   // a model saved without normals gets smooth ones
  return g;
}
/* [cx, cy, cz, w, h] quads square to z (halos and flames), as swimScene.js draws them */
function quads(list) {
  const p = [], uv = [];
  for (const [cx, cy, cz, w, h] of list) {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    p.push(x0, y0, cz, x1, y0, cz, x1, y1, cz, x0, y0, cz, x1, y1, cz, x0, y1, cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/* Loads one car and returns a maker: make(paintHex) gives one car's solid group (its own paint and tail lamps) and
   ghost group (one merged translucent shell drawn after a depth pre-pass), and lamps: the halo, indicator and
   flame pieces placed on this model's own tail lights (worked out from where they are). */
export async function loadCar(A, url, { envIntensity = 1, glowGain = 1, shadows = false, paintMetal = 0.25, paintRough = 0.36 } = {}) {
  const loader = new A.GLTFLoader().setMeshoptDecoder(A.MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const parts = [], ghostGeos = [];
  const tailBox = new THREE.Box3(), allBox = new THREE.Box3(), tmp = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    const tag = ((src && src.name) || '').split('|')[0];
    const role = ROLES.has(tag) ? tag : 'other';
    const m = o.matrixWorld.clone();
    parts.push({ geo: o.geometry, matrix: m, role, src });
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    tmp.copy(o.geometry.boundingBox).applyMatrix4(m);
    allBox.union(tmp);
    if (role === 'tail') tailBox.union(tmp);
    if (GHOST_ROLES.has(role)) ghostGeos.push(floatGeo(o.geometry, m));
  });
  const phys = (p) => new THREE.MeshPhysicalMaterial(Object.assign({ envMapIntensity: envIntensity }, p));
  /* the shared materials: the model's own, lit by the sky; glass ours unless the model's is see-through already */
  const glassOurs = phys({ color: 0x07090c, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.82, clearcoat: 0.6, clearcoatRoughness: 0 });
  const headOn = new THREE.Color(1, 0.97, 0.9).multiplyScalar(1.5 * glowGain);
  const own = new Map();
  const ownOf = (src, role) => {
    if (own.has(src)) return own.get(src);
    let m;
    if (role === 'glass') m = src && src.transparent && src.opacity < 0.95 && src.opacity > 0.3 ? Object.assign(src.clone(), { envMapIntensity: envIntensity * 1.3 }) : glassOurs;   // near-invisible glass reads as ours (dark, reflective)
    else if (role === 'head') { m = src.clone(); m.emissive = headOn.clone(); if (src.map) m.emissiveMap = src.map; }
    else {
      m = src.clone(); m.envMapIntensity = envIntensity;
      /* a part the maker left glowing that is not one of our lamps (a lens, a trim line) glows a quarter as much: in the race's
         bloom it read as a second pair of headlights */
      if (m.emissive) m.emissive.multiplyScalar(0.25);
      if (role === 'chrome') { m.metalness = Math.max(m.metalness || 0, 0.9); m.roughness = Math.min(m.roughness == null ? 0.2 : m.roughness, 0.15); }
    }
    own.set(src, m);
    return m;
  };
  /* The paint's baked occlusion stays; its colour is the seat's. */
  const paintSrc = (parts.find((p) => p.role === 'paint') || {}).src || null;
  const ghostShell = ghostGeos.length ? A.mergeGeometries(ghostGeos, false) : new THREE.BufferGeometry();
  for (const g of ghostGeos) g.dispose();
  ghostShell.computeBoundingSphere();
  const tailOn = new THREE.Color(0.85, 0.03, 0.02).multiplyScalar(0.6 * glowGain), brakeOn = new THREE.Color(1, 0.05, 0.03).multiplyScalar(2.2 * glowGain);
  /* where the tail lights are: the halos (brake), the amber indicator glows at their outer ends, the flames under */
  if (tailBox.isEmpty()) tailBox.set(new THREE.Vector3(-0.7, 0.7, allBox.max.z - 0.1), new THREE.Vector3(0.7, 0.85, allBox.max.z));
  const tz = Math.max(tailBox.max.z, allBox.max.z - 0.25) + 0.06, ty = (tailBox.min.y + tailBox.max.y) / 2;
  const tx = Math.max(0.35, Math.min(0.85, Math.max(-tailBox.min.x, tailBox.max.x) - 0.12));
  const lamps = {
    brake: { lamp: new THREE.BufferGeometry(), halo: quads([[-tx * 0.8, ty, tz, 1.5, 0.8], [tx * 0.8, ty, tz, 1.5, 0.8]]) },
    ind: [-1, 1].map((sx) => ({ lamp: new THREE.BufferGeometry(), halo: quads([[sx * (tx + 0.05), ty, tz + 0.02, 0.8, 0.5]]) })),
    flame: quads([[-0.42, 0.3, allBox.max.z + 0.12, 0.6, 0.4], [0.42, 0.3, allBox.max.z + 0.12, 0.6, 0.4],
                  [-0.42, 0.3, allBox.max.z + 0.1, 0.28, 0.2], [0.42, 0.3, allBox.max.z + 0.1, 0.28, 0.2]]),
  };
  function mesh(geo, mat, matrix) {
    const x = new THREE.Mesh(geo, mat);
    matrix.decompose(x.position, x.quaternion, x.scale);
    x.frustumCulled = false;
    x.castShadow = shadows;
    return x;
  }
  function make(paintHex) {
    const solid = new THREE.Group(), ghost = new THREE.Group();
    const paint = phys({ color: paintHex, metalness: paintMetal, roughness: paintRough, clearcoat: 1, clearcoatRoughness: 0.03,
      aoMap: (paintSrc && paintSrc.aoMap) || null });   // its occlusion only: a paint's flake or orange-peel normal map was tiled by an extension we drop
    const tails = new Map();
    const tailOf = (src) => {
      if (!tails.has(src)) { const m = src.clone(); m.emissive = tailOn.clone(); m.emissiveIntensity = 1; if (src.map && !src.emissiveMap) m.emissiveMap = src.map; tails.set(src, m); }
      return tails.get(src);
    };
    for (const p of parts) {
      const mat = p.role === 'paint' ? paint : p.role === 'tail' ? tailOf(p.src) : ownOf(p.src, p.role);
      const x = mesh(p.geo, mat, p.matrix);
      x.userData.role = p.role;
      solid.add(x);
    }
    const depth = new THREE.Mesh(ghostShell, new THREE.MeshBasicMaterial({ colorWrite: false }));
    const shell = new THREE.Mesh(ghostShell, new THREE.MeshStandardMaterial({ color: paintHex, emissive: new THREE.Color(paintHex).multiplyScalar(0.25),
      metalness: 0.3, roughness: 0.3, transparent: true, opacity: 0.45, depthWrite: false, envMapIntensity: envIntensity }));
    depth.renderOrder = 1; shell.renderOrder = 2;
    depth.frustumCulled = shell.frustumCulled = false;
    ghost.add(depth, shell);
    return {
      solid, ghost,
      setPaint(hex) { paint.color.setHex(hex); shell.material.color.setHex(hex); shell.material.emissive.setHex(hex).multiplyScalar(0.25); },
      /* lamps: brake (bool); the indicators are the halos swimScene.js shows */
      lamps(brake) { for (const m of tails.values()) m.emissive.copy(brake ? brakeOn : tailOn); },
      dispose() { paint.dispose(); for (const m of tails.values()) m.dispose(); depth.material.dispose(); shell.material.dispose(); },
    };
  }
  return {
    make, lamps,
    dispose() {
      for (const p of parts) p.geo.dispose();
      ghostShell.dispose();
      glassOurs.dispose();
      for (const m of own.values()) if (m !== glassOurs) m.dispose();
      lamps.brake.halo.dispose(); lamps.flame.dispose(); for (const q of lamps.ind) q.halo.dispose();
    },
  };
}

/* ── the traffic ───────────────────────────────────────────────────────────────────────────────────────────
   One glb per vehicle type (scripts/swimCarBuild.mjs, traffic mode): two meshes already merged, 'paint' (white,
   tinted per car by the instanced colour) and 'det' (every other part in its own colour, per-vertex roughness and
   metalness, lamps glowing), sized to the type's length. Returns { paint, det } geometries with the attributes the
   instanced traffic reads (color, glow, pbr), or null. */
export async function loadTraffic(A, url) {
  const gltf = await new A.GLTFLoader().setMeshoptDecoder(A.MeshoptDecoder).loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const out = {};
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const key = /paint/i.test(o.name) ? 'paint' : 'det';
    const g = floatGeo(o.geometry, o.matrixWorld), n = g.attributes.position.count, src = o.geometry.attributes;
    const col = new Float32Array(n * 3).fill(1), glow = new Float32Array(n), pbr = new Float32Array(n * 2);
    const c = src.color, gl = src._glow || src.glow, pr = src._pbr || src.pbr;
    for (let i = 0; i < n; i++) {
      if (c) { col[i * 3] = c.getX(i); col[i * 3 + 1] = c.getY(i); col[i * 3 + 2] = c.getZ(i); }
      glow[i] = gl ? gl.getX(i) : 0;
      pbr[i * 2] = pr ? pr.getX(i) : 0.5; pbr[i * 2 + 1] = pr ? pr.getY(i) : 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    g.setAttribute('pbr', new THREE.BufferAttribute(pbr, 2));
    g.computeBoundingSphere();
    out[key] = g;
  });
  if (!out.det) return null;
  if (!out.paint) { out.paint = out.det.clone(); out.paint.setDrawRange(0, 0); }
  return out;
}

/* ── the finish: bloom already added, then an edge-only speed blur, a vignette, ACES and sRGB ────────────────
   One full-screen pass. The blur pulls each pixel towards the view's centre by up to `speed`, only towards the
   edges (the road ahead and the car stay sharp: research said strong blur reads slower, so it frames, never
   smears), plus a hair of colour split on a close-pass burst. */
export const FinishShader = {
  name: 'SwimFinish',
  uniforms: {
    tDiffuse: { value: null }, speed: { value: 0 }, burst: { value: 0 }, vignette: { value: 0.32 },
    center: { value: new THREE.Vector2(0.5, 0.56) }, aspect: { value: 1.6 }, seed: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform float speed, burst, vignette, aspect, seed; uniform vec2 center; varying vec2 vUv;',
    // ACESFilmicToneMapping and sRGBTransferOETF come from three's own prefix (renderer.toneMapping is ACES here)
    'float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }',
    'void main(){',
    '  vec2 d = vUv - center; float r = length(d * vec2(aspect, 1.0));',
    '  float k = speed * smoothstep(0.22, 0.85, r);',
    '  vec3 c;',
    '  if (k > 0.0005) {',
    '    c = vec3(0.0); float j = rnd(vUv * 731.0);',
    '    for (int i = 0; i < 8; i++) { float t = (float(i) + j) / 8.0; c += texture2D(tDiffuse, vUv - d * k * t).rgb; }',
    '    c *= 0.125;',
    '  } else c = texture2D(tDiffuse, vUv).rgb;',
    '  if (burst > 0.001) {',
    '    vec2 o = d * burst * 0.012 * smoothstep(0.2, 0.9, r);',
    '    c.r = mix(c.r, texture2D(tDiffuse, vUv + o).r, 0.6); c.b = mix(c.b, texture2D(tDiffuse, vUv - o).b, 0.6);',
    '  }',
    '  c *= 1.0 - vignette * smoothstep(0.35, 1.15, r);',
    '  c = ACESFilmicToneMapping(c);',
    '  vec4 o4 = sRGBTransferOETF(vec4(c, 1.0));',
    '  o4.rgb += (rnd(vUv * 1000.0 + 3.0) - 0.5) / 255.0;',   // dither: no bands in the dusk sky
    '  gl_FragColor = o4;',
    '}',
  ].join('\n'),
};

/* The desktop pipeline: the scene into a 4x MSAA half-float target, bloom, the finish. */
export function makeComposer(A, renderer, scene, camera, { bloomStrength = 0.6, bloomRadius = 0.45, bloomThreshold = 1.0, samples = 4 } = {}) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  const composer = new A.EffectComposer(renderer, rt);
  composer.addPass(new A.RenderPass(scene, camera));
  const bloom = new A.UnrealBloomPass(new THREE.Vector2(size.x, size.y), bloomStrength, bloomRadius, bloomThreshold);
  composer.addPass(bloom);
  const finish = new A.ShaderPass(FinishShader);
  composer.addPass(finish);
  return { composer, bloom, finish, u: finish.uniforms };
}
