/* Swim's real cars and traffic: how public/vendor/models/swim/cars/*.glb and traffic/*.glb were made (2026-11-08).
   One downloaded Sketchfab glb (CC-BY 4.0, credits in public/vendor/models/swim/CREDITS.txt) -> game glb files.
   Configs: scripts/swimCarModels.json (src is the downloaded file, run from the folder that holds the downloads).
   Needs @gltf-transform/core, /extensions, /functions (v4), meshoptimizer (1.x) and sharp, which this repo does not
   install: run it from a scratch folder that has them. Cars write <id>.glb and <id>-lo.glb, traffic (traffic: true) <type>.glb.
   node buildCar.mjs <config.json> <carId>
   config[carId] = {
     src: 'path/to/scene.gltf',
     front: '-z' | '+z' | '-x' | '+x',     // where the nose points in the source, after its own node transforms
     len: 4.3,                             // length to scale to (uniform: the car keeps its proportions)
     drop: ['regex', ...],                 // nodes or materials removed (badges, logos, plates, interior bits, the ground)
     roles: { paint: 'regex', accent: 'regex', glass: 'regex', tail: 'regex', head: 'regex', chrome: 'regex',
              tyre: 'regex', rim: 'regex', plate: 'regex' },   // material name -> role (first match wins, else 'other')
     hi: { ratio, error, tex }, lo: { ratio, error, tex },
     detail: ['role', ...]                 // roles that are simplified much further (interior, rims, tyres...)
   }
   Output: <outDir>/<carId>.glb and <carId>-lo.glb, nose to -z, centred, wheels on y = 0, every material renamed
   '<role>|<original name>' so the game maps it without knowing the model. Logos go with their meshes and textures. */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { prune, dedup, weld, quantize, textureCompress, flatten, join, reorder, getBounds, transformMesh, clearNodeTransform, compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const [,, CFG, ID, OUTDIR = path.join(path.dirname(CFG), 'out')] = process.argv;
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'))[ID];
if (!cfg) throw new Error('no config for ' + ID);
await MeshoptSimplifier.ready; await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const ROLE_ORDER = ['tail', 'head', 'glass', 'plate', 'tyre', 'rim', 'chrome', 'accent', 'paint'];
const re = (s) => new RegExp(s, 'i');

async function build(level) {
  const L = cfg[level] || {};
  const doc = await io.read(cfg.src);
  const root = doc.getRoot();
  for (const e of root.listExtensionsUsed()) if (/variants|transmission|iridescence|volume|sheen|specular|ior|anisotropy|dispersion/.test(e.extensionName)) e.dispose();
  // 1. drop: badge, logo and plate meshes and whatever else the config names (by node or material name)
  const drops = (cfg.drop || []).map(re);
  for (const n of root.listNodes()) {
    const mesh = n.getMesh();
    if (drops.some((r) => r.test(n.getName()))) { n.setMesh(null); continue; }
    if (mesh) for (const p of mesh.listPrimitives()) {
      const m = p.getMaterial();
      if (m && drops.some((r) => r.test(m.getName()))) { mesh.removePrimitive(p); p.dispose(); }
    }
  }
  for (const t of root.listTextures()) if (/logo|badge|emblem|brand|decal|plate|licen[cs]e|sticker/i.test(t.getName() + ' ' + (t.getURI() || ''))) t.dispose();
  await doc.transform(prune());
  // 2. one material per role-name: every material renamed '<role>|<name>'
  const roles = Object.entries(cfg.roles || {}).sort((a, b) => ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]));
  for (const m of root.listMaterials()) {
    const n = m.getName() || '';
    let role = 'other';
    for (const [r, rx] of roles) if (re(rx).test(n)) { role = r; break; }
    m.setName(role + '|' + n);
    // every lamp keeps the glow its maker gave it
  }
  // 3. bake every transform into the meshes, then turn, scale and centre: nose to -z, wheels on the road
  await doc.transform(flatten());
  for (const n of root.listNodes()) { if (n.getMesh()) clearNodeTransform(n); }
  const b0 = getBounds(root.listScenes()[0]);
  const yaw = { '-z': 0, '+z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 }[cfg.front || '-z'];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const sizeX = b0.max[0] - b0.min[0], sizeZ = b0.max[2] - b0.min[2];
  const length = Math.abs(c) > 0.5 ? sizeZ : sizeX;
  const k = (cfg.len || 4.3) / length;
  const width = Math.abs(c) > 0.5 ? sizeX : sizeZ, kx = cfg.width ? cfg.width / width : k;   // traffic: exactly its type's width
  const cx = (b0.min[0] + b0.max[0]) / 2, cz = (b0.min[2] + b0.max[2]) / 2, y0 = b0.min[1] + (cfg.lift || 0);
  // column-major 4x4: translate(-cx, -y0, -cz), rotate about y by yaw, scale k
  const ky = cfg.height ? cfg.height / (b0.max[1] - b0.min[1] - (cfg.lift || 0)) : k;   // traffic: exactly its type's height too
  const m = [kx * c, 0, -k * s, 0, 0, ky, 0, 0, kx * s, 0, k * c, 0, 0, 0, 0, 1];
  const tx = -cx, ty = -y0, tz = -cz;
  m[12] = kx * (c * tx + s * tz); m[13] = ky * ty; m[14] = k * (-s * tx + c * tz);
  for (const mesh of root.listMeshes()) transformMesh(mesh, m);
  /* Badges merged into a big mesh: cfg.islands = [{ mat: 'regex on the source material name', max: 0.25, lat: 0.18, end: 1.6,
     y: [lo, hi] }] drops every connected piece of those materials that is small (longest side under max metres), on the
     middle (|x| under lat) and at an end (|z| over end), the car now nose to -z, 4.3 m long, wheels on y = 0. */
  for (const isl of cfg.islands || []) {
    const mre = re(isl.mat);
    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
      const mt = p.getMaterial(); if (!mt || !mre.test(mt.getName().split('|').slice(1).join('|'))) continue;
      const ix = p.getIndices(), pos = p.getAttribute('POSITION'); if (!ix || !pos || p.getMode() !== 4) continue;
      const I = ix.getArray(), n = pos.getCount(), P = new Float32Array(n * 3), e = [];
      for (let v = 0; v < n; v++) { pos.getElement(v, e); P[v * 3] = e[0]; P[v * 3 + 1] = e[1]; P[v * 3 + 2] = e[2]; }
      const key = new Map(), w = new Uint32Array(n);
      for (let v = 0; v < n; v++) { const k = Math.round(P[v * 3] * 2e4) + ',' + Math.round(P[v * 3 + 1] * 2e4) + ',' + Math.round(P[v * 3 + 2] * 2e4); let f = key.get(k); if (f === undefined) { f = v; key.set(k, v); } w[v] = f; }
      const par = new Int32Array(n).map((_, i) => i), find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
      for (let t = 0; t < I.length; t += 3) { const a0 = find(w[I[t]]), a1 = find(w[I[t + 1]]), a2 = find(w[I[t + 2]]); par[a1] = a0; par[find(a2)] = a0; }
      const box = new Map();
      for (let t = 0; t < I.length; t += 3) { const r = find(w[I[t]]); let b = box.get(r); if (!b) { b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0]; box.set(r, b); }
        for (let c = 0; c < 3; c++) { const v = I[t + c] * 3; for (let d = 0; d < 3; d++) { if (P[v + d] < b[d]) b[d] = P[v + d]; if (P[v + d] > b[d + 3]) b[d + 3] = P[v + d]; } } b[6]++; }
      const kill = new Set();
      for (const [r, b] of box) {
        const big = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]), cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
        if (big < (isl.max || 0.25) && Math.abs(cx) < (isl.lat || 0.18) && Math.abs(cz) > (isl.end || 1.6) && (!isl.y || (cy > isl.y[0] && cy < isl.y[1]))) {
          kill.add(r); console.log('island cut', mt.getName(), b[6] + 't', 'at', cx.toFixed(2), cy.toFixed(2), cz.toFixed(2), 'size', big.toFixed(2));
        }
      }
      if (!kill.size) continue;
      const out = []; for (let t = 0; t < I.length; t += 3) if (!kill.has(find(w[I[t]]))) out.push(I[t], I[t + 1], I[t + 2]);
      ix.setArray(new Uint32Array(out));
    }
  }
  // 4. one primitive per material, welded, then each simplified with its normals weighed in (meshopt's attribute-aware
  //    simplifier: smooth paint stays smooth), the roles nobody looks at much further, textures shrunk
  /* UVs on an untextured material only split vertices (seams lock the simplifier): drop them, and the tangents with them.
     Paint keeps only its AO map in the game, so paint keeps UVs only when it has one. */
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const mt = p.getMaterial(); if (!mt) continue;
    const paint = mt.getName().startsWith('paint|');
    const tex = paint ? !!mt.getOcclusionTexture() : !!(mt.getBaseColorTexture() || mt.getNormalTexture() || mt.getOcclusionTexture() || mt.getEmissiveTexture() || mt.getMetallicRoughnessTexture());
    if (tex) continue;
    for (const sem of p.listSemantics()) if (/^TEXCOORD_|^TANGENT$/.test(sem)) p.setAttribute(sem, null);
    if (paint) { mt.setNormalTexture(null); mt.setBaseColorTexture(null); mt.setMetallicRoughnessTexture(null); }
  }
  await doc.transform(join({ keepNamed: false }), weld());
  const detail = new Set(cfg.detail || ['other', 'rim', 'tyre', 'accent']);
  const roleTris = {};   // the caps are per role: a role split over many primitives shares its cap by size
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const r = ((p.getMaterial() && p.getMaterial().getName()) || 'other|').split('|')[0], ix = p.getIndices();
    if (ix) roleTris[r] = (roleTris[r] || 0) + ix.getCount() / 3;
  }
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const role = ((p.getMaterial() && p.getMaterial().getName()) || 'other|').split('|')[0];
    const ix = p.getIndices(), pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL');
    if (!ix || !pos || p.getMode() !== 4) continue;
    const isDet = detail.has(role);
    const ratio = role === 'paint' ? (L.paintRatio || L.ratio || 0.3) : isDet ? (L.detailRatio || 0.3) : (L.ratio || 0.3);
    const err = isDet ? (L.detailError || 0.01) : role === 'paint' && L.paintError ? L.paintError : (L.error || 0.001);
    const fl = (acc) => { const n = acc.getCount(), k = acc.getElementSize(), o = new Float32Array(n * k), e = []; for (let i = 0; i < n; i++) { acc.getElement(i, e); for (let c = 0; c < k; c++) o[i * k + c] = e[c]; } return o; };
    const src = new Uint32Array(ix.getArray()), P = fl(pos);
    // a hard cap per part as well as the ratio: a 2-million-triangle source must not stay heavy at 10 %
    const cap = role === 'paint' ? (L.maxPaint || (level === 'hi' ? 30000 : 9000)) : (L.maxRole || (level === 'hi' ? 10000 : 3000));
    const want = Math.max(36, Math.min(Math.floor(cap * (src.length / 3) / (roleTris[role] || 1)), Math.floor(src.length / 3 * ratio))) * 3;
    let out;
    try {
      out = nor && nor.getCount() === pos.getCount() ? MeshoptSimplifier.simplifyWithAttributes(src, P, 3, fl(nor), 3, [0.5, 0.5, 0.5], null, want, err, [])
        : MeshoptSimplifier.simplify(src, P, 3, want, err, []);
    } catch (e) { if (process.env.DEBUG) console.log('simplifyWithAttributes failed', role, e.message); try { out = MeshoptSimplifier.simplify(src, P, 3, want, err, []); } catch (e2) { if (process.env.DEBUG) console.log('simplify failed', role, e2.message, src.length, P.length); out = src; } }
    let arr = Array.isArray(out) ? out[0] : out;
    if (process.env.DEBUG) console.log('simp', role, 'e', Array.isArray(out) ? (+out[1]).toFixed(4) : '-', src.length / 3, '->', arr.length / 3, 'want', want / 3, 'verts', pos.getCount());
    /* Split normals (a maker's custom or weighted normals) lock every seam: let the simplifier collapse across them,
       still weighing the normals, before giving up on them. */
    if (arr.length > want * 1.6 && nor && nor.getCount() === pos.getCount() && !(cfg.noPermissive || []).includes(role)) {
      try {
        const o3 = MeshoptSimplifier.simplifyWithAttributes(src, P, 3, fl(nor), 3, [0.5, 0.5, 0.5], null, want, err, ['Permissive']);
        const a3 = Array.isArray(o3) ? o3[0] : o3;
        if (process.env.DEBUG) console.log('perm', role, src.length / 3, '->', a3.length / 3, 'e', Array.isArray(o3) ? (+o3[1]).toFixed(4) : '-');
        if (a3 && a3.length >= 3 && a3.length < arr.length) arr = a3;
      } catch (e) { if (process.env.DEBUG) console.log('permissive failed', role, e.message); }
    }
    /* A mesh whose every vertex is split (flat normals or UV seams everywhere) cannot be simplified as it is: weld it by
       position alone, simplify that, and give it fresh smooth normals. */
    if (arr.length > want * 1.6 && src.length / 3 > 2000) {
      // positions equal to within a hundred-thousandth of the part's size are one vertex
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < P.length; v += 3) for (let c = 0; c < 3; c++) { if (P[v + c] < lo[c]) lo[c] = P[v + c]; if (P[v + c] > hi[c]) hi[c] = P[v + c]; }
      const eps = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-5 || 1e-6, seen = new Map(), remap = new Uint32Array(P.length / 3);
      for (let v = 0; v < remap.length; v++) {
        const k = Math.round(P[v * 3] / eps) + ',' + Math.round(P[v * 3 + 1] / eps) + ',' + Math.round(P[v * 3 + 2] / eps);
        const f = seen.get(k); if (f === undefined) { seen.set(k, v); remap[v] = v; } else remap[v] = f;
      }
      const welded = new Uint32Array(src.length);
      for (let i = 0; i < src.length; i++) welded[i] = remap[src[i]];
      if (process.env.DEBUG) { const E = new Map(); for (let t = 0; t < welded.length; t += 3) for (let e = 0; e < 3; e++) { const x = welded[t + e], y = welded[t + (e + 1) % 3], k = x < y ? x + ',' + y : y + ',' + x; E.set(k, (E.get(k) || 0) + 1); } let b = 0, nm = 0; for (const v of E.values()) { if (v === 1) b++; else if (v > 2) nm++; } console.log('weld', role, 'verts', remap.length, '->', seen.size, 'edges', E.size, 'border', b, 'nonmanifold', nm); }
      let o2;
      try { o2 = MeshoptSimplifier.simplify(welded, P, 3, want, err, []); } catch (e) { if (process.env.DEBUG) console.log('weld simplify failed', e.message); o2 = null; }
      if (process.env.DEBUG && o2) console.log('weld simp', role, (Array.isArray(o2) ? o2[0] : o2).length / 3, 'err', Array.isArray(o2) ? o2[1] : '-');
      const a2 = o2 ? (Array.isArray(o2) ? o2[0] : o2) : null;
      if (a2 && a2.length >= 3 && a2.length < arr.length) {
        arr = a2;
        if (nor) {   // smooth normals from the faces left
          const n = pos.getCount(), acc = new Float32Array(n * 3);
          for (let t = 0; t < arr.length; t += 3) {
            const a = arr[t] * 3, b = arr[t + 1] * 3, c = arr[t + 2] * 3;
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            for (const v of [a, b, c]) { acc[v] += nx; acc[v + 1] += ny; acc[v + 2] += nz; }
          }
          for (let v = 0; v < n; v++) { const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1; acc[v * 3] /= l; acc[v * 3 + 1] /= l; acc[v * 3 + 2] /= l; }
          p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(acc).setBuffer(root.listBuffers()[0]));
        }
      }
    }
    // what seams still hold up (lamp internals, the cabin) goes by position alone
    if ((cfg.sloppy || ['other']).concat(cfg.sloppyAll ? [role] : []).includes(role) && arr.length / 3 > (L.sloppyAbove || 300) && arr.length > want * 1.5) {
      const s2 = MeshoptSimplifier.simplifySloppy(new Uint32Array(arr), P, 3, null, want, Math.max(err, L.sloppyError || 0.01));
      const a2 = Array.isArray(s2) ? s2[0] : s2;
      if (a2 && a2.length >= 3) arr = a2;
    }
    if (arr && arr.length >= 3) { ix.setArray(new Uint32Array(arr)); compactPrimitive(p); }
  }
  await doc.transform(dedup({ keepUniqueNames: true }), prune());   // never merge two materials of different roles
  if (cfg.traffic) return trafficOut(doc, level);
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [L.tex || 1024, L.tex || 1024], quality: 80 }));
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  root.getAsset().copyright = cfg.credit || '';
  const out = path.join(OUTDIR, ID + (level === 'lo' ? '-lo' : '') + '.glb');
  fs.mkdirSync(OUTDIR, { recursive: true });
  await io.write(out, doc);
  let tris = 0; const per = {};
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const n = (p.getIndices() ? p.getIndices().getCount() : 0) / 3; tris += n;
    const r = ((p.getMaterial() && p.getMaterial().getName()) || 'other|').split('|')[0]; per[r] = (per[r] || 0) + n;
  }
  const b = getBounds(root.listScenes()[0]);
  console.log(level, path.basename(out), (fs.statSync(out).size / 1e6).toFixed(2) + 'MB', tris + ' tris', JSON.stringify(per),
    'size', b.min.map((v, i) => (b.max[i] - v).toFixed(2)).join(' x '));
}
/* TRAFFIC: two meshes, 'paint' (white: the instanced colour tints it) and 'det' (every other part in its own colour:
   base colour times its texture's average, its roughness and metalness per vertex, lamps glowing), no textures. */
