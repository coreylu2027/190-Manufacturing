const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

type NumberArray = ArrayLike<number>;

export interface CadMesh {
  name?: string;
  color?: NumberArray | null;
  attributes: {
    position: { array: NumberArray };
    normal?: { array: NumberArray } | null;
  };
  index: { array: NumberArray };
}

export interface CadImportResult {
  success: boolean;
  meshes: CadMesh[];
}

interface BufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  target: number;
}

interface Accessor {
  bufferView: number;
  byteOffset: 0;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC3";
  min?: number[];
  max?: number[];
}

function align4(value: number) {
  return (value + 3) & ~3;
}

function finiteFloat32(values: NumberArray, label: string) {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite value`);
    result[index] = value;
  }
  return result;
}

function componentBounds(values: Float32Array) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < values.length; index += 3) {
    for (let component = 0; component < 3; component += 1) {
      min[component] = Math.min(min[component], values[index + component]);
      max[component] = Math.max(max[component], values[index + component]);
    }
  }
  return { min, max };
}

function normalizedColor(color: NumberArray | null | undefined) {
  if (!color || color.length < 3) return [0.72, 0.75, 0.8, 1];
  return [0, 1, 2].map((index) => Math.min(1, Math.max(0, Number(color[index]) || 0))).concat(1);
}

function typedBytes(values: Float32Array | Uint16Array | Uint32Array) {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

/** Convert triangulated OpenCascade output into a deterministic, embedded-buffer GLB. */
export function cadMeshesToGlb(result: CadImportResult, generator = "FRC190 STEP preview") {
  if (!result.success) throw new Error("OpenCascade could not read the STEP file");
  if (!Array.isArray(result.meshes) || result.meshes.length === 0) {
    throw new Error("The STEP file contains no renderable meshes");
  }

  const binaryChunks: Uint8Array[] = [];
  const bufferViews: BufferView[] = [];
  const accessors: Accessor[] = [];
  const meshes: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [];
  const materials: Array<Record<string, unknown>> = [];
  let binaryLength = 0;

  const append = (bytes: Uint8Array, target: number) => {
    const alignedOffset = align4(binaryLength);
    if (alignedOffset > binaryLength) binaryChunks.push(new Uint8Array(alignedOffset - binaryLength));
    binaryChunks.push(bytes);
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: alignedOffset, byteLength: bytes.byteLength, target });
    binaryLength = alignedOffset + bytes.byteLength;
    return viewIndex;
  };

  for (const [meshIndex, mesh] of result.meshes.entries()) {
    const positions = finiteFloat32(mesh.attributes?.position?.array ?? [], `Mesh ${meshIndex + 1} positions`);
    if (positions.length === 0 || positions.length % 3 !== 0) {
      throw new Error(`Mesh ${meshIndex + 1} has invalid vertex positions`);
    }
    const vertexCount = positions.length / 3;

    const positionView = append(typedBytes(positions), ARRAY_BUFFER);
    const bounds = componentBounds(positions);
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      byteOffset: 0,
      componentType: FLOAT,
      count: vertexCount,
      type: "VEC3",
      min: bounds.min,
      max: bounds.max,
    });

    let normalAccessor: number | undefined;
    if (mesh.attributes.normal?.array) {
      const normals = finiteFloat32(mesh.attributes.normal.array, `Mesh ${meshIndex + 1} normals`);
      if (normals.length !== positions.length) throw new Error(`Mesh ${meshIndex + 1} has invalid normals`);
      const normalView = append(typedBytes(normals), ARRAY_BUFFER);
      normalAccessor = accessors.length;
      accessors.push({
        bufferView: normalView,
        byteOffset: 0,
        componentType: FLOAT,
        count: vertexCount,
        type: "VEC3",
      });
    }

    const sourceIndices = mesh.index?.array ?? [];
    if (sourceIndices.length === 0 || sourceIndices.length % 3 !== 0) {
      throw new Error(`Mesh ${meshIndex + 1} has invalid triangle indices`);
    }
    let minIndex = Number.POSITIVE_INFINITY;
    let maxIndex = 0;
    const numericIndices = new Array<number>(sourceIndices.length);
    for (let index = 0; index < sourceIndices.length; index += 1) {
      const value = Number(sourceIndices[index]);
      if (!Number.isSafeInteger(value) || value < 0 || value >= vertexCount) {
        throw new Error(`Mesh ${meshIndex + 1} contains an out-of-range triangle index`);
      }
      numericIndices[index] = value;
      minIndex = Math.min(minIndex, value);
      maxIndex = Math.max(maxIndex, value);
    }
    const indices = maxIndex <= 65_535 ? new Uint16Array(numericIndices) : new Uint32Array(numericIndices);
    const indexView = append(typedBytes(indices), ELEMENT_ARRAY_BUFFER);
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: indexView,
      byteOffset: 0,
      componentType: indices instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: indices.length,
      type: "SCALAR",
      min: [minIndex],
      max: [maxIndex],
    });

    const materialIndex = materials.length;
    materials.push({
      name: `${mesh.name?.trim() || `Mesh ${meshIndex + 1}`} material`,
      pbrMetallicRoughness: {
        baseColorFactor: normalizedColor(mesh.color),
        metallicFactor: 0.05,
        roughnessFactor: 0.58,
      },
      doubleSided: true,
    });

    const attributes: Record<string, number> = { POSITION: positionAccessor };
    if (normalAccessor !== undefined) attributes.NORMAL = normalAccessor;
    meshes.push({
      name: mesh.name?.trim() || `Mesh ${meshIndex + 1}`,
      primitives: [{ attributes, indices: indexAccessor, material: materialIndex, mode: 4 }],
    });
    nodes.push({ mesh: meshIndex, name: mesh.name?.trim() || `Mesh ${meshIndex + 1}` });
  }

  const paddedBinaryLength = align4(binaryLength);
  const binary = new Uint8Array(paddedBinaryLength);
  let chunkOffset = 0;
  for (const chunk of binaryChunks) {
    binary.set(chunk, chunkOffset);
    chunkOffset += chunk.byteLength;
  }

  const document = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ name: "STEP preview", nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  const encodedJson = new TextEncoder().encode(JSON.stringify(document));
  const paddedJsonLength = align4(encodedJson.byteLength);
  const totalLength = 12 + 8 + paddedJsonLength + 8 + binary.byteLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, paddedJsonLength, true);
  view.setUint32(16, JSON_CHUNK_TYPE, true);
  glb.fill(0x20, 20, 20 + paddedJsonLength);
  glb.set(encodedJson, 20);
  const binaryHeader = 20 + paddedJsonLength;
  view.setUint32(binaryHeader, binary.byteLength, true);
  view.setUint32(binaryHeader + 4, BIN_CHUNK_TYPE, true);
  glb.set(binary, binaryHeader + 8);
  return glb;
}

export function inspectGlb(bytes: Uint8Array) {
  if (bytes.byteLength < 28) throw new Error("GLB is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION) {
    throw new Error("Invalid GLB header");
  }
  if (view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== JSON_CHUNK_TYPE) {
    throw new Error("Invalid GLB length or JSON chunk");
  }
  const jsonLength = view.getUint32(12, true);
  const binaryHeader = 20 + jsonLength;
  if (binaryHeader + 8 > bytes.byteLength || view.getUint32(binaryHeader + 4, true) !== BIN_CHUNK_TYPE) {
    throw new Error("Invalid GLB binary chunk");
  }
  const binaryLength = view.getUint32(binaryHeader, true);
  if (binaryHeader + 8 + binaryLength !== bytes.byteLength) throw new Error("Invalid GLB binary length");
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim();
  return JSON.parse(json) as Record<string, unknown>;
}
