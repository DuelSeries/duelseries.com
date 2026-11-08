swim-addons.min.js: the few three.js r186 add-ons (npm three@0.186.1, examples/jsm) that Swim's realistic look
needs (public/js/swim/swimHiFi.js), bundled into one ES module with esbuild 0.25 (--bundle --format=esm --minify
--external:three), so 'three' still comes from the page's importmap. Exports:

  GLTFLoader, MeshoptDecoder, mergeGeometries (utils/BufferGeometryUtils),
  EffectComposer, RenderPass, ShaderPass, UnrealBloomPass

Entry used to build it:
  export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
  export { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
  export { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
  export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
  export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
  export { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
  export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

Loaded only by the Swim pages, after their first frame (dynamic import). MIT licence, as three (../LICENSE).
