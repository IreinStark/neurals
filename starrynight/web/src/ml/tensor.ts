/**
 * Pixel <-> tensor conversion for the TransformerNet ONNX models (ARCHITECTURE_SPEC §8.1).
 *
 * Models take RGB CHW float32 in the raw 0–255 range (no ImageNet mean/std) and
 * return unclamped values (roughly -60..390), so output must be clamped.
 */

export interface Size {
  width: number;
  height: number;
}

/** RGBA HWC Uint8 -> RGB CHW Float32 (0–255). Alpha is dropped. */
export function rgbaToChwFloat32(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  out?: Float32Array,
): Float32Array {
  const plane = width * height;
  if (rgba.length !== plane * 4) {
    throw new RangeError(`Expected ${plane * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
  }
  const tensor = out ?? new Float32Array(plane * 3);
  if (tensor.length !== plane * 3) {
    throw new RangeError(`Output tensor must have length ${plane * 3}, got ${tensor.length}`);
  }
  const g = plane;
  const b = plane * 2;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    tensor[i] = rgba[p]!;
    tensor[g + i] = rgba[p + 1]!;
    tensor[b + i] = rgba[p + 2]!;
  }
  return tensor;
}

/**
 * RGB CHW Float32 -> RGBA HWC Uint8, clamping to 0–255.
 * `alpha` (optional) is the original alpha channel or a constant (default 255).
 */
export function chwFloat32ToRgba(
  tensor: Float32Array,
  width: number,
  height: number,
  alpha: Uint8ClampedArray | Uint8Array | number = 255,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const plane = width * height;
  if (tensor.length !== plane * 3) {
    throw new RangeError(`Expected tensor length ${plane * 3} for ${width}x${height}, got ${tensor.length}`);
  }
  const rgba = out ?? new Uint8ClampedArray(plane * 4);
  const g = plane;
  const b = plane * 2;
  const alphaIsArray = typeof alpha !== "number";
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    // Uint8ClampedArray clamps and rounds on assignment.
    rgba[p] = tensor[i]!;
    rgba[p + 1] = tensor[g + i]!;
    rgba[p + 2] = tensor[b + i]!;
    rgba[p + 3] = alphaIsArray ? (alpha as Uint8Array)[p + 3]! : (alpha as number);
  }
  return rgba;
}

/**
 * Fit (width, height) inside maxSide keeping aspect ratio. Dimensions are rounded
 * down to `multiple` (TransformerNet downsamples ×4, AdaIN ×8, so other sizes would
 * come back slightly different in size). Never upscales.
 */
export function fitWithin(width: number, height: number, maxSide: number, multiple = 4): Size {
  if (width <= 0 || height <= 0) throw new RangeError("width and height must be positive");
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const snap = (v: number) => Math.max(multiple, Math.floor((v * scale) / multiple) * multiple);
  return { width: snap(width), height: snap(height) };
}
