/**
 * Style catalog contract (ARCHITECTURE_SPEC §7.1, §8.1).
 * Mirrors backend/style_transfer/reco/style_catalog.py STYLE_MODEL_CANDIDATES.
 */
export const STYLE_IDS = [
  "starry-night",
  "mosaic",
  "udnie",
  "wave",
  "tokyo-ghoul",
  "lazy",
  "bayanihan",
  "pointilism",
] as const;

export type StyleId = (typeof STYLE_IDS)[number];

export interface OnnxModelSpec {
  id: StyleId;
  label: string;
  url: string;
  inputName: string;
  outputName: string;
  /** null = dynamic spatial axes; otherwise the fixed [H, W] the model requires. */
  fixedSize: readonly [number, number] | null;
  /** True when the Django backend also has a .pth checkpoint for this style. */
  serverAvailable: boolean;
}

const transformerNet = (id: StyleId, label: string): OnnxModelSpec => ({
  id,
  label,
  url: `/models/${id}.onnx`,
  inputName: "input",
  outputName: "output",
  fixedSize: null,
  serverAvailable: true,
});

export const ONNX_MODELS: Readonly<Record<StyleId, OnnxModelSpec>> = {
  "starry-night": transformerNet("starry-night", "Starry Night"),
  mosaic: transformerNet("mosaic", "Mosaic"),
  udnie: transformerNet("udnie", "Udnie"),
  wave: transformerNet("wave", "Great Wave"),
  "tokyo-ghoul": transformerNet("tokyo-ghoul", "Tokyo Ghoul"),
  lazy: transformerNet("lazy", "Lazy Sunday"),
  bayanihan: transformerNet("bayanihan", "Bayanihan"),
  pointilism: {
    id: "pointilism",
    label: "Pointillism",
    url: "/models/pointilism-10.onnx",
    inputName: "input1",
    outputName: "output1",
    fixedSize: [224, 224],
    serverAvailable: false,
  },
};

export function isStyleId(value: unknown): value is StyleId {
  return typeof value === "string" && (STYLE_IDS as readonly string[]).includes(value);
}
