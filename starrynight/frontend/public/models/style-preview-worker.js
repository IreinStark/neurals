/* ONNX inference worker — runs entirely off the main thread */

/*
 * Patch fetch BEFORE loading ort so every ort-wasm file request is
 * redirected to /models/. ort 1.8.0's UMD bundle uses __webpack_public_path__
 * which is '' in an importScripts context, causing it to fetch from the
 * origin root and get index.html (3c 21 44 4f) instead of the WASM binary.
 */
(function patchFetch() {
  var origFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = input instanceof Request ? input.url : String(input);
    var filename = url.split('/').pop().split('?')[0];
    if (/^ort-wasm[^/]*\.(wasm|js)$/.test(filename)) {
      var fixed = self.location.origin + '/models/' + filename;
      return origFetch(fixed, init);
    }
    return origFetch(input, init);
  };
}());

importScripts('/models/ort.min.js');

/* global ort */
ort.env.wasm.numThreads = 1;

var session = null;

self.onmessage = async function (event) {
  var type = event.data.type;

  if (type === 'load') {
    if (session) {
      await session.release().catch(function () {});
      session = null;
    }
    try {
      session = await ort.InferenceSession.create(event.data.modelUrl, {
        executionProviders: ['wasm'],
      });
      self.postMessage({ type: 'ready', provider: 'wasm' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err && err.message ? err.message : 'ONNX load failed' });
    }
    return;
  }

  if (type === 'run') {
    if (!session) {
      self.postMessage({ type: 'fallback' });
      return;
    }
    var imageData = event.data.imageData;
    var width = event.data.width;
    var height = event.data.height;
    try {
      var inputName = session.inputNames[0];
      var outputName = session.outputNames[0];
      var n = width * height;
      var chw = new Float32Array(3 * n);
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          var idx = (y * width + x) * 4;
          var offset = y * width + x;
          chw[offset]         = imageData[idx]     / 255.0;
          chw[offset + n]     = imageData[idx + 1] / 255.0;
          chw[offset + 2 * n] = imageData[idx + 2] / 255.0;
        }
      }
      var inputTensor = new ort.Tensor('float32', chw, [1, 3, height, width]);
      var results = await session.run({ [inputName]: inputTensor });
      var output = results[outputName];
      var outDims = output.dims;
      var outData = output.data;
      var outH = (outDims[2] | 0) || height;
      var outW = (outDims[3] | 0) || width;
      var outN = outW * outH;
      var scale = outData.some(function (v) { return v > 1.5; }) ? 1.0 : 255.0;
      var rgba = new Uint8ClampedArray(outN * 4);
      for (var p = 0; p < outN; p++) {
        var i = p * 4;
        rgba[i]     = Math.max(0, Math.min(255, Math.round(outData[p]          * scale)));
        rgba[i + 1] = Math.max(0, Math.min(255, Math.round(outData[p + outN]   * scale)));
        rgba[i + 2] = Math.max(0, Math.min(255, Math.round(outData[p + 2*outN] * scale)));
        rgba[i + 3] = 255;
      }
      self.postMessage({ type: 'result', rgba: rgba, outWidth: outW, outHeight: outH }, [rgba.buffer]);
    } catch (err) {
      self.postMessage({ type: 'fallback', message: err && err.message ? err.message : 'inference error' });
    }
    return;
  }

  if (type === 'release') {
    if (session) {
      await session.release().catch(function () {});
      session = null;
    }
  }
};
