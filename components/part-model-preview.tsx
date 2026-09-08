"use client";

import type { ModelViewerElement } from "@google/model-viewer";
import { Box, Expand, LoaderCircle, Rotate3D } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type PreviewState = "loading" | "ready" | "missing" | "error";

export function PartModelPreview({ src, partName }: { src: string; partName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ModelViewerElement>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [state, setState] = useState<PreviewState>("loading");
  const [message, setMessage] = useState("Loading private 3D preview…");

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let cancelled = false;

    async function load() {
      setState("loading");
      setMessage("Loading private 3D preview…");
      setModelUrl(null);
      const [response] = await Promise.all([
        fetch(src, { credentials: "same-origin", cache: "no-cache", signal: controller.signal }),
        import("@google/model-viewer"),
      ]);
      if (response.status === 404) {
        if (!cancelled) {
          setState("missing");
          setMessage("The STEP file is available, but its optimized 3D preview has not been generated yet.");
        }
        return;
      }
      if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
      if (response.headers.get("content-type")?.split(";")[0] !== "model/gltf-binary") {
        throw new Error("Preview response was not a GLB model");
      }
      objectUrl = URL.createObjectURL(await response.blob());
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setModelUrl(objectUrl);
      setMessage("Preparing interactive view…");
    }

    void load().catch((error) => {
      if (controller.signal.aborted || cancelled) return;
      console.error("Unable to load part preview", error);
      setState("error");
      setMessage("The 3D preview could not be loaded. The original STEP download is still available below.");
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !modelUrl) return;

    const handleLoad = () => setState("ready");
    const handleError = () => {
      setState("error");
      setMessage("The stored model could not be rendered. The original STEP download is still available below.");
    };
    const timeout = window.setTimeout(() => {
      if (viewer.loaded) {
        setState("ready");
        return;
      }
      setState("error");
      setMessage("The 3D renderer did not become ready. Try reloading the page or use the original STEP download below.");
    }, 20_000);

    viewer.addEventListener("load", handleLoad);
    viewer.addEventListener("error", handleError);
    // React can reconnect a lazily loaded custom element without replaying
    // property assignments. Set the source after the native listeners exist.
    viewer.setAttribute("src", modelUrl);
    if (viewer.loaded) handleLoad();

    return () => {
      window.clearTimeout(timeout);
      viewer.removeEventListener("load", handleLoad);
      viewer.removeEventListener("error", handleError);
      viewer.removeAttribute("src");
    };
  }, [modelUrl]);

  const resetCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.cameraOrbit = "45deg 55deg auto";
    viewer.cameraTarget = "auto auto auto";
    viewer.jumpCameraToGoal();
  };

  const enterFullscreen = () => {
    if (containerRef.current?.requestFullscreen) void containerRef.current.requestFullscreen();
  };

  return (
    <div ref={containerRef} className="part-model-preview group relative isolate h-[22rem] overflow-hidden rounded-xl border bg-[radial-gradient(circle_at_50%_35%,var(--muted),var(--background)_72%)] shadow-sm sm:h-[26rem]">
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground shadow-sm backdrop-blur">
        <Box className="size-3.5 text-primary" /> Interactive model
      </div>

      {modelUrl && (
        <model-viewer
          ref={viewerRef}
          alt={`3D preview of ${partName}`}
          className="h-full w-full bg-transparent"
          camera-controls
          auto-rotate
          interaction-prompt="auto"
          shadow-intensity="0.7"
          exposure="1.05"
          loading="eager"
          reveal="auto"
        />
      )}

      {state !== "ready" && (
        <div className="absolute inset-0 grid place-items-center bg-background/85 p-8 text-center backdrop-blur-sm">
          <div className="max-w-sm">
            {state === "loading" ? <LoaderCircle className="mx-auto size-8 animate-spin text-primary" /> : <Box className="mx-auto size-9 text-muted-foreground" />}
            <p className="mt-3 text-sm font-semibold">{message}</p>
          </div>
        </div>
      )}

      {state === "ready" && (
        <div className="absolute bottom-3 right-3 z-10 flex gap-2 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Button size="icon" variant="secondary" className="shadow-md" aria-label="Reset 3D view" onClick={resetCamera}>
            <Rotate3D />
          </Button>
          <Button size="icon" variant="secondary" className="shadow-md" aria-label="Open 3D view fullscreen" onClick={enterFullscreen}>
            <Expand />
          </Button>
        </div>
      )}

      {state === "ready" && (
        <p className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-full bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">
          Drag to rotate · pinch or scroll to zoom
        </p>
      )}
    </div>
  );
}
