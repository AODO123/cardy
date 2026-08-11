// Shared photo handling for the form and the admin dashboard. A picked image
// is shrunk to a small JPEG so the stored card stays light, then handed to a
// callback as a data URI. Used by both index.html and views/admin.html.

// Longest side a stored photo may have, in pixels.
var MAX_PHOTO_SIDE = 400;

// Downscale an already-loaded <img> to a JPEG data URI. The image keeps its
// own aspect ratio — we shrink the longest side to maxSide and never upscale,
// and we deliberately do NOT crop to a square: the card page and the OG image
// both render the photo as a circle and slice the centre, so there's no reason
// to throw the edges away up front.
function resizeToDataUri(img, maxSide) {
  var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  var w = Math.max(1, Math.round(img.width * scale));
  var h = Math.max(1, Math.round(img.height * scale));
  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// Read a picked File and call cb(dataUri) once it is resized. Files that
// aren't images are ignored (the input already filters, but be safe).
function readPhotoFile(file, cb) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () { cb(resizeToDataUri(img, MAX_PHOTO_SIDE)); };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
