(function () {
  "use strict";

  // ============================================================
  // Constants
  // ============================================================
  const ANALYSIS_MAX_DIM = 256;
  const K_MEANS_K = 6;
  const K_MEANS_MAX_ITER = 20;
  const MEDIAN_CUT_DEPTH = 4;
  const PALETTE_COUNT = 6;
  const LOUPE_ZOOM = 8;
  const LOUPE_SIZE = 120;

  // ============================================================
  // DOM References
  // ============================================================
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const fileBtn = document.getElementById("file-btn");
  const dropError = document.getElementById("drop-zone-error");
  const workspace = document.getElementById("workspace");
  const imageSection = document.getElementById("image-section");
  const imageContainer = document.getElementById("image-container");
  const imageCanvas = document.getElementById("image-canvas");
  const analysisCanvas = document.getElementById("analysis-canvas");
  const resultsSection = document.getElementById("results");
  const newImageBtn = document.getElementById("new-image-btn");
  const loupeEl = document.getElementById("loupe");
  const loupeCanvas = document.getElementById("loupe-canvas");
  const toast = document.getElementById("toast");

  const imageCtx = imageCanvas.getContext("2d", { willReadFrequently: true });
  const analysisCtx = analysisCanvas.getContext("2d");
  const loupeCtx = loupeCanvas.getContext("2d");

  let eyedropperGroup = null;

  // ============================================================
  // Color Conversions
  // ============================================================

  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(function (c) {
      return c.toString(16).padStart(2, "0");
    }).join("");
  }

  function rgbToHsl(r, g, b) {
    var rn = r / 255, gn = g / 255, bn = b / 255;
    var max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    var h = 0, s = 0, l = (max + min) / 2;

    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      else if (max === gn) h = ((bn - rn) / d + 2) / 6;
      else h = ((rn - gn) / d + 4) / 6;
    }

    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
      l: Math.round(l * 100)
    };
  }

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgbToOklch(r, g, b) {
    var lr = srgbToLinear(r / 255);
    var lg = srgbToLinear(g / 255);
    var lb = srgbToLinear(b / 255);

    var l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    var m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    var s_ = 0.0883024619 * lr + 0.2220049168 * lg + 0.6896926214 * lb;

    var lc = Math.cbrt(l_), mc = Math.cbrt(m_), sc = Math.cbrt(s_);

    var L = 0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc;
    var a = 1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc;
    var bv = 0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc;

    var C = Math.sqrt(a * a + bv * bv);
    var H = Math.atan2(bv, a) * 180 / Math.PI;
    if (H < 0) H += 360;

    return { l: L, c: C, h: H };
  }

  function formatAllSpaces(r, g, b) {
    var hex = rgbToHex(r, g, b);
    var hsl = rgbToHsl(r, g, b);
    var oklch = rgbToOklch(r, g, b);

    var oklchStr = oklch.c < 0.001
      ? "oklch(" + (oklch.l * 100).toFixed(1) + "% 0 none)"
      : "oklch(" + (oklch.l * 100).toFixed(1) + "% " + oklch.c.toFixed(3) + " " + oklch.h.toFixed(1) + ")";

    return [
      { label: "HEX", value: hex },
      { label: "RGB", value: "rgb(" + r + ", " + g + ", " + b + ")" },
      { label: "HSL", value: "hsl(" + hsl.h + ", " + hsl.s + "%, " + hsl.l + "%)" },
      { label: "OKLCH", value: oklchStr }
    ];
  }

  // ============================================================
  // Image Loading
  // ============================================================

  function loadImageFromFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error("Failed to load image")); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error("Failed to read file")); };
      reader.readAsDataURL(file);
    });
  }

  function drawToCanvas(img, canvas, ctx, maxDim) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (maxDim && (w > maxDim || h > maxDim)) {
      var scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
  }

  function extractPixels(canvas, ctx) {
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var pixels = [];
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 10) continue; // skip transparent
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    return pixels;
  }

  // ============================================================
  // Algorithm: Dominant Color (frequency-based)
  // ============================================================

  function computeDominant(pixels, count) {
    var freq = {};
    var bucketPixels = {};

    for (var i = 0; i < pixels.length; i++) {
      var p = pixels[i];
      // Quantize to 4-bit per channel
      var qr = (p[0] >> 4), qg = (p[1] >> 4), qb = (p[2] >> 4);
      var key = qr + "," + qg + "," + qb;
      freq[key] = (freq[key] || 0) + 1;
      if (!bucketPixels[key]) bucketPixels[key] = [0, 0, 0, 0];
      bucketPixels[key][0] += p[0];
      bucketPixels[key][1] += p[1];
      bucketPixels[key][2] += p[2];
      bucketPixels[key][3] += 1;
    }

    var sorted = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
    var result = [];
    for (var j = 0; j < Math.min(count, sorted.length); j++) {
      var bp = bucketPixels[sorted[j]];
      var n = bp[3];
      result.push([Math.round(bp[0] / n), Math.round(bp[1] / n), Math.round(bp[2] / n)]);
    }
    return result;
  }

  // ============================================================
  // Algorithm: K-Means Clustering
  // ============================================================

  function euclideanDist2(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  function kMeansPlusPlusInit(pixels, k) {
    var centroids = [pixels[Math.floor(Math.random() * pixels.length)]];
    for (var i = 1; i < k; i++) {
      var distances = [];
      var total = 0;
      for (var j = 0; j < pixels.length; j++) {
        var minD = Infinity;
        for (var c = 0; c < centroids.length; c++) {
          var d = euclideanDist2(pixels[j], centroids[c]);
          if (d < minD) minD = d;
        }
        distances.push(minD);
        total += minD;
      }
      var r = Math.random() * total;
      var cum = 0;
      for (var m = 0; m < pixels.length; m++) {
        cum += distances[m];
        if (cum >= r) {
          centroids.push(pixels[m].slice());
          break;
        }
      }
    }
    return centroids;
  }

  function computeKMeans(pixels, k, maxIter) {
    if (pixels.length <= k) {
      return pixels.slice(0, k);
    }

    // Subsample for speed
    var sample = pixels;
    if (pixels.length > 20000) {
      var step = Math.ceil(pixels.length / 20000);
      sample = [];
      for (var s = 0; s < pixels.length; s += step) {
        sample.push(pixels[s]);
      }
    }

    var centroids = kMeansPlusPlusInit(sample, k);
    var assignments = new Array(sample.length);

    for (var iter = 0; iter < maxIter; iter++) {
      // Assign
      for (var i = 0; i < sample.length; i++) {
        var minD = Infinity, minIdx = 0;
        for (var c = 0; c < k; c++) {
          var d = euclideanDist2(sample[i], centroids[c]);
          if (d < minD) { minD = d; minIdx = c; }
        }
        assignments[i] = minIdx;
      }

      // Recompute centroids
      var sums = [], counts = [];
      for (var ci = 0; ci < k; ci++) { sums.push([0, 0, 0]); counts.push(0); }
      for (var j = 0; j < sample.length; j++) {
        var a = assignments[j];
        sums[a][0] += sample[j][0];
        sums[a][1] += sample[j][1];
        sums[a][2] += sample[j][2];
        counts[a]++;
      }

      var converged = true;
      for (var nc = 0; nc < k; nc++) {
        var newC;
        if (counts[nc] === 0) {
          newC = sample[Math.floor(Math.random() * sample.length)].slice();
        } else {
          newC = [
            Math.round(sums[nc][0] / counts[nc]),
            Math.round(sums[nc][1] / counts[nc]),
            Math.round(sums[nc][2] / counts[nc])
          ];
        }
        if (euclideanDist2(centroids[nc], newC) > 1) converged = false;
        centroids[nc] = newC;
      }

      if (converged) break;
    }

    // Sort by cluster size descending
    var clusterSizes = counts.map(function (cnt, idx) { return { idx: idx, cnt: cnt }; });
    clusterSizes.sort(function (a, b) { return b.cnt - a.cnt; });
    return clusterSizes.map(function (cs) { return centroids[cs.idx]; });
  }

  // ============================================================
  // Algorithm: Median Cut
  // ============================================================

  function computeMedianCut(pixels, depth, count) {
    if (pixels.length === 0) return [];

    var buckets = [pixels.slice()];

    for (var level = 0; level < depth; level++) {
      var newBuckets = [];
      for (var bi = 0; bi < buckets.length; bi++) {
        var bucket = buckets[bi];
        if (bucket.length <= 1) {
          newBuckets.push(bucket);
          continue;
        }

        // Find channel with greatest range
        var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (var i = 0; i < bucket.length; i++) {
          var p = bucket[i];
          if (p[0] < minR) minR = p[0]; if (p[0] > maxR) maxR = p[0];
          if (p[1] < minG) minG = p[1]; if (p[1] > maxG) maxG = p[1];
          if (p[2] < minB) minB = p[2]; if (p[2] > maxB) maxB = p[2];
        }
        var rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
        var ch = rangeR >= rangeG && rangeR >= rangeB ? 0 : (rangeG >= rangeB ? 1 : 2);

        bucket.sort(function (a, b) { return a[ch] - b[ch]; });
        var mid = Math.floor(bucket.length / 2);
        newBuckets.push(bucket.slice(0, mid));
        newBuckets.push(bucket.slice(mid));
      }
      buckets = newBuckets;
    }

    // Average each bucket
    var colors = [];
    for (var bj = 0; bj < buckets.length; bj++) {
      var b = buckets[bj];
      if (b.length === 0) continue;
      var sr = 0, sg = 0, sb = 0;
      for (var k = 0; k < b.length; k++) {
        sr += b[k][0]; sg += b[k][1]; sb += b[k][2];
      }
      colors.push({
        color: [Math.round(sr / b.length), Math.round(sg / b.length), Math.round(sb / b.length)],
        size: b.length
      });
    }

    colors.sort(function (a, b) { return b.size - a.size; });
    return colors.slice(0, count).map(function (c) { return c.color; });
  }

  // ============================================================
  // UI: Rendering
  // ============================================================

  function createSwatch(r, g, b) {
    var swatch = document.createElement("div");
    swatch.className = "swatch";

    var colorBlock = document.createElement("div");
    colorBlock.className = "swatch-color";
    colorBlock.style.background = rgbToHex(r, g, b);
    colorBlock.setAttribute("aria-label", rgbToHex(r, g, b));
    swatch.appendChild(colorBlock);

    var values = document.createElement("div");
    values.className = "swatch-values";

    var formats = formatAllSpaces(r, g, b);
    for (var i = 0; i < formats.length; i++) {
      var btn = document.createElement("button");
      btn.className = "color-value";
      btn.setAttribute("data-value", formats[i].value);
      btn.textContent = formats[i].label + ": " + formats[i].value;
      btn.title = "Click to copy";
      values.appendChild(btn);
    }

    swatch.appendChild(values);
    return swatch;
  }

  function renderAlgorithmGroup(name, colors, container) {
    var group = document.createElement("div");
    group.className = "algorithm-group";

    var h2 = document.createElement("h2");
    h2.textContent = name;
    group.appendChild(h2);

    var swatches = document.createElement("div");
    swatches.className = "swatches";

    for (var i = 0; i < colors.length; i++) {
      swatches.appendChild(createSwatch(colors[i][0], colors[i][1], colors[i][2]));
    }

    group.appendChild(swatches);
    container.appendChild(group);
    return group;
  }

  function renderEyedropperGroup(container) {
    var group = document.createElement("div");
    group.className = "algorithm-group";
    group.id = "eyedropper-group";

    var h2 = document.createElement("h2");
    h2.textContent = "Manual Eyedropper";
    group.appendChild(h2);

    var swatches = document.createElement("div");
    swatches.className = "swatches";
    group.appendChild(swatches);

    var placeholder = document.createElement("p");
    placeholder.className = "eyedropper-placeholder";
    placeholder.textContent = "Click on the image above to pick colors.";
    group.appendChild(placeholder);

    container.appendChild(group);
    return group;
  }

  function addEyedropperSwatch(r, g, b) {
    if (!eyedropperGroup) return;
    var swatches = eyedropperGroup.querySelector(".swatches");
    var placeholder = eyedropperGroup.querySelector(".eyedropper-placeholder");
    if (placeholder) placeholder.hidden = true;
    swatches.appendChild(createSwatch(r, g, b));
  }

  function clearResults() {
    resultsSection.innerHTML = "";
    eyedropperGroup = null;
  }

  // ============================================================
  // Toast & Clipboard
  // ============================================================

  var toastTimer = null;

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    // Force reflow for transition
    toast.offsetHeight;
    toast.classList.add("visible");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("visible");
      setTimeout(function () { toast.hidden = true; }, 200);
    }, 1500);
  }

  function copyValue(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast("Copied: " + text);
      });
    } else {
      // Fallback
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied: " + text);
    }
  }

  // ============================================================
  // Eyedropper & Loupe
  // ============================================================

  function getCanvasPixelAtEvent(canvas, ctx, e) {
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var x = Math.floor((e.clientX - rect.left) * scaleX);
    var y = Math.floor((e.clientY - rect.top) * scaleY);
    x = Math.max(0, Math.min(x, canvas.width - 1));
    y = Math.max(0, Math.min(y, canvas.height - 1));
    var data = ctx.getImageData(x, y, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2], x: x, y: y };
  }

  function updateLoupe(canvas, e) {
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var cx = (e.clientX - rect.left) * scaleX;
    var cy = (e.clientY - rect.top) * scaleY;

    // Position loupe relative to image container
    var containerRect = imageContainer.getBoundingClientRect();
    var lx = e.clientX - containerRect.left;
    var ly = e.clientY - containerRect.top;
    loupeEl.style.left = lx + "px";
    loupeEl.style.top = ly + "px";

    // Draw magnified region
    var srcSize = LOUPE_SIZE / LOUPE_ZOOM;
    var sx = cx - srcSize / 2;
    var sy = cy - srcSize / 2;

    loupeCtx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.drawImage(
      canvas,
      sx, sy, srcSize, srcSize,
      0, 0, LOUPE_SIZE, LOUPE_SIZE
    );

    // Draw crosshair
    loupeCtx.strokeStyle = "rgba(255,255,255,0.7)";
    loupeCtx.lineWidth = 1;
    loupeCtx.beginPath();
    loupeCtx.moveTo(LOUPE_SIZE / 2, 0);
    loupeCtx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
    loupeCtx.moveTo(0, LOUPE_SIZE / 2);
    loupeCtx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
    loupeCtx.stroke();
  }

  // ============================================================
  // Main Flow
  // ============================================================

  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      dropError.textContent = "Please select a valid image file.";
      dropError.hidden = false;
      return;
    }
    dropError.hidden = true;

    loadImageFromFile(file).then(function (img) {
      // Show workspace, hide drop zone
      dropZone.hidden = true;
      workspace.hidden = false;

      // Draw display canvas (max 800px wide)
      drawToCanvas(img, imageCanvas, imageCtx, 800);

      // Draw analysis canvas (max 256px)
      drawToCanvas(img, analysisCanvas, analysisCtx, ANALYSIS_MAX_DIM);

      // Run analysis
      runAnalysis();
    }).catch(function () {
      dropError.textContent = "Failed to load image. Please try another file.";
      dropError.hidden = false;
    });
  }

  function runAnalysis() {
    clearResults();

    var pixels = extractPixels(analysisCanvas, analysisCtx);
    if (pixels.length === 0) {
      resultsSection.innerHTML = '<p class="analyzing-indicator">No visible pixels found in this image.</p>';
      return;
    }

    // Run algorithms
    var dominant = computeDominant(pixels, PALETTE_COUNT);
    var kmeans = computeKMeans(pixels, K_MEANS_K, K_MEANS_MAX_ITER);
    var medianCut = computeMedianCut(pixels, MEDIAN_CUT_DEPTH, PALETTE_COUNT);

    // Render
    renderAlgorithmGroup("Dominant Colors", dominant, resultsSection);
    renderAlgorithmGroup("K-Means Clustering", kmeans, resultsSection);
    renderAlgorithmGroup("Median Cut", medianCut, resultsSection);
    eyedropperGroup = renderEyedropperGroup(resultsSection);
  }

  function resetToStart() {
    workspace.hidden = true;
    dropZone.hidden = false;
    dropError.hidden = true;
    fileInput.value = "";
    clearResults();
  }

  // ============================================================
  // Event Wiring
  // ============================================================

  // Drop zone click opens file picker
  dropZone.addEventListener("click", function (e) {
    if (e.target !== fileBtn) fileInput.click();
  });
  fileBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) {
      handleFile(fileInput.files[0]);
    }
  });

  // Drag and drop
  dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("dragover");
  });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // New image button
  newImageBtn.addEventListener("click", resetToStart);

  // Canvas click (eyedropper)
  imageCanvas.addEventListener("click", function (e) {
    var px = getCanvasPixelAtEvent(imageCanvas, imageCtx, e);
    addEyedropperSwatch(px.r, px.g, px.b);
  });

  // Canvas mouse move (loupe)
  imageCanvas.addEventListener("mousemove", function (e) {
    loupeEl.hidden = false;
    updateLoupe(imageCanvas, e);
  });
  imageCanvas.addEventListener("mouseleave", function () {
    loupeEl.hidden = true;
  });

  // Delegated click-to-copy on color values
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".color-value");
    if (!btn) return;

    var value = btn.getAttribute("data-value");
    copyValue(value);

    btn.classList.add("copied");
    var original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(function () {
      btn.classList.remove("copied");
      btn.textContent = original;
    }, 1200);
  });

  // Prevent default drag on body
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) { e.preventDefault(); });

})();
