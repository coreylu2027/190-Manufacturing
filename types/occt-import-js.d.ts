declare module "occt-import-js" {
  import type { CadImportResult } from "@/lib/manufacturing/glb.mts";

  interface TriangulationParameters {
    linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
    linearDeflection?: number;
    angularDeflection?: number;
  }

  interface OpenCascadeImporter {
    ReadStepFile(content: Uint8Array, params: null | TriangulationParameters): CadImportResult;
  }

  export default function createOpenCascadeImporter(): Promise<OpenCascadeImporter>;
}
