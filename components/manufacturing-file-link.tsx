"use client";

import { ArrowUpRight, ChevronRight, Cloud, Download, FileText } from "lucide-react";
import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from "react";

import type { ManufacturingOperation } from "@/lib/types";

const MAX_CACHED_FILES = 6;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;

interface PrefetchedFile {
  objectUrl: string;
  byteSize: number;
}

interface CacheEntry {
  promise: Promise<PrefetchedFile | null>;
  file?: PrefetchedFile;
}

const prefetchedFiles = new Map<string, CacheEntry>();
let cachedBytes = 0;

function evict(href: string, entry: CacheEntry) {
  if (prefetchedFiles.get(href) !== entry || !entry.file) return;
  prefetchedFiles.delete(href);
  cachedBytes -= entry.file.byteSize;
  URL.revokeObjectURL(entry.file.objectUrl);
}

function trimCache(currentHref: string) {
  for (const [href, entry] of prefetchedFiles) {
    if (prefetchedFiles.size <= MAX_CACHED_FILES && cachedBytes <= MAX_CACHED_BYTES) break;
    if (href !== currentHref) evict(href, entry);
  }
}

function prefetchFile(href: string) {
  const cached = prefetchedFiles.get(href);
  if (cached) {
    prefetchedFiles.delete(href);
    prefetchedFiles.set(href, cached);
    return cached.promise;
  }

  const entry = {} as CacheEntry;
  entry.promise = fetch(href, {
    cache: "force-cache",
    credentials: "same-origin",
    redirect: "follow",
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Unable to preload manufacturing file (${response.status})`);
      const blob = await response.blob();
      const file = { objectUrl: URL.createObjectURL(blob), byteSize: blob.size };
      entry.file = file;
      cachedBytes += file.byteSize;
      trimCache(href);
      return file;
    })
    .catch(() => {
      if (prefetchedFiles.get(href) === entry) prefetchedFiles.delete(href);
      return null;
    });
  prefetchedFiles.set(href, entry);
  return entry.promise;
}

type ManufacturingFileLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
};

/** Silently warm a private manufacturing file in this browser while its link is visible. */
export const ManufacturingFileLink = forwardRef<HTMLAnchorElement, ManufacturingFileLinkProps>(
  function ManufacturingFileLink({ href, download, ...props }, ref) {
    const canUsePrefetchedBlob = download !== undefined && download !== false;
    const [prefetched, setPrefetched] = useState<{ sourceHref: string; objectUrl: string } | null>(() => {
      const objectUrl = canUsePrefetchedBlob ? prefetchedFiles.get(href)?.file?.objectUrl : null;
      return objectUrl ? { sourceHref: href, objectUrl } : null;
    });

    useEffect(() => {
      if (!canUsePrefetchedBlob) return;
      let active = true;
      void prefetchFile(href).then((file) => {
        if (active && file) setPrefetched({ sourceHref: href, objectUrl: file.objectUrl });
      });
      return () => {
        active = false;
      };
    }, [canUsePrefetchedBlob, href]);

    const resolvedHref = canUsePrefetchedBlob && prefetched?.sourceHref === href ? prefetched.objectUrl : href;
    return <a ref={ref} href={resolvedHref} download={download} {...props} />;
  },
);

type PartFiles = Pick<ManufacturingOperation, "id" | "hasDrawingPdf" | "drawingPdfName" | "hasStepFile" | "stepName" | "drawingUrl">;

/** The "Files & source" section of a detail sheet; without a part only the BOM source is listed. */
export function FilesAndSource({ basePath, part, onshapeUrl }: { basePath: "/api/operations" | "/api/fabrication"; part: PartFiles | undefined; onshapeUrl: string | null }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Files & source</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          ...(part ? [
            { label: "Drawing PDF", href: part.hasDrawingPdf ? `${basePath}/${part.id}/files/drawing-pdf` : null, fileName: part.drawingPdfName, icon: FileText },
            // Only the STEP download is prefetched; see ManufacturingFileLink.
            { label: "STEP file", href: part.hasStepFile ? `${basePath}/${part.id}/files/step` : null, fileName: part.stepName, icon: Download, download: part.stepName ?? true },
            { label: "Onshape drawing", href: part.drawingUrl, fileName: null, icon: ArrowUpRight },
          ] : []),
          { label: "BOM source", href: onshapeUrl, fileName: null, icon: Cloud },
        ].map(({ label, href, fileName, icon: Icon, download }) => href ? (
          <ManufacturingFileLink key={label} href={href} download={download} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-xl border p-3 text-sm font-semibold transition hover:border-primary/40 hover:bg-accent/40"><div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></div><span className="min-w-0"><span className="block">{label}</span>{fileName && <span className="block truncate text-[10px] font-normal text-muted-foreground">{fileName}</span>}</span><ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" /></ManufacturingFileLink>
        ) : (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm text-muted-foreground"><div className="grid size-8 place-items-center rounded-lg bg-muted"><Icon className="size-4" /></div>{label}<span className="ml-auto text-[10px] uppercase">Missing</span></div>
        ))}
      </div>
    </section>
  );
}
