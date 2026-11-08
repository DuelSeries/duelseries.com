/* Swim's far traffic: public/vendor/models/swim/traffic/<type>-far.glb from <type>.glb (2026-11-08).
   A traffic car past FAR_M metres (public/js/swim/swimScene.js) is a few dozen pixels wide, yet each was drawn with all
   of its 3k to 20k triangles: about 900k a frame in dense traffic. This writes each type's far copy: the same two
   meshes ('paint', 'det') with the same attributes (COLOR_0, _GLOW, _PBR), simplified by meshoptimizer keeping the
   normals and the colour edges (glass stays glass, lamps stay lamps), never moving a surface by more than `error`
   (a share of the vehicle's length: 1.5% is 7 cm on a sedan, under a pixel at FAR_M on a 1280-wide screen).
   Permissive: the flat-shaded models split every corner into one vertex per face, which without it locks them all.
   Needs @gltf-transform/core, /extensions, /functions (v4) and meshoptimizer (1.x), which this repo does not install:
   run it from a scratch folder that has them (as scripts/swimCarBuild.mjs).
   node swimTrafficFar.mjs <trafficDir> [ratio 0.1] [error 0.015] */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dequantize, prune, reorder, quantize, compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const [,, DIR, RATIO = '0.1', ERROR = '0.015'] = process.argv;
await MeshoptSimplifier.ready; await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const TYPES = ['sedan', 'hatch', 'suv', 'van', 'truck', 'bus'];

for (const type of TYPES) {
  const src = path.join(DIR, type + '.glb');
  if (!fs.existsSync(src)) { console.log('skip', type); continue; }
  const doc = await io.read(src);
  await doc.transform(dequantize());
  const root = doc.getRoot();
  let before = 0, after = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL'), col = p.getAttribute('COLOR_0'), idx = p.getIndices();
    const n = pos.getCount(), P = new Float32Array(pos.getArray());
    const I = new Uint32Array(idx.getArray());
    /* normals and colour per vertex, colour weighted most: a colour edge (glass to body, lamp to bumper) is kept */
    const A = new Float32Array(n * 6), e = [];
    for (let i = 0; i < n; i++) {
      if (nor) { nor.getElement(i, e); A[i * 6] = e[0]; A[i * 6 + 1] = e[1]; A[i * 6 + 2] = e[2]; }
      if (col) { col.getElement(i, e); A[i * 6 + 3] = e[0]; A[i * 6 + 4] = e[1]; A[i * 6 + 5] = e[2]; }
    }
    const want = Math.max(3, Math.floor(I.length * +RATIO / 3) * 3);
    const [out] = MeshoptSimplifier.simplifyWithAttributes(I, P, 3, A, 6, [0.25, 0.25, 0.25, 1, 1, 1], null, want, +ERROR, ['Permissive']);
    before += I.length / 3; after += out.length / 3;
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(out)).setBuffer(root.listBuffers()[0]));
    compactPrimitive(p);
  }
  await doc.transform(prune({ keepAttributes: true }), reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 8 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const out = path.join(DIR, type + '-far.glb');
  await io.write(out, doc);
  console.log(type.padEnd(6), String(before).padStart(6), '->', String(after).padStart(5), 'tris', (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
}