async function trafficOut(doc, level) {
  const root = doc.getRoot(), buf = root.listBuffers()[0];
  const mats = { paint: doc.createMaterial('paint'), det: doc.createMaterial('det') };
  const avg = new Map(); const texPix = new Map();
  for (const m of root.listMaterials()) {
    if (m === mats.paint || m === mats.det) continue;
    let col = m.getBaseColorFactor().slice(0, 3);
    const t = m.getBaseColorTexture();
    if (t && t.getImage()) {
      if (!avg.has(t)) { const st = await sharp(Buffer.from(t.getImage())).stats(); avg.set(t, st.channels.slice(0, 3).map((ch) => Math.pow(ch.mean / 255, 2.2))); }
      const a = avg.get(t); col = col.map((v, i) => v * a[i]);
    }
    m.setExtras({ col, pbr: [m.getRoughnessFactor(), m.getMetallicFactor()] });
  }
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial(), role = ((mat && mat.getName()) || 'other|').split('|')[0];
    const ex = (mat && mat.getExtras()) || {}, n = p.getAttribute('POSITION').getCount();
    const isPaint = role === 'paint' && !cfg.noPaint;
    const glowV = role === 'tail' || role === 'head' ? 1 : 0;
    const col = isPaint ? [1, 1, 1] : (cfg.colors && cfg.colors[role]) || ex.col || [0.5, 0.5, 0.5];
    const pr = role === 'glass' ? [0.04, 0] : role === 'chrome' ? [0.15, 1] : role === 'tyre' ? [0.85, 0] : ex.pbr || [0.5, 0];
    const C = new Float32Array(n * 3), G = new Float32Array(n), R = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { C.set(col, i * 3); G[i] = glowV; R[i * 2] = pr[0]; R[i * 2 + 1] = pr[1]; }
    /* cfg.vertexTex: a model painted from one texture keeps its parts apart: each vertex takes the texture's colour
       under it (not the material's average), so wheels stay dark and windows stay glass. */
    const tex = mat && mat.getBaseColorTexture(), uv = p.getAttribute('TEXCOORD_0');
    if (cfg.vertexTex && !isPaint && tex && tex.getImage() && uv) {
      if (!texPix.has(tex)) { const { data, info } = await sharp(Buffer.from(tex.getImage())).resize(256, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }); texPix.set(tex, { data, w: info.width, h: info.height }); }
      const T = texPix.get(tex), f = mat.getBaseColorFactor(), e = [];
      for (let i = 0; i < n; i++) {
        uv.getElement(i, e);
        const u = ((e[0] % 1) + 1) % 1, v = ((e[1] % 1) + 1) % 1, x = Math.min(T.w - 1, Math.floor(u * T.w)), y = Math.min(T.h - 1, Math.floor(v * T.h)), o = (y * T.w + x) * 3;
        for (let c = 0; c < 3; c++) C[i * 3 + c] = Math.pow(T.data[o + c] / 255, 2.2) * f[c];
      }
    }
    for (const k of p.listSemantics()) if (/TEXCOORD|COLOR|TANGENT/.test(k)) p.setAttribute(k, null);
    p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(C).setBuffer(buf));
    p.setAttribute('_GLOW', doc.createAccessor().setType('SCALAR').setArray(G).setBuffer(buf));
    p.setAttribute('_PBR', doc.createAccessor().setType('VEC2').setArray(R).setBuffer(buf));
    p.setMaterial(isPaint ? mats.paint : mats.det);
  }
  for (const t of root.listTextures()) t.dispose();
  await doc.transform(prune({ keepAttributes: true }), join({ keepNamed: false }), weld());
  for (const node of root.listNodes()) { const mesh = node.getMesh(); if (!mesh) continue; const mt = mesh.listPrimitives()[0].getMaterial(); const nm = mt === mats.paint ? 'paint' : 'det'; node.setName(nm); mesh.setName(nm); }
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 8 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  root.getAsset().copyright = cfg.credit || '';
  const out = path.join(OUTDIR, ID + '.glb');
  fs.mkdirSync(OUTDIR, { recursive: true });
  await io.write(out, doc);
  let tris = 0; for (const mesh of root.listMeshes()) for (const q of mesh.listPrimitives()) tris += (q.getIndices() ? q.getIndices().getCount() : 0) / 3;
  const b = getBounds(root.listScenes()[0]);
  console.log('traffic', path.basename(out), (fs.statSync(out).size / 1e6).toFixed(2) + 'MB', tris + ' tris', root.listMeshes().map((x) => x.getName()).join(','), 'size', b.min.map((v, i) => (b.max[i] - v).toFixed(2)).join(' x '));
}
await build('hi');
if (!cfg.traffic) await build('lo');
