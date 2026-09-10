import type { ModelViewerElement } from "@google/model-viewer";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<HTMLAttributes<ModelViewerElement>, ModelViewerElement> & {
        src?: string;
        alt?: string;
        loading?: "auto" | "lazy" | "eager";
        reveal?: "auto" | "interaction" | "manual";
        "camera-controls"?: boolean;
        "auto-rotate"?: boolean;
        "interaction-prompt"?: "auto" | "none";
        "shadow-intensity"?: string;
        "environment-image"?: string;
        exposure?: string;
      };
    }
  }
}
